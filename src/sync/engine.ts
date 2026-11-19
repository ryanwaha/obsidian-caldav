import type { CacheStore } from "../cache/db";
import { type CalDavClient, type SyncResult, TokenExpiredError } from "../caldav/client";
import { parseResource } from "../ical/parse";
import type { CalObject, CollectionInfo, SyncReport } from "../types";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

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
    const report: SyncReport = { startedAt: this.now(), finishedAt: 0, collections: 0, objects: 0, changed: 0, removed: 0, skipped: 0, errors: [] };
    try {
      const { home } = await this.client.discover();
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
          report.errors.push({ collection: col.href, message: message(e) });
        }
      }
    } catch (e) {
      report.errors.push({ message: message(e) });
    }
    report.objects = await this.cache.count();
    report.finishedAt = this.now();
    this.last = report;
    return report;
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
        report.skipped++;
        toRemove.add(ch.href); // 已不是可用的物件；不在快取裡時 removeObjects 會忽略
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
