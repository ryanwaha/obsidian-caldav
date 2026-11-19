import { type App, Modal, Notice, Plugin, Setting } from "obsidian";
import { CacheStore } from "./cache/db";
import { CalDavClient } from "./caldav/client";
import { basicAuth } from "./caldav/http";
import { requestUrlTransport } from "./caldav/requestUrlTransport";
import { CalDavSettingTab, DEFAULT_SETTINGS, SECRET_ID, type Settings } from "./settings";
import { SyncEngine } from "./sync/engine";
import type { SyncReport } from "./types";

export default class CalDavPlugin extends Plugin {
  settings: Settings = { ...DEFAULT_SETTINGS };
  private cache?: CacheStore;
  private engine?: SyncEngine;
  private engineKey?: string;
  private intervalId?: number;

  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.addSettingTab(new CalDavSettingTab(this.app, this));
    this.addCommand({ id: "sync-now", name: "立即同步", callback: () => void this.syncNow(true) });
    this.addCommand({ id: "lookup-short-id", name: "以短 ID 查詢", callback: () => new LookupModal(this.app, this).open() });
    this.registerDomEvent(document, "visibilitychange", () => { if (document.visibilityState === "visible") void this.syncNow(false); });
    this.app.workspace.onLayoutReady(() => { this.resetInterval(); void this.syncNow(false); });
  }

  onunload() { this.cache?.close(); }

  async saveSettings() {
    await this.saveData(this.settings);
    this.resetInterval();
  }

  private resetInterval() {
    if (this.intervalId !== undefined) window.clearInterval(this.intervalId);
    this.intervalId = this.registerInterval(window.setInterval(() => void this.syncNow(false), this.settings.syncIntervalMinutes * 60_000));
  }

  /** 設定齊全時回傳（必要時重建）同步引擎；fingerprint 變了就用新的快取。 */
  private async ensureEngine(): Promise<SyncEngine | undefined> {
    const { serverUrl, username } = this.settings;
    const password = this.app.secretStorage.getSecret(SECRET_ID);
    if (!serverUrl || !username || !password) return undefined;
    const key = `${serverUrl}|${username}|${password}`;
    if (this.engine && this.engineKey === key) return this.engine;
    this.cache?.close();
    this.cache = await CacheStore.open(`obsidian-caldav-${(this.app as App & { appId: string }).appId}`, `${serverUrl}|${username}`);
    this.engine = new SyncEngine(new CalDavClient(serverUrl, basicAuth(username, password), requestUrlTransport()), this.cache);
    this.engineKey = key;
    return this.engine;
  }

  async syncNow(notify: boolean): Promise<SyncReport | undefined> {
    const engine = await this.ensureEngine();
    if (!engine) {
      if (notify) new Notice("CalDAV：請先在設定頁填 Server URL、使用者名稱與密碼");
      return undefined;
    }
    const r = await engine.syncAll();
    if (r.errors.length) console.warn("[obsidian-caldav] 同步錯誤", r.errors);
    if (notify) {
      new Notice(r.errors.length
        ? `CalDAV 同步有錯誤：${r.errors.map((e) => `${e.collection ?? ""} ${e.message}`.trim()).join("；")}`
        : `CalDAV：已同步 ${r.objects} 筆（變更 ${r.changed}、刪除 ${r.removed}${r.skipped ? `、略過 ${r.skipped}` : ""}）`);
    }
    return r;
  }

  async statusLines(): Promise<string[]> {
    if (!this.cache || !this.engine) return ["尚未設定或尚未同步"];
    const r = this.engine.lastReport;
    const cols = await this.cache.getCollections();
    const lines = [
      `上次同步：${r ? new Date(r.finishedAt).toLocaleString() : "—"}`,
      `物件數：${await this.cache.count()}`,
      `清單：${cols.map((c) => c.displayName).join("、") || "—"}`,
    ];
    if (r?.errors.length) lines.push(`最近錯誤：${r.errors.map((e) => `${e.collection ?? ""} ${e.message}`.trim()).join("；")}`);
    return lines;
  }

  async lookup(id: string): Promise<string> {
    if (!this.cache) await this.ensureEngine();
    if (!this.cache) return "尚未設定";
    const objs = await this.cache.findByShortId(id);
    const cols = new Map((await this.cache.getCollections()).map((c) => [c.href, c.displayName]));
    if (objs.length) {
      return objs.map((o) => [o.kind, o.summary || "（無標題）", o.status ?? "", o.due ? `到期 ${o.due.value}` : o.start ? `開始 ${o.start.value}` : "", o.rrule ? `重複 ${o.rrule}` : "", `清單 ${cols.get(o.collection) ?? o.collection}`].filter(Boolean).join("｜")).join("\n");
    }
    const ts = await this.cache.findTombstonesByShortId(id);
    if (ts.length) return ts.map((t) => `已刪除：${t.summary || "（無標題）"}`).join("\n");
    return "查無此物";
  }
}

class LookupModal extends Modal {
  constructor(app: App, private plugin: CalDavPlugin) { super(app); }
  onOpen() {
    let value = "";
    const out = this.contentEl.createEl("pre", { text: "" });
    out.style.whiteSpace = "pre-wrap";
    new Setting(this.contentEl).setName("短 ID").addText((t) => {
      t.onChange((v) => (value = v.trim().toLowerCase()));
      t.inputEl.addEventListener("keydown", (e) => { if (e.key === "Enter") void go(); });
    }).addButton((b) => b.setButtonText("查詢").onClick(() => void go()));
    const go = async () => { out.setText(await this.plugin.lookup(value)); };
  }
  onClose() { this.contentEl.empty(); }
}
