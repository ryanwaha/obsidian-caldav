import { type App, type EventRef, Notice, parseYaml, stringifyYaml, TFile } from "obsidian";
import type { CacheStore } from "../cache/db";
import { mergeConflictVersions } from "./conflicts";
import { chooseRestore, pathFromDocId, RecentPaths, serverRestoreDecision } from "./snapshot";
import { newFileContent, splitFrontmatter } from "./frontmatter";
import { PROJ_DIR } from "./types";
import type { ProjectionWriter } from "./writer";

type ChangesFeed = { on(ev: "change", cb: (c: { id: string }) => void): ChangesFeed; cancel(): void };
type LiveSyncCore = {
  localDatabase?: { getDBEntry?: (...a: unknown[]) => Promise<unknown>; localDatabase?: { changes?: (o: object) => ChangesFeed } };
  databaseFileAccess?: { storeContent?: (path: string, content: string) => Promise<boolean> };
  services?: { conflict?: { resolveByDeletingRevision?: (path: string, rev: string, title: string) => Promise<unknown> } };
};
type DbEntry = { data: string | string[]; _conflicts?: string[] };

import { SERVER_GRACE_MS as GRACE_MS } from "./plan";
const inDir = (p: string) => p.startsWith(`${PROJ_DIR}/`) && p.endsWith(".md") && p.slice(PROJ_DIR.length + 1).indexOf("/") < 0;

/** 伺服器模式：投影檔被刪除／改名時還原（§8.6 兜底），LiveSync 衝突以程式解決（§8.7，S7）。 */
export class ProjectionGuard {
  private warned = false;
  private recent = new RecentPaths();
  private sweepCounter = 0;
  private feed?: ChangesFeed;

  /** 訂閱 LiveSync 本機資料庫的變更：遠端帶來的衝突不一定會寫檔，只看寫檔事件會漏（e2e 步驟 9） */
  private follow(core: LiveSyncCore): void {
    if (this.feed) return;
    const changes = core.localDatabase?.localDatabase?.changes;
    if (typeof changes !== "function") return;
    this.feed = changes.call(core.localDatabase!.localDatabase, { since: "now", live: true, style: "all_docs" })
      .on("change", (c) => { const p = pathFromDocId(c.id); if (p) this.recent.add(p); });
  }
  stop(): void { this.feed?.cancel(); this.feed = undefined; }
  constructor(private app: App, private getCache: () => Promise<CacheStore | undefined>, private writer: ProjectionWriter) {}

  start(register: (r: EventRef) => void): void {
    register(this.app.vault.on("modify", (f) => { if (f instanceof TFile && inDir(f.path)) this.recent.add(f.path); }));
    register(this.app.vault.on("create", (f) => { if (f instanceof TFile && inDir(f.path)) this.recent.add(f.path); }));
    register(this.app.vault.on("delete", (f) => { if (f instanceof TFile && inDir(f.path)) void this.restoreDeleted(f.path); }));
    register(this.app.vault.on("rename", (f, old) => { if (f instanceof TFile && inDir(old)) void this.undoRename(f, old); }));
  }

  private async restoreDeleted(path: string): Promise<void> {
    if (this.writer.isOwn(path)) return;
    const cache = await this.getCache();
    const snap = await cache?.getProjection(path);
    if (!snap) { console.warn("[obsidian-caldav] 投影檔被刪除，但沒有快照可還原", path); return; }
    await new Promise((r) => window.setTimeout(r, GRACE_MS)); // 等裝置自己的改回、以及遠端改名「刪除＋建立」的另一半
    if (!serverRestoreDecision({ existsNow: !!this.app.vault.getAbstractFileByPath(path), db: await this.dbState(path) })) return;
    const snaps = new Set((await cache!.allProjections()).map((s) => s.path));
    const others: { path: string; uid: string; hasSnap: boolean }[] = [];
    for (const f of this.app.vault.getMarkdownFiles()) {
      if (!inDir(f.path) || f.path === path) continue;
      const uid = splitFrontmatter(await this.app.vault.cachedRead(f), parseYaml).fm?._uid;
      if (uid === snap.uid) others.push({ path: f.path, uid, hasSnap: snaps.has(f.path) });
    }
    const c = chooseRestore(snap.uid, others);
    if (c.kind === "skip") return;
    this.writer.markOwn(path);
    if (c.kind === "rename-back") {
      const from = this.app.vault.getAbstractFileByPath(c.from);
      if (from instanceof TFile) {
        this.writer.markOwn(c.from);
        await this.app.fileManager.renameFile(from, path);
        // 改名保留 mtime 與 size，LiveSync 會以「路徑＋mtime＋size」把它當成自己剛寫的檔而不上傳（S9）；重寫一次讓 mtime 改變
        const back = this.app.vault.getAbstractFileByPath(path);
        if (back instanceof TFile) await this.app.vault.modify(back, await this.app.vault.read(back));
      }
      console.info("[obsidian-caldav] 投影檔被改名，已改回", c.from, "→", path);
      return;
    }
    await this.app.vault.create(path, newFileContent(snap.fm, (o) => stringifyYaml(o)) + snap.body);
    console.info("[obsidian-caldav] 已還原被刪除的投影檔", path);
  }

