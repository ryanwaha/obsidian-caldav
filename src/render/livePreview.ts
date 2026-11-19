import { syntaxTree } from "@codemirror/language";
import { editorLivePreviewField } from "obsidian";
import { type EditorState, type Extension, Prec, RangeSetBuilder, StateEffect } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from "@codemirror/view";
import { renderRef } from "./chip";
import type { MemoryIndex } from "./index";
import { type RefView, present } from "./present";
import { findRefs } from "./refs";

/** 索引更新時，由 main.ts 對每個編輯器 dispatch，觸發重繪。 */
export const refreshEffect = StateEffect.define<null>();

class RefWidget extends WidgetType {
  constructor(private id: string, private label: string, private version: number, private index: MemoryIndex, private onClick: (v: RefView) => void) { super(); }
  eq(other: RefWidget): boolean { return other.id === this.id && other.label === this.label && other.version === this.version; }
  toDOM(): HTMLElement {
    const el = document.createElement("span");
    const { objs, tombs } = this.index.get(this.id);
    renderRef(el, present(this.id, this.label, objs, tombs, new Date()), this.onClick);
    return el;
  }
  ignoreEvent(): boolean { return true; }
}

/** 位置是否在程式碼裡（行內程式碼或 code block）。節點名稱見 M2 ledger。 */
function inCode(state: EditorState, pos: number): boolean {
  for (let node: { name: string; parent: unknown } | null = syntaxTree(state).resolveInner(pos, 1); node; node = node.parent as typeof node) {
    if (/code/i.test(node.name)) return true;
  }
  return false;
}

function build(view: EditorView, index: MemoryIndex, onClick: (v: RefView) => void): DecorationSet {
  const b = new RangeSetBuilder<Decoration>();
  const { state } = view;
  if (!state.field(editorLivePreviewField, false)) return b.finish(); // 原始碼模式顯示原文
  const sel = state.selection.ranges;
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to;) {
      const line = state.doc.lineAt(pos);
      for (const r of findRefs(line.text, line.from)) {
        if (sel.some((s) => s.from <= r.to && s.to >= r.from)) continue; // 游標或選取進入：顯示原文
        if (inCode(state, r.from + 1)) continue;
        b.add(r.from, r.to, Decoration.replace({ widget: new RefWidget(r.id, r.label, index.version, index, onClick) }));
      }
      pos = line.to + 1;
    }
  }
  return b.finish();
}

export function livePreviewExtension(index: MemoryIndex, onClick: (v: RefView) => void): Extension {
  const plugin = ViewPlugin.fromClass(class {
    decorations: DecorationSet;
    constructor(view: EditorView) { this.decorations = build(view, index, onClick); }
    update(u: ViewUpdate) {
      const modeChanged = u.startState.field(editorLivePreviewField, false) !== u.state.field(editorLivePreviewField, false);
      if (u.docChanged || u.selectionSet || u.viewportChanged || modeChanged || u.transactions.some((t) => t.effects.some((e) => e.is(refreshEffect)))) {
        this.decorations = build(u.view, index, onClick);
      }
    }
  }, { decorations: (v) => v.decorations });
  return Prec.highest(plugin);
}
