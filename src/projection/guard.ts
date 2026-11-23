import { type App, type EventRef, Notice, parseYaml, stringifyYaml, TFile } from "obsidian";
import type { CacheStore } from "../cache/db";
import { mergeConflictVersions } from "./conflicts";
import { newFileContent, splitFrontmatter } from "./frontmatter";
import { PROJ_DIR } from "./types";
import type { ProjectionWriter } from "./writer";

type LiveSyncCore = {
  localDatabase?: { getDBEntry?: (...a: unknown[]) => Promise<unknown> };
  databaseFileAccess?: { storeContent?: (path: string, content: string) => Promise<boolean> };
  services?: { conflict?: { resolveByDeletingRevision?: (path: string, rev: string, title: string) => Promise<unknown> } };
};
type DbEntry = { data: string | string[]; _conflicts?: string[] };

const inDir = (p: string) => p.startsWith(`${PROJ_DIR}/`) && p.endsWith(".md") && p.slice(PROJ_DIR.length + 1).indexOf("/") < 0;

/** 伺服器模式：投影檔被刪除／改名時還原（§8.6 兜底），LiveSync 衝突以程式解決（§8.7，S7）。 */
export class ProjectionGuard {
  private warned = false;
  constructor(private app: App, private getCache: () => Promise<CacheStore | undefined>, private writer: ProjectionWriter) {}

  start(register: (r: EventRef) => void): void {
    register(this.app.vault.on("delete", (f) => { if (f instanceof TFile && inDir(f.path)) void this.restoreDeleted(f.path); }));
    register(this.app.vault.on("rename", (f, old) => { if (f instanceof TFile && inDir(old)) void this.undoRename(f, old); }));
  }

  private async restoreDeleted(path: string): Promise<void> {
    if (this.writer.isOwn(path)) return;
    const cache = await this.getCache();
    const snap = await cache?.getProjection(path);
    if (!snap) { console.warn("[obsidian-caldav] 投影檔被刪除，但沒有快照可還原", path); return; }
    await new Promise((r) => window.setTimeout(r, 500));
    if (this.app.vault.getAbstractFileByPath(path)) return;
    this.writer.markOwn(path);
    await this.app.vault.create(path, newFileContent(snap.fm, (o) => stringifyYaml(o)) + snap.body);
    console.info("[obsidian-caldav] 已還原被刪除的投影檔", path);
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

  /** 掃描 `_caldav/` 的 LiveSync 衝突並解決。回傳解決的數量。 */
  async resolveConflicts(paths?: string[]): Promise<number> {
    const core = this.core();
    const cache = await this.getCache();
    if (!core || !cache) return 0;
    const list = paths ?? this.app.vault.getMarkdownFiles().map((f) => f.path).filter(inDir);
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
        await cache.putProjection({ ...snap, fm: merged.fm, body: merged.body, writtenAt: Date.now() });
        if (!(await core.databaseFileAccess!.storeContent!(path, content))) continue;
        await core.services!.conflict!.resolveByDeletingRevision!(path, rev, "obsidian-caldav");
        n++;
      } catch (e) {
        console.warn("[obsidian-caldav] 解衝突失敗", path, e);
      }
    }
    return n;
  }
}
