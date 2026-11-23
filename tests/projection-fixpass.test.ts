import "fake-indexeddb/auto";
import { afterEach, describe, expect, test } from "vitest";
import { CacheStore } from "../src/cache/db";
import { parseResource } from "../src/ical/parse";
import { enqueuePatch, revertFailed } from "../src/projection/enqueue";
import { projectFields } from "../src/projection/fields";
import { applySetUnset, chooseRestore, dirtyPaths, RecentPaths } from "../src/projection/snapshot";
import { processUpstream, type UpstreamDeps } from "../src/projection/upstreamCore";
import type { CalObject, PendingUpdate } from "../src/types";
import { todo } from "./msBuilder";

const stores: CacheStore[] = [];
afterEach(() => { while (stores.length) stores.pop()!.close(); });
const T = "/ryanw/tasks/", W = "/ryanw/work/";
async function setup(lines = ["STATUS:NEEDS-ACTION"]) {
  const cache = await CacheStore.open(`fix-${Math.random()}`, "fp"); stores.push(cache);
  await cache.putCollection({ href: T, displayName: "tasks", components: ["VTODO"] });
  await cache.putCollection({ href: W, displayName: "work", components: ["VTODO"] });
  const o = (await parseResource(todo("a", "原", lines), { href: `${T}a.ics`, etag: '"e1"', collection: T })) as CalObject;
  await cache.upsertObjects([o]);
  const fm = { ...(await projectFields(o)) } as Record<string, unknown>;
  await cache.putProjection({ path: "_caldav/a.md", uid: "a", fm, body: "", writtenAt: 0 });
  return { cache, o, fm };
}
function deps(cache: CacheStore, over: Partial<UpstreamDeps> = {}) {
  const calls: string[] = [];
  const writes: { set: Record<string, unknown>; unset: string[] }[] = [];
  const d: UpstreamDeps = {
    cache, now: () => new Date(),
    move: async (h, dest) => { calls.push(`MOVE ${h} ${dest}`); return 201; },
    del: async (h) => { calls.push(`DELETE ${h}`); return 204; },
    refresh: async () => { calls.push("refresh"); },
    writeFm: async (_p, set, unset) => { writes.push({ set, unset }); },
    syncSoon: () => { calls.push("sync"); },
    ...over,
  };
  return { d, calls, writes };
}

describe("C1 snapshot never absorbs unprocessed user edits", () => {
  test("applySetUnset applies only what the server wrote", () => {
    const old = { title: "伺服器寫的", _etag: '"1"', _sync: "ok" };
    expect(applySetUnset(old, { _etag: '"2"' }, ["_sync"])).toEqual({ title: "伺服器寫的", _etag: '"2"' });
  });
  test("processUpstream snapshot uses the fm it processed, not a re-read", async () => {
    const { cache, fm } = await setup();
    const { d } = deps(cache);
    await processUpstream("_caldav/a.md", { ...fm, title: "第一次" }, "", d);
    expect((await cache.getProjection("_caldav/a.md"))!.fm.title).toBe("第一次");
  });
});

