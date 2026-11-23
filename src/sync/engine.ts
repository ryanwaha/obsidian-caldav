import type { CacheStore } from "../cache/db";
import { type CalDavClient, type SyncResult, TokenExpiredError } from "../caldav/client";
import { parseResource } from "../ical/parse";
import { applyPatch, managedValues } from "../ical/patch";
import { detectAliases } from "./moves";
import { type CalObject, type CollectionInfo, type PendingCreate, type PendingUpdate, type SyncReport, isUpdate } from "../types";

const toError = (e: unknown, collection?: string) => {
  const err: SyncReport["errors"][number] = { message: e instanceof Error ? e.message : String(e) };
  if (collection) err.collection = collection;
  if (e instanceof Error || e instanceof DOMException) err.name = (e as Error).name;
  return err;
};

export class SyncEngine {
  private running?: Promise<SyncReport>;
  private last?: SyncReport;

  constructor(private client: CalDavClient, private cache: CacheStore, private now: () => number = Date.now) {}

  get lastReport(): SyncReport | undefined { return this.last; }

  /** 同一時間只跑一次；執行中再被呼叫，回傳同一個 Promise。 */
  syncAll(): Promise<SyncReport> {
    if (!this.running) {
      this.running = this.run().finally(() => { this.running = undefined; });
    }
    return this.running;
  }

  private async run(): Promise<SyncReport> {
    const report: SyncReport = { startedAt: this.now(), finishedAt: 0, collections: 0, objects: 0, changed: 0, removed: 0, skipped: 0, skippedItems: [], sent: 0, aliases: 0, pendingQueued: 0, pendingFailed: 0, errors: [] };
    try {
      const { home } = await this.client.discover();
      await this.flushPending(report);
      const server = await this.client.listCollections(home);
      const cached = new Map((await this.cache.getCollections()).map((c) => [c.href, c]));
      report.collections = server.length;

      for (const gone of [...cached.keys()].filter((h) => !server.some((s) => s.href === h))) {
        report.removed += await this.cache.removeObjects(await this.cache.hrefsInCollection(gone), report.startedAt);
        await this.cache.deleteCollection(gone);
      }

      for (const col of server) {
        try {
          await this.syncOne({ ...col, syncToken: cached.get(col.href)?.syncToken, lastSyncAt: cached.get(col.href)?.lastSyncAt }, report);
        } catch (e) {
          report.errors.push(toError(e, col.href));
        }
      }
      try {
        // 每輪都對所有還沒有 alias 的 tombstone 比對：新集合可能上一輪失敗、或搬移途中才同步到
        const fresh = detectAliases(await this.cache.allTombstones(), await this.cache.allObjects(), await this.cache.allAliases(), report.startedAt);
        await this.cache.putAliases(fresh);
        report.aliases = fresh.length;
      } catch (e) {
        report.errors.push(toError(e));
      }
      report.objects = await this.cache.count();
      const all = await this.cache.allPending();
      report.pendingQueued = all.filter((p) => p.fingerprint === this.cache.fingerprint && p.state === "queued").length;
      report.pendingFailed = all.length - report.pendingQueued;
    } catch (e) {
      report.errors.push(toError(e));
    }
    report.finishedAt = this.now();
    this.last = report;
    return report;
  }

