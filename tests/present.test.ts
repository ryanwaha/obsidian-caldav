import { describe, expect, test } from "vitest";
import { parseResource } from "../src/ical/parse";
import { formatDate, nextEventOccurrence, present } from "../src/render/present";
import type { CalObject, Tombstone } from "../src/types";
import { fx } from "./fixtures";

const now = new Date(2026, 10, 19, 10, 0);
const tz = "Asia/Taipei";
async function obj(ics: string): Promise<CalObject> {
  const r = await parseResource(ics, { href: "/ryanw/test/x.ics", etag: '"e"', collection: "/ryanw/test/" });
  if ("skip" in r) throw new Error(r.skip);
  return r;
}
const vcal = (...lines: string[]) => ["BEGIN:VCALENDAR", "VERSION:2.0", ...lines, "END:VCALENDAR"].join("\r\n");

describe("formatDate", () => {
  test.each([
    [{ value: "20261119T150000", dateOnly: false, tzid: tz }, "今天 15:00"],
    [{ value: "20261120T090000", dateOnly: false, tzid: tz }, "明天 09:00"],
    [{ value: "20261124T150000", dateOnly: false, tzid: tz }, "11/24 15:00"],
    [{ value: "20261119", dateOnly: true }, "今天"],
    [{ value: "20270105", dateOnly: true }, "2027/1/5"],
    [{ value: "20261120T040000Z", dateOnly: false }, "明天 12:00"],
  ])("%j → %s", (d, expected) => {
    expect(formatDate(d, now)).toBe(expected);
  });
});

describe("present", () => {
  test("重複 VTODO master，空標籤", async () => {
    const o = await obj(fx("ios-27.2/10-after-phone/test/F17BEA7B-D695-4111-B0FC-481F6BD1EC2A.ics"));
    const v = present("5cd3cmqd", "", [o], [], now);
    expect(v).toMatchObject({ state: "ok", id: "5cd3cmqd", text: "test2", kind: "VTODO", recur: "每週二、三、五", when: "12/16 15:00", done: false, overdue: false });
    expect(v.obj).toBe(o);
  });
  test("有標籤時用標籤", async () => {
    const o = await obj(fx("ios-27.2/10-after-phone/test/F17BEA7B-D695-4111-B0FC-481F6BD1EC2A.ics"));
    expect(present("5cd3cmqd", "週報", [o], [], now).text).toBe("週報");
  });
  test("完成副本", async () => {
    const o = await obj(fx("ios-27.2/10-after-phone/test/76F72A6F-2164-4BD7-9C97-0F5062FAB561.ics"));
    expect(present("x", "", [o], [], now)).toMatchObject({ done: true, overdue: false });
  });
  test("逾期", async () => {
    const o = await obj(vcal("BEGIN:VTODO", "UID:late", "SUMMARY:遲了", "STATUS:NEEDS-ACTION", "DUE;TZID=Asia/Taipei:20261118T090000", "END:VTODO"));
    expect(present("x", "", [o], [], now)).toMatchObject({ overdue: true, when: "11/18 09:00" });
  });
  test("沒有 DUE 時用 DTSTART", async () => {
    const o = await obj(vcal("BEGIN:VTODO", "UID:s", "DTSTART;VALUE=DATE:20261125", "END:VTODO"));
    expect(present("x", "", [o], [], now).when).toBe("11/25");
  });
  test("非重複 VEVENT 用 DTSTART", async () => {
    const o = await obj(fx("ios-27.2/00-baseline/C330573A-6CB3-4BC9-BE47-E666252903CA.ics"));
    expect(present("x", "", [o], [], now)).toMatchObject({ kind: "VEVENT", when: "明天 15:00", text: "test3" });
  });
  test("ambiguous", async () => {
    const a = await obj(vcal("BEGIN:VTODO", "UID:a", "END:VTODO"));
    const b = await obj(vcal("BEGIN:VTODO", "UID:b", "END:VTODO"));
    const v = present("x", "", [a, b], [], now);
    expect(v).toMatchObject({ state: "ambiguous", text: "有歧義（2 筆）" });
    expect(v.candidates).toHaveLength(2);
  });
  test("deleted", () => {
    const t: Tombstone = { href: "/h", uid: "u", shortId: "x", collection: "/c/", summary: "暫存刪除", deletedAt: 1 };
    expect(present("x", "", [], [t], now)).toMatchObject({ state: "deleted", text: "暫存刪除" });
    expect(present("x", "我的標籤", [], [t], now).text).toBe("我的標籤");
  });
  test("missing", () => {
    expect(present("x", "", [], [], now)).toMatchObject({ state: "missing", text: "查無此物" });
  });
  test("重複 VEVENT 的 when 用下一次發生", async () => {
    const o = await obj(fx("ios-27.2/00-baseline/1000FF97-293C-4475-BC63-055D0C5B413D.ics"));
    expect(present("x", "", [o], [], new Date(2026, 10, 20, 8)).when).toBe("11/26");
  });
});