describe("I1 MOVE before enqueue; pending follows the new href", () => {
  test("title + list in one edit", async () => {
    const { cache, fm } = await setup();
    const { d, calls } = deps(cache);
    await processUpstream("_caldav/a.md", { ...fm, title: "新", list: "work" }, "", d);
    expect(calls[0]).toBe(`MOVE ${T}a.ics ${W}a.ics`);
    const p = (await cache.getPending(`upd:${W}a.ics`)) as PendingUpdate;
    expect(p).toMatchObject({ href: `${W}a.ics`, collection: W, patch: { summary: "新" } });
    expect(await cache.getPending(`upd:${T}a.ics`)).toBeUndefined();
    expect((await cache.getObject(`${W}a.ics`))?.uid).toBe("a");
    expect(await cache.getObject(`${T}a.ics`)).toBeUndefined();
    expect(await cache.findTombstonesByShortId((await cache.getObject(`${W}a.ics`))!.shortId)).toEqual([]);
  });
  test("existing queued pending is rehomed on MOVE", async () => {
    const { cache, o, fm } = await setup();
    await enqueuePatch(cache, o, { status: "completed" }, new Date());
    const { d } = deps(cache);
    await processUpstream("_caldav/a.md", { ...fm, list: "work" }, "", d);
    expect(await cache.getPending(`upd:${W}a.ics`)).toMatchObject({ patch: { status: "completed" } });
  });
  test("MOVE failure rolls back only list; other fields still sent", async () => {
    const { cache, fm } = await setup();
    const { d, writes } = deps(cache, { move: async () => 412 });
    await processUpstream("_caldav/a.md", { ...fm, title: "新", list: "work" }, "", d);
    expect(writes[0].set).toMatchObject({ list: "tasks", _sync: "rejected" });
    expect(writes[0].set).not.toHaveProperty("title");
    expect(await cache.getPending(`upd:${T}a.ics`)).toMatchObject({ patch: { summary: "新" } });
  });
});

describe("I2 failed pending reverts the optimistic cache", () => {
  test("revertFailed restores baseIcs", async () => {
    const { cache, o } = await setup();
    await enqueuePatch(cache, o, { summary: "被拒" }, new Date());
    const p = (await cache.getPending(`upd:${T}a.ics`)) as PendingUpdate;
    expect((await cache.getObject(o.href))!.summary).toBe("被拒");
    await revertFailed(cache, { ...p, state: "failed" });
    expect((await cache.getObject(o.href))!.summary).toBe("原");
  });
});

describe("I3 editing another field during an engine conflict", () => {
  test("replaces the old patch instead of merging mine back in", async () => {
    const { cache, o } = await setup();
    await enqueuePatch(cache, o, { summary: "A" }, new Date());
    const p = (await cache.getPending(`upd:${T}a.ics`)) as PendingUpdate;
    await cache.updatePending({ ...p, state: "conflict", conflict: { serverIcs: "SRV", serverEtag: '"s"', base: { summary: "原", status: "" }, mine: { summary: "A", status: "" }, server: { summary: "B", status: "" } } });
    await enqueuePatch(cache, (await cache.getObject(o.href))!, { status: "completed" }, new Date());
    expect(((await cache.getPending(`upd:${T}a.ics`)) as PendingUpdate).patch).toEqual({ status: "completed" });
  });
});

describe("I4 duplicate _uid after a remote rename", () => {
  test("a new file with the same uid and no snapshot → rename it back", () => {
    expect(chooseRestore("a", [{ path: "_caldav/new.md", uid: "a", hasSnap: false }])).toEqual({ kind: "rename-back", from: "_caldav/new.md" });
  });
  test("no other file → restore from snapshot", () => expect(chooseRestore("a", [])).toEqual({ kind: "restore" }));
  test("another snapshotted file with same uid → skip (it is the primary)", () => {
    expect(chooseRestore("a", [{ path: "_caldav/x.md", uid: "a", hasSnap: true }])).toEqual({ kind: "skip" });
  });
});

describe("I5 dirty files without a real pending are re-queued", () => {
  test("dirtyPaths", () => {
    const files = [{ path: "p1", fm: { _uid: "u1", title: "改" }, bodyEmpty: true }, { path: "p2", fm: { _uid: "u2", title: "同" }, bodyEmpty: true }, { path: "p3", fm: { _uid: "u3", title: "改" }, bodyEmpty: true }];
    const snaps = new Map([["p1", { title: "原" }], ["p2", { title: "同" }], ["p3", { title: "原" }]]);
    expect(dirtyPaths(files, snaps, new Set(["u3"]))).toEqual({ dirtyUids: new Set(["u1", "u3"]), orphanPaths: ["p1"] });
  });
});

describe("I6 conflict scan only touches recently written paths", () => {
  test("RecentPaths drains", () => {
    const r = new RecentPaths();
    r.add("a"); r.add("b"); r.add("a");
    expect(r.drain().sort()).toEqual(["a", "b"]);
    expect(r.drain()).toEqual([]);
  });
});

