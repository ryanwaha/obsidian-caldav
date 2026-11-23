import { expect, test } from "vitest";
import { parseResource } from "../src/ical/parse";
import { projectFields } from "../src/projection/fields";
import { planUpstream } from "../src/projection/upstream";
import type { CalObject, CollectionInfo } from "../src/types";
import { todo } from "./msBuilder";

const T = "/ryanw/tasks/", W = "/ryanw/work/";
const cols: CollectionInfo[] = [{ href: T, displayName: "tasks", components: ["VTODO"] }, { href: W, displayName: "work", components: ["VTODO", "VEVENT"] }];
async function obj(ics: string, collection = T): Promise<CalObject> {
  const r = await parseResource(ics, { href: `${collection}x.ics`, etag: '"e"', collection });
  if ("skip" in r) throw new Error(r.skip);
  return r;
}
const vevent = (lines: string[]) => ["BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", "UID:ev", "SUMMARY:會議", "DTSTAMP:20261119T000000Z", ...lines, "END:VEVENT", "END:VCALENDAR", ""].join("\r\n");
async function run(o: CalObject, change: Record<string, unknown>, opts: { bodyChanged?: boolean; base?: Record<string, unknown> } = {}) {
  const base = opts.base ?? ({ ...(await projectFields(o)) } as Record<string, unknown>);
  const mine = { ...base, ...change };
  for (const [k, v] of Object.entries(change)) if (v === undefined) delete mine[k];
  return planUpstream({ mine, base, bodyChanged: opts.bodyChanged ?? false, obj: o, collections: cols });
}
const plain = () => obj(todo("t", "交週報", ["DUE;VALUE=DATE:20261124", "STATUS:NEEDS-ACTION"]));

test("title", async () => expect((await run(await plain(), { title: "新" })).result).toEqual({ kind: "send", patch: { summary: "新" } }));
test("status", async () => expect((await run(await plain(), { status: "completed" })).result).toEqual({ kind: "send", patch: { status: "completed" } }));
test("status-invalid", async () => expect((await run(await plain(), { status: "done" })).result.kind).toBe("reject"));
test("due-date-only", async () => expect((await run(await plain(), { due: "2026-12-01" })).result).toEqual({ kind: "send", patch: { date: { date: "2026-12-01" } } }));
test("due-with-time", async () => expect((await run(await plain(), { due_time: "09:30" })).result).toEqual({ kind: "send", patch: { date: { date: "2026-11-24", time: "09:30" } } }));
test("due-cleared", async () => expect((await run(await plain(), { due: undefined })).result).toEqual({ kind: "send", patch: { date: null } }));
test("event-start", async () => {
  const e = await obj(vevent(["DTSTART;TZID=Asia/Taipei:20261124T100000", "DTEND;TZID=Asia/Taipei:20261124T110000"]), W);
  expect((await run(e, { start_time: "14:00" })).result).toEqual({ kind: "send", patch: { date: { date: "2026-11-24", time: "14:00" } } });
});
test("event-end-all-day-plus-one", async () => {
  const e = await obj(vevent(["DTSTART;VALUE=DATE:20261124", "DTEND;VALUE=DATE:20261125"]), W);
  expect((await run(e, { end: "2026-11-26" })).result).toEqual({ kind: "send", patch: { end: { date: "2026-11-27" } } });
});
test("list-move", async () => expect((await run(await plain(), { list: "work" })).result).toEqual({ kind: "send", patch: {}, move: W }));
test("list-unknown", async () => expect((await run(await plain(), { list: "nope" })).result.kind).toBe("reject"));
test("system-key-rollback", async () => {
  const r = await run(await plain(), { _etag: '"x"', _sync: "conflict" });
  expect(r.rollbackSystemKeys.sort()).toEqual(["_etag", "_sync"]);
  expect(r.result).toEqual({ kind: "none" });
});
test("request-delete", async () => expect((await run(await plain(), { _request: "delete" })).result).toEqual({ kind: "request", request: "delete" }));
test("request-dismiss", async () => expect((await run(await plain(), { _request: "dismiss-conflict" })).result).toEqual({ kind: "request", request: "dismiss-conflict" }));
test("deleted-reject", async () => {
  const o = await plain();
  const base = { ...(await projectFields(o)), _deleted: true } as Record<string, unknown>;
  expect((await run(o, { title: "x" }, { base })).result).toEqual({ kind: "reject", message: "任務已刪除" });
});
test("recurring-status-rejected", async () => {
  const rec = await obj(todo("r", "每週", ["DTSTART;VALUE=DATE:20261123", "DUE;VALUE=DATE:20261123", "RRULE:FREQ=WEEKLY"]));
  expect((await run(rec, { status: "completed" })).result).toEqual({ kind: "reject", message: "重複任務的完成請在提醒事項操作" });
});
test("invalid-values", async () => {
  for (const c of [{ due_time: "9:5" }, { due_time: "25:00" }, { due: "2026/11/24" }, { due: "2026-02-30" }, { due: undefined, due_time: "09:00" }])
    expect((await run(await plain(), c)).result.kind, JSON.stringify(c)).toBe("reject");
});
test("body-only", async () => expect((await run(await plain(), {}, { bodyChanged: true })).result).toEqual({ kind: "body-only" }));
test("none", async () => expect((await run(await plain(), {})).result).toEqual({ kind: "none" }));
test("base-not-cache", async () => {
  const before = await plain();
  const base = { ...(await projectFields(before)) } as Record<string, unknown>;
  const serverChanged = await obj(todo("t", "伺服器新標題", ["DUE;VALUE=DATE:20261124", "STATUS:NEEDS-ACTION"]));
  expect(planUpstream({ mine: base, base, bodyChanged: false, obj: serverChanged, collections: cols }).result).toEqual({ kind: "none" });
});