describe("nextEventOccurrence", () => {
  test("全天每週", async () => {
    const o = await obj(fx("ios-27.2/00-baseline/1000FF97-293C-4475-BC63-055D0C5B413D.ics"));
    expect(nextEventOccurrence(o, new Date(2026, 10, 20, 8))).toEqual({ value: "20261126", dateOnly: true });
  });
  test("當天的全天事件仍算下一次", async () => {
    const o = await obj(fx("ios-27.2/00-baseline/1000FF97-293C-4475-BC63-055D0C5B413D.ics"));
    expect(nextEventOccurrence(o, now)).toEqual({ value: "20261119", dateOnly: true });
  });
  test("帶 TZID 的每週事件", async () => {
    const o = await obj(vcal("BEGIN:VEVENT", "UID:w", "DTSTART;TZID=Asia/Taipei:20261117T100000", "RRULE:FREQ=WEEKLY", "END:VEVENT"));
    expect(nextEventOccurrence(o, now)).toEqual({ value: "20261124T100000", dateOnly: false, tzid: "Asia/Taipei" });
  });
  test("UNTIL 已過", async () => {
    const o = await obj(vcal("BEGIN:VEVENT", "UID:u", "DTSTART;VALUE=DATE:20261001", "RRULE:FREQ=WEEKLY;UNTIL=20261015", "END:VEVENT"));
    expect(nextEventOccurrence(o, now)).toBeUndefined();
  });
});

describe("review fixes", () => {
  test("I1：2010 年起的每日事件仍算得出下一次", async () => {
    const o = await obj(vcal("BEGIN:VEVENT", "UID:old", "DTSTART;TZID=Asia/Taipei:20100101T090000", "RRULE:FREQ=DAILY", "END:VEVENT"));
    expect(nextEventOccurrence(o, now)).toEqual(expect.objectContaining({ value: "20261120T090000" }));
  });
  test("I1：快轉保留 INTERVAL 對齊（每 2 天，2010-01-01 起）", async () => {
    const o = await obj(vcal("BEGIN:VEVENT", "UID:i2", "DTSTART;VALUE=DATE:20100101", "RRULE:FREQ=DAILY;INTERVAL=2", "END:VEVENT"));
    // 2010-01-01 到 2026-11-19 共 6166 天（偶數）→ 11/19 是發生日
    expect(nextEventOccurrence(o, now)).toEqual({ value: "20261119", dateOnly: true });
  });
  test("I1：每週 BYDAY 自 2015 年起", async () => {
    const o = await obj(vcal("BEGIN:VEVENT", "UID:w15", "DTSTART;TZID=Asia/Taipei:20150105T100000", "RRULE:FREQ=WEEKLY;BYDAY=MO,TH", "END:VEVENT"));
    expect(nextEventOccurrence(o, now)?.value).toBe("20261119T100000"); // 11/19 週四 10:00 即 now
  });
  test("I1：COUNT 規則不快轉，照算", async () => {
    const o = await obj(vcal("BEGIN:VEVENT", "UID:c", "DTSTART;VALUE=DATE:20261101", "RRULE:FREQ=DAILY;COUNT=30", "END:VEVENT"));
    expect(nextEventOccurrence(o, now)).toEqual({ value: "20261119", dateOnly: true });
    const o2 = await obj(vcal("BEGIN:VEVENT", "UID:c2", "DTSTART;VALUE=DATE:20261101", "RRULE:FREQ=DAILY;COUNT=5", "END:VEVENT"));
    expect(nextEventOccurrence(o2, now)).toBeUndefined();
  });
  test("I4：其他時區的時間換算成本機", async () => {
    const ny = ["BEGIN:VTIMEZONE", "TZID:America/New_York", "BEGIN:STANDARD", "DTSTART:20071104T020000", "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU", "TZOFFSETFROM:-0400", "TZOFFSETTO:-0500", "TZNAME:EST", "END:STANDARD", "BEGIN:DAYLIGHT", "DTSTART:20070311T020000", "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU", "TZOFFSETFROM:-0500", "TZOFFSETTO:-0400", "TZNAME:EDT", "END:DAYLIGHT", "END:VTIMEZONE"];
    const o = await obj(vcal(...ny, "BEGIN:VEVENT", "UID:ny", "DTSTART;TZID=America/New_York:20261124T090000", "END:VEVENT"));
    expect(present("x", "", [o], [], now).when).toBe("11/24 22:00");
  });
});
