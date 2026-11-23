import { type App, Modal, Notice, Setting, TFile } from "obsidian";
import { dueOf } from "../projection/upstream";

/** 客戶端只寫可寫欄位與 `_request`（M6-3 Global Constraints） */
export async function writeFm(app: App, path: string, set: Record<string, unknown>, unset: string[] = []): Promise<void> {
  const f = app.vault.getAbstractFileByPath(path);
  if (!(f instanceof TFile)) { new Notice("CalDAV：找不到投影檔"); return; }
  await app.fileManager.processFrontMatter(f, (fm) => { Object.assign(fm, set); for (const k of unset) delete fm[k]; });
}

export function fmOf(app: App, path: string): Record<string, unknown> | undefined {
  const f = app.vault.getAbstractFileByPath(path);
  return f instanceof TFile ? (app.metadataCache.getFileCache(f)?.frontmatter as Record<string, unknown> | undefined) : undefined;
}

export async function toggleDone(app: App, path: string): Promise<void> {
  const fm = fmOf(app, path);
  if (!fm) return;
  await writeFm(app, path, { status: fm.status === "completed" ? "needs-action" : "completed" });
}

/** 日期（＋時間）編輯框；驗證規則與伺服器 planUpstream 相同 */
export class DateModal extends Modal {
  constructor(app: App, private path: string, private keys: { date: string; time: string }) { super(app); }
  onOpen(): void {
    const fm = fmOf(this.app, this.path) ?? {};
    let date = String(fm[this.keys.date] ?? ""), time = String(fm[this.keys.time] ?? "");
    this.titleEl.setText("修改日期");
    new Setting(this.contentEl).setName("日期").setDesc("YYYY-MM-DD；留空 = 清除").addText((t) => { t.inputEl.type = "date"; t.setValue(date).onChange((v) => (date = v)); });
    new Setting(this.contentEl).setName("時間").setDesc("HH:mm；留空 = 全天").addText((t) => { t.inputEl.type = "time"; t.setValue(time).onChange((v) => (time = v)); });
    new Setting(this.contentEl).addButton((b) => b.setButtonText("儲存").setCta().onClick(async () => {
      const probe = { due: date || undefined, due_time: time || undefined };
      const r = dueOf(probe);
      if ("error" in r) { new Notice(r.error); return; }
      const set: Record<string, unknown> = {}, unset: string[] = [];
      if (date) set[this.keys.date] = date; else unset.push(this.keys.date);
      if (time) set[this.keys.time] = time; else unset.push(this.keys.time);
      await writeFm(this.app, this.path, set, unset);
      this.close();
    }));
  }
  onClose(): void { this.contentEl.empty(); }
}

export class TextModal extends Modal {
  constructor(app: App, private heading: string, private value: string, private onSave: (v: string) => Promise<void>) { super(app); }
  onOpen(): void {
    let v = this.value;
    this.titleEl.setText(this.heading);
    new Setting(this.contentEl).addText((t) => { t.setValue(v).onChange((x) => (v = x)); t.inputEl.style.width = "100%"; });
    new Setting(this.contentEl).addButton((b) => b.setButtonText("儲存").setCta().onClick(async () => { await this.onSave(v.trim()); this.close(); }));
  }
  onClose(): void { this.contentEl.empty(); }
}

export class ConfirmModal extends Modal {
  constructor(app: App, private message: string, private onYes: () => Promise<void>) { super(app); }
  onOpen(): void {
    this.contentEl.createEl("p", { text: this.message });
    new Setting(this.contentEl).addButton((b) => b.setButtonText("取消").onClick(() => this.close()))
      .addButton((b) => b.setButtonText("確定").setWarning().onClick(async () => { await this.onYes(); this.close(); }));
  }
  onClose(): void { this.contentEl.empty(); }
}

/** 「更新快照標籤」：把這篇筆記中指向 target 的連結標籤改成目前標題（使用者指令，P2） */
export async function updateLabels(app: App, notePath: string, targetPath: string): Promise<number> {
  const note = app.vault.getAbstractFileByPath(notePath);
  const fm = fmOf(app, targetPath);
  if (!(note instanceof TFile) || !fm) return 0;
  const id = targetPath.slice(targetPath.lastIndexOf("/") + 1).replace(/\.md$/, "");
  const alias = Array.isArray(fm.aliases) && fm.aliases.length ? String(fm.aliases[0]) : String(fm.title ?? "");
  let n = 0;
  await app.vault.process(note, (t) => t.replace(new RegExp(`\\[\\[${id}(\\|[^\\]]*)?\\]\\]`, "g"), () => { n++; return `[[${id}|${alias}]]`; }));
  return n;
}
