import type { CacheStore } from "../cache/db";
import { type CalDavClient, type SyncResult, TokenExpiredError } from "../caldav/client";
import { parseResource } from "../ical/parse";
import type { CalObject, CollectionInfo, SyncReport } from "../types";

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
      let res: { status: number; etag?: string };
      try {
        res = await this.client.put(p.href, p.ics, { ifNoneMatch: true });
      } catch (e) {
        await this.cache.updatePending({ ...p, attempts: p.attempts + 1, lastError: toError(e).message });
        report.errors.push(toError(e, p.collection));
        return;
      }
      if (res.status === 201 || res.status === 204 || res.status === 412) {
        // 412：UID 是本機隨機產生的，只可能是上次已送出但沒收到回應
        if (res.status !== 412) {
          const parsed = await parseResource(p.ics, { href: p.href, etag: res.etag ?? "", collection: p.collection });
          if (!("skip" in parsed)) await this.cache.upsertObjects([parsed]);
        }
        await this.cache.removePending(p.uid);
        report.sent++;
      } else if (res.status >= 400 && res.status < 500) {
        await this.cache.updatePending({ ...p, state: "failed", attempts: p.attempts + 1, lastError: `HTTP ${res.status}` });
      } else {
        await this.cache.updatePending({ ...p, attempts: p.attempts + 1, lastError: `HTTP ${res.status}` });
        report.errors.push({ collection: p.collection, message: `送出新任務失敗（HTTP ${res.status}）` });
        return;
      }
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
