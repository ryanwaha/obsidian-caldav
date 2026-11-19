import { EditorState } from "@codemirror/state";
import { expect, test } from "vitest";
import { collectRefs } from "../src/render/viewRefs";

const doc = "x [](cal:5cd3cmqd) y [](cal:x2n6srvv)\nsecond [](cal:7pmqbjh5)";
const state = EditorState.create({ doc });
const none = () => false;

test("I3：可視範圍在行中切開時不重複、保持排序", () => {
  const mid = 10;
  const refs = collectRefs(state, [{ from: 0, to: mid }, { from: mid + 5, to: doc.length }], [], none);
  expect(refs.map((r) => r.id)).toEqual(["5cd3cmqd", "x2n6srvv", "7pmqbjh5"]);
});

test("選取範圍碰到參照時略過", () => {
  const refs = collectRefs(state, [{ from: 0, to: doc.length }], [{ from: 5, to: 5 }], none);
  expect(refs.map((r) => r.id)).toEqual(["x2n6srvv", "7pmqbjh5"]);
});

test("inCode 為真的略過；檢查位置是 '(cal:' 而非標籤第一個字", () => {
  const s = EditorState.create({ doc: "[`x`](cal:5cd3cmqd)" });
  const checked: number[] = [];
  const refs = collectRefs(s, [{ from: 0, to: s.doc.length }], [], (_st, pos) => { checked.push(pos); return false; });
  expect(refs).toHaveLength(1);
  expect(checked).toEqual(["[`x`]".length]);
});
