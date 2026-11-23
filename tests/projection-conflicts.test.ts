import { expect, test } from "vitest";
import { mergeConflictVersions } from "../src/projection/conflicts";

const fm = (o: Record<string, unknown>) => o;
const server = fm({ title: "伺服器", status: "needs-action", list: "tasks", _uid: "u", _etag: '"s"', _sync: "ok", _deleted: false });

test("same-body", () => {
  const r = mergeConflictVersions(server, { fm: { ...server, title: "A" }, body: "筆記\n" }, { fm: { ...server, title: "B" }, body: "筆記\n" });
  expect(r.fm).toMatchObject({ title: "伺服器", _sync: "conflict" });
  expect(r.body).toBe("筆記\n");
});

test("different-body-concatenated", () => {
  const r = mergeConflictVersions(server, { fm: server, body: "甲\n" }, { fm: server, body: "乙\n" });
  expect(r.body).toBe("甲\n\n---\n（LiveSync 衝突合併）\n\n乙\n");
});

test("device-value-into-_conflict", () => {
  const r = mergeConflictVersions(server, { fm: { ...server, title: "A" }, body: "" }, { fm: { ...server }, body: "" });
  expect(r.fm._conflict).toEqual({ title: { mine: "A", theirs: "伺服器" } });
});

test("own-write-noop", () => {
  const r = mergeConflictVersions(server, { fm: { ...server, _etag: '"old"', _sync: "rejected" }, body: "x" }, { fm: { ...server }, body: "x" });
  expect(r.fm).not.toHaveProperty("_conflict");
  expect(r.fm._sync).toBe("ok");
  expect(r.fm._etag).toBe('"s"');
});
