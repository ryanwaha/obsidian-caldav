import { type App, type Editor, MarkdownView, Modal, Notice, Plugin, Setting } from "obsidian";
import { buildTodo } from "./ical/build";
import { parseResource } from "./ical/parse";
import { shortId } from "./shortid";
import { PickModal } from "./ui/pickModal";
import { type NewTaskInput, NewTaskModal } from "./ui/newTaskModal";
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
import type { CollectionInfo, SyncReport } from "./types";

export default class CalDavPlugin extends Plugin {
  settings: Settings = { ...DEFAULT_SETTINGS };
  private sessions = new SessionManager(async (cfg, fingerprint) => {
    const cache = await CacheStore.open(`obsidian-caldav-${(this.app as App & { appId: string }).appId}`, fingerprint);
    return { cache, engine: new SyncEngine(new CalDavClient(cfg.serverUrl, basicAuth(cfg.username, cfg.password), requestUrlTransport()), cache) };
  });
  private intervalId?: number;
  private lastReport?: SyncReport;
  readonly index = new MemoryIndex();
  private collections: CollectionInfo[] = [];
  private get collectionNames() { return new Map(this.collections.map((c) => [c.href, c.displayName])); }

  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.addSettingTab(new CalDavSettingTab(this.app, this));
    this.addCommand({ id: "sync-now", name: "立即同步", callback: () => void this.syncNow(true) });
    this.addCommand({ id: "insert-ref", name: "插入任務／事件參照", editorCallback: (editor) => this.insertRef(editor) });
    this.addCommand({ id: "new-task", name: "新建任務並插入參照", editorCallback: (editor) => this.newTask(editor) });
    this.addCommand({ id: "lookup-short-id", name: "以短 ID 查詢", callback: () => new LookupModal(this.app, this).open() });
    this.registerEditorExtension(livePreviewExtension(this.index, (v) => this.openDetail(v)));
    this.registerMarkdownPostProcessor(readingModeProcessor(this.index, (v) => this.openDetail(v)));
    this.register(this.index.onChange(() => this.refreshEditors()));
    // iOS 從其他 App 切回時不一定觸發 visibilitychange，所以多聽幾種「回到前景」的訊號，15 秒內只同步一次
    this.registerDomEvent(document, "visibilitychange", () => { if (document.visibilityState === "visible") this.foregroundSync("visibilitychange"); });
    this.registerDomEvent(window, "focus", () => this.foregroundSync("focus"));
    this.registerDomEvent(window, "pageshow", () => this.foregroundSync("pageshow"));
    this.registerDomEvent(document, "resume" as keyof DocumentEventMap, () => this.foregroundSync("resume"));
    this.registerEvent(this.app.workspace.on("file-open", () => this.foregroundSync("file-open")));
    this.app.workspace.onLayoutReady(async () => {
      this.resetInterval();
      await this.reloadIndex(); // 先顯示快取（離線也可用），再同步
      // 跨日時重繪，讓「今天／明天」與逾期標示更新
      let day = new Date().toDateString();
      this.registerInterval(window.setInterval(() => {
        const d = new Date().toDateString();
        if (d !== day) { day = d; this.index.touch(); }
      }, 60_000));
      void this.syncNow(false, "啟動");
    });
  }

  onunload() { this.sessions.reset(); }

  async saveSettings() {
    await this.saveData(this.settings);
    this.resetInterval();
  }

  private resetInterval() {
    if (this.intervalId !== undefined) window.clearInterval(this.intervalId);
    this.intervalId = this.registerInterval(window.setInterval(() => void this.syncNow(false, "定時"), this.settings.syncIntervalMinutes * 60_000));
  }

  private config(): Config | undefined {
    const password = this.app.secretStorage.getSecret(SECRET_ID);
    const { serverUrl, username } = this.settings;
    return serverUrl && username && password ? { serverUrl, username, password } : undefined;
  }

  private lastForeground = 0;
  private triggers: string[] = [];

  private foregroundSync(source: string): void {
    const now = Date.now();
    if (now - this.lastForeground < 15_000) return;
    this.lastForeground = now;
    void this.syncNow(false, source);
  }

  async syncNow(notify: boolean, source = notify ? "手動" : "自動"): Promise<SyncReport | undefined> {
    const r = await this.sessions.sync(this.config());
    // 只有資料可能改變時才重載索引；否則每次回前景都會重繪所有 chip
    if (!r || r.changed > 0 || r.removed > 0 || this.index.version === 0 || r.collections !== this.collections.length || r.sent > 0 || r.pendingQueued > 0 || r.pendingFailed > 0) await this.reloadIndex();
    if (!r) {
      if (notify) new Notice("CalDAV：請先在設定頁填 Server URL、使用者名稱與密碼");
      return undefined;
    }
    this.lastReport = r;
    const t = new Date();
    this.triggers.unshift(`${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}:${String(t.getSeconds()).padStart(2, "0")} ${source}：變更 ${r.changed}、刪除 ${r.removed}${r.sent ? `、送出 ${r.sent}` : ""}${r.errors.length ? "、有錯誤" : ""}`);
    this.triggers.length = Math.min(this.triggers.length, 8);
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
      this.collections = (await session?.cache.getCollections()) ?? [];
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

  todoCollections(): CollectionInfo[] { return this.collections.filter((c) => c.components.includes("VTODO")); }
  defaultCollectionHref(): string | undefined {
    const cols = this.todoCollections();
    return cols.find((c) => c.href === this.settings.defaultCollection)?.href ?? cols[0]?.href;
  }

  /** P2：插件對 .md 唯一的寫入；標籤一律留空（§6.3）。 */
  private insertRef(editor: Editor): void {
    const objs = this.index.allObjects();
    if (!objs.length) { new Notice("CalDAV：快取是空的，請先設定並同步"); return; }
    new PickModal(this.app, objs, (h) => this.collectionNames.get(h) ?? h, (o) => {
      editor.replaceSelection(`[](cal:${o.shortId})`);
      if (this.index.get(o.shortId).objs.length > 1) new Notice("注意：這個短 ID 對到多筆物件，參照會顯示為有歧義");
    }).open();
  }

  private newTask(editor: Editor): void {
    const cols = this.todoCollections();
    const def = this.defaultCollectionHref();
    if (!this.config() || !def) { new Notice("CalDAV：請先設定並同步一次，才能選擇清單"); return; }
    new NewTaskModal(this.app, cols, def, (v) => void this.createTask(editor, v)).open();
  }

  private async createTask(editor: Editor, v: NewTaskInput): Promise<void> {
    try {
      const session = await this.sessions.get(this.config());
      if (!session) { new Notice("CalDAV：尚未設定"); return; }
      const uid = crypto.randomUUID();
      const ics = buildTodo({ uid, summary: v.summary, due: v.date ? { date: v.date, time: v.time } : undefined }, new Date());
      const href = `${v.collection}${uid}.ics`;
      const parsed = await parseResource(ics, { href, etag: "", collection: v.collection });
      const sid = await shortId(uid);
      await session.cache.enqueue({
        uid, shortId: sid, fingerprint: session.cache.fingerprint, collection: v.collection, href, ics,
        summary: v.summary, due: "skip" in parsed ? undefined : parsed.due, createdAt: Date.now(), attempts: 0, state: "queued",
      });
      await this.reloadIndex();
      editor.replaceSelection(`[](cal:${sid})`);
      void this.syncNow(false, "新建");
    } catch (e) {
      new Notice(`CalDAV：無法建立任務：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async retryFailed(): Promise<void> {
    const session = await this.sessions.get(this.config());
    if (!session) return;
    for (const p of await session.cache.allPending()) {
      if (p.state === "failed" && p.fingerprint === session.cache.fingerprint) await session.cache.updatePending({ ...p, state: "queued" });
    }
    await this.syncNow(true, "重試");
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
      const pending = await session.cache.allPending();
      if (pending.length) {
        const mine = pending.filter((p) => p.fingerprint === session.cache.fingerprint);
        lines.push(`待送：${mine.filter((p) => p.state === "queued").length}　失敗：${mine.filter((p) => p.state === "failed").length}${pending.length > mine.length ? `　屬於其他帳號：${pending.length - mine.length}` : ""}`);
        for (const p of mine.filter((p) => p.state === "failed")) lines.push(`　✗ ${p.summary}（${p.lastError ?? "未知原因"}）`);
      }
      if (this.triggers.length) lines.push("最近同步：", ...this.triggers.map((x) => `　${x}`));
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
