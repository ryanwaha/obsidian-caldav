import { expect, test } from "vitest";
import { editable } from "../src/ical/editable";
import type { CalObject } from "../src/types";

const o = (extra: Partial<CalObject>): CalObject => ({ href: "/h", collection: "/c/", etag: '"e"', uid: "u", shortId: "x", kind: "VTODO", summary: "s", hasOverrides: false, ics: "", ...extra });
test.each([
  ["不重複 VTODO", o({}), { title: true, done: true, date: true }],
  ["重複 VTODO", o({ rrule: "FREQ=WEEKLY" }), { title: true, done: false, date: true }],
  ["不重複 VEVENT", o({ kind: "VEVENT" }), { title: true, done: false, date: true }],
  ["重複 VEVENT", o({ kind: "VEVENT", rrule: "FREQ=DAILY" }), { title: false, done: false, date: false }],
  ["帶 override", o({ kind: "VEVENT", hasOverrides: true }), { title: false, done: false, date: false }],
  ["VTODO 帶 override", o({ hasOverrides: true }), { title: false, done: false, date: false }],
] as [string, CalObject, object][])("%s", (_n, obj, expected) => {
  expect(editable(obj)).toEqual(expected);
});
