import { expect, test } from "vitest";
import { toLocalParts } from "../src/projection/dates";
import { sanitizeAlias } from "../src/projection/alias";

test("date-only", () => expect(toLocalParts({ value: "20261124", dateOnly: true })).toEqual({ date: "2026-11-24" }));
test("taipei local", () => expect(toLocalParts({ value: "20261124T093000", dateOnly: false, tzid: "Asia/Taipei" })).toEqual({ date: "2026-11-24", time: "09:30" }));
test("utc-crosses-midnight", () => expect(toLocalParts({ value: "20261123T170000Z", dateOnly: false, epoch: Date.UTC(2026, 10, 23, 17) })).toEqual({ date: "2026-11-24", time: "01:00" }));
test("other tz via epoch", () => expect(toLocalParts({ value: "20261124T090000", dateOnly: false, tzid: "Europe/Berlin", epoch: Date.UTC(2026, 10, 24, 8) })).toEqual({ date: "2026-11-24", time: "16:00" }));
test("floating (no tzid, no Z) treated as local", () => expect(toLocalParts({ value: "20261124T093000", dateOnly: false })).toEqual({ date: "2026-11-24", time: "09:30" }));
test("sanitizeAlias", () => {
  expect(sanitizeAlias("繳費：電費 | 十一月 #帳單")).toBe("繳費：電費 | 十一月 #帳單");
  expect(sanitizeAlias("a [[b]] c\nd")).toBe("a ⟦b⟧ c d");
});
