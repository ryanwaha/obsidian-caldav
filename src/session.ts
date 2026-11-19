import type { CacheStore } from "./cache/db";
import type { SyncEngine } from "./sync/engine";
import type { SyncReport } from "./types";

export interface Config { serverUrl: string; username: string; password: string }
export interface Session { engine: SyncEngine; cache: CacheStore }
/** fingerprint 決定快取歸屬；換了就清空重建。 */
export type SessionFactory = (cfg: Config, fingerprint: string) => Promise<Session>;

export const normalizeServerUrl = (u: string) => u.trim().replace(/\/+$/, "");

/** 這些錯誤代表 IndexedDB 連線已不可用（例如 iOS 背景後連線遺失），下次要重開。 */
const DB_BROKEN = new Set(["InvalidStateError", "UnknownError", "TransactionInactiveError", "AbortError", "QuotaExceededError"]);

/**
 * 管理「目前設定對應的快取與同步引擎」。
 * - 建立過程與同步都是 single-flight，避免同時開出兩份快取。
 * - 任何例外都轉成帶錯誤的 report，不往外拋。
 */
export class SessionManager {
  private current?: { key: string; session: Promise<Session> };
  private inflight?: Promise<SyncReport | undefined>;

  constructor(private factory: SessionFactory) {}

  private static key(cfg: Config) {
    const fingerprint = `${normalizeServerUrl(cfg.serverUrl)}|${cfg.username.trim()}`;
    return { fingerprint, key: `${fingerprint}|${cfg.password}` };
  }

  /** 設定不完整時傳 undefined：關閉既有 session。 */
  async get(cfg: Config | undefined): Promise<Session | undefined> {
    if (!cfg || !cfg.serverUrl.trim() || !cfg.username.trim() || !cfg.password) { this.reset(); return undefined; }
    const { key, fingerprint } = SessionManager.key(cfg);
    if (this.current?.key !== key) {
      this.reset();
      const normalized = { ...cfg, serverUrl: normalizeServerUrl(cfg.serverUrl), username: cfg.username.trim() };
      const session = this.factory(normalized, fingerprint);
      this.current = { key, session };
      session.catch(() => { if (this.current?.session === session) this.current = undefined; });
    }
    return this.current.session;
  }

  private rerun?: Config;

  /** 進行中又被要求同步時，結束後用最新設定再跑一輪（例如送出途中使用者又修改了）。 */
  sync(cfg: Config | undefined): Promise<SyncReport | undefined> {
    if (this.inflight) {
      if (cfg) this.rerun = cfg;
      return this.inflight;
    }
    this.inflight = this.runSync(cfg).finally(() => {
      this.inflight = undefined;
      const again = this.rerun;
      this.rerun = undefined;
      if (again) void this.sync(again);
    });
    return this.inflight;
  }

  private async runSync(cfg: Config | undefined): Promise<SyncReport | undefined> {
    const now = Date.now();
    let session: Session | undefined;
    try {
      session = await this.get(cfg);
    } catch (e) {
      return { startedAt: now, finishedAt: Date.now(), collections: 0, objects: 0, changed: 0, removed: 0, skipped: 0, skippedItems: [], sent: 0, pendingQueued: 0, pendingFailed: 0,
        errors: [{ message: `無法開啟本機快取：${e instanceof Error ? e.message : String(e)}`, name: e instanceof Error ? e.name : undefined }] };
    }
    if (!session) return undefined;
    const report = await session.engine.syncAll();
    if (report.errors.some((e) => e.name && DB_BROKEN.has(e.name))) this.reset();
    return report;
  }

  reset(): void {
    const old = this.current;
    this.current = undefined;
    old?.session.then((s) => s.cache.close(), () => {});
  }
}
