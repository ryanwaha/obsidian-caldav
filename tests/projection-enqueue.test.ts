import "fake-indexeddb/auto";
import { afterEach, expect, test } from "vitest";
import { CacheStore } from "../src/cache/db";
import { parseResource } from "../src/ical/parse";
import { enqueuePatch } from "../src/projection/enqueue";
import type { CalObject, PendingUpdate } from "../src/types";
import { todo } from "./msBuilder";

const stores: CacheStore[] = [];
afterEach(() => { while (stores.length) stores.pop()!.close(); });
async function setup() {
  const c = await CacheStore.open(`enq-${Math.random()}`, "fp"); stores.push(c);
  const r = await parseResource(todo("a", "原", ["STATUS:NEEDS-ACTION"]), { href: "/ryanw/tasks/a.ics", etag: '"e1"', collection: "/ryanw/tasks/" });
  const o = r as CalObject; await c.upsertObjects([o]);
  return { c, o };
}

test("new pending with base = cached object, optimistic cache updated", async () => {
  const { c, o } = await setup();
  await enqueuePatch(c, o, { summary: "新" }, new Date());
  const p = (await c.getPending("upd:/ryanw/tasks/a.ics")) as PendingUpdate;
  expect(p).toMatchObject({ state: "queued", baseEtag: '"e1"', patch: { summary: "新" }, rev: 1, objUid: "a" });
  expect((await c.getObject(o.href))!.summary).toBe("新");
});

test("merges into existing pending, rev+1", async () => {
  const { c, o } = await setup();
  await enqueuePatch(c, o, { summary: "新" }, new Date());
  await enqueuePatch(c, (await c.getObject(o.href))!, { status: "completed" }, new Date());
  const p = (await c.getPending("upd:/ryanw/tasks/a.ics")) as PendingUpdate;
  expect(p.patch).toEqual({ summary: "新", status: "completed" });
  expect(p.rev).toBe(2);
});

test("editing during conflict rebases onto the server version", async () => {
  const { c, o } = await setup();
  await enqueuePatch(c, o, { summary: "新" }, new Date());
  const p = (await c.getPending("upd:/ryanw/tasks/a.ics")) as PendingUpdate;
  await c.updatePending({ ...p, state: "conflict", conflict: { serverIcs: "SRV", serverEtag: '"s9"', base: { summary: "原", status: "" }, mine: { summary: "新", status: "" }, server: { summary: "伺", status: "" } } });
  await enqueuePatch(c, (await c.getObject(o.href))!, { summary: "我決定" }, new Date());
  expect(await c.getPending("upd:/ryanw/tasks/a.ics")).toMatchObject({ state: "queued", baseIcs: "SRV", baseEtag: '"s9"', conflict: undefined });
});

test("disallowed patch throws and enqueues nothing", async () => {
  const { c } = await setup();
  const r = await parseResource(todo("r", "每週", ["DTSTART;VALUE=DATE:20261123", "RRULE:FREQ=WEEKLY"]), { href: "/ryanw/tasks/r.ics", etag: '"e"', collection: "/ryanw/tasks/" });
  await expect(enqueuePatch(c, r as CalObject, { status: "completed" }, new Date())).rejects.toThrow();
  expect(await c.getPending("upd:/ryanw/tasks/r.ics")).toBeUndefined();
});
