import { describe, expect, test } from "vitest";
import { parseResource } from "../src/ical/parse";
import type { CalObject } from "../src/types";
import { fx } from "./fixtures";

const meta = (href: string) => ({ href, etag: '"e"', collection: "/ryanw/test/" });
const ios = (p: string) => fx(`ios-27.2/${p}`);
async function ok(ics: string): Promise<CalObject> {
  const r = await parseResource(ics, meta("/ryanw/test/x.ics"));
  if ("skip" in r) throw new Error(`skipped: ${r.skip}`);
  return r;
}

describe("parseResource", () => {
  test("重複 VTODO master（test2）", async () => {
    const o = await ok(ios("10-after-phone/test/F17BEA7B-D695-4111-B0FC-481F6BD1EC2A.ics"));
    expect(o.kind).toBe("VTODO");
    expect(o.uid).toBe("F17BEA7B-D695-4111-B0FC-481F6BD1EC2A");
    expect(o.shortId).toBe("5cd3cmqd");
    expect(o.summary).toBe("test2");
    expect(o.rrule).toBe("FREQ=WEEKLY;BYDAY=TU,WE,FR");
    expect(o.due).toEqual({ value: "20261216T150000", dateOnly: false, tzid: "Asia/Taipei" });
    expect(o.status).toBe("NEEDS-ACTION");
    expect(o.created).toBe("20261119T064923Z");
    expect(o.hasOverrides).toBe(false);
    expect(o.href).toBe("/ryanw/test/x.ics");
    expect(o.etag).toBe('"e"');
  });

  test("完成副本", async () => {
    const o = await ok(ios("10-after-phone/test/76F72A6F-2164-4BD7-9C97-0F5062FAB561.ics"));
    expect(o.status).toBe("COMPLETED");
    expect(o.completed).toBe("20261119T065623Z");
    expect(o.rrule).toBeUndefined();
  });

  test("全天重複事件", async () => {
    const o = await ok(ios("00-baseline/1000FF97-293C-4475-BC63-055D0C5B413D.ics"));
    expect(o.kind).toBe("VEVENT");
    expect(o.start).toEqual({ value: "20261119", dateOnly: true });
    expect(o.end).toEqual({ value: "20261120", dateOnly: true });
    expect(o.rrule).toBe("FREQ=WEEKLY");
  });

  test("帶位置提醒：ics 原樣保存", async () => {
    const raw = ios("10-after-phone/tasks/CD14C2C1-9D2C-4F19-B96C-71F394462131.ics");
    const o = await ok(raw);
    expect(o.ics).toBe(raw);
    expect(o.summary).toBe("test1");
  });

  test("UTC 時間保留 Z", async () => {
    const o = await ok(["BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VTODO", "UID:u", "DUE:20261120T040000Z", "END:VTODO", "END:VCALENDAR"].join("\r\n"));
    expect(o.due).toEqual({ value: "20261120T040000Z", dateOnly: false });
    expect(o.summary).toBe("");
  });

  test("master + RECURRENCE-ID override", async () => {
    const ics = ["BEGIN:VCALENDAR", "VERSION:2.0",
      "BEGIN:VEVENT", "UID:ev", "RECURRENCE-ID;TZID=Asia/Taipei:20261126T100000", "DTSTART;TZID=Asia/Taipei:20261126T110000", "SUMMARY:改時間的那次", "END:VEVENT",
      "BEGIN:VEVENT", "UID:ev", "DTSTART;TZID=Asia/Taipei:20261119T100000", "RRULE:FREQ=WEEKLY", "SUMMARY:週會", "END:VEVENT",
      "END:VCALENDAR"].join("\r\n");
    const o = await ok(ics);
    expect(o.hasOverrides).toBe(true);
    expect(o.summary).toBe("週會");
    expect(o.start).toEqual({ value: "20261119T100000", dateOnly: false, tzid: "Asia/Taipei" });
  });

  test("只有 override 時取第一個，hasOverrides 為 true", async () => {
    const ics = ["BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", "UID:ev", "RECURRENCE-ID:20261126T100000Z", "DTSTART:20261126T110000Z", "SUMMARY:孤兒", "END:VEVENT", "END:VCALENDAR"].join("\r\n");
    const o = await ok(ics);
    expect(o.hasOverrides).toBe(true);
    expect(o.summary).toBe("孤兒");
  });

  test.each([
    ["VJOURNAL", ["BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VJOURNAL", "UID:j", "END:VJOURNAL", "END:VCALENDAR"].join("\r\n")],
    ["缺 UID", ["BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VTODO", "SUMMARY:x", "END:VTODO", "END:VCALENDAR"].join("\r\n")],
    ["亂碼", "not an icalendar \u0000 at all"],
    ["空字串", ""],
  ])("%s → skip", async (_name, ics) => {
    const r = await parseResource(ics, meta("/ryanw/test/bad.ics"));
    expect(r).toHaveProperty("skip");
    expect((r as { skip: string }).skip.length).toBeGreaterThan(0);
  });
});
