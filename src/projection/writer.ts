import { type App, Notice, parseYaml, stringifyYaml, TFile } from "obsidian";
import { newFileContent, splitFrontmatter as split } from "./frontmatter";
import type { CacheStore } from "../cache/db";
import { isUpdate, type PendingUpdate } from "../types";
import { applySetUnset, dirtyPaths } from "./snapshot";
import { revertFailed } from "./enqueue";
import { projectFields } from "./fields";
import { planReconcile, type ProjAction, type ProjFile } from "./plan";
import { PROJ_DIR, type ProjFm } from "./types";

export interface ReconcileStats { created: number; updated: number; renamed: number; merged: number; skipped: number }

/** 讀檔自己解析 frontmatter，不依賴 metadataCache（剛建立或剛改寫的檔案，metadataCache 可能還沒更新）。 */
const splitFrontmatter = (text: string) => split(text, parseYaml);

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
    // 被伺服器拒收的待送：先把快取還原成送出前的版本，投影才會回到伺服器的值（review I2）
    for (const p of pending.values()) if (p.state === "failed") await revertFailed(cache, p);
    const snaps = new Map((await cache.allProjections()).map((s) => [s.path, s]));
    const known = new Set(snaps.keys()); // 先於首次快照計算（review I4）
    const snappedUids = new Set([...snaps.values()].map((s) => s.uid));
    for (const f of files) {
      const uid = f.fm?._uid;
      if (typeof uid !== "string" || snaps.has(f.path) || snappedUids.has(uid)) continue;
      // 第一次看到、而且這個 uid 在別處沒有快照（例如 M6-1 建立的檔）：以現況為 base
      const s = { path: f.path, uid, fm: applySetUnset(f.fm!, {}, []), body: "", writtenAt: Date.now() };
      await cache.putProjection(s); snaps.set(f.path, s); snappedUids.add(uid);
    }
    // 可寫欄位和快照不同 = 使用者的修改還沒被上行處理：當成待送不覆寫（review focus 2）；沒有真正待送的重新排進上行（review I5）
    const { dirtyUids, orphanPaths } = dirtyPaths(files, new Map([...snaps].map(([k, v]) => [k, v.fm])), new Set(pending.keys()));
    for (const uid of dirtyUids) if (!pending.has(uid)) pending.set(uid, { state: "queued" } as PendingUpdate);
    for (const p of orphanPaths) this.onDirty?.(p);
    const actions = planReconcile({
      objects, projected,
      tombstones: await cache.allTombstones(), aliases: await cache.allAliases(), collections,
      whitelist: wl, files, now: Date.now(), complete, pending, known,
    });
    const uidByPath = new Map(files.map((f) => [f.path, f.fm?._uid]));
    const updatedUids = new Set<string>();

    const canRename = (vault as typeof vault & { getConfig(k: string): unknown }).getConfig("alwaysUpdateLinks") === true;
    let warned = false;
    for (const a of actions) {
      try {
        await this.apply(a, canRename, stats);
        if (a.op === "update") { const u = uidByPath.get(a.path); if (typeof u === "string") updatedUids.add(u); }
      } catch (e) {
        console.warn("[obsidian-caldav] 投影動作失敗", a, e);
      }
      if (!canRename && (a.op === "rename" || a.op === "merge-into") && !warned) {
        warned = true;
        new Notice("CalDAV 投影：「自動更新內部連結」未開啟，已跳過搬移的改名", 10_000);
      }
    }
    // 失敗的待送已經投影成 _sync: rejected（值回到伺服器的），伺服器模式不再保留
    // 只在 rejected 已成功投影到檔案之後才刪（review I2）
    for (const p of pending.values()) if (p.state === "failed" && p.uid && updatedUids.has(p.objUid)) await cache.removePending(p.uid);
    return stats;
  }

  private file(path: string): TFile {
    const f = this.app.vault.getAbstractFileByPath(path);
    if (!(f instanceof TFile)) throw new Error(`找不到 ${path}`);
    return f;
  }

  /** reconcile 發現使用者修改沒有被上行處理時通知（review I5） */
  onDirty?: (path: string) => void;
  /** 伺服器自己的刪除／改名（路徑 → 到期時間）：回滾不處理（設計 §8.8） */
  private own = new Map<string, number>();
  markOwn(path: string): void { this.own.set(path, Date.now() + 10_000); }
  isOwn(path: string): boolean { const t = this.own.get(path); return t !== undefined && t > Date.now(); }

  /** 上行執行器用：只寫 frontmatter；快照由 upstreamCore 推導（review C1） */
  async writeFmOnly(path: string, set: Record<string, unknown>, unset: string[]): Promise<void> {
    await this.app.fileManager.processFrontMatter(this.file(path), (fm) => { Object.assign(fm, set); for (const k of unset) delete fm[k]; });
  }

  private async apply(a: ProjAction, canRename: boolean, stats: ReconcileStats): Promise<void> {
    const fmApi = this.app.fileManager;
    const cache = await this.getCache();
    switch (a.op) {
      case "create": {
        await this.app.vault.create(a.path, newFileContent(a.fm, (o) => stringifyYaml(o)));
        await cache?.putProjection({ path: a.path, uid: a.fm._uid, fm: applySetUnset(a.fm as unknown as Record<string, unknown>, {}, []), body: "", writtenAt: Date.now() });
        stats.created++;
        return;
      }
      case "update": {
        await fmApi.processFrontMatter(this.file(a.path), (fm) => {
          Object.assign(fm, a.set);
          for (const k of a.unset) delete fm[k];
        });
        // 快照 = 舊快照＋伺服器寫的 set/unset；dirty 檔的可寫欄位不在 set 裡，自然保留 base（review C1）
        const old = await cache?.getProjection(a.path);
        if (cache && old) await cache.putProjection({ ...old, fm: applySetUnset(old.fm, a.set as Record<string, unknown>, a.unset), writtenAt: Date.now() });
        stats.updated++;
        return;
      }
      case "rename":
        if (!canRename) { stats.skipped++; return; }
        this.markOwn(a.from); this.markOwn(a.to);
        await fmApi.renameFile(this.file(a.from), a.to);
        const moved = await cache?.getProjection(a.from);
        await cache?.deleteProjection(a.from);
        if (cache && moved) await cache.putProjection({ ...moved, path: a.to, writtenAt: Date.now() });
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
