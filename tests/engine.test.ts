import "fake-indexeddb/auto";
import { afterEach, describe, expect, test } from "vitest";
import { CacheStore } from "../src/cache/db";
import { CalDavClient } from "../src/caldav/client";
import type { HttpRequest } from "../src/caldav/http";
import { shortId } from "../src/shortid";
import { SyncEngine } from "../src/sync/engine";
import { fakeTransport, xml, type Route } from "./fakeTransport";
import { radicale } from "./fixtures";
import { syncMs, todo } from "./msBuilder";

const SERVER = "https://cal.example";
const TEST = "/ryanw/test/", TASKS = "/ryanw/tasks/";
const onlyTasksCollections = radicale("propfind-collections.xml").replace(/<response><href>\/ryanw\/test\/<\/href>.*?<\/response>/s, "");

const stores: CacheStore[] = [];
afterEach(() => { while (stores.length) stores.pop()!.close(); });

async function setup(reports: Record<string, Route | Route[]>, collections: Route | Route[] = xml(radicale("propfind-collections.xml"))) {
  const cols = Array.isArray(collections) ? collections : [collections];
  const { transport, calls } = fakeTransport({
    "PROPFIND /": xml(radicale("propfind-principal.xml")),
    "PROPFIND /ryanw/": (req: HttpRequest) => (req.body!.includes("calendar-home-set") ? xml(radicale("propfind-home-set.xml")) : nextCol()),
    ...Object.fromEntries(Object.entries(reports).map(([k, v]) => [`REPORT ${k}`, v])),
  });
  let ci = 0;
  const nextCol = () => { const r = cols[Math.min(ci++, cols.length - 1)]; return typeof r === "function" ? (r as any)() : r; };
  const cache = await CacheStore.open(`engine-${Math.random()}`, "fp");
  stores.push(cache);
  let t = 1000;
  const engine = new SyncEngine(new CalDavClient(SERVER, "Basic x", transport), cache, () => t++);
  return { engine, cache, calls };
}
const tokenOf = async (cache: CacheStore, href: string) => (await cache.getCollections()).find((c) => c.href === href)?.syncToken;

