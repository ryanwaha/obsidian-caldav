import { type App, Modal, Notice, Setting } from "obsidian";
import type { CollectionInfo } from "../types";

export interface NewTaskInput { summary: string; date?: string; time?: string; collection: string }

export class NewTaskModal extends Modal {
  constructor(app: App, private collections: CollectionInfo[], private defaultCollection: string, private onSubmit: (v: NewTaskInput) => void) { super(app); }

  onOpen() {
    this.setTitle("新建任務");
    const v: NewTaskInput = { summary: "", collection: this.defaultCollection };
    const submit = () => {
      if (!v.summary.trim()) { new Notice("請輸入標題"); return; }
      this.close();
      this.onSubmit({ ...v, summary: v.summary.trim(), time: v.date ? v.time : undefined });
    };
    new Setting(this.contentEl).setName("標題").addText((t) => {
      t.onChange((x) => (v.summary = x));
      t.inputEl.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); submit(); } });
      window.setTimeout(() => t.inputEl.focus(), 0);
    });
    new Setting(this.contentEl).setName("到期日").setDesc("可留空；時間只有在填了日期時才有效")
      .addText((t) => { t.inputEl.type = "date"; t.onChange((x) => (v.date = x || undefined)); })
      .addText((t) => { t.inputEl.type = "time"; t.onChange((x) => (v.time = x || undefined)); });
    new Setting(this.contentEl).setName("清單").addDropdown((d) => {
      for (const c of this.collections) d.addOption(c.href, c.displayName);
      d.setValue(v.collection).onChange((x) => (v.collection = x));
    });
    new Setting(this.contentEl).addButton((b) => b.setButtonText("建立並插入參照").setCta().onClick(submit));
  }

  onClose() { this.contentEl.empty(); }
}
