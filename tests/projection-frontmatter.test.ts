import { expect, test } from "vitest";
import { newFileContent, splitFrontmatter } from "../src/projection/frontmatter";

const parse = (y: string) => JSON.parse(`{${y.split("\n").filter(Boolean).map((l) => { const i = l.indexOf(": "); return `${JSON.stringify(l.slice(0, i))}:${JSON.stringify(l.slice(i + 2))}`; }).join(",")}}`);

test("title ending with --- does not end the frontmatter", () => {
  const r = splitFrontmatter("---\ntitle: 分隔---\n_uid: u1\n---\n", parse);
  expect(r.fm).toEqual({ title: "分隔---", _uid: "u1" });
  expect(r.body).toBe("");
});

test("a --- line inside a block scalar does not end the frontmatter", () => {
  const yaml = "_notes: |-\n  上\n  ---\n  下\n_uid: u1";
  const seen: string[] = [];
  const r = splitFrontmatter(`---\n${yaml}\n---\n正文\n`, (y) => { seen.push(y); return { _uid: "u1" }; });
  expect(seen[0]).toBe(yaml);
  expect(r.body).toBe("正文\n");
});

test("no frontmatter → fm null, whole text is body", () => {
  expect(splitFrontmatter("正文\n", parse)).toEqual({ fm: null, body: "正文\n" });
});

test("newFileContent round-trips through splitFrontmatter", () => {
  const text = newFileContent({ _uid: "u1", title: "x" }, (o) => Object.entries(o).map(([k, v]) => `${k}: ${v}`).join("\n") + "\n");
  expect(text.startsWith("---\n")).toBe(true);
  expect(splitFrontmatter(text, parse).fm).toEqual({ _uid: "u1", title: "x" });
});