  /** 送出待送的新建。網路或伺服器錯誤時停止本輪，留待下次。 */
  private async flushPending(report: SyncReport): Promise<void> {
    const queue = (await this.cache.allPending())
      .filter((p) => p.fingerprint === this.cache.fingerprint && p.state === "queued")
      .sort((a, b) => a.createdAt - b.createdAt);
    for (const p of queue) {
      if (isUpdate(p)) {
        if (!(await this.flushUpdate(p, report))) return;
        continue;
      }
      const c: PendingCreate = p;
      let res: { status: number; etag?: string };
      try {
        res = await this.client.put(c.href, c.ics, { ifNoneMatch: true });
      } catch (e) {
        await this.cache.updatePending({ ...p, attempts: p.attempts + 1, lastError: toError(e).message });
        report.errors.push(toError(e, p.collection));
        return;
      }
      const temporary = res.status === 408 || res.status === 423 || res.status === 429 || res.status >= 500;
      if (res.status >= 200 && res.status < 300) {
        const parsed = await parseResource(p.ics, { href: p.href, etag: res.etag ?? "", collection: p.collection });
        if (!("skip" in parsed)) await this.cache.upsertObjects([parsed]);
        await this.cache.removePending(p.uid);
        report.sent++;
      } else if (res.status === 412) {
        // UID 是本機隨機產生的，412 只可能是上次已送出但沒收到回應。
        // 快取裡還沒有就先放本機版本（etag 空白，之後同步會更新）；已有的可能是伺服器較新的版本，不覆蓋。
        if (!(await this.cache.getObject(p.href))) {
          const parsed = await parseResource(p.ics, { href: p.href, etag: "", collection: p.collection });
          if (!("skip" in parsed)) await this.cache.upsertObjects([parsed]);
        }
        await this.cache.removePending(p.uid);
        report.sent++;
      } else if (temporary) {
        await this.cache.updatePending({ ...p, attempts: p.attempts + 1, lastError: `HTTP ${res.status}` });
        report.errors.push({ collection: p.collection, message: `送出新任務暫時失敗（HTTP ${res.status}）` });
        return;
      } else {
        await this.cache.updatePending({ ...p, state: "failed", attempts: p.attempts + 1, lastError: `HTTP ${res.status}` });
      }
    }
  }

  /** 公開給「用伺服器的」：取得伺服器上最新版本寫入快取。 */
  async refreshObject(href: string, collection: string): Promise<void> {
    const cur = await this.client.get(href);
    // deletedAt 用上一輪的開始時間：已在那之後同步過的集合不會讓它被誤判為「可能已搬移」
    if (cur.status === 404) { await this.cache.removeObjects([href], this.last?.startedAt ?? this.now()); return; }
    if (cur.status !== 200) throw new Error(`取得伺服器版本失敗（HTTP ${cur.status}）`);
    const parsed = await parseResource(cur.ics, { href, etag: cur.etag ?? "", collection });
    if (!("skip" in parsed)) await this.cache.upsertObjects([parsed]);
  }

