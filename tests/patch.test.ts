import { describe, expect, test } from "vitest";
import { applyPatch, managedValues } from "../src/ical/patch";
import { parseResource } from "../src/ical/parse";
import type { CalObject } from "../src/types";
import { fx } from "./fixtures";

const now = new Date(Date.UTC(2026, 10, 19, 9, 0, 0));
const ios = (p: string) => fx(`ios-27.2/${p}`);
const unfold = (s: string) => s.replace(/\r\n[ \t]/g, "");
async function parsed(ics: string): Promise<CalObject> {
  const r = await parseResource(ics, { href: "/c/x.ics", etag: "", collection: "/c/" });
  if ("skip" in r) throw new Error(r.skip);
  return r;
}
const vcal = (...l: string[]) => ["BEGIN:VCALENDAR", "VERSION:2.0", ...l, "END:VCALENDAR", ""].join("\r\n");

describe("applyPatch", () => {
  test("T1 未知欄位、CATEGORIES、DESCRIPTION 保留；只改標題", async () => {
    const before = ios("10-after-phone/test/t1-unknown-fields.ics");
    const after = applyPatch(before, { summary: "新標題" }, now);
    const u = unfold(after);
    for (const keep of ["X-TEST:keep", "X-TEST-PARAM;FOO=bar:value", "CATEGORIES:alpha,beta", "X-APPLE-SORT-ORDER:4", "PRIORITY:1", "DUE;TZID=Asia/Taipei:20261121T090000"]) expect(u).toContain(keep);
    expect((await parsed(after)).summary).toBe("新標題");
    expect(u).toContain("LAST-MODIFIED:20261119T090000Z");
    expect(u).toContain("DTSTAMP:20261119T090000Z");
  });

  test("完成與取消完成", async () => {
    const base = vcal("BEGIN:VTODO", "UID:a", "SUMMARY:x", "STATUS:NEEDS-ACTION", "END:VTODO");
    const done = applyPatch(base, { done: true }, now);
    expect(unfold(done)).toContain("COMPLETED:20261119T090000Z");
    expect(unfold(done)).toContain("PERCENT-COMPLETE:100");
    expect((await parsed(done)).status).toBe("COMPLETED");
    const undone = applyPatch(done, { done: false }, now);
    expect(unfold(undone)).not.toMatch(/^COMPLETED:/m);
    expect(unfold(undone)).not.toContain("PERCENT-COMPLETE");
    expect((await parsed(undone)).status).toBe("NEEDS-ACTION");
  });

  test("改 DUE：DTSTART 跟著改、絕對 VALARM 平移、位置提醒不動", async () => {
    const before = ios("10-after-phone/tasks/CD14C2C1-9D2C-4F19-B96C-71F394462131.ics"); // due 11/20 12:00，alarm 04:00Z，另有位置提醒
    const after = applyPatch(before, { date: { date: "2026-11-22", time: "15:30" } }, now);
    const o = await parsed(after);
    expect(o.due).toMatchObject({ value: "20261122T153000", tzid: "Asia/Taipei" });
    expect(o.start).toMatchObject({ value: "20261122T153000", tzid: "Asia/Taipei" });
    const u = unfold(after);
    expect(u).toContain("TRIGGER;VALUE=DATE-TIME:20261122T073000Z"); // 平移 2 天 3.5 小時
    expect(u).toContain("TRIGGER;VALUE=DATE-TIME:19760401T005545Z"); // 位置提醒不動
    expect(u).toContain("X-APPLE-STRUCTURED-LOCATION");
  });

  test("改成全天：VALUE=DATE；DTSTART 跟著", async () => {
    const before = ios("10-after-phone/test/8ADF576B-CED5-4071-BE32-9CB2BBA5F4B1.ics");
    const o = await parsed(applyPatch(before, { date: { date: "2026-11-25" } }, now));
    expect(o.due).toEqual({ value: "20261125", dateOnly: true });
    expect(o.start).toEqual({ value: "20261125", dateOnly: true });
  });

  test("清除日期：移除 DUE 與跟著的 DTSTART", async () => {
    const before = ios("10-after-phone/test/8ADF576B-CED5-4071-BE32-9CB2BBA5F4B1.ics");
    const o = await parsed(applyPatch(before, { date: null }, now));
    expect(o.due).toBeUndefined();
    expect(o.start).toBeUndefined();
  });

  test("沒有 VTIMEZONE 時補上；原本 UTC 改寫成 TZID", async () => {
    const base = vcal("BEGIN:VTODO", "UID:z", "DUE:20261120T040000Z", "END:VTODO");
    const after = applyPatch(base, { date: { date: "2026-11-21", time: "09:00" } }, now);
    expect(after).toContain("BEGIN:VTIMEZONE");
    expect(after).toContain("TZID:Asia/Taipei");
    expect((await parsed(after)).due).toMatchObject({ value: "20261121T090000", tzid: "Asia/Taipei" });
  });

  test("VEVENT 改開始：結束平移、SEQUENCE+1", async () => {
    const before = ios("00-baseline/C330573A-6CB3-4BC9-BE47-E666252903CA.ics"); // 11/20 15:00-16:00，SEQUENCE:0
    const after = applyPatch(before, { date: { date: "2026-11-21", time: "10:00" } }, now);
    const o = await parsed(after);
    expect(o.start).toMatchObject({ value: "20261121T100000" });
    expect(o.end).toMatchObject({ value: "20261121T110000" });
    expect(unfold(after)).toContain("SEQUENCE:1");
    expect(unfold(after)).toMatch(/^URL(;VALUE=URI)?:http:\/\/url\.test$/m); // ical.js 省略預設的 VALUE=URI，語意相同
  });

  test("摺行 ≤ 75 octets", () => {
    const after = applyPatch(vcal("BEGIN:VTODO", "UID:f", "END:VTODO"), { summary: "很長的中文標題".repeat(20) }, now);
    for (const line of after.split("\r\n")) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
  });
});