describe("SyncEngine", () => {
  test("初次同步寫入兩個清單並記下 token", async () => {
    const { engine, cache } = await setup({
      [TEST]: xml(syncMs("t-test-1", [{ href: `${TEST}a.ics`, ics: todo("a") }, { href: `${TEST}b.ics`, ics: todo("b") }])),
      [TASKS]: xml(syncMs("t-tasks-1", [{ href: `${TASKS}c.ics`, ics: todo("c") }])),
    });
    const r = await engine.syncAll();
    expect(r.errors).toEqual([]);
    expect(r).toMatchObject({ collections: 2, objects: 3, changed: 3, removed: 0, skipped: 0 });
    expect(await cache.count()).toBe(3);
    expect(await tokenOf(cache, TEST)).toBe("t-test-1");
    expect(await tokenOf(cache, TASKS)).toBe("t-tasks-1");
    expect(engine.lastReport).toBe(r);
  });

  test("增量：刪一筆、改一筆", async () => {
    const { engine, cache, calls } = await setup({
      [TEST]: [
        xml(syncMs("t1", [{ href: `${TEST}a.ics`, ics: todo("a") }, { href: `${TEST}b.ics`, ics: todo("b") }])),
        xml(syncMs("t2", [{ href: `${TEST}a.ics`, etag: '"2"', ics: todo("a", "a 改") }], [`${TEST}b.ics`])),
      ],
      [TASKS]: xml(syncMs("k1", [])),
    });
    await engine.syncAll();
    const r = await engine.syncAll();
    expect(r).toMatchObject({ changed: 1, removed: 1, objects: 1 });
    const a = await cache.findByShortId(await shortId("a"));
    expect(a[0]).toMatchObject({ etag: '"2"', summary: "a 改" });
    expect(await cache.findTombstonesByShortId(await shortId("b"))).toHaveLength(1);
    const second = calls.filter((c) => c.method === "REPORT" && c.url.endsWith(TEST))[1];
    expect(second.body).toContain("<d:sync-token>t1</d:sync-token>");
    expect(await tokenOf(cache, TEST)).toBe("t2");
  });

  test("token 過期 → 全量同步，消失的轉刪除紀錄", async () => {
    const { engine, cache, calls } = await setup({
      [TEST]: [
        xml(syncMs("t1", [{ href: `${TEST}a.ics`, ics: todo("a") }, { href: `${TEST}b.ics`, ics: todo("b") }])),
        xml(radicale("sync-invalid-token-403.xml"), 403),
        xml(syncMs("t-full", [{ href: `${TEST}a.ics`, ics: todo("a") }])),
      ],
      [TASKS]: xml(syncMs("k1", [])),
    });
    await engine.syncAll();
    const r = await engine.syncAll();
    expect(r.errors).toEqual([]);
    expect(r.removed).toBe(1);
    expect(await cache.hrefsInCollection(TEST)).toEqual([`${TEST}a.ics`]);
    const reports = calls.filter((c) => c.method === "REPORT" && c.url.endsWith(TEST));
    expect(reports[2].body).toContain("<d:sync-token/>");
    expect(await tokenOf(cache, TEST)).toBe("t-full");
  });

  test("清單在伺服器上消失 → 物件轉刪除紀錄、清單移除", async () => {
    const { engine, cache } = await setup(
      { [TEST]: xml(syncMs("t1", [{ href: `${TEST}a.ics`, ics: todo("a") }])), [TASKS]: xml(syncMs("k1", [{ href: `${TASKS}c.ics`, ics: todo("c") }])) },
      [xml(radicale("propfind-collections.xml")), xml(onlyTasksCollections)],
    );
    await engine.syncAll();
    const r = await engine.syncAll();
    expect(r.removed).toBe(1);
    expect(r.collections).toBe(1);
    expect((await cache.getCollections()).map((c) => c.href)).toEqual([TASKS]);
    expect(await cache.hrefsInCollection(TEST)).toEqual([]);
  });

  test("清單改名只更新 displayName，token 保留", async () => {
    const renamed = radicale("propfind-collections.xml").replace("<displayname>任務</displayname>", "<displayname>工作</displayname>");
    const { engine, cache, calls } = await setup(
      { [TEST]: xml(syncMs("t1", [])), [TASKS]: [xml(syncMs("k1", [])), xml(syncMs("k2", []))] },
      [xml(radicale("propfind-collections.xml")), xml(renamed)],
    );
    await engine.syncAll();
    await engine.syncAll();
    expect((await cache.getCollections()).find((c) => c.href === TASKS)!.displayName).toBe("工作");
    const second = calls.filter((c) => c.method === "REPORT" && c.url.endsWith(TASKS))[1];
    expect(second.body).toContain("<d:sync-token>k1</d:sync-token>");
  });

  test("錯誤隔離：test 500，tasks 照常；test 的 token 不前進", async () => {
    const { engine, cache } = await setup({
      [TEST]: { status: 500, headers: {}, text: "boom" },
      [TASKS]: xml(syncMs("k1", [{ href: `${TASKS}c.ics`, ics: todo("c") }])),
    });
    const r = await engine.syncAll();
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].collection).toBe(TEST);
    expect(r.errors[0].message).toContain("500");
    expect(await cache.count()).toBe(1);
    expect(await tokenOf(cache, TEST)).toBeUndefined();
  });

  test("離線：全部逾時，快取不動", async () => {
    const ok = await setup({ [TEST]: xml(syncMs("t1", [{ href: `${TEST}a.ics`, ics: todo("a") }])), [TASKS]: xml(syncMs("k1", [])) });
    await ok.engine.syncAll();
    const failing = new SyncEngine(new CalDavClient(SERVER, "Basic x", async () => { throw new Error("timeout"); }), ok.cache);
    const r = await failing.syncAll();
    expect(r).toMatchObject({ collections: 0, changed: 0, removed: 0 });
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].message).toContain("timeout");
    expect(await ok.cache.count()).toBe(1);
  });

  test("無法解析的資源：skipped 計數，其他照寫；原本在快取的會被移除", async () => {
    const { engine, cache } = await setup({
      [TEST]: [
        xml(syncMs("t1", [{ href: `${TEST}a.ics`, ics: todo("a") }, { href: `${TEST}b.ics`, ics: todo("b") }])),
        xml(syncMs("t2", [{ href: `${TEST}b.ics`, ics: "garbage" }, { href: `${TEST}z.ics`, ics: "" }])),
      ],
      [TASKS]: xml(syncMs("k1", [])),
    });
    await engine.syncAll();
    const r = await engine.syncAll();
    expect(r.skipped).toBe(2);
    expect(r.removed).toBe(1);
    expect(await cache.hrefsInCollection(TEST)).toEqual([`${TEST}a.ics`]);
  });

  test("single-flight：同時呼叫兩次只跑一輪", async () => {
    const { engine, calls } = await setup({ [TEST]: xml(syncMs("t1", [])), [TASKS]: xml(syncMs("k1", [])) });
    const p1 = engine.syncAll(), p2 = engine.syncAll();
    expect(p2).toBe(p1);
    await p1;
    expect(calls.filter((c) => c.method === "REPORT")).toHaveLength(2);
    await engine.syncAll();
    expect(calls.filter((c) => c.method === "REPORT")).toHaveLength(4);
  });
});
