import { type App, type Editor, type EditorPosition, MarkdownView, type MarkdownFileInfo, type TAbstractFile, TFile, TFolder, Modal, Notice, Plugin, Setting } from "obsidian";
import { BacklinkIndex } from "./backlinks/index";
import { rewriteRefs } from "./backlinks/rewrite";
import { type RefRewrite, UpdateRefsModal } from "./ui/updateRefsModal";
import { buildTodo } from "./ical/build";
import { applyPatch } from "./ical/patch";
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
import { ProjectionWriter } from "./projection/writer";
import { UpstreamRunner } from "./projection/upstreamRunner";
import { ProjectionGuard } from "./projection/guard";
import { type CalObject, type CollectionInfo, type Patch, type PendingUpdate, type SyncReport, isUpdate } from "./types";

export default class CalDavPlugin extends Plugin {
  settings: Settings = { ...DEFAULT_SETTINGS };
  private sessions = new SessionManager(async (cfg, fingerprint) => {
    const cache = await CacheStore.open(`obsidian-caldav-${(this.app as App & { appId: string }).appId}`, fingerprint);
    return { cache, engine: new SyncEngine(new CalDavClient(cfg.serverUrl, basicAuth(cfg.username, cfg.password), requestUrlTransport()), cache) };
  });
  private intervalId?: number;
  readonly projection = new ProjectionWriter(this.app, async () => (await this.sessions.get(this.config()).catch(() => undefined))?.cache, () => this.settings.projectCollections);
  readonly guard = new ProjectionGuard(this.app, async () => (await this.sessions.get(this.config()).catch(() => undefined))?.cache, this.projection);
  private lastReport?: SyncReport;
  readonly index = new MemoryIndex();
  readonly backlinks = new BacklinkIndex();
  private modifyTimers = new Map<string, number>();
  private scanDone = false;
  private collections: CollectionInfo[] = [];
  private pendingUpdates = new Map<string, PendingUpdate>();
  private get collectionNames() { return new Map(this.collections.map((c) => [c.href, c.displayName])); }

  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.sessions.onReport = (r) => {
      if (this.settings.mode !== "server") return;
      void this.projection.reconcile(r.errors.length === 0).then(async (p) => {
        const c = await this.guard.resolveConflicts();
        if (c) console.info("[obsidian-caldav] 已解決 LiveSync 衝突", c);
        if (p.created || p.updated || p.renamed || p.merged) console.info("[obsidian-caldav] 投影", p);
      });
    };
    this.addSettingTab(new CalDavSettingTab(this.app, this));
    if (this.settings.mode === "client") { this.loadClient(); return; }
    this.addCommand({ id: "sync-now", name: "立即同步", callback: () => void this.syncNow(true) });
    this.addCommand({ id: "insert-ref", name: "插入任務／事件參照", editorCallback: (editor) => this.insertRef(editor) });
    this.addCommand({ id: "new-task", name: "新建任務並插入參照", editorCallback: (editor, ctx) => this.newTask(editor, ctx) });
    this.addCommand({ id: "lookup-short-id", name: "以短 ID 查詢", callback: () => new LookupModal(this.app, this).open() });
    this.addCommand({ id: "update-refs", name: "更新參照（已搬移的任務）", callback: () => this.updateMovedRefs() });
    this.registerEditorExtension(livePreviewExtension(this.index, (v) => this.openDetail(v), (v) => void this.toggleDone(v)));
    this.registerMarkdownPostProcessor(readingModeProcessor(this.index, (v) => this.openDetail(v), (v) => void this.toggleDone(v)));
    this.register(this.index.onChange(() => this.refreshEditors()));
    // iOS 從其他 App 切回時不一定觸發 visibilitychange，所以多聽幾種「回到前景」的訊號，15 秒內只同步一次
    this.registerDomEvent(document, "visibilitychange", () => { if (document.visibilityState === "visible") this.foregroundSync("visibilitychange"); });
    this.registerDomEvent(window, "focus", () => this.foregroundSync("focus"));
    this.registerDomEvent(window, "pageshow", () => this.foregroundSync("pageshow"));
    this.registerDomEvent(document, "resume" as keyof DocumentEventMap, () => this.foregroundSync("resume"));
    this.registerEvent(this.app.workspace.on("file-open", () => this.foregroundSync("file-open")));
    this.app.workspace.onLayoutReady(async () => {
      if (this.settings.mode === "server") {
        ProjectionWriter.setPropertyTypes(this.app);
        const runner = new UpstreamRunner(this.app, async () => this.sessions.get(this.config()).catch(() => undefined), this.projection, () => void this.syncNow(false, "上行"));
        runner.start((r) => this.registerEvent(r));
        this.projection.onDirty = (p) => runner.schedule(p);
        this.guard.start((r) => this.registerEvent(r));
        this.register(() => this.guard.stop());
      }
      this.resetInterval();
      await this.reloadIndex(); // 先顯示快取（離線也可用），再同步
      this.watchVault();
      void this.scanVault();
      // 跨日時重繪，讓「今天／明天」與逾期標示更新
      let day = new Date().toDateString();
      this.registerInterval(window.setInterval(() => {
        const d = new Date().toDateString();
        if (d !== day) { day = d; this.index.touch(); }
      }, 60_000));
      void this.syncNow(false, "啟動");
    });
  }

  /** M6 裝置模式：不建立 CalDAV session、不同步；只註冊投影檔的 chip、守門與指令（M6-3）。 */
  private loadClient(): void {
    // Task 3–6 在這裡註冊
  }

  onunload() {
    this.sessions.reset();
    for (const t of this.modifyTimers.values()) window.clearTimeout(t);
  }

  /** 反向索引：啟動後分批掃描全部 .md（iOS 上不阻塞介面）。 */
  private async scanVault(): Promise<void> {
    const started = Date.now();
    const files = this.app.vault.getMarkdownFiles();
    for (let i = 0; i < files.length; i++) {
      try {
        this.backlinks.setFile(files[i].path, await this.app.vault.cachedRead(files[i]));
      } catch (e) {
        console.warn("[obsidian-caldav] 無法讀取", files[i].path, e);
      }
      if (i % 50 === 49) await new Promise((r) => window.setTimeout(r, 0));
    }
    this.scanDone = true;
    console.debug(`[obsidian-caldav] 反向索引：${files.length} 篇，${Date.now() - started} ms`);
  }

  private watchVault(): void {
    const isMd = (f: TAbstractFile): f is TFile => f instanceof TFile && f.extension === "md";
    const cancel = (path: string) => { window.clearTimeout(this.modifyTimers.get(path)); this.modifyTimers.delete(path); };
    const cancelUnder = (path: string) => { for (const p of [...this.modifyTimers.keys()]) if (p === path || p.startsWith(`${path}/`)) cancel(p); };
    const read = (f: TFile) => void this.app.vault.cachedRead(f).then((t) => this.backlinks.setFile(f.path, t), () => {});
    this.registerEvent(this.app.vault.on("create", (f) => { if (isMd(f)) read(f); }));
    this.registerEvent(this.app.vault.on("modify", (f) => {
      if (!isMd(f)) return;
      window.clearTimeout(this.modifyTimers.get(f.path));
      this.modifyTimers.set(f.path, window.setTimeout(() => { this.modifyTimers.delete(f.path); read(f); }, 500));
    }));
    this.registerEvent(this.app.vault.on("delete", (f) => {
      cancelUnder(f.path); // 刪除前 500 ms 內的修改不能把路徑加回來
      if (f instanceof TFolder) this.backlinks.removeFolder(f.path);
      else this.backlinks.removeFile(f.path);
    }));
    this.registerEvent(this.app.vault.on("rename", (f, old) => {
      cancelUnder(old);
      if (f instanceof TFolder) this.backlinks.renameFolder(old, f.path);
      else if (isMd(f)) { if (!this.backlinks.rename(old, f.path)) read(f); }
      else this.backlinks.removeFile(old); // 改成非 .md
    }));
  }

  /** 已搬移、且有筆記參照的短 ID。 */
  private movedRewrites(only?: { from: string; to: string }): RefRewrite[] {
    if (only) {
      return [{ from: only.from, to: only.to, title: this.index.get(only.to).objs[0]?.summary || "（無標題）", notes: this.backlinks.notesFor(only.from) }];
    }
    const out: RefRewrite[] = [];
    for (const id of this.backlinks.referencedIds()) {
      const v = this.index.view(id, "", new Date());
      if (v.state === "moved" && v.obj) out.push({ from: id, to: v.obj.shortId, title: v.obj.summary || "（無標題）", notes: this.backlinks.notesFor(id) });
    }
    return out;
  }

  /** P2：使用者確認後才改寫 .md。 */
  private updateMovedRefs(only?: { from: string; to: string }): void {
    if (!this.scanDone) { new Notice("CalDAV：還在掃描筆記，請稍後再試（否則會漏掉部分參照）"); return; }
    const items = this.movedRewrites(only).filter((i) => i.notes.length);
    if (!items.length) { new Notice(only ? "CalDAV：沒有筆記參照這個短 ID（程式碼裡的不算）" : "CalDAV：沒有需要更新的參照"); return; }
    new UpdateRefsModal(this.app, items, () => void this.rewrite(items)).open();
  }

  private async rewrite(items: RefRewrite[]): Promise<void> {
    const map = new Map(items.map((i) => [i.from, i.to]));
    let refs = 0, files = 0;
    const failed: string[] = [];
    for (const path of new Set(items.flatMap((i) => i.notes))) {
      const f = this.app.vault.getAbstractFileByPath(path);
      if (!(f instanceof TFile)) continue;
      try {
        let n = 0;
        // 回呼內以檔案當下的內容重新掃描，不會覆蓋確認期間打的字
        await this.app.vault.process(f, (text) => { const r = rewriteRefs(text, map); n = r.count; return r.text; });
        if (n) { refs += n; files++; }
      } catch (e) {
        failed.push(`${path}（${e instanceof Error ? e.message : String(e)}）`);
      }
    }
    new Notice(`CalDAV：已更新 ${refs} 個參照（${files} 篇筆記）${failed.length ? `；失敗：${failed.join("、")}` : ""}`, failed.length ? 10_000 : 5_000);
  }

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
    if (!r || r.changed > 0 || r.removed > 0 || r.aliases > 0 || this.index.hasMaybe() || this.index.version === 0 || r.collections !== this.collections.length || r.sent > 0 || r.pendingQueued > 0 || r.pendingFailed > 0) await this.reloadIndex();
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
      this.pendingUpdates = new Map(((await session?.cache.allPending()) ?? []).filter(isUpdate).map((p) => [p.href, p]));
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
    const at = editor.getCursor("to"); // 插在選取之後，不覆蓋使用者選取的文字
    new PickModal(this.app, objs, (h) => this.collectionNames.get(h) ?? h, (o) => {
      editor.replaceRange(`[](cal:${o.shortId})`, at);
      if (this.index.get(o.shortId).objs.length > 1) new Notice("注意：這個短 ID 對到多筆物件，參照會顯示為有歧義");
    }).open();
  }

  private newTask(editor: Editor, ctx: MarkdownView | MarkdownFileInfo): void {
    const file = ctx.file;
    const at = editor.getCursor("to");
    const cols = this.todoCollections();
    const def = this.defaultCollectionHref();
    if (!this.config() || !def) { new Notice("CalDAV：請先設定並同步一次，才能選擇清單"); return; }
    new NewTaskModal(this.app, cols, def, (v) => void this.createTask(file, at, v)).open();
  }

  /** 只有原筆記仍在作用中才插入；否則把參照交給使用者自己貼，避免插進別篇筆記。 */
  private insertAt(file: TFile | null, at: EditorPosition, text: string): void {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (file && view?.file === file) {
      view.editor.replaceRange(text, at);
    } else {
      void navigator.clipboard?.writeText(text).catch(() => {});
      new Notice(`CalDAV：任務已建立，但原筆記已不在畫面上。參照已複製，請手動貼上：${text}`, 10_000);
    }
  }

  private async createTask(file: TFile | null, at: EditorPosition, v: NewTaskInput): Promise<void> {
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
      this.insertAt(file, at, `[](cal:${sid})`); // 入佇列後立刻插入，再更新索引
      await this.reloadIndex();
      void this.syncNow(false, "新建");
    } catch (e) {
      new Notice(`CalDAV：無法建立任務：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async retryFailed(): Promise<void> {
    const session = await this.sessions.get(this.config());
    if (!session) return;
    for (const p of await session.cache.allPending()) {
      if (p.state === "failed" && p.fingerprint === session.cache.fingerprint) await session.cache.updatePending({ ...p, state: "queued" } as typeof p);
    }
    await this.syncNow(true, "重試");
  }

  openDetail(view: RefView): void {
    new DetailModal(this.app, view, {
      collectionName: (href) => this.collectionNames.get(href) ?? href,
      pendingUpdate: view.obj && this.pendingUpdates.get(view.obj.href),
      onSave: (obj, patch) => void this.editObject(obj, patch),
      onResolve: (p, choice) => void this.resolveConflict(p, choice),
      notes: this.backlinks.notesFor(view.id),
      openNote: (path) => void this.app.workspace.openLinkText(path, "", false),
      onRewrite: (from, to) => this.updateMovedRefs({ from, to }),
    }).open();
  }

  /** 以快取裡最新的狀態為準切換（連點時 view 可能還是舊的）。 */
  private async toggleDone(view: RefView): Promise<void> {
    if (!view.obj) return;
    const session = await this.sessions.get(this.config());
    const cur = (await session?.cache.getObject(view.obj.href)) ?? view.obj;
    const done = cur.status === "COMPLETED" || cur.status === "CANCELLED";
    await this.editObject(cur, { done: !done });
  }

  /** 寫入待送修改（每個物件一筆，合併 patch）→ 樂觀更新快取 → 同步。 */
  async editObject(obj: CalObject, patch: Patch): Promise<void> {
    try {
      const session = await this.sessions.get(this.config());
      if (!session) { new Notice("CalDAV：尚未設定"); return; }
      const cur = (await session.cache.getObject(obj.href)) ?? obj;
      // 先算出樂觀版本：§4.3 不允許的修改會在這裡丟出例外，不會進佇列
      const optimisticIcs = applyPatch(cur.ics, patch, new Date());
      const key = `upd:${obj.href}`;
      const existing = (await session.cache.getPending(key)) as PendingUpdate | undefined;
      const op: PendingUpdate = existing
        // 衝突或失敗中又修改：重設為待送，下次送出時重新比對（舊的衝突快照已不代表這次的修改）
        ? { ...existing, patch: { ...existing.patch, ...patch }, summary: patch.summary ?? existing.summary, rev: (existing.rev ?? 0) + 1, state: "queued", conflict: undefined, lastError: undefined }
        : { op: "update", uid: key, objUid: cur.uid, shortId: cur.shortId, fingerprint: session.cache.fingerprint, collection: cur.collection, href: cur.href,
            baseIcs: cur.ics, baseEtag: cur.etag, patch, summary: patch.summary ?? cur.summary, rev: 1, createdAt: Date.now(), attempts: 0, state: "queued" };
      await session.cache.updatePending(op);
      const optimistic = await parseResource(optimisticIcs, { href: cur.href, etag: cur.etag, collection: cur.collection });
      if (!("skip" in optimistic)) await session.cache.upsertObjects([optimistic]);
      await this.reloadIndex();
      void this.syncNow(false, "編輯");
    } catch (e) {
      new Notice(`CalDAV：無法修改：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async resolveConflict(p: PendingUpdate, choice: "mine" | "server"): Promise<void> {
    const session = await this.sessions.get(this.config());
    if (!session || !p.conflict) return;
    if (choice === "mine") {
      // 以伺服器目前版本為新的基準，重新套用我的修改
      await session.cache.updatePending({ ...p, baseIcs: p.conflict.serverIcs, baseEtag: p.conflict.serverEtag, state: "queued", conflict: undefined, lastError: undefined });
      await this.syncNow(true, "衝突：用我的");
    } else {
      // 不用衝突當下的快照（之後伺服器可能又變了），直接取最新版本
      await session.cache.removePending(p.uid);
      try {
        await session.engine.refreshObject(p.href, p.collection);
      } catch (e) {
        new Notice(`CalDAV：已放棄我的修改，但取得伺服器版本失敗；下次同步會更新：${e instanceof Error ? e.message : String(e)}`);
      }
      await this.reloadIndex();
    }
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
        lines.push(`待送：${mine.filter((p) => p.state === "queued").length}　失敗：${mine.filter((p) => p.state === "failed").length}　衝突：${mine.filter((p) => p.state === "conflict").length}${pending.length > mine.length ? `　屬於其他帳號：${pending.length - mine.length}` : ""}`);
        for (const p of mine.filter((p) => p.state === "failed")) lines.push(`　✗ ${isUpdate(p) ? "修改" : "新建"}「${p.summary}」（${p.lastError ?? "未知原因"}）`);
        for (const p of mine.filter((p) => p.state === "conflict")) lines.push(`　⚠ 修改「${p.summary}」與伺服器衝突：點該參照開啟詳情選擇`);
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
      const v = this.index.view(id, "", new Date());
      if (v.state === "moved" && v.obj) return `已搬移：${v.obj.summary || "（無標題）"}｜${cols.get(v.movedFrom ?? "") ?? v.movedFrom} → ${cols.get(v.obj.collection) ?? v.obj.collection}｜新短 ID ${v.obj.shortId}`;
      if (v.state === "maybe-moved") return `可能已搬移：${ts[0]?.summary || "（無標題）"}（還有清單沒同步完）`;
      if (v.state === "ambiguous" && v.candidates) return `搬移後有多筆相符：\n${v.candidates.map((o) => `${o.summary}｜${cols.get(o.collection) ?? o.collection}｜${o.shortId}`).join("\n")}`;
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
