import { expect, test } from "vitest";
import { conflictWrites, isLocal, systemKeysChanged } from "../src/client/guardLogic";

const c = { title: { mine: "A", theirs: "B" }, due_time: { mine: null, theirs: "09:30" } };
test("mine → write my values back (null = remove)", () => expect(conflictWrites(c, "mine")).toEqual({ set: { title: "A" }, unset: ["due_time"] }));
test("server → dismiss request only, no writable change", () => expect(conflictWrites(c, "server")).toEqual({ set: { _request: "dismiss-conflict" }, unset: [] }));
test("isLocal (S9)", () => {
  const sam = { isFileProcessing: (p: string) => p === "busy", recentlyTouched: (f: { path: string }) => f.path === "touched" };
  expect(isLocal(sam, { path: "x", stat: { mtime: 1, size: 1 } })).toBe(true);
  expect(isLocal(sam, { path: "busy", stat: { mtime: 1, size: 1 } })).toBe(false);
  expect(isLocal(sam, { path: "touched", stat: { mtime: 1, size: 1 } })).toBe(false);
  expect(isLocal(undefined, { path: "x", stat: { mtime: 1, size: 1 } })).toBeUndefined();
});
test("systemKeysChanged", () => {
  expect(systemKeysChanged({ _etag: "1", title: "a" }, { _etag: "2", title: "b" })).toEqual(["_etag"]);
  expect(systemKeysChanged({ title: "a" }, { title: "b" })).toEqual([]);
});

test("isLocalDelete: only isFileProcessing counts (recentlyTouched is true for any file LiveSync last wrote)", async () => {
  const { isLocalDelete } = await import("../src/client/guardLogic");
  const sam = { isFileProcessing: (p: string) => p === "busy", recentlyTouched: () => true };
  expect(isLocalDelete(sam, "x")).toBe(true);
  expect(isLocalDelete(sam, "busy")).toBe(false);
  expect(isLocalDelete(undefined, "x")).toBeUndefined();
});

test("OwnOps: the guard ignores events it caused itself", async () => {
  const { OwnOps } = await import("../src/client/guardLogic");
  const o = new OwnOps(() => 1000);
  o.mark("caldav/a.md");
  expect(o.has("caldav/a.md")).toBe(true);
  expect(o.has("caldav/b.md")).toBe(false);
  const later = new OwnOps(() => 1000 + 11_000); (later as unknown as { m: Map<string, number> }).m = (o as unknown as { m: Map<string, number> }).m;
  expect(later.has("caldav/a.md")).toBe(false);
});
