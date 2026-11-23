import { MarkdownView, Plugin, TAbstractFile, TFile } from "obsidian";
import { syntaxTree } from "@codemirror/language";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";

class ChipWidget extends WidgetType {
  constructor(readonly target: string) { super(); }
  eq(o: ChipWidget) { return o.target === this.target; }
  toDOM() {
    const el = document.createElement("span");
    el.className = "m6-probe-chip"; el.textContent = "◆"; el.dataset.target = this.target;
    el.style.cssText = "display:inline-block;padding:0 6px;margin-left:2px;background:#553;cursor:pointer";
    el.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); });
    el.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); window.__m6log.push({ t: Date.now(), ev: "chip-click", target: this.target }); });
    return el;
  }
  ignoreEvent() { return true; }
}

declare global { interface Window { __m6log: unknown[]; __m6tree: () => unknown } }
const DIR = "_caldav/";

export default class M6Probe extends Plugin {
  async onload() {
    window.__m6log = [];
    const log = (ev: string, file: TAbstractFile, extra: Record<string, unknown> = {}) => {
      if (!file.path.startsWith(DIR) && !(extra.oldPath as string | undefined)?.startsWith(DIR)) return;
      const fm = file instanceof TFile ? this.app.metadataCache.getFileCache(file)?.frontmatter ?? null : null;
      const rec = { t: Date.now(), ev, path: file.path, fm: fm ? { ...fm } : null, ...extra };
      window.__m6log.push(rec);
      console.log("[m6-probe]", JSON.stringify(rec));
    };
    this.app.workspace.onLayoutReady(() => {
      for (const ev of ["modify", "create", "delete"] as const)
        this.registerEvent(this.app.vault.on(ev as "modify", (f) => log(ev, f)));
      this.registerEvent(this.app.vault.on("rename", (f, oldPath) => log("rename", f, { oldPath })));
      this.registerEvent(this.app.metadataCache.on("changed", (f) => log("changed", f)));
    });
    window.__m6tree = () => {
      const v = this.app.workspace.getActiveViewOfType(MarkdownView);
      const cm = (v?.editor as unknown as { cm: EditorView } | undefined)?.cm;
      if (!cm) return "no cm";
      const out: { line: number; text: string; nodes: string[] }[] = [];
      const doc = cm.state.doc;
      for (let i = 1; i <= doc.lines; i++) out.push({ line: i, text: doc.line(i).text, nodes: [] });
      syntaxTree(cm.state).iterate({ enter: (n) => {
        if (n.name === "Document") return;
        const ln = doc.lineAt(n.from).number;
        out[ln - 1].nodes.push(`${n.name}@${n.from - doc.line(ln).from}-${n.to - doc.line(ln).from}`);
      } });
      return out;
    };
    const app = this.app;
    const build = (view: EditorView): DecorationSet => {
      const b = new RangeSetBuilder<Decoration>();
      const file = app.workspace.getActiveFile();
      for (const { from, to } of view.visibleRanges) {
        let target: string | null = null; let embed = false;
        syntaxTree(view.state).iterate({ from, to, enter: (n) => {
          const name = n.name;
          if (name.includes("formatting-link-start")) { target = null; embed = name.includes("formatting-embed"); return; }
          if (name.includes("hmd-internal-link") && !name.includes("link-alias") && target === null)
            target = view.state.sliceDoc(n.from, n.to);
          if (name.includes("formatting-link-end") && target !== null) {
            const path = target.split("#")[0];
            const dest = app.metadataCache.getFirstLinkpathDest(path, file?.path ?? "");
            if (!embed && dest?.path.startsWith(DIR)) b.add(n.to, n.to, Decoration.widget({ widget: new ChipWidget(dest.path), side: 1 }));
            target = null;
          }
        } });
      }
      return b.finish();
    };
    this.registerEditorExtension(ViewPlugin.fromClass(class {
      decorations: DecorationSet;
      constructor(v: EditorView) { this.decorations = build(v); }
      update(u: ViewUpdate) { if (u.docChanged || u.viewportChanged || u.selectionSet) this.decorations = build(u.view); }
    }, { decorations: (v) => v.decorations }));
    this.addCommand({ id: "clear-log", name: "Clear log", callback: () => { window.__m6log = []; } });
  }
}
