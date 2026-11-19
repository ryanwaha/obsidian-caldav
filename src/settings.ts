import { type App, PluginSettingTab, Setting } from "obsidian";
import type CalDavPlugin from "./main";

export interface Settings { serverUrl: string; username: string; syncIntervalMinutes: number }
export const DEFAULT_SETTINGS: Settings = { serverUrl: "", username: "", syncIntervalMinutes: 5 };
export const SECRET_ID = "obsidian-caldav-password";

export class CalDavSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: CalDavPlugin) { super(app, plugin); }

  display(): void {
    const { containerEl } = this;
    const s = this.plugin.settings;
    containerEl.empty();

    new Setting(containerEl).setName("Server URL").setDesc("例如 https://host:8448（不含路徑）")
      .addText((t) => t.setValue(s.serverUrl).onChange(async (v) => { s.serverUrl = v.trim(); await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("使用者名稱")
      .addText((t) => t.setValue(s.username).onChange(async (v) => { s.username = v.trim(); await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("密碼").setDesc("存在本機 SecretStorage，不寫入 vault、不同步")
      .addText((t) => {
        t.inputEl.type = "password";
        t.setPlaceholder(this.app.secretStorage.getSecret(SECRET_ID) ? "（已設定）" : "");
        t.onChange((v) => { if (v) this.app.secretStorage.setSecret(SECRET_ID, v); });
      });
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
      await this.plugin.syncNow(true);
      b.setDisabled(false);
      await render();
    }));
  }
}
