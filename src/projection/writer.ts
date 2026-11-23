import { type App, Notice, parseYaml, TFile } from "obsidian";
import type { CacheStore } from "../cache/db";
import { projectFields } from "./fields";
import { planReconcile, type ProjAction, type ProjFile } from "./plan";
import { PROJ_DIR, type ProjFm } from "./types";

export interface ReconcileStats { created: number; updated: number; renamed: number; merged: number; skipped: number }

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n?---(?:\r?\n|$)/;

/** 讀檔自己解析 frontmatter，不依賴 metadataCache（剛建立或剛改寫的檔案，metadataCache 可能還沒更新）。 */
export function splitFrontmatter(text: string): { fm: Record<string, unknown> | null; body: string } {
  const m = FM_RE.exec(text);
  if (!m) return { fm: null, body: text };
  let fm: unknown = null;
  try { fm = m[1].trim() ? parseYaml(m[1]) : {}; } catch { fm = null; }
  return { fm: fm && typeof fm === "object" && !Array.isArray(fm) ? (fm as Record<string, unknown>) : null, body: text.slice(m[0].length) };
}

/** 伺服器模式：把快取投影到 `_caldav/`（設計 §7.1）。同一時間只跑一輪；進行中又被呼叫，結束後再跑一輪。 */
export class ProjectionWriter {
  private running?: Promise<ReconcileStats>;
  private again = false;

  constructor(private app: App, private getCache: () => Promise<CacheStore | undefined>, private whitelist: () => string[]) {}

  static setPropertyTypes(app: App): void {
    const m = (app as App & { metadataTypeManager?: { setType(k: string, t: string): void } }).metadataTypeManager;
    if (!m) return;
    for (const k of ["due", "start", "end"]) m.setType(k, "date");
    for (const k of ["due_time", "start_time", "end_time", "list", "status"]) m.setType(k, "text");
  }

  reconcile(): Promise<ReconcileStats> {
    if (this.running) { this.again = true; return this.running; }
    this.running = this.loop().finally(() => { this.running = undefined; });
    return this.running;
  }

  private async loop(): Promise<ReconcileStats> {
    let s: ReconcileStats;
    do { this.again = false; s = await this.once(); } while (this.again);
    return s;
  }

  private async readFiles(): Promise<ProjFile[]> {
    const files = this.app.vault.getMarkdownFiles().filter((f) => f.parent?.path === PROJ_DIR);
    return Promise.all(files.map(async (f) => {
      const { fm, body } = splitFrontmatter(await this.app.vault.read(f));
      return { path: f.path, fm, bodyEmpty: body.trim() === "" };
    }));
  }

  private async once(): Promise<ReconcileStats> {
    const stats: ReconcileStats = { created: 0, updated: 0, renamed: 0, merged: 0, skipped: 0 };
    const cache = await this.getCache();
    if (!cache) return stats;
    const vault = this.app.vault;
    if (!vault.getAbstractFileByPath(PROJ_DIR)) await vault.createFolder(PROJ_DIR);

    const objects = await cache.allObjects();
    const projected = new Map<string, ProjFm>();
    for (const o of objects) if (!projected.has(o.uid)) projected.set(o.uid, await projectFields(o));
    const actions = planReconcile({
      objects, projected,
      tombstones: await cache.allTombstones(), aliases: await cache.allAliases(), collections: await cache.getCollections(),
      whitelist: this.whitelist(), files: await this.readFiles(), now: Date.now(),
    });

    const canRename = (vault as typeof vault & { getConfig(k: string): unknown }).getConfig("alwaysUpdateLinks") === true;
    let warned = false;
    for (const a of actions) {
      try {
        await this.apply(a, canRename, stats);
      } catch (e) {
        console.warn("[obsidian-caldav] 投影動作失敗", a, e);
      }
      if (!canRename && (a.op === "rename" || a.op === "merge-into") && !warned) {
        warned = true;
        new Notice("CalDAV 投影：「自動更新內部連結」未開啟，已跳過搬移的改名", 10_000);
      }
    }
    return stats;
  }

  private file(path: string): TFile {
    const f = this.app.vault.getAbstractFileByPath(path);
    if (!(f instanceof TFile)) throw new Error(`找不到 ${path}`);
    return f;
  }

  private async apply(a: ProjAction, canRename: boolean, stats: ReconcileStats): Promise<void> {
    const fmApi = this.app.fileManager;
    switch (a.op) {
      case "create": {
        const f = await this.app.vault.create(a.path, "");
        await fmApi.processFrontMatter(f, (fm) => { Object.assign(fm, a.fm); });
        stats.created++;
        return;
      }
      case "update":
        await fmApi.processFrontMatter(this.file(a.path), (fm) => {
          Object.assign(fm, a.set);
          for (const k of a.unset) delete fm[k];
        });
        stats.updated++;
        return;
      case "rename":
        if (!canRename) { stats.skipped++; return; }
        await fmApi.renameFile(this.file(a.from), a.to);
        stats.renamed++;
        return;
      case "merge-into": {
        if (!canRename) { stats.skipped++; return; }
        const drop = this.file(a.drop);
        const { body } = splitFrontmatter(await this.app.vault.read(drop));
        if (body.trim()) await this.app.vault.process(this.file(a.keep), (t) => `${t.replace(/\s*$/, "")}\n\n${body.trim()}\n`);
        await fmApi.trashFile(drop);
        stats.merged++;
        return;
      }
    }
  }
}
