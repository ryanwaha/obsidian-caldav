import { type App, Modal, Setting } from "obsidian";

export interface RefRewrite { from: string; to: string; title: string; notes: string[] }

/** 「更新參照」的確認：列出舊 → 新與受影響的筆記，按確認才寫 .md（P2）。 */
export class UpdateRefsModal extends Modal {
  constructor(app: App, private items: RefRewrite[], private onConfirm: () => void) { super(app); }
  onOpen() {
    const { contentEl, items } = this;
    this.setTitle("更新參照");
    const files = new Set(items.flatMap((i) => i.notes));
    contentEl.createEl("p", { text: `將改寫 ${items.length} 個短 ID，涉及 ${files.size} 篇筆記。只換掉短 ID，標籤不變；程式碼裡的不動。` });
    const ul = contentEl.createEl("ul");
    for (const i of items) {
      const li = ul.createEl("li");
      li.createSpan({ text: `${i.title}：${i.from} → ${i.to}` });
      li.createDiv({ text: i.notes.join("、"), cls: "caldav-pick__meta" });
    }
    new Setting(contentEl)
      .addButton((b) => b.setButtonText("改寫").setCta().onClick(() => { this.close(); this.onConfirm(); }))
      .addButton((b) => b.setButtonText("取消").onClick(() => this.close()));
  }
  onClose() { this.contentEl.empty(); }
}
