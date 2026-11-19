import type { CacheStore } from "../cache/db";
import { type CalDavClient, type SyncResult, TokenExpiredError } from "../caldav/client";
import { parseResource } from "../ical/parse";
import { applyPatch, managedValues } from "../ical/patch";
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
    const report: SyncReport = { startedAt: this.now(), finishedAt: 0, collections: 0, objects: 0, changed: 0, removed: 0, skipped: 0, skippedItems: [], sent: 0, pendingQueued: 0, pendingFailed: 0, errors: [] };
    try {
      const { home } = await this.client.discover();
      await this.flushPending(report);
      const server = await this.client.listCollections(home);
      const cached = new Map((await this.cache.getCollections()).map((c) => [c.href, c]));
      report.collections = server.length;

      for (const gone of [...cached.keys()].filter((h) => !server.some((s) => s.href === h))) {
        report.removed += await this.cache.removeObjects(await this.cache.hrefsInCollection(gone), this.now());
        await this.cache.deleteCollection(gone);
      }

      for (const col of server) {
        try {
          await this.syncOne({ ...col, syncToken: cached.get(col.href)?.syncToken, lastSyncAt: cached.get(col.href)?.lastSyncAt }, report);
        } catch (e) {
          report.errors.push(toError(e, col.href));
        }
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

  private async succeed(p: PendingUpdate, ics: string, etag: string | undefined, report: SyncReport): Promise<void> {
    const parsed = await parseResource(ics, { href: p.href, etag: etag ?? "", collection: p.collection });
    if (!("skip" in parsed)) await this.cache.upsertObjects([parsed]);
    await this.cache.removePending(p.uid);
    report.sent++;
  }

  /**
   * 送出一筆修改。回傳 false 表示遇到暫時性錯誤，應停止本輪 flush。
   * 412：重新取得伺服器版本；修改涉及的欄位伺服器都沒動過（或剛好和我的一樣）就合併重送，否則標為衝突。
   */
  private async flushUpdate(p: PendingUpdate, report: SyncReport): Promise<boolean> {
    const temporary = (s: number) => s === 408 || s === 423 || s === 429 || s >= 500;
    const fail = async (lastError: string) => this.cache.updatePending({ ...p, state: "failed", attempts: p.attempts + 1, lastError });
    const retryLater = async (msg: string, e?: unknown) => {
      await this.cache.updatePending({ ...p, attempts: p.attempts + 1, lastError: msg });
      report.errors.push(e ? toError(e, p.collection) : { collection: p.collection, message: msg });
      return false;
    };
    try {
      let baseIcs = p.baseIcs, etag = p.baseEtag;
      let res: { status: number; etag?: string };
      if (etag) {
        const ics = applyPatch(baseIcs, p.patch, new Date(this.now()));
        res = await this.client.put(p.href, ics, { ifMatch: etag });
        if (res.status >= 200 && res.status < 300) { await this.succeed(p, ics, res.etag, report); return true; }
        if (res.status === 404) { await fail("伺服器上已刪除"); return true; }
        if (temporary(res.status)) return retryLater(`修改暫時失敗（HTTP ${res.status}）`);
        if (res.status !== 412) { await fail(`HTTP ${res.status}`); return true; }
      }
      // 412，或沒有 etag：取得伺服器目前的版本
      const cur = await this.client.get(p.href);
      if (cur.status === 404) { await fail("伺服器上已刪除"); return true; }
      if (temporary(cur.status)) return retryLater(`取得伺服器版本暫時失敗（HTTP ${cur.status}）`);
      if (cur.status !== 200 || !cur.etag) { await fail(`取得伺服器版本失敗（HTTP ${cur.status}）`); return true; }
      if (!etag) baseIcs = cur.ics; // 沒有 etag 時，以伺服器版本為基準
      const base = managedValues(baseIcs), server = managedValues(cur.ics);
      const mine = managedValues(applyPatch(baseIcs, p.patch, new Date(this.now())));
      const fields = (Object.keys(p.patch) as (keyof typeof p.patch)[]).map((k) => (k === "date" ? "date" : k) as "summary" | "done" | "date");
      const conflicting = fields.filter((f) => server[f] !== base[f] && server[f] !== mine[f]);
      if (conflicting.length) {
        await this.cache.updatePending({ ...p, state: "conflict", lastError: "伺服器上同一欄位也被修改", conflict: { serverIcs: cur.ics, serverEtag: cur.etag, base, mine, server } });
        return true;
      }
      if (fields.every((f) => server[f] === mine[f])) { await this.succeed(p, cur.ics, cur.etag, report); return true; }
      const merged = applyPatch(cur.ics, p.patch, new Date(this.now()));
      res = await this.client.put(p.href, merged, { ifMatch: cur.etag });
      if (res.status >= 200 && res.status < 300) { await this.succeed(p, merged, res.etag, report); return true; }
      if (res.status === 404) { await fail("伺服器上已刪除"); return true; }
      if (res.status === 412 || temporary(res.status)) return retryLater(`修改暫時失敗（HTTP ${res.status}）`);
      await fail(`HTTP ${res.status}`);
      return true;
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
    report.removed += await this.cache.removeObjects([...toRemove], this.now());
    // 寫入成功後才前進 token；失敗時下次會重新拿到同樣的變更
    await this.cache.putCollection({ ...col, syncToken: result.token, lastSyncAt: this.now() });
  }
}
