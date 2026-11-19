import "fake-indexeddb/auto";
import { afterEach, describe, expect, test } from "vitest";
import { CacheStore } from "../src/cache/db";
import { CalDavClient } from "../src/caldav/client";
import type { HttpRequest } from "../src/caldav/http";
import { parseResource } from "../src/ical/parse";
import { shortId } from "../src/shortid";
import { SyncEngine } from "../src/sync/engine";
import { MoveResolver } from "../src/sync/moves";
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

  test("無法解析的資源：skipped 記錄原因；已在快取的保留舊版、不寫刪除紀錄", async () => {
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
    expect(r.removed).toBe(0);
    expect(r.skippedItems.map((s) => s.href).sort()).toEqual([`${TEST}b.ics`, `${TEST}z.ics`]);
    expect(r.skippedItems.every((s) => s.reason.length > 0)).toBe(true);
    expect((await cache.hrefsInCollection(TEST)).sort()).toEqual([`${TEST}a.ics`, `${TEST}b.ics`]);
    expect(await cache.findTombstonesByShortId(await shortId("b"))).toEqual([]);
  });

  test("快取連線已關閉：syncAll 回傳帶錯誤的 report，不 reject", async () => {
    const { engine, cache } = await setup({ [TEST]: xml(syncMs("t1", [])), [TASKS]: xml(syncMs("k1", [])) });
    cache.close();
    const r = await engine.syncAll();
    expect(r.errors.length).toBeGreaterThan(0);
    expect(engine.lastReport).toBe(r);
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

describe("flush pending creates", () => {
  const P = (uid: string, extra: Partial<import("../src/types").PendingCreate> = {}) => ({
    uid, shortId: "pppppppp", fingerprint: "fp", collection: TEST, href: `${TEST}${uid}.ics`, ics: todo(uid, `新 ${uid}`),
    summary: `新 ${uid}`, createdAt: 1, attempts: 0, state: "queued" as const, ...extra,
  });

  test("201：送出、寫入快取、清出佇列；PUT 在 REPORT 之前", async () => {
    const put = { status: 201, headers: { ETag: '"new"' }, text: "" };
    const t = await setupWithPut(put);
    // 清單已同步過（有 token）：增量結果為空，驗證的是 flush 自己寫入快取
    await t.cache.putCollection({ href: TEST, displayName: "測試", components: ["VTODO"], syncToken: "t0" });
    await t.cache.enqueue(P("n1"));
    const r = await t.engine.syncAll();
    expect(r.sent).toBe(1);
    expect(await t.cache.allPending()).toEqual([]);
    expect((await t.cache.findByShortId(await shortId("n1")))[0]).toMatchObject({ summary: "新 n1", etag: '"new"' });
    const methods = t.calls.map((c) => c.method);
    expect(methods.indexOf("PUT")).toBeLessThan(methods.indexOf("REPORT"));
    expect(r).toMatchObject({ pendingQueued: 0, pendingFailed: 0 });
  });

  test("412：視為已送出", async () => {
    const t = await setupWithPut({ status: 412, headers: {}, text: "" });
    await t.cache.enqueue(P("n1"));
    const r = await t.engine.syncAll();
    expect(r.sent).toBe(1);
    expect(await t.cache.allPending()).toEqual([]);
  });

  test("I1：412 後清單同步失敗，物件仍在快取（chip 不會變查無此物）", async () => {
    const t = await setupWithPut({ status: 412, headers: {}, text: "" }, { status: 500, headers: {}, text: "" });
    await t.cache.enqueue(P("n1"));
    await t.engine.syncAll();
    expect(await t.cache.allPending()).toEqual([]);
    expect((await t.cache.findByShortId(await shortId("n1")))[0]).toMatchObject({ summary: "新 n1" });
  });

  test("I1：412 時不覆蓋快取裡已有的版本", async () => {
    const t = await setupWithPut({ status: 412, headers: {}, text: "" }, { status: 500, headers: {}, text: "" });
    const existing = await parseResource(todo("n1", "伺服器上的新標題"), { href: `${TEST}n1.ics`, etag: '"srv"', collection: TEST });
    await t.cache.upsertObjects([existing as any]);
    await t.cache.enqueue(P("n1"));
    await t.engine.syncAll();
    expect((await t.cache.findByShortId(await shortId("n1")))[0]).toMatchObject({ summary: "伺服器上的新標題", etag: '"srv"' });
  });

  test("M4：200 也算成功", async () => {
    const t = await setupWithPut({ status: 200, headers: {}, text: "" });
    await t.cache.enqueue(P("n1"));
    const r = await t.engine.syncAll();
    expect(r.sent).toBe(1);
    expect(r.errors).toEqual([]);
  });

  test.each([408, 423, 429])("M4：%i 是暫時性錯誤，保留 queued 並停止本輪", async (code) => {
    const t = await setupWithPut({ status: code, headers: {}, text: "" });
    await t.cache.enqueue(P("n1", { createdAt: 1 }));
    await t.cache.enqueue(P("n2", { createdAt: 2 }));
    await t.engine.syncAll();
    expect(t.calls.filter((c) => c.method === "PUT")).toHaveLength(1);
    expect((await t.cache.allPending()).every((p) => p.state === "queued")).toBe(true);
  });

  test("403：標為失敗並保留", async () => {
    const t = await setupWithPut({ status: 403, headers: {}, text: "" });
    await t.cache.enqueue(P("n1"));
    const r = await t.engine.syncAll();
    expect(r.sent).toBe(0);
    expect(await t.cache.allPending()).toEqual([expect.objectContaining({ uid: "n1", state: "failed", lastError: "HTTP 403", attempts: 1 })]);
    expect(r.pendingFailed).toBe(1);
  });

  test("逾時：保留 queued、停止本輪 flush", async () => {
    const t = await setupWithPut(() => { throw new Error("timeout"); });
    await t.cache.enqueue(P("n1", { createdAt: 1 }));
    await t.cache.enqueue(P("n2", { createdAt: 2 }));
    const r = await t.engine.syncAll();
    expect(t.calls.filter((c) => c.method === "PUT")).toHaveLength(1);
    expect(t.calls.find((c) => c.method === "PUT")!.url).toContain("n1.ics");
    const ps = await t.cache.allPending();
    expect(ps.every((p) => p.state === "queued")).toBe(true);
    expect(ps.find((p) => p.uid === "n1")!.attempts).toBe(1);
    expect(r.errors.some((e) => e.message.includes("timeout"))).toBe(true);
    expect(r.pendingQueued).toBe(2);
  });

  test("其他帳號的待送：不送、不動，計入 failed", async () => {
    const t = await setupWithPut({ status: 201, headers: {}, text: "" });
    await t.cache.enqueue(P("n1", { fingerprint: "other" }));
    const r = await t.engine.syncAll();
    expect(t.calls.some((c) => c.method === "PUT")).toBe(false);
    expect((await t.cache.allPending())[0]).toMatchObject({ state: "queued", attempts: 0 });
    expect(r.pendingFailed).toBe(1);
  });

  async function setupWithPut(put: Route, testReport: Route = xml(syncMs("t1", []))) {
    const { transport, calls } = fakeTransport({
      "PROPFIND /": xml(radicale("propfind-principal.xml")),
      "PROPFIND /ryanw/": (req: HttpRequest) => (req.body!.includes("calendar-home-set") ? xml(radicale("propfind-home-set.xml")) : xml(radicale("propfind-collections.xml"))),
      [`REPORT ${TEST}`]: testReport,
      [`REPORT ${TASKS}`]: xml(syncMs("k1", [])),
      [`PUT ${TEST}n1.ics`]: put,
      [`PUT ${TEST}n2.ics`]: put,
    });
    const cache = await CacheStore.open(`flush-${Math.random()}`, "fp");
    stores.push(cache);
    return { engine: new SyncEngine(new CalDavClient(SERVER, "Basic x", transport), cache), cache, calls };
  }
});

describe("flush pending updates", () => {
  const base = todo("u1", "原標題", ["DUE;VALUE=DATE:20261124", "STATUS:NEEDS-ACTION"]);
  const href = `${TEST}u1.ics`;
  const U = (patch: object, extra: object = {}) => ({
    op: "update" as const, uid: `upd:${href}`, objUid: "u1", shortId: "uuuuuuuu", fingerprint: "fp", collection: TEST, href,
    baseIcs: base, baseEtag: '"b"', patch, summary: "原標題", createdAt: 1, attempts: 0, state: "queued" as const, ...extra,
  });
  async function make(routes: Record<string, Route | Route[]>) {
    const { transport, calls } = fakeTransport({
      "PROPFIND /": xml(radicale("propfind-principal.xml")),
      "PROPFIND /ryanw/": (req: HttpRequest) => (req.body!.includes("calendar-home-set") ? xml(radicale("propfind-home-set.xml")) : xml(radicale("propfind-collections.xml"))),
      [`REPORT ${TEST}`]: { status: 500, headers: {}, text: "" }, // 讓結果只反映 flush
      [`REPORT ${TASKS}`]: xml(syncMs("k1", [])),
      ...routes,
    });
    const cache = await CacheStore.open(`upd-${Math.random()}`, "fp");
    stores.push(cache);
    return { engine: new SyncEngine(new CalDavClient(SERVER, "Basic x", transport), cache), cache, calls };
  }
  const cached = async (cache: CacheStore) => cache.getObject(href);

  test("2xx：PUT 帶 If-Match，寫入快取並移出佇列", async () => {
    const t = await make({ [`PUT ${href}`]: { status: 204, headers: { Etag: '"n"' }, text: "" } });
    await t.cache.enqueue(U({ summary: "新標題" }));
    const r = await t.engine.syncAll();
    const put = t.calls.find((c) => c.method === "PUT")!;
    expect(put.headers?.["If-Match"]).toBe('"b"');
    expect(put.body).toContain("SUMMARY:新標題");
    expect(await t.cache.allPending()).toEqual([]);
    expect(await cached(t.cache)).toMatchObject({ summary: "新標題", etag: '"n"' });
    expect(r.sent).toBe(1);
  });

  test("412 且伺服器改的是別的欄位：自動合併重送", async () => {
    const server = todo("u1", "原標題", ["DUE;VALUE=DATE:20261130", "STATUS:NEEDS-ACTION"]); // 別人改了日期
    const t = await make({
      [`PUT ${href}`]: [{ status: 412, headers: {}, text: "" }, { status: 204, headers: { Etag: '"m"' }, text: "" }],
      [`GET ${href}`]: { status: 200, headers: { Etag: '"s"' }, text: server },
    });
    await t.cache.enqueue(U({ summary: "新標題" }));
    await t.engine.syncAll();
    const puts = t.calls.filter((c) => c.method === "PUT");
    expect(puts).toHaveLength(2);
    expect(puts[1].headers?.["If-Match"]).toBe('"s"');
    expect(puts[1].body).toContain("SUMMARY:新標題");
    expect(puts[1].body).toContain("DUE;VALUE=DATE:20261130"); // 保留別人的修改
    expect(await t.cache.allPending()).toEqual([]);
    expect(await cached(t.cache)).toMatchObject({ summary: "新標題", etag: '"m"' });
  });

  test("412 且伺服器也改了同一欄位：標為衝突，不覆蓋", async () => {
    const server = todo("u1", "別人的標題", ["DUE;VALUE=DATE:20261124", "STATUS:NEEDS-ACTION"]);
    const t = await make({
      [`PUT ${href}`]: { status: 412, headers: {}, text: "" },
      [`GET ${href}`]: { status: 200, headers: { Etag: '"s"' }, text: server },
    });
    await t.cache.enqueue(U({ summary: "我的標題" }));
    await t.engine.syncAll();
    expect(t.calls.filter((c) => c.method === "PUT")).toHaveLength(1);
    const [p] = await t.cache.allPending();
    expect(p).toMatchObject({ state: "conflict" });
    expect((p as any).conflict).toMatchObject({ serverEtag: '"s"', mine: { summary: "我的標題" }, server: { summary: "別人的標題" } });
  });

  test("412 但伺服器的值剛好和我的一樣：視為成功", async () => {
    const server = todo("u1", "新標題", ["DUE;VALUE=DATE:20261124", "STATUS:NEEDS-ACTION"]);
    const t = await make({
      [`PUT ${href}`]: { status: 412, headers: {}, text: "" },
      [`GET ${href}`]: { status: 200, headers: { Etag: '"s"' }, text: server },
    });
    await t.cache.enqueue(U({ summary: "新標題" }));
    await t.engine.syncAll();
    expect(await t.cache.allPending()).toEqual([]);
  });

  test("伺服器上已刪除（404）：標為失敗", async () => {
    const t = await make({ [`PUT ${href}`]: { status: 412, headers: {}, text: "" }, [`GET ${href}`]: { status: 404, headers: {}, text: "" } });
    await t.cache.enqueue(U({ summary: "x" }));
    await t.engine.syncAll();
    expect((await t.cache.allPending())[0]).toMatchObject({ state: "failed", lastError: "伺服器上已刪除" });
  });

  test("baseEtag 為空：先 GET 取得 etag 再寫", async () => {
    const t = await make({
      [`GET ${href}`]: { status: 200, headers: { Etag: '"s"' }, text: base },
      [`PUT ${href}`]: { status: 204, headers: { Etag: '"n"' }, text: "" },
    });
    await t.cache.enqueue(U({ done: true }, { baseEtag: "" }));
    await t.engine.syncAll();
    const put = t.calls.find((c) => c.method === "PUT")!;
    expect(put.headers?.["If-Match"]).toBe('"s"');
    expect(await t.cache.allPending()).toEqual([]);
  });

  test("逾時：保留 queued", async () => {
    const t = await make({ [`PUT ${href}`]: () => { throw new Error("timeout"); } });
    await t.cache.enqueue(U({ summary: "x" }));
    await t.engine.syncAll();
    expect((await t.cache.allPending())[0]).toMatchObject({ state: "queued", attempts: 1 });
  });
});

describe("M4 review fixes", () => {
  const base = todo("u1", "原標題", ["DUE;VALUE=DATE:20261124", "STATUS:NEEDS-ACTION"]);
  const href = `${TEST}u1.ics`;
  const U = (patch: object, extra: object = {}) => ({
    op: "update" as const, uid: `upd:${href}`, objUid: "u1", shortId: "uuuuuuuu", fingerprint: "fp", collection: TEST, href,
    baseIcs: base, baseEtag: '"b"', patch, summary: "原標題", createdAt: 1, attempts: 0, state: "queued" as const, rev: 1, ...extra,
  });
  async function make(routes: (cache: CacheStore) => Record<string, Route | Route[]>) {
    const cache = await CacheStore.open(`fix-${Math.random()}`, "fp");
    stores.push(cache);
    const { transport, calls } = fakeTransport({
      "PROPFIND /": xml(radicale("propfind-principal.xml")),
      "PROPFIND /ryanw/": (req: HttpRequest) => (req.body!.includes("calendar-home-set") ? xml(radicale("propfind-home-set.xml")) : xml(radicale("propfind-collections.xml"))),
      [`REPORT ${TEST}`]: { status: 500, headers: {}, text: "" },
      [`REPORT ${TASKS}`]: xml(syncMs("k1", [])),
      ...routes(cache),
    });
    return { engine: new SyncEngine(new CalDavClient(SERVER, "Basic x", transport), cache), cache, calls };
  }

  test("C2：送出途中又被修改 → 不刪除，以剛送出的版本為新基準繼續排隊", async () => {
    const t = await make((cache) => ({
      [`PUT ${href}`]: async () => {
        await cache.updatePending(U({ done: true, summary: "新" }, { rev: 2 })); // 使用者在 PUT 途中又勾了完成
        return { status: 204, headers: { Etag: '"n"' }, text: "" };
      },
    }));
    await t.cache.enqueue(U({ summary: "新" }));
    await t.engine.syncAll();
    const [p] = await t.cache.allPending();
    expect(p).toMatchObject({ state: "queued", rev: 2, baseEtag: '"n"', patch: { done: true, summary: "新" } });
    expect((p as any).baseIcs).toContain("SUMMARY:新");
  });

  test("I1：412 後發現伺服器已把物件改成重複 → 標為失敗、不送出", async () => {
    const server = todo("u1", "原標題", ["DUE;VALUE=DATE:20261124", "STATUS:NEEDS-ACTION", "RRULE:FREQ=WEEKLY"]);
    const t = await make(() => ({
      [`PUT ${href}`]: { status: 412, headers: {}, text: "" },
      [`GET ${href}`]: { status: 200, headers: { Etag: '"s"' }, text: server },
    }));
    await t.cache.enqueue(U({ done: true }));
    await t.engine.syncAll();
    expect(t.calls.filter((c) => c.method === "PUT")).toHaveLength(1);
    expect((await t.cache.allPending())[0]).toMatchObject({ state: "failed", lastError: expect.stringMatching(/重複/) });
  });

  test("I2：伺服器把任務改成 CANCELLED、我勾完成 → 衝突", async () => {
    const server = todo("u1", "原標題", ["DUE;VALUE=DATE:20261124", "STATUS:CANCELLED"]);
    const t = await make(() => ({
      [`PUT ${href}`]: { status: 412, headers: {}, text: "" },
      [`GET ${href}`]: { status: 200, headers: { Etag: '"s"' }, text: server },
    }));
    await t.cache.enqueue(U({ done: true }));
    await t.engine.syncAll();
    expect((await t.cache.allPending())[0]).toMatchObject({ state: "conflict" });
  });

  test("I2：伺服器改了時區、我改日期 → 衝突", async () => {
    const tzBase = todo("u1", "t", ["DUE;TZID=Asia/Taipei:20261124T150000"]);
    const server = todo("u1", "t", ["DUE;TZID=America/New_York:20261124T150000"]);
    const t = await make(() => ({
      [`PUT ${href}`]: { status: 412, headers: {}, text: "" },
      [`GET ${href}`]: { status: 200, headers: { Etag: '"s"' }, text: server },
    }));
    await t.cache.enqueue(U({ date: { date: "2026-11-25", time: "10:00" } }, { baseIcs: tzBase }));
    await t.engine.syncAll();
    expect((await t.cache.allPending())[0]).toMatchObject({ state: "conflict" });
  });

  test("refreshObject：GET 最新版寫入快取", async () => {
    const latest = todo("u1", "最新", ["DUE;VALUE=DATE:20261130"]);
    const t = await make(() => ({ [`GET ${href}`]: { status: 200, headers: { Etag: '"l"' }, text: latest } }));
    await t.engine.refreshObject(href, TEST);
    expect(await t.cache.getObject(href)).toMatchObject({ summary: "最新", etag: '"l"' });
  });
});

describe("SessionManager rerun", () => {
  test("同步進行中又被要求：結束後再跑一輪", async () => {
    const { SessionManager } = await import("../src/session");
    let runs = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fakeEngine = { syncAll: async () => { runs++; if (runs === 1) await gate; return { errors: [] } as any; } };
    const m = new SessionManager(async () => ({ engine: fakeEngine as any, cache: { close() {} } as any }));
    const cfg = { serverUrl: "https://x", username: "u", password: "p" };
    const p1 = m.sync(cfg);
    await new Promise((r) => setTimeout(r, 0));
    const p2 = m.sync(cfg);
    release();
    await p1; await p2;
    await new Promise((r) => setTimeout(r, 10));
    expect(runs).toBe(2);
  });
});

describe("搬移偵測（M5）", () => {
  const resolveB = async (cache: CacheStore, uid: string) => {
    const ts = await cache.findTombstonesByShortId(await shortId(uid));
    return new MoveResolver(await cache.allObjects(), await cache.allTombstones(), await cache.allAliases(), await cache.getCollections()).resolve(ts);
  };

  test("同一輪：測試 → 任務（iOS：舊集合刪、新集合新 UID）→ 寫入 alias", async () => {
    const { engine, cache } = await setup({
      [TEST]: [xml(syncMs("t1", [{ href: `${TEST}a.ics`, ics: todo("a", "交週報") }])), xml(syncMs("t2", [], [`${TEST}a.ics`]))],
      [TASKS]: [xml(syncMs("k1", [])), xml(syncMs("k2", [{ href: `${TASKS}n.ics`, ics: todo("n", "交週報") }]))],
    });
    expect((await engine.syncAll()).aliases).toBe(0);
    const r = await engine.syncAll();
    expect(r.aliases).toBe(1);
    expect(await cache.allAliases()).toMatchObject([{ fromUid: "a", fromShortId: await shortId("a"), toUid: "n", toShortId: await shortId("n") }]);
    expect(await resolveB(cache, "a")).toMatchObject({ kind: "moved", obj: { uid: "n" } });
    expect((await engine.syncAll()).aliases).toBe(0); // 不重複寫
  });

  test("跨兩輪：新集合這輪失敗 → 可能已搬走；下一輪成功 → alias", async () => {
    const { engine, cache } = await setup({
      [TEST]: [xml(syncMs("t1", [{ href: `${TEST}a.ics`, ics: todo("a", "交週報") }])), xml(syncMs("t2", [], [`${TEST}a.ics`])), xml(syncMs("t2", []))],
      [TASKS]: [xml(syncMs("k1", [])), { status: 500, headers: {}, text: "boom" }, xml(syncMs("k2", [{ href: `${TASKS}n.ics`, ics: todo("n", "交週報") }]))],
    });
    await engine.syncAll();
    const r2 = await engine.syncAll();
    expect(r2.aliases).toBe(0);
    expect(r2.errors).toHaveLength(1);
    expect((await resolveB(cache, "a")).kind).toBe("maybe");
    expect((await engine.syncAll()).aliases).toBe(1);
    expect((await resolveB(cache, "a")).kind).toBe("moved");
  });

  test("普通刪除（較晚同步的集合）→ deleted，不是可能已搬走", async () => {
    const { engine, cache } = await setup({
      [TEST]: [xml(syncMs("t1", [{ href: `${TEST}a.ics`, ics: todo("a", "交週報") }])), xml(syncMs("t2", [], [`${TEST}a.ics`]))],
      [TASKS]: xml(syncMs("k1", [])),
    });
    await engine.syncAll();
    const r = await engine.syncAll();
    const t = (await cache.allTombstones())[0];
    expect(t.deletedAt).toBe(r.startedAt);
    expect(await resolveB(cache, "a")).toMatchObject({ kind: "deleted" });
  });
});

test("I1：refreshObject 收到 404 時，deletedAt 用上一輪開始時間", async () => {
  const { engine, cache } = await setup({
    [TEST]: xml(syncMs("t1", [{ href: `${TEST}a.ics`, ics: todo("a") }])),
    [TASKS]: xml(syncMs("k1", [])),
  });
  const r = await engine.syncAll();
  await engine.refreshObject(`${TEST}a.ics`, TEST); // 沒有 GET 路由 → 404
  expect((await cache.allTombstones())[0].deletedAt).toBe(r.startedAt);
  expect(new MoveResolver([], await cache.allTombstones(), [], await cache.getCollections()).resolve(await cache.allTombstones()).kind).toBe("deleted");
});
