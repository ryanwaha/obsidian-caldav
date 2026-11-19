import "fake-indexeddb/auto";
import { afterEach, describe, expect, test } from "vitest";
import { CacheStore } from "../src/cache/db";
import type { CalObject } from "../src/types";

let n = 0;
const fresh = () => `db-test-${++n}-${Math.random()}`;
const opened: CacheStore[] = [];
async function open(name: string, fp = "srv|ryanw") { const s = await CacheStore.open(name, fp); opened.push(s); return s; }
afterEach(() => { while (opened.length) opened.pop()!.close(); });

const obj = (href: string, shortId: string, extra: Partial<CalObject> = {}): CalObject => ({
  href, collection: "/ryanw/test/", etag: '"1"', uid: href, shortId, kind: "VTODO",
  summary: `S ${href}`, created: "20261119T000000Z", hasOverrides: false, ics: "BEGIN:VCALENDAR", ...extra,
});

describe("CacheStore", () => {
  test("upsert 後可用短 ID 查詢；同 href 覆蓋", async () => {
    const s = await open(fresh());
    await s.upsertObjects([obj("/a.ics", "aaaaaaaa"), obj("/b.ics", "bbbbbbbb")]);
    expect((await s.findByShortId("aaaaaaaa")).map((o) => o.href)).toEqual(["/a.ics"]);
    await s.upsertObjects([obj("/a.ics", "aaaaaaaa", { etag: '"2"' })]);
    expect(await s.count()).toBe(2);
    expect((await s.findByShortId("aaaaaaaa"))[0].etag).toBe('"2"');
  });

  test("同短 ID 多筆都回傳（歧義）", async () => {
    const s = await open(fresh());
    await s.upsertObjects([obj("/a.ics", "samesame"), obj("/b.ics", "samesame")]);
    expect(await s.findByShortId("samesame")).toHaveLength(2);
  });

  test("removeObjects 轉成刪除紀錄，只算快取裡有的", async () => {
    const s = await open(fresh());
    await s.upsertObjects([obj("/a.ics", "aaaaaaaa")]);
    expect(await s.removeObjects(["/a.ics", "/never.ics"], 1000)).toBe(1);
    expect(await s.findByShortId("aaaaaaaa")).toEqual([]);
    const ts = await s.findTombstonesByShortId("aaaaaaaa");
    expect(ts).toHaveLength(1);
    expect(ts[0]).toMatchObject({ href: "/a.ics", uid: "/a.ics", summary: "S /a.ics", created: "20261119T000000Z", deletedAt: 1000, collection: "/ryanw/test/" });
    expect(await s.findTombstonesByShortId(await Promise.resolve("zzzzzzzz"))).toEqual([]);
  });

  test("重新 upsert 會移除刪除紀錄", async () => {
    const s = await open(fresh());
    await s.upsertObjects([obj("/a.ics", "aaaaaaaa")]);
    await s.removeObjects(["/a.ics"], 1);
    await s.upsertObjects([obj("/a.ics", "aaaaaaaa")]);
    expect(await s.findTombstonesByShortId("aaaaaaaa")).toEqual([]);
  });

  test("hrefsInCollection", async () => {
    const s = await open(fresh());
    await s.upsertObjects([obj("/a.ics", "aaaaaaaa"), obj("/x.ics", "xxxxxxxx", { collection: "/ryanw/tasks/" })]);
    expect(await s.hrefsInCollection("/ryanw/test/")).toEqual(["/a.ics"]);
  });

  test("清單存取與刪除", async () => {
    const s = await open(fresh());
    await s.putCollection({ href: "/ryanw/test/", displayName: "測試", components: ["VTODO"], syncToken: "t1", lastSyncAt: 5 });
    expect(await s.getCollections()).toEqual([{ href: "/ryanw/test/", displayName: "測試", components: ["VTODO"], syncToken: "t1", lastSyncAt: 5 }]);
    await s.deleteCollection("/ryanw/test/");
    expect(await s.getCollections()).toEqual([]);
  });

  test("同 fingerprint 重開資料仍在；換 fingerprint 清空", async () => {
    const name = fresh();
    let s = await open(name, "A");
    await s.upsertObjects([obj("/a.ics", "aaaaaaaa"), obj("/d.ics", "dddddddd")]);
    await s.putCollection({ href: "/c/", displayName: "c", components: ["VTODO"] });
    await s.removeObjects(["/d.ics"], 0);
    s.close();
    s = await open(name, "A");
    expect(await s.count()).toBe(1);
    s.close();
    s = await open(name, "B");
    expect(await s.count()).toBe(0);
    expect(await s.getCollections()).toEqual([]);
    expect(await s.findTombstonesByShortId("dddddddd")).toEqual([]);
  });
});
