import { type App, type EventRef, Modal, Notice, parseYaml, Setting, TFile } from "obsidian";
import { splitFrontmatter } from "../projection/frontmatter";
import { PROJ_DIR } from "../projection/types";
import { writeFm } from "./actions";
import { type ConflictMap, conflictWrites, isLocal, isLocalDelete, OwnOps, type StorageAccessManager, systemKeysChanged } from "./guardLogic";

const inDir = (p: string) => p.startsWith(`${PROJ_DIR}/`) && p.endsWith(".md") && p.slice(PROJ_DIR.length + 1).indexOf("/") < 0;

export class ConflictModal extends Modal {
  constructor(app: App, private path: string, private c: ConflictMap) { super(app); }
  onOpen(): void {
    this.titleEl.setText("CalDAV：這個任務有衝突");
    this.contentEl.createEl("p", { text: "你在 Obsidian 的修改和其他地方（例如提醒事項）的修改不一致。目前檔案顯示的是伺服器的值。" });
    for (const [k, v] of Object.entries(this.c)) new Setting(this.contentEl).setName(k).setDesc(`你的：${v.mine ?? "（空）"}　伺服器：${v.theirs ?? "（空）"}`);
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText("用伺服器的").onClick(async () => { const w = conflictWrites(this.c, "server"); await writeFm(this.app, this.path, w.set, w.unset); this.close(); }))
      .addButton((b) => b.setButtonText("用我的").setCta().onClick(async () => { const w = conflictWrites(this.c, "mine"); await writeFm(this.app, this.path, w.set, w.unset); this.close(); }));
  }
  onClose(): void { this.contentEl.empty(); }
}

/** 裝置端守門（設計 §8.6、§8.8；S9）：本機誤刪／改名立即還原；`_sync` 變化以通知回饋；衝突對話框。 */
export class ClientGuard {
  private content = new Map<string, string>();
  private fms = new Map<string, Record<string, unknown>>();
  private own = new OwnOps();

  constructor(private app: App) {}

  private sam(): StorageAccessManager | undefined {
    const core = (this.app as App & { plugins?: { plugins?: Record<string, { core?: { _serviceModules?: { storageAccess?: { vaultAccess?: { storageAccessManager?: StorageAccessManager } } } } }> } })
      .plugins?.plugins?.["obsidian-livesync"]?.core;
    return core?._serviceModules?.storageAccess?.vaultAccess?.storageAccessManager;
  }

  start(register: (r: EventRef) => void): void {
    register(this.app.metadataCache.on("changed", (f, data) => { if (inDir(f.path)) this.onChanged(f, data); }));
    register(this.app.vault.on("delete", (f) => { if (f instanceof TFile && inDir(f.path)) void this.onDelete(f); }));
    register(this.app.vault.on("rename", (f, old) => { if (f instanceof TFile && inDir(old)) void this.onRename(f, old); }));
    void this.preload();
  }

  private async preload(): Promise<void> {
    const files = this.app.vault.getMarkdownFiles().filter((f) => inDir(f.path));
    for (let i = 0; i < files.length; i++) {
      const text = await this.app.vault.cachedRead(files[i]);
      this.content.set(files[i].path, text);
      const fm = splitFrontmatter(text, parseYaml).fm;
      if (fm) this.fms.set(files[i].path, fm);
      if (i % 50 === 49) await new Promise((r) => window.setTimeout(r, 0));
    }
  }

  private onChanged(f: TFile, data: string): void {
    const prev = this.fms.get(f.path);
    const fm = splitFrontmatter(data, parseYaml).fm;
    this.content.set(f.path, data);
    if (!fm) return;
    this.fms.set(f.path, fm);
    if (!prev) return;
    if (fm._sync === "rejected" && (prev._sync !== "rejected" || prev._sync_msg !== fm._sync_msg))
      new Notice(`CalDAV：「${fm.title ?? f.basename}」的修改沒有被接受：${fm._sync_msg ?? ""}`, 8000);
    if (fm._sync === "conflict" && prev._sync !== "conflict" && fm._conflict) {
      const n = new Notice(`CalDAV：「${fm.title ?? f.basename}」有衝突，點這裡處理`, 0);
      n.noticeEl.addEventListener("click", () => { n.hide(); new ConflictModal(this.app, f.path, fm._conflict as ConflictMap).open(); });
    }
    const local = isLocal(this.sam(), { path: f.path, stat: f.stat });
    if (local === true && systemKeysChanged(prev, fm).length) new Notice("CalDAV：「_」開頭的欄位由系統管理，會被還原", 5000);
  }

  private async onDelete(f: TFile): Promise<void> {
    if (this.own.has(f.path)) return;
    if (isLocalDelete(this.sam(), f.path) !== true) return; // LiveSync 帶來的（例如伺服器搬移）不還原
    const text = this.content.get(f.path);
    if (text === undefined) return;
    this.own.mark(f.path);
    await this.app.vault.create(f.path, text);
    new Notice("CalDAV：投影檔由系統管理，已還原。要刪除任務請用 chip 選單的「刪除任務」", 8000);
  }

  private async onRename(f: TFile, old: string): Promise<void> {
    if (!this.sam()) return; // 拿不到 LiveSync 內部 API 時不做本機還原（Global Constraints）；改名事件本身只來自本機（S9）
    if (this.own.has(old) || this.own.has(f.path)) return;
    if (this.app.vault.getAbstractFileByPath(old)) return;
    this.own.mark(old); this.own.mark(f.path);
    await this.app.fileManager.renameFile(f, old);
    // 改名保留 mtime 與 size，LiveSync 會當成自己剛寫的檔而不上傳（S9）；重寫一次讓 mtime 改變（M6-3 review I4）
    const back = this.app.vault.getAbstractFileByPath(old);
    if (back instanceof TFile) await this.app.vault.modify(back, await this.app.vault.read(back));
    new Notice("CalDAV：投影檔的名稱與位置由系統管理，已改回", 6000);
  }
}
