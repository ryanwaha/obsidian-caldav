import { type App, PluginSettingTab, Setting } from "obsidian";
import type CalDavPlugin from "./main";
import { normalizeServerUrl } from "./session";

export interface Settings {
  serverUrl: string; username: string; syncIntervalMinutes: number; defaultCollection: string;
  /** M6：server = 投影到 _caldav/（只在 headless 伺服器上用）；client = 0.5.0 行為 */
  mode: "client" | "server";
  /** 投影的集合 href；空 = 全部 */
  projectCollections: string[];
}
export const DEFAULT_SETTINGS: Settings = { serverUrl: "", username: "", syncIntervalMinutes: 5, defaultCollection: "", mode: "client", projectCollections: [] };
export const SECRET_ID = "obsidian-caldav-password";

export class CalDavSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: CalDavPlugin) { super(app, plugin); }

  display(): void {
    const { containerEl } = this;
    const s = this.plugin.settings;
    containerEl.empty();

    // 文字欄位在離開（blur）時才儲存：打到一半的值不能觸發同步，否則 fingerprint 改變會清空快取
    const onBlur = (el: HTMLInputElement, save: (v: string) => void) =>
      el.addEventListener("blur", async () => { save(el.value.trim()); await this.plugin.saveSettings(); });
    new Setting(containerEl).setName("Server URL").setDesc("例如 https://host:8448（不含路徑）")
      .addText((t) => { t.setValue(s.serverUrl); onBlur(t.inputEl, (v) => (s.serverUrl = normalizeServerUrl(v))); });
    new Setting(containerEl).setName("使用者名稱")
      .addText((t) => { t.setValue(s.username); onBlur(t.inputEl, (v) => (s.username = v)); });
    new Setting(containerEl).setName("密碼").setDesc("存在本機 SecretStorage，不寫入 vault、不同步")
      .addText((t) => {
        t.inputEl.type = "password";
        t.setPlaceholder(this.app.secretStorage.getSecret(SECRET_ID) ? "（已設定）" : "");
        t.inputEl.addEventListener("blur", () => {
          if (t.inputEl.value) { this.app.secretStorage.setSecret(SECRET_ID, t.inputEl.value); t.setValue(""); t.setPlaceholder("（已設定）"); }
        });
      })
      .addButton((b) => b.setButtonText("清除").onClick(() => { this.app.secretStorage.setSecret(SECRET_ID, ""); this.display(); }));
    new Setting(containerEl).setName("自動同步間隔（分鐘）").setDesc("回到 Obsidian 前景時也會同步")
      .addText((t) => t.setValue(String(s.syncIntervalMinutes)).onChange(async (v) => {
        const n = Number(v);
        if (Number.isFinite(n) && n >= 1) { s.syncIntervalMinutes = Math.round(n); await this.plugin.saveSettings(); }
      }));

    const todoCols = this.plugin.todoCollections();
    new Setting(containerEl).setName("新建任務的預設清單").setDesc(todoCols.length ? "" : "同步後才會列出清單")
      .addDropdown((d) => {
        for (const c of todoCols) d.addOption(c.href, c.displayName);
        d.setValue(this.plugin.defaultCollectionHref() ?? "").onChange(async (x) => { s.defaultCollection = x; await this.plugin.saveSettings(); });
      });

    containerEl.createEl("h3", { text: "投影（M6）" });
    new Setting(containerEl).setName("模式").setDesc("server：把 CalDAV 物件投影到 _caldav/。整個系統只能有一台（headless 伺服器）設為 server")
      .addDropdown((d) => d.addOption("client", "client").addOption("server", "server").setValue(s.mode)
        .onChange(async (v) => { s.mode = v as Settings["mode"]; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("投影的清單").setDesc("集合 href，逗號分隔；留空 = 全部")
      .addText((t) => { t.setValue(s.projectCollections.join(", ")); onBlur(t.inputEl, (v) => (s.projectCollections = v.split(",").map((x) => x.trim()).filter(Boolean))); });

    containerEl.createEl("h3", { text: "同步狀態" });
    const status = containerEl.createDiv();
    const render = async () => {
      status.empty();
      for (const line of await this.plugin.statusLines()) status.createEl("div", { text: line });
    };
    void render();
    new Setting(containerEl).addButton((b) => b.setButtonText("重試失敗的待送").onClick(async () => {
      b.setDisabled(true);
      try { await this.plugin.retryFailed(); } finally { b.setDisabled(false); await render(); }
    })).addButton((b) => b.setButtonText("立即同步").setCta().onClick(async () => {
      b.setDisabled(true);
      try { await this.plugin.syncNow(true); } finally { b.setDisabled(false); await render(); }
    }));
  }
}