  /** LiveSync 資料庫中這份文件目前是否為刪除狀態 */
  private async dbState(path: string): Promise<"deleted" | "live" | "unknown"> {
    try {
      const core = (this.app as App & { plugins?: { plugins?: Record<string, { core?: LiveSyncCore }> } }).plugins?.plugins?.["obsidian-livesync"]?.core;
      const get = core?.localDatabase?.getDBEntry;
      if (typeof get !== "function") return "unknown";
      const doc = (await get.call(core!.localDatabase, path, undefined, false, true, true)) as (DbEntry & { deleted?: boolean; _deleted?: boolean }) | false;
      if (!doc) return "deleted";
      return doc.deleted || doc._deleted ? "deleted" : "live";
    } catch {
      return "unknown";
    }
  }

  private async undoRename(f: TFile, old: string): Promise<void> {
    if (this.writer.isOwn(old) || this.writer.isOwn(f.path)) return;
    if (this.app.vault.getAbstractFileByPath(old)) return;
    this.writer.markOwn(old); this.writer.markOwn(f.path);
    await this.app.fileManager.renameFile(f, old);
    console.info("[obsidian-caldav] 已改回投影檔名稱", f.path, "→", old);
  }

  private core(): LiveSyncCore | undefined {
    const core = (this.app as App & { plugins?: { plugins?: Record<string, { core?: LiveSyncCore }> } }).plugins?.plugins?.["obsidian-livesync"]?.core;
    if (!core) return undefined;
    const ok = typeof core.localDatabase?.getDBEntry === "function" && typeof core.databaseFileAccess?.storeContent === "function"
      && typeof core.services?.conflict?.resolveByDeletingRevision === "function";
    if (!ok) {
      if (!this.warned) { this.warned = true; new Notice("CalDAV 投影：LiveSync 版本不支援自動解衝突，衝突需手動處理", 10_000); }
      return undefined;
    }
    return core;
  }

  /** 掃描 `caldav/` 的 LiveSync 衝突並解決。回傳解決的數量。 */
  async resolveConflicts(paths?: string[]): Promise<number> {
    const core = this.core();
    const cache = await this.getCache();
    if (!core || !cache) return 0;
    this.follow(core);
    // 平常只看最近被寫入的檔（review I6）；每 12 輪做一次全掃，補抓沒有寫檔事件的衝突
    const full = ++this.sweepCounter % 12 === 1;
    const list = paths ?? (full ? this.app.vault.getMarkdownFiles().map((f) => f.path).filter(inDir) : this.recent.drain());
    const text = (d: DbEntry) => (Array.isArray(d.data) ? d.data.join("") : d.data);
    let n = 0;
    for (const path of list) {
      try {
        const doc = (await core.localDatabase!.getDBEntry!(path, { conflicts: true }, false, true, true)) as DbEntry | false;
        const rev = doc && doc._conflicts?.[0];
        if (!doc || !rev) continue;
        const other = (await core.localDatabase!.getDBEntry!(path, { rev }, false, true, true)) as DbEntry | false;
        const snap = await cache.getProjection(path);
        if (!other || !snap) continue;
        const a = splitFrontmatter(text(doc), parseYaml), b = splitFrontmatter(text(other), parseYaml);
        const merged = mergeConflictVersions(snap.fm, a, b);
        const content = newFileContent(merged.fm, (o) => stringifyYaml(o)) + merged.body;
        if (!(await core.databaseFileAccess!.storeContent!(path, content))) continue;
        await cache.putProjection({ ...snap, fm: merged.fm, body: merged.body, writtenAt: Date.now() });
        await core.services!.conflict!.resolveByDeletingRevision!(path, rev, "obsidian-caldav");
        n++;
      } catch (e) {
        console.warn("[obsidian-caldav] 解衝突失敗", path, e);
      }
    }
    return n;
  }
}
