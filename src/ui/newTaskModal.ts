import { type App, Modal, Notice, Setting } from "obsidian";
import type { CollectionInfo } from "../types";
import { normalizeDue } from "./due";

export interface NewTaskInput { summary: string; date?: string; time?: string; collection: string }

export class NewTaskModal extends Modal {
  constructor(app: App, private collections: CollectionInfo[], private defaultCollection: string, private onSubmit: (v: NewTaskInput) => void) { super(app); }

  onOpen() {
    this.setTitle("新建任務");
    this.modalEl.addClass("caldav-new-task");
    let titleEl!: HTMLInputElement, dateEl!: HTMLInputElement, timeEl!: HTMLInputElement;
    let collection = this.defaultCollection;
    // 送出時直接讀欄位值：iOS 的日期／時間選擇器不一定觸發 input 事件
    const submit = () => {
      const summary = titleEl.value.trim();
      if (!summary) { new Notice("請輸入標題"); return; }
      this.close();
      this.onSubmit({ summary, collection, ...normalizeDue(dateEl.value, timeEl.value, new Date()) });
    };
    new Setting(this.contentEl).setName("標題").addText((t) => {
      titleEl = t.inputEl;
      t.inputEl.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); submit(); } });
      window.setTimeout(() => t.inputEl.focus(), 0);
    });
    new Setting(this.contentEl).setName("日期").setDesc("可留空；只填時間時視為今天")
      .addText((t) => { t.inputEl.type = "date"; dateEl = t.inputEl; });
    new Setting(this.contentEl).setName("時間").setDesc("可留空（全天）")
      .addText((t) => { t.inputEl.type = "time"; timeEl = t.inputEl; });
    new Setting(this.contentEl).setName("清單").addDropdown((d) => {
      for (const c of this.collections) d.addOption(c.href, c.displayName);
      d.setValue(collection).onChange((x) => (collection = x));
    });
    new Setting(this.contentEl).addButton((b) => b.setButtonText("建立並插入參照").setCta().onClick(submit));
  }

  onClose() { this.contentEl.empty(); }
}
