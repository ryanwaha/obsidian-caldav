import type { EditorState } from "@codemirror/state";
import { type RefMatch, findRefs } from "./refs";

/**
 * 可視範圍內、需要渲染的參照（依位置排序、不重複）。
 * 可視範圍可能在行中切開（長行、block widget），所以以「行」為單位去重。
 * inCode 檢查的是 "(cal:" 的位置，標籤以行內程式碼開頭時不會誤判。
 */
export function collectRefs(
  state: EditorState,
  ranges: readonly { from: number; to: number }[],
  selection: readonly { from: number; to: number }[],
  inCode: (state: EditorState, pos: number) => boolean,
): RefMatch[] {
  const out: RefMatch[] = [];
  let lastLine = 0;
  for (const { from, to } of ranges) {
    for (let n = Math.max(state.doc.lineAt(from).number, lastLine + 1); n <= state.doc.lineAt(to).number; n++) {
      const line = state.doc.line(n);
      lastLine = n;
      for (const r of findRefs(line.text, line.from)) {
        if (selection.some((s) => s.from <= r.to && s.to >= r.from)) continue; // 游標或選取進入：顯示原文
        if (inCode(state, r.from + r.label.length + 2)) continue;
        out.push(r);
      }
    }
  }
  return out;
}
