import { expect, test } from "vitest";
import { parseResource } from "../src/ical/parse";
import { describeRrule } from "../src/render/recur";
import { projectFields, writableHash } from "../src/projection/fields";
import { listName } from "../src/projection/types";
import type { CalObject } from "../src/types";
import { todo } from "./msBuilder";

const COL = "/ryanw/tasks/";
async function obj(ics: string, etag = '"e1"'): Promise<CalObject> {
  const r = await parseResource(ics, { href: `${COL}x.ics`, etag, collection: COL });
  if ("skip" in r) throw new Error(r.skip);
  return r;
}
const vevent = (lines: string[]) => ["BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", "UID:ev1", "SUMMARY:會議", "DTSTAMP:20261119T000000Z", ...lines, "END:VEVENT", "END:VCALENDAR", ""].join("\r\n");

test("listName", () => expect(listName("/ryanw/tasks/")).toBe("tasks"));

test("vtodo all-day", async () => {
  const fm = await projectFields(await obj(todo("t1", "交週報", ["DUE;VALUE=DATE:20261124", "STATUS:NEEDS-ACTION"])));
  expect(fm).toMatchObject({ title: "交週報", status: "needs-action", due: "2026-11-24", list: "tasks", aliases: ["交週報"], _kind: "VTODO", _uid: "t1", _deleted: false, _sync: "ok" });
  expect(fm).not.toHaveProperty("due_time");
});

test("vtodo timed", async () => {
  const fm = await projectFields(await obj(todo("t2", "x", ["DUE;TZID=Asia/Taipei:20261124T093000"])));
  expect(fm).toMatchObject({ due: "2026-11-24", due_time: "09:30" });
});

test("vevent", async () => {
  const fm = await projectFields(await obj(vevent(["DTSTART;TZID=Asia/Taipei:20261124T100000", "DTEND;TZID=Asia/Taipei:20261124T113000"])));
  expect(fm).toMatchObject({ _kind: "VEVENT", start: "2026-11-24", start_time: "10:00", end: "2026-11-24", end_time: "11:30" });
  expect(fm).not.toHaveProperty("status");
  expect(fm).not.toHaveProperty("due");
});

test("description → _notes", async () => {
  expect((await projectFields(await obj(todo("t3", "x", ["DESCRIPTION:第一行\\n第二行"]))))._notes).toBe("第一行\n第二行");
  expect(await projectFields(await obj(todo("t4")))).not.toHaveProperty("_notes");
});

test("rrule → _rrule", async () => {
  const fm = await projectFields(await obj(todo("t5", "x", ["DTSTART;VALUE=DATE:20261123", "RRULE:FREQ=WEEKLY;BYDAY=MO"])));
  expect(fm._rrule).toBe(describeRrule("FREQ=WEEKLY;BYDAY=MO"));
});

test("alias sanitized", async () => {
  const fm = await projectFields(await obj(todo("t6", "看 [[x]]")));
  expect(fm.title).toBe("看 [[x]]");
  expect(fm.aliases).toEqual(["看 ⟦x⟧"]);
});

test("hash stable", async () => {
  const a = await projectFields(await obj(todo("t7", "甲")));
  const b = await projectFields(await obj(todo("t7", "甲")));
  const c = await projectFields(await obj(todo("t7", "乙")));
  expect(a._hash).toBe(b._hash);
  expect(a._hash).not.toBe(c._hash);
  expect(await writableHash({ list: "tasks", title: "甲" })).toBe(await writableHash({ title: "甲", list: "tasks" }));
});

test("etag", async () => expect((await projectFields(await obj(todo("t8"), '"zz"')))._etag).toBe('"zz"'));

test("all-day vevent end is inclusive (DTEND − 1 day, like Full Calendar)", async () => {
  const one = await projectFields(await obj(vevent(["DTSTART;VALUE=DATE:20261124", "DTEND;VALUE=DATE:20261125"])));
  expect(one).toMatchObject({ start: "2026-11-24", end: "2026-11-24" });
  expect(one).not.toHaveProperty("end_time");
  const span = await projectFields(await obj(vevent(["DTSTART;VALUE=DATE:20261130", "DTEND;VALUE=DATE:20261202"])));
  expect(span).toMatchObject({ start: "2026-11-30", end: "2026-12-01" });
});
