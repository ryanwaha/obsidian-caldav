import { type App, MarkdownView, Modal, Notice, Plugin, Setting } from "obsidian";
import type { EditorView } from "@codemirror/view";
import { MemoryIndex } from "./render/index";
import { DetailModal } from "./render/detailModal";
import { livePreviewExtension, refreshEffect } from "./render/livePreview";
import { readingModeProcessor } from "./render/readingMode";
import type { RefView } from "./render/present";
import { CacheStore } from "./cache/db";
import { CalDavClient } from "./caldav/client";
import { basicAuth } from "./caldav/http";
import { requestUrlTransport } from "./caldav/requestUrlTransport";
import { type Config, SessionManager } from "./session";
import { CalDavSettingTab, DEFAULT_SETTINGS, SECRET_ID, type Settings } from "./settings";
import { SyncEngine } from "./sync/engine";
import type { SyncReport } from "./types";

export default class CalDavPlugin extends Plugin {
  settings: Settings = { ...DEFAULT_SETTINGS };
  private sessions = new SessionManager(async (cfg, fingerprint) => {
    const cache = await CacheStore.open(`obsidian-caldav-${(this.app as App & { appId: string }).appId}`, fingerprint);
    return { cache, engine: new SyncEngine(new CalDavClient(cfg.serverUrl, basicAuth(cfg.username, cfg.password), requestUrlTransport()), cache) };
  });
  private intervalId?: number;
  private lastReport?: SyncReport;
  readonly index = new MemoryIndex();
  private collectionNames = new Map<string, string>();

  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.addSettingTab(new CalDavSettingTab(this.app, this));
    this.addCommand({ id: "sync-now", name: "立即同步", callback: () => void this.syncNow(true) });
    this.addCommand({ id: "lookup-short-id", name: "以短 ID 查詢", callback: () => new LookupModal(this.app, this).open() });
    this.registerEditorExtension(livePreviewExtension(this.index, (v) => this.openDetail(v)));
    this.registerMarkdownPostProcessor(readingModeProcessor(this.index, (v) => this.openDetail(v)));
    this.register(this.index.onChange(() => this.refreshEditors()));
    this.registerDomEvent(document, "visibilitychange", () => { if (document.visibilityState === "visible") void this.syncNow(false); });
    this.app.workspace.onLayoutReady(async () => {
      this.resetInterval();
      await this.reloadIndex(); // 先顯示快取（離線也可用），再同步
      void this.syncNow(false);
    });
  }

  onunload() { this.sessions.reset(); }

  async saveSettings() {
    await this.saveData(this.settings);
    this.resetInterval();
  }

  private resetInterval() {
    if (this.intervalId !== undefined) window.clearInterval(this.intervalId);
    this.intervalId = this.registerInterval(window.setInterval(() => void this.syncNow(false), this.settings.syncIntervalMinutes * 60_000));
  }

  private config(): Config | undefined {
    const password = this.app.secretStorage.getSecret(SECRET_ID);
    const { serverUrl, username } = this.settings;
    return serverUrl && username && password ? { serverUrl, username, password } : undefined;
  }

  async syncNow(notify: boolean): Promise<SyncReport | undefined> {
    const r = await this.sessions.sync(this.config());
    await this.reloadIndex();
    if (!r) {
      if (notify) new Notice("CalDAV：請先在設定頁填 Server URL、使用者名稱與密碼");
      return undefined;
    }
    this.lastReport = r;
    if (r.errors.length) console.warn("[obsidian-caldav] 同步錯誤", r.errors);
    if (notify) {
      new Notice(r.errors.length
        ? `CalDAV 同步有錯誤：${r.errors.map((e) => `${e.collection ?? ""} ${e.message}`.trim()).join("；")}`
        : `CalDAV：已同步 ${r.objects} 筆（變更 ${r.changed}、刪除 ${r.removed}${r.skipped ? `、略過 ${r.skipped}` : ""}）`);
    }
    return r;
  }

  private async reloadIndex(): Promise<void> {
    try {
      const session = await this.sessions.get(this.config());
      this.collectionNames = new Map((await session?.cache.getCollections() ?? []).map((c) => [c.href, c.displayName]));
      await this.index.load(session?.cache);
    } catch (e) {
      console.warn("[obsidian-caldav] 無法載入索引", e);
    }
  }

  private refreshEditors(): void {
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.view instanceof MarkdownView) {
        const cm = (leaf.view.editor as unknown as { cm?: EditorView }).cm;
        cm?.dispatch({ effects: refreshEffect.of(null) });
      }
    });
  }

  openDetail(view: RefView): void {
    new DetailModal(this.app, view, (href) => this.collectionNames.get(href) ?? href).open();
  }

  async statusLines(): Promise<string[]> {
    try {
      const session = await this.sessions.get(this.config());
      if (!session) return ["尚未設定"];
      const r = this.lastReport;
      const cols = await session.cache.getCollections();
      const lines = [
        `上次同步：${r ? new Date(r.finishedAt).toLocaleString() : "—"}`,
        `物件數：${await session.cache.count()}`,
        `清單：${cols.map((c) => c.displayName).join("、") || "—"}`,
      ];
      if (r?.errors.length) lines.push(`最近錯誤：${r.errors.map((e) => `${e.collection ?? ""} ${e.message}`.trim()).join("；")}`);
      if (r?.skippedItems.length) lines.push(`略過（無法解析）：${r.skippedItems.map((s) => `${s.href}（${s.reason}）`).join("；")}`);
      return lines;
    } catch (e) {
      return [`無法讀取本機快取：${e instanceof Error ? e.message : String(e)}`];
    }
  }

  async lookup(id: string): Promise<string> {
    try {
      const session = await this.sessions.get(this.config());
      if (!session) return "尚未設定";
      const { cache } = session;
      const objs = await cache.findByShortId(id);
      const cols = new Map((await cache.getCollections()).map((c) => [c.href, c.displayName]));
      if (objs.length) {
        return objs.map((o) => [o.kind, o.summary || "（無標題）", o.status ?? "", o.due ? `到期 ${o.due.value}` : o.start ? `開始 ${o.start.value}` : "", o.rrule ? `重複 ${o.rrule}` : "", `清單 ${cols.get(o.collection) ?? o.collection}`].filter(Boolean).join("｜")).join("\n");
      }
      const ts = await cache.findTombstonesByShortId(id);
      if (ts.length) return ts.map((t) => `已刪除：${t.summary || "（無標題）"}`).join("\n");
      return "查無此物";
    } catch (e) {
      return `無法讀取本機快取：${e instanceof Error ? e.message : String(e)}`;
    }
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
