import { type App, type Editor, Modal, Notice, Setting, stringifyYaml, TFile } from "obsidian";
import { newFileContent } from "../projection/frontmatter";
import { PROJ_DIR } from "../projection/types";
import { shortId } from "../shortid";
import { listOptions, newTaskFm, type NewTaskFields } from "./newTaskLogic";

/** 裝置新建任務：建立沒有 `_etag` 的投影檔，游標處插入 `[[id|標題]]`（設計 D9）。離線也可用。 */
export class ClientNewTaskModal extends Modal {
  constructor(app: App, private editor: Editor) { super(app); }
  onOpen(): void {
    const fms = this.app.vault.getMarkdownFiles().filter((f) => f.parent?.path === PROJ_DIR)
      .map((f) => (this.app.metadataCache.getFileCache(f)?.frontmatter ?? {}) as Record<string, unknown>);
    const lists = listOptions(fms);
    const v: NewTaskFields = { title: "", list: lists[0] ?? "" };
    this.titleEl.setText("新建任務");
    new Setting(this.contentEl).setName("標題").addText((t) => { t.onChange((x) => (v.title = x)); window.setTimeout(() => t.inputEl.focus(), 0); });
    new Setting(this.contentEl).setName("清單").setDesc(lists.length ? "" : "還沒有任何任務可推斷清單；請先在提醒事項建立一個").addDropdown((d) => { for (const l of lists) d.addOption(l, l); d.setValue(v.list).onChange((x) => (v.list = x)); });
    new Setting(this.contentEl).setName("日期").addText((t) => { t.inputEl.type = "date"; t.onChange((x) => (v.date = x)); });
    new Setting(this.contentEl).setName("時間").setDesc("留空 = 全天").addText((t) => { t.inputEl.type = "time"; t.onChange((x) => (v.time = x)); });
    new Setting(this.contentEl).addButton((b) => b.setButtonText("建立").setCta().onClick(() => void this.create(v)));
  }

  private async create(v: NewTaskFields): Promise<void> {
    let fm: Record<string, unknown>;
    let path = "";
    try {
      for (let i = 0; i < 5; i++) {
        const uid = crypto.randomUUID();
        fm = newTaskFm(v, uid);
        path = `${PROJ_DIR}/${await shortId(uid)}.md`;
        if (!this.app.vault.getAbstractFileByPath(path)) break;
      }
      if (!this.app.vault.getAbstractFileByPath(PROJ_DIR)) await this.app.vault.createFolder(PROJ_DIR);
      const f = await this.app.vault.create(path, newFileContent(fm!, (o) => stringifyYaml(o)));
      const id = (f as TFile).basename;
      this.editor.replaceSelection(`[[${id}|${(fm!.aliases as string[])[0]}]]`);
      this.close();
    } catch (e) {
      new Notice(`CalDAV：${e instanceof Error ? e.message : String(e)}`);
    }
  }
  onClose(): void { this.contentEl.empty(); }
}