describe("I7 object is looked up by the snapshot uid", () => {
  test("changing _uid and title together: title goes to the snapshot's object, _uid rolled back", async () => {
    const { cache, fm } = await setup();
    const other = (await parseResource(todo("b", "別的"), { href: `${T}b.ics`, etag: '"e"', collection: T })) as CalObject;
    await cache.upsertObjects([other]);
    const { d, writes } = deps(cache);
    await processUpstream("_caldav/a.md", { ...fm, _uid: "b", title: "新" }, "", d);
    expect(await cache.getPending(`upd:${T}a.ics`)).toMatchObject({ patch: { summary: "新" } });
    expect(await cache.getPending(`upd:${T}b.ics`)).toBeUndefined();
    expect(writes[0].set).toMatchObject({ _uid: "a" });
  });
});

describe("request with writable edits in the same change", () => {
  test("writable values are rolled back, not silently absorbed", async () => {
    const { cache, fm } = await setup();
    const { d, writes } = deps(cache);
    await processUpstream("_caldav/a.md", { ...fm, title: "順手改", _request: "delete" }, "", d);
    expect(writes[0].set).toMatchObject({ title: "原" });
  });
  test("dismiss-conflict removes only a conflict pending", async () => {
    const { cache, o, fm } = await setup();
    await enqueuePatch(cache, o, { summary: "排隊中" }, new Date());
    const { d } = deps(cache);
    await processUpstream("_caldav/a.md", { ...fm, title: "排隊中", _request: "dismiss-conflict" }, "", d);
    expect(await cache.getPending(`upd:${T}a.ics`)).toBeDefined();
  });
});

describe("I6 follow-up: conflict detection via LiveSync change feed", () => {
  test("pathFromDocId", async () => {
    const { pathFromDocId } = await import("../src/projection/snapshot");
    expect(pathFromDocId("/_caldav/x1aybrz7.md")).toBe("_caldav/x1aybrz7.md");
    expect(pathFromDocId("note.md")).toBeUndefined();
    expect(pathFromDocId("h:2vmpuxrh21vm")).toBeUndefined();
  });
});

describe("I4 follow-up: runner must not snapshot a renamed copy", () => {
  test("new path whose uid already has a snapshot elsewhere gets no snapshot", async () => {
    const { cache, fm } = await setup();
    const { d } = deps(cache);
    await processUpstream("_caldav/我改的名字.md", fm, "", d);
    expect(await cache.getProjection("_caldav/我改的名字.md")).toBeUndefined();
  });
});

describe("M6-3 Task 1: server-side create from a projection file", () => {
  test("file without _etag and unknown uid → PendingCreate", async () => {
    const { cache } = await setup();
    const { d, calls } = deps(cache);
    const fm = { title: "裝置新建", status: "needs-action", due: "2026-12-01", due_time: "09:30", list: "work", _kind: "VTODO", _uid: "new-1" };
    await processUpstream("_caldav/nnnnnnnn.md", fm, "", d);
    const p = await cache.getPending("new-1");
    expect(p).toMatchObject({ uid: "new-1", collection: W, href: `${W}new-1.ics`, state: "queued" });
    expect((p as { ics: string }).ics).toContain("SUMMARY:裝置新建");
    expect((p as { ics: string }).ics).toContain("DUE;TZID=Asia/Taipei:20261201T093000");
    expect(calls).toContain("sync");
    expect(await cache.getProjection("_caldav/nnnnnnnn.md")).toBeDefined();
  });
  test("unknown list → rejected, nothing queued", async () => {
    const { cache } = await setup();
    const { d, writes } = deps(cache);
    await processUpstream("_caldav/nnnnnnnn.md", { title: "x", list: "nope", _kind: "VTODO", _uid: "new-2" }, "", d);
    expect(await cache.getPending("new-2")).toBeUndefined();
    expect(writes[0].set).toMatchObject({ _sync: "rejected" });
  });
});
