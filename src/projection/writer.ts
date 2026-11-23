import { type App, Notice, parseYaml, stringifyYaml, TFile } from "obsidian";
import { newFileContent, splitFrontmatter as split } from "./frontmatter";
import type { CacheStore } from "../cache/db";
import { isUpdate, type PendingUpdate } from "../types";
import { WRITABLE_KEYS } from "./types";
import { projectFields } from "./fields";
import { planReconcile, type ProjAction, type ProjFile } from "./plan";
import { PROJ_DIR, type ProjFm } from "./types";

export interface ReconcileStats { created: number; updated: number; renamed: number; merged: number; skipped: number }

/** 讀檔自己解析 frontmatter，不依賴 metadataCache（剛建立或剛改寫的檔案，metadataCache 可能還沒更新）。 */
const splitFrontmatter = (text: string) => split(text, parseYaml);
const norm = (v: unknown) => (v == null || v === "" ? null : typeof v === "object" ? JSON.stringify(v) : String(v));

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

  private lastSyncOk = false;

  /** @param syncOk 觸發這次對帳的同步沒有錯誤 */
  reconcile(syncOk = false): Promise<ReconcileStats> {
    this.lastSyncOk = syncOk;
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
    const collections = await cache.getCollections();
    const wl = this.whitelist();
    const complete = this.lastSyncOk && collections.length > 0 && collections.every((c) => (wl.length && !wl.includes(c.href)) || c.lastSyncAt !== undefined);
    const files = await this.readFiles();
    const pending = new Map<string, PendingUpdate>((await cache.allPending()).filter(isUpdate).filter((p) => p.fingerprint === cache.fingerprint).map((p) => [p.objUid, p]));
    // 檔案上的可寫欄位和快照不同 = 使用者的修改還沒被上行處理（debounce 中）：當成待送，不覆寫（M6-2 review focus 2）
    const dirty = new Set<string>();
    for (const f of files) {
      const uid = f.fm?._uid;
      if (typeof uid !== "string") continue;
      const snap = await cache.getProjection(f.path);
      if (!snap) { await this.snapshot(f.path); continue; } // 第一次看到（例如 M6-1 建立的檔）：以現況為 base
      if (snap && WRITABLE_KEYS.some((k) => norm(f.fm![k]) !== norm(snap.fm[k]))) {
        dirty.add(uid);
        if (!pending.has(uid)) pending.set(uid, { state: "queued" } as PendingUpdate);
      }
    }
    this.dirty = dirty;
    const actions = planReconcile({
      objects, projected,
      tombstones: await cache.allTombstones(), aliases: await cache.allAliases(), collections,
      whitelist: wl, files, now: Date.now(), complete, pending,
      known: new Set((await cache.allProjections()).map((p) => p.path)),
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
    // 失敗的待送已經投影成 _sync: rejected（值回到伺服器的），伺服器模式不再保留
    for (const p of pending.values()) if (p.state === "failed" && p.uid) await cache.removePending(p.uid);
    return stats;
  }

  private file(path: string): TFile {
    const f = this.app.vault.getAbstractFileByPath(path);
    if (!(f instanceof TFile)) throw new Error(`找不到 ${path}`);
    return f;
  }

  private dirty = new Set<string>();
  /** 伺服器自己的刪除／改名（路徑 → 到期時間）：回滾不處理（設計 §8.8） */
  private own = new Map<string, number>();
  markOwn(path: string): void { this.own.set(path, Date.now() + 10_000); }
  isOwn(path: string): boolean { const t = this.own.get(path); return t !== undefined && t > Date.now(); }

  /** 寫出後更新快照（三方比對的 base）。dirty 的檔案保留舊快照的可寫欄位，讓上行仍看得到使用者的修改。 */
  async snapshot(path: string, keepWritable = false): Promise<void> {
    const cache = await this.getCache();
    const f = this.app.vault.getAbstractFileByPath(path);
    if (!cache || !(f instanceof TFile)) return;
    const { fm, body } = splitFrontmatter(await this.app.vault.read(f));
    if (!fm || typeof fm._uid !== "string") return;
    const next: Record<string, unknown> = JSON.parse(JSON.stringify(fm));
    delete next._request;
    if (keepWritable) {
      const old = await cache.getProjection(path);
      if (old) for (const k of WRITABLE_KEYS) { if (k in old.fm) next[k] = old.fm[k]; else delete next[k]; }
    }
    await cache.putProjection({ path, uid: fm._uid, fm: next, body, writtenAt: Date.now() });
  }

  /** 上行執行器用：寫 frontmatter 並更新快照。 */
  async writeFm(path: string, set: Record<string, unknown>, unset: string[]): Promise<void> {
    await this.app.fileManager.processFrontMatter(this.file(path), (fm) => { Object.assign(fm, set); for (const k of unset) delete fm[k]; });
    await this.snapshot(path);
  }

  private async apply(a: ProjAction, canRename: boolean, stats: ReconcileStats): Promise<void> {
    const fmApi = this.app.fileManager;
    const cache = await this.getCache();
    switch (a.op) {
      case "create": {
        await this.app.vault.create(a.path, newFileContent(a.fm, (o) => stringifyYaml(o)));
        await this.snapshot(a.path);
        stats.created++;
        return;
      }
      case "update": {
        await fmApi.processFrontMatter(this.file(a.path), (fm) => {
          Object.assign(fm, a.set);
          for (const k of a.unset) delete fm[k];
        });
        const uid = (await cache?.getProjection(a.path))?.uid;
        await this.snapshot(a.path, uid !== undefined && this.dirty.has(uid));
        stats.updated++;
        return;
      }
      case "rename":
        if (!canRename) { stats.skipped++; return; }
        this.markOwn(a.from); this.markOwn(a.to);
        await fmApi.renameFile(this.file(a.from), a.to);
        await cache?.deleteProjection(a.from);
        await this.snapshot(a.to);
        stats.renamed++;
        return;
      case "merge-into": {
        if (!canRename) { stats.skipped++; return; }
        const drop = this.file(a.drop);
        const { body } = splitFrontmatter(await this.app.vault.read(drop));
        if (body.trim()) await this.app.vault.process(this.file(a.keep), (t) => `${t.replace(/\s*$/, "")}\n\n${body.trim()}\n`);
        this.markOwn(a.drop);
        await fmApi.trashFile(drop);
        await cache?.deleteProjection(a.drop);
        stats.merged++;
        return;
      }
    }
  }
}
