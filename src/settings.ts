import { type App, PluginSettingTab, Setting } from "obsidian";
import type CalDavPlugin from "./main";
import { normalizeServerUrl } from "./session";

export interface Settings { serverUrl: string; username: string; syncIntervalMinutes: number }
export const DEFAULT_SETTINGS: Settings = { serverUrl: "", username: "", syncIntervalMinutes: 5 };
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

    containerEl.createEl("h3", { text: "同步狀態" });
    const status = containerEl.createDiv();
    const render = async () => {
      status.empty();
      for (const line of await this.plugin.statusLines()) status.createEl("div", { text: line });
    };
    void render();
    new Setting(containerEl).addButton((b) => b.setButtonText("立即同步").setCta().onClick(async () => {
      b.setDisabled(true);
      try { await this.plugin.syncNow(true); } finally { b.setDisabled(false); await render(); }
    }));
  }
}
