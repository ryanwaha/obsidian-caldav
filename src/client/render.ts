import { syntaxTree } from "@codemirror/language";
import { type Extension, Prec, RangeSetBuilder, StateEffect } from "@codemirror/state";
import { Decoration, type DecorationSet, type EditorView, ViewPlugin, type ViewUpdate, WidgetType } from "@codemirror/view";
import { type App, editorInfoField, Menu, type MarkdownPostProcessor, TFile } from "obsidian";
import { PROJ_DIR } from "../projection/types";
import { chipView } from "./chip";
import { ConfirmModal, DateModal, fmOf, TextModal, toggleDone, updateLabels, writeFm } from "./actions";
import { ConflictModal } from "./guard";
import type { ConflictMap } from "./guardLogic";
import { Notice } from "obsidian";

export const chipRefresh = StateEffect.define<null>();
const LIGHT: Record<string, string> = { ok: "", pending: "等待伺服器處理", rejected: "被拒絕", conflict: "有衝突", deleted: "已刪除" };

function resolve(app: App, linktext: string, source: string): TFile | null {
  const f = app.metadataCache.getFirstLinkpathDest(linktext.split("#")[0], source);
  return f && f.parent?.path === PROJ_DIR ? f : null;
}

/** 建立 chip DOM。所有事件都攔下，不讓游標進入連結、不觸發連結開啟（S1）。 */
export function buildChip(app: App, target: string, label: string | undefined, source: string): HTMLElement {
  const el = document.createElement("span");
  el.className = "m6-chip";
  el.dataset.target = target;
  const fm = fmOf(app, target);
  if (!fm) { el.textContent = "…"; return el; }
  const v = chipView(fm, label, new Date());
  el.classList.add(`m6-chip--${v.light}`);
  if (v.checkbox && fm.status === "completed") el.classList.add("m6-chip--done");
  const stop = (e: Event) => { e.preventDefault(); e.stopPropagation(); };
  el.addEventListener("mousedown", stop);
  if (v.checkbox) {
    const cb = el.createEl("input", { type: "checkbox", cls: "m6-chip__check" });
    cb.checked = v.checkbox.checked; cb.disabled = !v.checkbox.enabled;
    cb.title = v.checkbox.enabled ? "切換完成" : "重複或已刪除的任務請在提醒事項操作";
    cb.addEventListener("click", (e) => { stop(e); if (v.checkbox!.enabled) void toggleDone(app, target); });
  }
  if (v.date) {
    const d = el.createSpan({ cls: "m6-chip__date", text: v.date });
    d.addEventListener("click", (e) => {
      stop(e);
      if (!v.editable || fm._rrule) return;
      new DateModal(app, target, v.kind === "VTODO" ? { date: "due", time: "due_time" } : { date: "start", time: "start_time" }).open();
    });
  }
  if (v.light !== "ok") el.createSpan({ cls: "m6-chip__light", text: "●", attr: { "aria-label": `${LIGHT[v.light]}${v.message ? `：${v.message}` : ""}` } });
  if (v.titleChanged) el.createSpan({ cls: "m6-chip__changed", text: "↻", attr: { "aria-label": `標題已改為「${v.title}」` } });
  const more = el.createSpan({ cls: "m6-chip__more", text: "⋯" });
  more.addEventListener("click", (e) => {
    stop(e);
    const m = new Menu();
    if (v.light === "conflict" && fm._conflict) m.addItem((i) => i.setTitle("處理衝突…").onClick(() => new ConflictModal(app, target, fm._conflict as ConflictMap).open()));
    if (v.light === "rejected" && v.message) m.addItem((i) => i.setTitle("為什麼被拒絕？").onClick(() => new Notice(`CalDAV：${v.message}`, 10_000)));
    if (v.light === "pending" && !fm._etag) m.addItem((i) => i.setTitle("等待伺服器建立…").setDisabled(true));
    if (v.editable) {
      m.addItem((i) => i.setTitle("改標題").onClick(() => new TextModal(app, "改標題", String(fm.title ?? ""), (t) => (t ? writeFm(app, target, { title: t }) : Promise.resolve())).open()));
      if (v.kind === "VTODO" && !fm._rrule) for (const s of ["needs-action", "in-process", "completed", "cancelled"])
        m.addItem((i) => i.setTitle(`狀態：${s}`).setChecked(fm.status === s).onClick(() => void writeFm(app, target, { status: s })));
      m.addItem((i) => i.setTitle("刪除任務…").onClick(() => new ConfirmModal(app, `確定要在 CalDAV 刪除「${v.title}」？投影檔與你寫的內容會保留。`, () => writeFm(app, target, { _request: "delete" })).open()));
    }
    if (v.titleChanged) m.addItem((i) => i.setTitle("更新這篇筆記的連結標籤").onClick(() => void updateLabels(app, source, target)));
    m.addItem((i) => i.setTitle("開啟投影檔").onClick(() => void app.workspace.openLinkText(target, source)));
    m.showAtMouseEvent(e as MouseEvent);
  });
  return el;
}

