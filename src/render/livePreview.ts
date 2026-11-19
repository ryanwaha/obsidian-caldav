import { syntaxTree } from "@codemirror/language";
import { editorLivePreviewField } from "obsidian";
import { type EditorState, type Extension, Prec, RangeSetBuilder, StateEffect } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from "@codemirror/view";
import { renderRef } from "./chip";
import type { MemoryIndex } from "./index";
import { type RefView, present } from "./present";
import { collectRefs } from "./viewRefs";

/** 點擊 chip 的回呼；reveal 會把游標移進參照，顯示原文以便編輯標籤。 */
export type OnClick = (v: RefView, reveal?: () => void) => void;

/** 索引更新時，由 main.ts 對每個編輯器 dispatch，觸發重繪。 */
export const refreshEffect = StateEffect.define<null>();

class RefWidget extends WidgetType {
  constructor(private id: string, private label: string, private version: number, private index: MemoryIndex, private onClick: OnClick) { super(); }
  eq(other: RefWidget): boolean { return other.id === this.id && other.label === this.label && other.version === this.version; }
  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement("span");
    const { objs, tombs } = this.index.get(this.id);
    const reveal = () => {
      const pos = view.posAtDOM(el);
      view.dispatch({ selection: { anchor: pos + 1 } });
      view.focus();
    };
    renderRef(el, present(this.id, this.label, objs, tombs, new Date()), (v) => this.onClick(v, reveal));
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

function build(view: EditorView, index: MemoryIndex, onClick: OnClick): DecorationSet {
  const b = new RangeSetBuilder<Decoration>();
  const { state } = view;
  if (!state.field(editorLivePreviewField, false)) return b.finish(); // 原始碼模式顯示原文
  try {
    for (const r of collectRefs(state, view.visibleRanges, state.selection.ranges, inCode)) {
      b.add(r.from, r.to, Decoration.replace({ widget: new RefWidget(r.id, r.label, index.version, index, onClick), inclusive: true }));
    }
    return b.finish();
  } catch (e) {
    console.error("[obsidian-caldav] live preview", e);
    return Decoration.none;
  }
}

export function livePreviewExtension(index: MemoryIndex, onClick: OnClick): Extension {
  const plugin = ViewPlugin.fromClass(class {
    decorations: DecorationSet;
    constructor(view: EditorView) { this.decorations = build(view, index, onClick); }
    update(u: ViewUpdate) {
      const modeChanged = u.startState.field(editorLivePreviewField, false) !== u.state.field(editorLivePreviewField, false);
      const treeChanged = syntaxTree(u.startState) !== syntaxTree(u.state); // 長筆記背景解析完成
      if (u.docChanged || u.selectionSet || u.viewportChanged || modeChanged || treeChanged || u.transactions.some((t) => t.effects.some((e) => e.is(refreshEffect)))) {
        this.decorations = build(u.view, index, onClick);
      }
    }
  }, { decorations: (v) => v.decorations });
  return Prec.highest(plugin);
}
