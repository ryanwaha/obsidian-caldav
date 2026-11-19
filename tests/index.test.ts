import "fake-indexeddb/auto";
import { afterEach, expect, test, vi } from "vitest";
import { CacheStore } from "../src/cache/db";
import { MemoryIndex } from "../src/render/index";
import type { CalObject } from "../src/types";

const stores: CacheStore[] = [];
afterEach(() => { while (stores.length) stores.pop()!.close(); });
const open = async () => { const s = await CacheStore.open(`idx-${Math.random()}`, "fp"); stores.push(s); return s; };
const obj = (href: string, shortId: string): CalObject => ({ href, collection: "/c/", etag: '"1"', uid: href, shortId, kind: "VTODO", summary: href, hasOverrides: false, ics: "" });

test("allObjects / allTombstones", async () => {
  const c = await open();
  await c.upsertObjects([obj("/a", "aaaaaaaa"), obj("/b", "bbbbbbbb"), obj("/c", "cccccccc")]);
  await c.removeObjects(["/b"], 1);
  expect((await c.allObjects()).map((o) => o.href).sort()).toEqual(["/a", "/c"]);
  expect((await c.allTombstones()).map((t) => t.href)).toEqual(["/b"]);
});

test("load 後同步查詢；大寫 id 也查得到", async () => {
  const c = await open();
  await c.upsertObjects([obj("/a", "aaaaaaaa"), obj("/b", "bbbbbbbb")]);
  await c.removeObjects(["/b"], 1);
  const idx = new MemoryIndex();
  expect(idx.get("aaaaaaaa")).toEqual({ objs: [], tombs: [], pending: [] });
  await idx.load(c);
  expect(idx.get("AAAAAAAA").objs.map((o) => o.href)).toEqual(["/a"]);
  expect(idx.get("bbbbbbbb")).toMatchObject({ objs: [], tombs: [{ href: "/b" }] });
});

test("onChange 與取消訂閱、version 遞增", async () => {
  const c = await open();
  const idx = new MemoryIndex();
  const fn = vi.fn();
  const off = idx.onChange(fn);
  const v0 = idx.version;
  await idx.load(c);
  expect(fn).toHaveBeenCalledTimes(1);
  expect(idx.version).toBe(v0 + 1);
  off();
  await idx.load(undefined);
  expect(fn).toHaveBeenCalledTimes(1);
  expect(idx.version).toBe(v0 + 2);
});

test("load(undefined) 清空", async () => {
  const c = await open();
  await c.upsertObjects([obj("/a", "aaaaaaaa")]);
  const idx = new MemoryIndex();
  await idx.load(c);
  await idx.load(undefined);
  expect(idx.get("aaaaaaaa")).toEqual({ objs: [], tombs: [], pending: [] });
});

test("listener 拋例外不影響其他 listener", async () => {
  const idx = new MemoryIndex();
  const good = vi.fn();
  idx.onChange(() => { throw new Error("bad"); });
  idx.onChange(good);
  await idx.load(undefined);
  expect(good).toHaveBeenCalledTimes(1);
});

test("touch：只遞增 version 並通知，不改資料", async () => {
  const c = await open();
  await c.upsertObjects([obj("/a", "aaaaaaaa")]);
  const idx = new MemoryIndex();
  await idx.load(c);
  const fn = vi.fn();
  idx.onChange(fn);
  const v = idx.version;
  idx.touch();
  expect(idx.version).toBe(v + 1);
  expect(fn).toHaveBeenCalledTimes(1);
  expect(idx.get("aaaaaaaa").objs).toHaveLength(1);
});

test("pending 也可用短 ID 查到", async () => {
  const c = await open();
  await c.enqueue({ uid: "n1", shortId: "pppppppp", fingerprint: "fp", collection: "/c/", href: "/c/n1.ics", ics: "", summary: "新", createdAt: 1, attempts: 0, state: "queued" });
  const idx = new MemoryIndex();
  await idx.load(c);
  expect(idx.get("pppppppp").pending.map((p) => p.uid)).toEqual(["n1"]);
  expect(idx.get("zzzzzzzz").pending).toEqual([]);
});
