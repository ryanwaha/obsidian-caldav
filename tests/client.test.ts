import { describe, expect, test } from "vitest";
import { CalDavClient, HttpError, TokenExpiredError } from "../src/caldav/client";
import { fakeTransport, xml } from "./fakeTransport";
import { radicale } from "./fixtures";

const SERVER = "https://cal.example:8448";
const discoveryRoutes = {
  "PROPFIND /": xml(radicale("propfind-principal.xml")),
  "PROPFIND /ryanw/": [xml(radicale("propfind-home-set.xml")), xml(radicale("propfind-collections.xml"))],
};

describe("CalDavClient", () => {
  test("discover 直接對 server URL 發 PROPFIND，不走 well-known", async () => {
    const { transport, calls } = fakeTransport(discoveryRoutes);
    const c = new CalDavClient(SERVER, "Basic x", transport);
    expect(await c.discover()).toEqual({ principal: "/ryanw/", home: "/ryanw/" });
    expect(calls[0].url).toBe(SERVER + "/");
    expect(calls[0].method).toBe("PROPFIND");
    expect(calls[0].headers?.Depth).toBe("0");
    expect(calls.every((r) => r.headers?.Authorization === "Basic x")).toBe(true);
    expect(calls.some((r) => r.url.includes(".well-known"))).toBe(false);
  });

  test("server URL 結尾斜線不會造成雙斜線", async () => {
    const { transport, calls } = fakeTransport(discoveryRoutes);
    await new CalDavClient(SERVER + "/", "Basic x", transport).discover();
    expect(calls[0].url).toBe(SERVER + "/");
    expect(calls[1].url).toBe(SERVER + "/ryanw/");
  });

  test("listCollections 只回傳 calendar 清單", async () => {
    const { transport, calls } = fakeTransport({ "PROPFIND /ryanw/": xml(radicale("propfind-collections.xml")) });
    const cols = await new CalDavClient(SERVER, "Basic x", transport).listCollections("/ryanw/");
    expect(cols.map((c) => c.href).sort()).toEqual(["/ryanw/tasks/", "/ryanw/test/"]);
    const tasks = cols.find((c) => c.href === "/ryanw/tasks/")!;
    expect(tasks.displayName).toBe("任務");
    expect(tasks.components).toEqual(["VTODO", "VEVENT"]);
    expect(tasks.syncToken).toBeUndefined(); // 伺服器的 token 不代表本機已同步
    expect(calls[0].headers?.Depth).toBe("1");
  });

  test("syncCollection 403 valid-sync-token → TokenExpiredError", async () => {
    const { transport } = fakeTransport({ "REPORT /ryanw/test/": xml(radicale("sync-invalid-token-403.xml"), 403) });
    await expect(new CalDavClient(SERVER, "Basic x", transport).syncCollection("/ryanw/test/", "old")).rejects.toBeInstanceOf(TokenExpiredError);
  });

  test("syncCollection 401 → HttpError，訊息為帳號或密碼錯誤", async () => {
    const { transport } = fakeTransport({ "REPORT /ryanw/test/": { status: 401, headers: {}, text: "" } });
    const p = new CalDavClient(SERVER, "Basic x", transport).syncCollection("/ryanw/test/", null);
    await expect(p).rejects.toBeInstanceOf(HttpError);
    await expect(p).rejects.toMatchObject({ status: 401, message: "帳號或密碼錯誤" });
  });

  test("syncCollection 初次：changed 帶 etag 與 ics", async () => {
    const { transport, calls } = fakeTransport({ "REPORT /ryanw/tasks/": xml(radicale("sync-initial-with-data.xml")) });
    const r = await new CalDavClient(SERVER, "Basic x", transport).syncCollection("/ryanw/tasks/", null);
    expect(r.token).toMatch(/^http:\/\/radicale\.org\/ns\/sync\//);
    expect(r.changed.length).toBeGreaterThan(0);
    for (const ch of r.changed) { expect(ch.etag).toMatch(/^".+"$/); expect(ch.ics).toContain("BEGIN:VCALENDAR"); }
    expect(r.removed).toEqual([]);
    expect(calls[0].headers?.Depth).toBe("1");
    expect(calls[0].body).toContain("calendar-data");
  });

  test("syncCollection：404 列入 removed", async () => {
    const { transport } = fakeTransport({ "REPORT /ryanw/test/": xml(radicale("sync-initial-etag-only.xml")) });
    const r = await new CalDavClient(SERVER, "Basic x", transport).syncCollection("/ryanw/test/", null);
    expect(r.removed).toHaveLength(5); // fixture 內 "404 Not Found" 共 5 筆
    expect(r.removed).toContain("/ryanw/test/85483CE1-1395-4CD0-BF87-7B32BA498B32.ics");
  });
});

describe("CalDavClient.put", () => {
  test("If-None-Match 與 Content-Type；回傳 etag", async () => {
    const { transport, calls } = fakeTransport({ "PUT /ryanw/test/n.ics": { status: 201, headers: { Etag: '"abc"' }, text: "" } });
    const r = await new CalDavClient(SERVER, "Basic x", transport).put("/ryanw/test/n.ics", "BEGIN:VCALENDAR", { ifNoneMatch: true });
    expect(r).toEqual({ status: 201, etag: '"abc"' });
    expect(calls[0].headers).toMatchObject({ Authorization: "Basic x", "If-None-Match": "*", "Content-Type": "text/calendar; charset=utf-8" });
    expect(calls[0].body).toBe("BEGIN:VCALENDAR");
  });
  test("If-Match；412 照實回傳", async () => {
    const { transport, calls } = fakeTransport({ "PUT /ryanw/test/n.ics": { status: 412, headers: {}, text: "" } });
    const r = await new CalDavClient(SERVER, "Basic x", transport).put("/ryanw/test/n.ics", "X", { ifMatch: '"e1"' });
    expect(r.status).toBe(412);
    expect(calls[0].headers?.["If-Match"]).toBe('"e1"');
  });
  test("401 → HttpError", async () => {
    const { transport } = fakeTransport({ "PUT /ryanw/test/n.ics": { status: 401, headers: {}, text: "" } });
    await expect(new CalDavClient(SERVER, "Basic x", transport).put("/ryanw/test/n.ics", "X", { ifNoneMatch: true })).rejects.toBeInstanceOf(HttpError);
  });
});

describe("CalDavClient.get", () => {
  test("回傳 ics 與 etag", async () => {
    const { transport, calls } = fakeTransport({ "GET /ryanw/test/a.ics": { status: 200, headers: { ETag: '"g"' }, text: "BEGIN:VCALENDAR" } });
    expect(await new CalDavClient(SERVER, "Basic x", transport).get("/ryanw/test/a.ics")).toEqual({ status: 200, ics: "BEGIN:VCALENDAR", etag: '"g"' });
    expect(calls[0].headers?.Authorization).toBe("Basic x");
  });
  test("404 照實回傳；401 丟例外", async () => {
    const { transport } = fakeTransport({ "GET /a.ics": { status: 404, headers: {}, text: "" }, "GET /b.ics": { status: 401, headers: {}, text: "" } });
    const c = new CalDavClient(SERVER, "Basic x", transport);
    expect((await c.get("/a.ics")).status).toBe(404);
    await expect(c.get("/b.ics")).rejects.toBeInstanceOf(HttpError);
  });

  test("move sends MOVE with Destination and Overwrite F", async () => {
    const { transport, calls } = fakeTransport({ "MOVE /ryanw/tasks/a.ics": { status: 201, headers: {}, text: "" } } as any);
    const c = new CalDavClient(SERVER, "Basic x", transport);
    expect(await c.move("/ryanw/tasks/a.ics", "/ryanw/work/a.ics")).toBe(201);
    expect(calls[0].method).toBe("MOVE");
    expect(calls[0].headers?.Destination).toBe(SERVER + "/ryanw/work/a.ics");
    expect(calls[0].headers?.Overwrite).toBe("F");
  });

  test("delete sends If-Match", async () => {
    const { transport, calls } = fakeTransport({ "DELETE /ryanw/tasks/a.ics": { status: 204, headers: {}, text: "" } } as any);
    const c = new CalDavClient(SERVER, "Basic x", transport);
    expect(await c.delete("/ryanw/tasks/a.ics", '"e1"')).toBe(204);
    expect(calls[0].headers?.["If-Match"]).toBe('"e1"');
  });
});
