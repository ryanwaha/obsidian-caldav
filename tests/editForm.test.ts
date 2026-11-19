import { expect, test } from "vitest";
import { dateInputOf, diffPatch } from "../src/ui/editForm";
import type { CalObject } from "../src/types";

const o = (extra: Partial<CalObject>): CalObject => ({ href: "/h", collection: "/c/", etag: "", uid: "u", shortId: "x", kind: "VTODO", summary: "原", hasOverrides: false, ics: "", status: "NEEDS-ACTION", ...extra });

test("dateInputOf", () => {
  expect(dateInputOf(undefined)).toEqual({ date: "", time: "" });
  expect(dateInputOf({ value: "20261124", dateOnly: true })).toEqual({ date: "2026-11-24", time: "" });
  expect(dateInputOf({ value: "20261124T153000", dateOnly: false, tzid: "Asia/Taipei" })).toEqual({ date: "2026-11-24", time: "15:30" });
  expect(dateInputOf({ value: "20261124T070000Z", dateOnly: false })).toEqual({ date: "2026-11-24", time: "15:00" }); // 轉台北
});

test("diffPatch：只包含改過的欄位", () => {
  const obj = o({ due: { value: "20261124T153000", dateOnly: false, tzid: "Asia/Taipei" } });
  expect(diffPatch(obj, { summary: "原", done: false, date: "2026-11-24", time: "15:30" })).toEqual({});
  expect(diffPatch(obj, { summary: " 新 ", done: false, date: "2026-11-24", time: "15:30" })).toEqual({ summary: "新" });
  expect(diffPatch(obj, { summary: "原", done: true, date: "2026-11-24", time: "15:30" })).toEqual({ done: true });
  expect(diffPatch(obj, { summary: "原", done: false, date: "2026-11-25", time: "" })).toEqual({ date: { date: "2026-11-25" } });
  expect(diffPatch(obj, { summary: "原", done: false, date: "", time: "" })).toEqual({ date: null });
  expect(diffPatch(o({}), { summary: "原", done: false, date: "", time: "09:00" })).toEqual({ date: { date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), time: "09:00" } });
});

test("diffPatch：空標題不送", () => {
  expect(diffPatch(o({}), { summary: "  ", done: false, date: "", time: "" })).toEqual({});
});

test("diffPatch：VEVENT 用 DTSTART", () => {
  const ev = o({ kind: "VEVENT", start: { value: "20261120", dateOnly: true } });
  expect(diffPatch(ev, { summary: "原", done: false, date: "2026-11-20", time: "" })).toEqual({});
  expect(diffPatch(ev, { summary: "原", done: false, date: "2026-11-21", time: "" })).toEqual({ date: { date: "2026-11-21" } });
});
