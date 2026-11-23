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

describe("pending queue (db v2)", () => {
  const pending = (uid: string, extra: Partial<import("../src/types").PendingCreate> = {}) => ({
    uid, shortId: "pppppppp", fingerprint: "srv|ryanw", collection: "/c/", href: `/c/${uid}.ics`, ics: "BEGIN:VCALENDAR",
    summary: `S ${uid}`, createdAt: 1, attempts: 0, state: "queued" as const, ...extra,
  });

  test("從 v1 資料庫升級：資料保留，可 enqueue", async () => {
    const name = fresh();
    await new Promise<void>((resolve, reject) => {
      const r = indexedDB.open(name, 1);
      r.onupgradeneeded = () => {
        const db = r.result;
        db.createObjectStore("meta");
        db.createObjectStore("collections", { keyPath: "href" });
        const o = db.createObjectStore("objects", { keyPath: "href" });
        o.createIndex("shortId", "shortId"); o.createIndex("collection", "collection");
        db.createObjectStore("tombstones", { keyPath: "href" }).createIndex("shortId", "shortId");
      };
      r.onsuccess = () => {
        const db = r.result;
        const tx = db.transaction(["meta", "objects"], "readwrite");
        tx.objectStore("meta").put("srv|ryanw", "fingerprint");
        tx.objectStore("objects").put(obj("/a.ics", "aaaaaaaa"));
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
      r.onerror = () => reject(r.error);
    });
    const s = await open(name, "srv|ryanw");
    expect(await s.count()).toBe(1);
    await s.enqueue(pending("p1"));
    expect((await s.allPending()).map((p) => p.uid)).toEqual(["p1"]);
  });

  test("enqueue / update / remove", async () => {
    const s = await open(fresh());
    await s.enqueue(pending("p1"));
    await s.updatePending(pending("p1", { state: "failed", lastError: "HTTP 403", attempts: 1 }));
    expect((await s.allPending())[0]).toMatchObject({ state: "failed", lastError: "HTTP 403", attempts: 1 });
    await s.removePending("p1");
    expect(await s.allPending()).toEqual([]);
  });

  test("換 fingerprint：快取清空，待送保留", async () => {
    const name = fresh();
    let s = await open(name, "A");
    await s.upsertObjects([obj("/a.ics", "aaaaaaaa")]);
    await s.enqueue(pending("p1", { fingerprint: "A" }));
    s.close();
    s = await open(name, "B");
    expect(s.fingerprint).toBe("B");
    expect(await s.count()).toBe(0);
    expect((await s.allPending()).map((p) => p.uid)).toEqual(["p1"]);
  });
});

test("I2：舊版連線未關閉導致升級被擋時，open 會失敗而不是永遠等待", async () => {
  const name = fresh();
  const v1 = await new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open(name, 1);
    r.onupgradeneeded = () => { r.result.createObjectStore("meta"); };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  // v1 連線沒有 onversionchange，也不關閉
  await expect(CacheStore.open(name, "fp")).rejects.toThrow(/其他/);
  v1.close();
});

describe("aliases (db v3)", () => {
  const alias = (fromUid: string, extra: Partial<import("../src/types").Alias> = {}): import("../src/types").Alias => ({
    fromUid, fromShortId: "oldoldol", toUid: "new-uid", toShortId: "newnewne", detectedAt: 1, ...extra,
  });

  test("removeObjects 的刪除紀錄帶 kind", async () => {
    const s = await open(fresh());
    await s.upsertObjects([obj("/e.ics", "eeeeeeee", { kind: "VEVENT" })]);
    await s.removeObjects(["/e.ics"], 7);
    expect((await s.findTombstonesByShortId("eeeeeeee"))[0]).toMatchObject({ kind: "VEVENT", deletedAt: 7 });
  });

  test("putAliases / allAliases；同 fromUid 覆蓋", async () => {
    const s = await open(fresh());
    await s.putAliases([alias("u1"), alias("u2", { fromShortId: "bbbbbbbb" })]);
    await s.putAliases([alias("u1", { toUid: "x" })]);
    const all = await s.allAliases();
    expect(all).toHaveLength(2);
    expect(all.find((a) => a.fromUid === "u1")!.toUid).toBe("x");
  });

  test("從 v2 升級：pending 與物件保留；換帳號清空 aliases", async () => {
    const name = fresh();
    await new Promise<void>((resolve, reject) => {
      const r = indexedDB.open(name, 2);
      r.onupgradeneeded = () => {
        const db = r.result;
        db.createObjectStore("meta");
        db.createObjectStore("collections", { keyPath: "href" });
        const o = db.createObjectStore("objects", { keyPath: "href" });
        o.createIndex("shortId", "shortId"); o.createIndex("collection", "collection");
        db.createObjectStore("tombstones", { keyPath: "href" }).createIndex("shortId", "shortId");
        db.createObjectStore("pending", { keyPath: "uid" }).createIndex("shortId", "shortId");
      };
      r.onsuccess = () => {
        const db = r.result;
        const tx = db.transaction(["meta", "objects", "pending"], "readwrite");
        tx.objectStore("meta").put("A", "fingerprint");
        tx.objectStore("objects").put(obj("/a.ics", "aaaaaaaa"));
        tx.objectStore("pending").put({ uid: "p1", shortId: "pppppppp", fingerprint: "A" });
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
      r.onerror = () => reject(r.error);
    });
    let s = await open(name, "A");
    expect(await s.count()).toBe(1);
    expect(await s.allPending()).toHaveLength(1);
    await s.putAliases([alias("u1")]);
    s.close();
    s = await open(name, "B");
    expect(await s.allAliases()).toEqual([]);
    expect(await s.allPending()).toHaveLength(1);
  });
});

describe("projections store (M6-2)", () => {
  const snap = (path: string) => ({ path, uid: `u-${path}`, fm: { title: "t", _etag: '"1"' }, body: "筆記\n", writtenAt: 1 });
  test("projections round-trip", async () => {
    const s = await open(fresh());
    await s.putProjection(snap("caldav/a.md"));
    expect(await s.getProjection("caldav/a.md")).toEqual(snap("caldav/a.md"));
    expect(await s.allProjections()).toHaveLength(1);
    await s.deleteProjection("caldav/a.md");
    expect(await s.getProjection("caldav/a.md")).toBeUndefined();
  });
  test("upgrade from v3 keeps objects", async () => {
    const name = fresh();
    await new Promise<void>((resolve, reject) => {
      const r = indexedDB.open(name, 3);
      r.onupgradeneeded = () => {
        const db = r.result;
        db.createObjectStore("meta"); db.createObjectStore("collections", { keyPath: "href" });
        const o = db.createObjectStore("objects", { keyPath: "href" }); o.createIndex("shortId", "shortId"); o.createIndex("collection", "collection");
        db.createObjectStore("tombstones", { keyPath: "href" }).createIndex("shortId", "shortId");
        db.createObjectStore("pending", { keyPath: "uid" }).createIndex("shortId", "shortId");
        db.createObjectStore("aliases", { keyPath: "fromUid" }).createIndex("fromShortId", "fromShortId");
        o.put(obj("/v3.ics", "vvvvvvvv")); db.transaction; r.transaction!.objectStore("meta").put("srv|ryanw", "fingerprint");
      };
      r.onsuccess = () => { r.result.close(); resolve(); };
      r.onerror = () => reject(r.error);
    });
    const s = await open(name);
    expect((await s.findByShortId("vvvvvvvv")).map((o) => o.href)).toEqual(["/v3.ics"]);
    await s.putProjection(snap("caldav/b.md"));
    expect(await s.getProjection("caldav/b.md")).toBeDefined();
  });
  test("fingerprint change clears projections", async () => {
    const name = fresh();
    const s = await open(name);
    await s.putProjection(snap("caldav/a.md"));
    s.close();
    const s2 = await open(name, "other|user");
    expect(await s2.allProjections()).toEqual([]);
  });
});
