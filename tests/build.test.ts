import { describe, expect, test } from "vitest";
import { buildTodo } from "../src/ical/build";
import { parseResource } from "../src/ical/parse";
import type { CalObject } from "../src/types";

const now = new Date(Date.UTC(2026, 10, 19, 8, 0, 0));
async function roundtrip(ics: string): Promise<CalObject> {
  const r = await parseResource(ics, { href: "/c/x.ics", etag: "", collection: "/c/" });
  if ("skip" in r) throw new Error(r.skip);
  return r;
}

describe("buildTodo", () => {
  test("有時間：TZID=Asia/Taipei，附 VTIMEZONE", async () => {
    const ics = buildTodo({ uid: "u1", summary: "交週報", due: { date: "2026-11-24", time: "15:00" } }, now);
    expect(ics).toContain("DUE;TZID=Asia/Taipei:20261124T150000");
    expect(ics).toContain("BEGIN:VTIMEZONE");
    const o = await roundtrip(ics);
    expect(o).toMatchObject({ uid: "u1", kind: "VTODO", summary: "交週報", status: "NEEDS-ACTION" });
    expect(o.due).toEqual({ value: "20261124T150000", dateOnly: false, tzid: "Asia/Taipei", epoch: Date.UTC(2026, 10, 24, 7, 0, 0) });
  });
  test("只有日期：VALUE=DATE，不附 VTIMEZONE", async () => {
    const ics = buildTodo({ uid: "u2", summary: "繳費", due: { date: "2026-11-24" } }, now);
    expect(ics).toContain("DUE;VALUE=DATE:20261124");
    expect(ics).not.toContain("VTIMEZONE");
    expect((await roundtrip(ics)).due).toEqual({ value: "20261124", dateOnly: true });
  });
  test("沒有 due", async () => {
    expect((await roundtrip(buildTodo({ uid: "u3", summary: "x" }, now))).due).toBeUndefined();
  });
  test("特殊字元原樣往返", async () => {
    const s = "a,b;c\\d\n第二行 😀";
    expect((await roundtrip(buildTodo({ uid: "u4", summary: s }, now))).summary).toBe(s);
  });
  test("摺行：每行 ≤ 75 bytes", () => {
    const ics = buildTodo({ uid: "u5", summary: "很長的中文標題".repeat(20) }, now);
    for (const line of ics.split("\r\n")) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
  });
  test("時間戳為 UTC", async () => {
    const ics = buildTodo({ uid: "u6", summary: "x" }, now);
    expect(ics).toContain("DTSTAMP:20261119T080000Z");
    expect((await roundtrip(ics)).created).toBe("20261119T080000Z");
  });
});