class ChipWidget extends WidgetType {
  constructor(readonly app: App, readonly target: string, readonly label: string | undefined, readonly source: string, readonly version: number) { super(); }
  eq(o: ChipWidget) { return o.target === this.target && o.label === this.label && o.version === this.version; }
  toDOM() { return buildChip(this.app, this.target, this.label, this.source); }
  ignoreEvent() { return true; }
}

/** Live Preview：在指向 caldav/ 的 wikilink 後面加 chip（S1 規則） */
export function chipExtension(app: App, version: () => number): Extension {
  const build = (view: EditorView): DecorationSet => {
    const b = new RangeSetBuilder<Decoration>();
    const source = view.state.field(editorInfoField, false)?.file?.path ?? "";
    for (const { from, to } of view.visibleRanges) {
      let target: string | null = null, label: string | undefined, embed = false;
      syntaxTree(view.state).iterate({ from, to, enter: (n) => {
        const name = n.name;
        if (name.includes("formatting-link-start")) { target = null; label = undefined; embed = name.includes("formatting-embed"); return; }
        if (name.includes("hmd-internal-link") && name.includes("link-alias") && !name.includes("link-alias-pipe") && target !== null)
          label = (label ?? "") + view.state.sliceDoc(n.from, n.to);
        else if (name.includes("hmd-internal-link") && !name.includes("link-alias") && target === null) target = view.state.sliceDoc(n.from, n.to);
        if (name.includes("formatting-link-end") && target !== null) {
          const f = !embed ? resolve(app, target, source) : null;
          if (f) b.add(n.to, n.to, Decoration.widget({ widget: new ChipWidget(app, f.path, label, source, version()), side: 1 }));
          target = null;
        }
      } });
    }
    return b.finish();
  };
  return Prec.low(ViewPlugin.fromClass(class {
    decorations: DecorationSet;
    constructor(v: EditorView) { this.decorations = build(v); }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || u.transactions.some((t) => t.effects.some((e) => e.is(chipRefresh)))) this.decorations = build(u.view);
    }
  }, { decorations: (v) => v.decorations }));
}

/** 閱讀模式 */
export function chipPostProcessor(app: App): MarkdownPostProcessor {
  return (el, ctx) => {
    for (const a of Array.from(el.querySelectorAll<HTMLAnchorElement>("a.internal-link"))) {
      if (a.closest(".internal-embed")) continue;
      const href = a.getAttribute("data-href");
      const f = href ? resolve(app, href, ctx.sourcePath) : null;
      if (!f) continue;
      const label = a.textContent && a.textContent !== href ? a.textContent : undefined;
      a.after(buildChip(app, f.path, label, ctx.sourcePath));
    }
  };
}