describe("managedValues", () => {
  test("讀出標題、完成、日期", () => {
    expect(managedValues(ios("10-after-phone/test/8ADF576B-CED5-4071-BE32-9CB2BBA5F4B1.ics"))).toEqual({ summary: "reminder test:modified", status: "NEEDS-ACTION", date: "date-time|Asia/Taipei|20261119T150000" });
    expect(managedValues(vcal("BEGIN:VEVENT", "UID:e", "SUMMARY:會", "DTSTART;VALUE=DATE:20261120", "END:VEVENT"))).toEqual({ summary: "會", status: "", date: "date||20261120" });
  });
});

describe("提醒：形式改變時", () => {
  const allDay = vcal("BEGIN:VTODO", "UID:a", "DUE;VALUE=DATE:20261124", "BEGIN:VALARM", "ACTION:DISPLAY", "TRIGGER;VALUE=DATE-TIME:20261124T010000Z", "END:VALARM", "END:VTODO");
  test("全天 → 有時間：提醒設在新的到期時間", () => {
    expect(unfold(applyPatch(allDay, { date: { date: "2026-11-25", time: "10:00" } }, now))).toContain("TRIGGER;VALUE=DATE-TIME:20261125T020000Z");
  });
  test("有時間 → 全天：提醒設在新日期 09:00（台北）", () => {
    const timed = vcal("BEGIN:VTODO", "UID:b", "DUE;TZID=Asia/Taipei:20261124T150000", "BEGIN:VALARM", "ACTION:DISPLAY", "TRIGGER;VALUE=DATE-TIME:20261124T070000Z", "END:VALARM", "END:VTODO");
    expect(unfold(applyPatch(timed, { date: { date: "2026-11-26" } }, now))).toContain("TRIGGER;VALUE=DATE-TIME:20261126T010000Z");
  });
  test("全天 → 全天：平移天數", () => {
    expect(unfold(applyPatch(allDay, { date: { date: "2026-11-26" } }, now))).toContain("TRIGGER;VALUE=DATE-TIME:20261126T010000Z");
  });
});

describe("review fixes", () => {
  const MANAGED = /^(SUMMARY|STATUS|COMPLETED|PERCENT-COMPLETE|DUE|DTSTART|DTEND|DTSTAMP|LAST-MODIFIED|SEQUENCE|TRIGGER)[;:]/;
  test.each([
    "10-after-phone/tasks/CD14C2C1-9D2C-4F19-B96C-71F394462131.ics",
    "00-baseline/85483CE1-1395-4CD0-BF87-7B32BA498B32.ics",
    "10-after-phone/test/t1-unknown-fields.ics",
  ])("C1：修改兩次後，未管理的行逐位元組相同（%s）", (f) => {
    const orig = ios(f);
    const twice = applyPatch(applyPatch(orig, { summary: "一" }, now), { done: true }, now);
    const keep = (s: string) => unfold(s).split("\r\n").filter((l) => l && !MANAGED.test(l));
    expect(keep(twice).filter((l) => !/^(COMPLETED|PERCENT-COMPLETE)/.test(l))).toEqual(keep(orig));
  });

  test("I1：重複 VTODO 不能改完成狀態；重複 VEVENT、帶 override 不能改", () => {
    const rt = vcal("BEGIN:VTODO", "UID:r", "RRULE:FREQ=WEEKLY", "DUE;VALUE=DATE:20261124", "END:VTODO");
    expect(() => applyPatch(rt, { done: true }, now)).toThrow(/重複/);
    expect(() => applyPatch(rt, { summary: "可以" }, now)).not.toThrow();
    const re = vcal("BEGIN:VEVENT", "UID:e", "DTSTART;VALUE=DATE:20261120", "RRULE:FREQ=WEEKLY", "END:VEVENT");
    expect(() => applyPatch(re, { summary: "x" }, now)).toThrow(/重複/);
    const ov = vcal("BEGIN:VEVENT", "UID:o", "DTSTART;VALUE=DATE:20261120", "END:VEVENT", "BEGIN:VEVENT", "UID:o", "RECURRENCE-ID;VALUE=DATE:20261127", "DTSTART;VALUE=DATE:20261128", "END:VEVENT");
    expect(() => applyPatch(ov, { summary: "x" }, now)).toThrow(/重複/);
  });

  test("I2b：重複 VTODO 不能清除日期", () => {
    const rt = vcal("BEGIN:VTODO", "UID:r", "RRULE:FREQ=WEEKLY", "DTSTART;VALUE=DATE:20261124", "DUE;VALUE=DATE:20261124", "END:VTODO");
    expect(() => applyPatch(rt, { date: null }, now)).toThrow(/重複/);
  });

  test("I2：managedValues 保留 STATUS 原文與日期的時區、形式", () => {
    const a = managedValues(vcal("BEGIN:VTODO", "UID:a", "STATUS:CANCELLED", "DUE;TZID=America/New_York:20261124T150000", "END:VTODO"));
    const b = managedValues(vcal("BEGIN:VTODO", "UID:a", "STATUS:COMPLETED", "DUE;TZID=Asia/Taipei:20261124T150000", "END:VTODO"));
    expect(a.status).toBe("CANCELLED");
    expect(b.status).toBe("COMPLETED");
    expect(a.date).not.toBe(b.date);
  });
});
