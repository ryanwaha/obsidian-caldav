import "fake-indexeddb/auto";
import { describe, expect, test } from "vitest";
import { CacheStore } from "../src/cache/db";
import { CalDavClient } from "../src/caldav/client";
import { type Config, SessionManager, normalizeServerUrl } from "../src/session";
import { SyncEngine } from "../src/sync/engine";
import { fakeTransport, xml } from "./fakeTransport";
import { radicale } from "./fixtures";
import { syncMs } from "./msBuilder";

const routes = {
  "PROPFIND /": xml(radicale("propfind-principal.xml")),
  "PROPFIND /ryanw/": (req: { body?: string }) => xml(radicale(req.body!.includes("calendar-home-set") ? "propfind-home-set.xml" : "propfind-collections.xml")),
  "REPORT /ryanw/test/": xml(syncMs("t", [])),
  "REPORT /ryanw/tasks/": xml(syncMs("k", [])),
};
const cfg = (serverUrl = "https://cal.example"): Config => ({ serverUrl, username: "ryanw", password: "pw" });

function manager(opts: { fail?: number } = {}) {
  const { transport, calls } = fakeTransport(routes as any);
  const db = `session-${Math.random()}`;
  const made: CacheStore[] = [];
  let failures = opts.fail ?? 0;
  const m = new SessionManager(async (c, fingerprint) => {
    if (failures > 0) { failures--; throw new Error("IDB unavailable"); }
    const cache = await CacheStore.open(db, fingerprint);
    made.push(cache);
    return { cache, engine: new SyncEngine(new CalDavClient(c.serverUrl, "Basic x", transport), cache) };
  });
  return { m, made, calls };
}

describe("SessionManager", () => {
  test("normalizeServerUrl 去掉空白與結尾斜線", () => {
    expect(normalizeServerUrl("  https://x:8448//  ")).toBe("https://x:8448");
  });

  test("同時兩次 sync：只建立一個 session、只跑一輪", async () => {
    const { m, made, calls } = manager();
    const p1 = m.sync(cfg()), p2 = m.sync(cfg());
    expect(p2).toBe(p1);
    await p1;
    expect(made).toHaveLength(1);
    expect(calls.filter((c) => c.method === "REPORT")).toHaveLength(2);
  });

  test("網址只差結尾斜線視為同一台伺服器", async () => {
    const { m, made } = manager();
    await m.sync(cfg("https://cal.example"));
    await m.sync(cfg("https://cal.example/"));
    expect(made).toHaveLength(1);
  });

  test("建立失敗：回傳帶錯誤的 report，下次重試", async () => {
    const { m, made } = manager({ fail: 1 });
    const r1 = await m.sync(cfg());
    expect(r1!.errors[0].message).toContain("IDB unavailable");
    const r2 = await m.sync(cfg());
    expect(r2!.errors).toEqual([]);
    expect(made).toHaveLength(1);
  });

  test("DB 連線被關閉：該次回報錯誤，下次自動重開", async () => {
    const { m, made } = manager();
    await m.sync(cfg());
    made[0].close();
    const r = await m.sync(cfg());
    expect(r!.errors.length).toBeGreaterThan(0);
    const r3 = await m.sync(cfg());
    expect(r3!.errors).toEqual([]);
    expect(made).toHaveLength(2);
  });

  test("設定不完整：回傳 undefined 並關閉既有 session", async () => {
    const { m } = manager();
    await m.sync(cfg());
    expect(await m.sync(undefined)).toBeUndefined();
    expect(await m.get(undefined)).toBeUndefined();
  });

  test("換帳號：關閉舊 session、建立新的", async () => {
    const { m, made } = manager();
    await m.sync(cfg());
    await m.sync({ ...cfg(), username: "other" });
    expect(made).toHaveLength(2);
  });
});