  /**
   * 送出一筆修改。回傳 false 表示遇到暫時性錯誤，應停止本輪 flush。
   * 412：重新取得伺服器版本；修改涉及的欄位伺服器都沒動過（或剛好和我的一樣）就合併重送，否則標為衝突。
   * 送出途中若使用者又修改了（rev 改變），不刪除也不覆寫那筆，而是以剛送出的版本為新基準。
   */
  private async flushUpdate(p: PendingUpdate, report: SyncReport): Promise<boolean> {
    const temporary = (s: number) => s === 408 || s === 423 || s === 429 || s >= 500;
    const latest = async () => (await this.cache.getPending(p.uid)) as PendingUpdate | undefined;
    const unchanged = (cur: PendingUpdate | undefined): cur is PendingUpdate => !!cur && (cur.rev ?? 0) === (p.rev ?? 0);
    const succeed = async (ics: string, etag: string | undefined) => {
      const cur = await latest();
      if (cur && (cur.rev ?? 0) !== (p.rev ?? 0)) {
        // 送出途中又被修改：保留新的修改，基準改成剛送出的版本；快取裡的樂觀版本已包含新修改，不覆寫
        await this.cache.updatePending({ ...cur, baseIcs: ics, baseEtag: etag ?? "", state: "queued", conflict: undefined, lastError: undefined });
      } else {
        const parsed = await parseResource(ics, { href: p.href, etag: etag ?? "", collection: p.collection });
        if (!("skip" in parsed)) await this.cache.upsertObjects([parsed]);
        await this.cache.removePending(p.uid);
      }
      report.sent++;
      return true;
    };
    const mark = async (fields: Partial<PendingUpdate>) => {
      const cur = await latest();
      if (unchanged(cur)) await this.cache.updatePending({ ...cur, ...fields });
    };
    const fail = async (lastError: string) => { await mark({ state: "failed", attempts: p.attempts + 1, lastError }); return true; };
    const retryLater = async (msg: string, e?: unknown) => {
      const cur = await latest();
      if (cur) await this.cache.updatePending({ ...cur, attempts: cur.attempts + 1, lastError: msg });
      report.errors.push(e ? toError(e, p.collection) : { collection: p.collection, message: msg });
      return false;
    };
    const patched = (ics: string): string | Error => {
      try { return applyPatch(ics, p.patch, new Date(this.now())); } catch (e) { return e instanceof Error ? e : new Error(String(e)); }
    };
    const FIELD = { summary: "summary", done: "status", date: "date", status: "status", end: "end" } as const;
    try {
      let baseIcs = p.baseIcs;
      if (p.baseEtag) {
        const ics = patched(baseIcs);
        if (ics instanceof Error) return fail(ics.message);
        const res = await this.client.put(p.href, ics, { ifMatch: p.baseEtag });
        if (res.status >= 200 && res.status < 300) return succeed(ics, res.etag);
        if (res.status === 404) return fail("伺服器上已刪除");
        if (temporary(res.status)) return retryLater(`修改暫時失敗（HTTP ${res.status}）`);
        if (res.status !== 412) return fail(`HTTP ${res.status}`);
      }
      // 412，或沒有 etag：取得伺服器目前的版本
      const cur = await this.client.get(p.href);
      if (cur.status === 404) return fail("伺服器上已刪除");
      if (temporary(cur.status)) return retryLater(`取得伺服器版本暫時失敗（HTTP ${cur.status}）`);
      if (cur.status !== 200 || !cur.etag) return fail(`取得伺服器版本失敗（HTTP ${cur.status}）`);
      if (!p.baseEtag) baseIcs = cur.ics; // 沒有 etag 時，以伺服器版本為基準
      const merged = patched(cur.ics); // 伺服器版本若已變成重複項目，這裡會被 §4.3 擋下
      if (merged instanceof Error) return fail(merged.message);
      const mineIcs = patched(baseIcs);
      if (mineIcs instanceof Error) return fail(mineIcs.message);
      const base = managedValues(baseIcs), server = managedValues(cur.ics), mine = managedValues(mineIcs);
      const fields = (Object.keys(p.patch) as (keyof typeof FIELD)[]).map((k) => FIELD[k]);
      if (fields.some((f) => server[f] !== base[f] && server[f] !== mine[f])) {
        await mark({ state: "conflict", lastError: "伺服器上同一欄位也被修改", conflict: { serverIcs: cur.ics, serverEtag: cur.etag, base, mine, server } });
        return true;
      }
      if (fields.every((f) => server[f] === mine[f])) return succeed(cur.ics, cur.etag);
      const res = await this.client.put(p.href, merged, { ifMatch: cur.etag });
      if (res.status >= 200 && res.status < 300) return succeed(merged, res.etag);
      if (res.status === 404) return fail("伺服器上已刪除");
      if (res.status === 412 || temporary(res.status)) return retryLater(`修改暫時失敗（HTTP ${res.status}）`);
      return fail(`HTTP ${res.status}`);
    } catch (e) {
      return retryLater(toError(e).message, e);
    }
  }

  private async syncOne(col: CollectionInfo, report: SyncReport): Promise<void> {
    let result: SyncResult;
    let full = col.syncToken === undefined;
    try {
      result = await this.client.syncCollection(col.href, col.syncToken ?? null);
    } catch (e) {
      if (!(e instanceof TokenExpiredError)) throw e;
      full = true;
      result = await this.client.syncCollection(col.href, null);
    }

    const upserts: CalObject[] = [];
    const toRemove = new Set(result.removed);
    for (const ch of result.changed) {
      const parsed = await parseResource(ch.ics, { href: ch.href, etag: ch.etag, collection: col.href });
      if ("skip" in parsed) {
        // 伺服器上仍存在，不寫刪除紀錄；快取裡有舊版就保留舊版
        report.skipped++;
        report.skippedItems.push({ href: ch.href, reason: parsed.skip });
        console.warn(`[obsidian-caldav] 略過 ${ch.href}：${parsed.skip}`);
      } else {
        upserts.push(parsed);
      }
    }
    if (full) {
      const seen = new Set(result.changed.map((c) => c.href));
      for (const href of await this.cache.hrefsInCollection(col.href)) if (!seen.has(href)) toRemove.add(href);
    }

    await this.cache.upsertObjects(upserts);
    report.changed += upserts.length;
    // deletedAt 用本輪開始時間：同輪較早同步的集合不會被誤認為「刪除之後還沒同步」
    report.removed += await this.cache.removeObjects([...toRemove], report.startedAt);
    // 寫入成功後才前進 token；失敗時下次會重新拿到同樣的變更
    await this.cache.putCollection({ ...col, syncToken: result.token, lastSyncAt: this.now() });
  }
}
