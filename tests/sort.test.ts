import { expect, test } from "vitest";
import { sortForPicker } from "../src/ui/sort";
import type { CalObject } from "../src/types";

const o = (summary: string, extra: Partial<CalObject>): CalObject => ({ href: summary, collection: "/c/", etag: "", uid: summary, shortId: "x", kind: "VTODO", summary, hasOverrides: false, ics: "", ...extra });

test("未完成任務（依到期日，無日期在後）→ 事件 → 已完成", () => {
  const items = [
    o("完成", { status: "COMPLETED", due: { value: "20261101", dateOnly: true } }),
    o("事件", { kind: "VEVENT", start: { value: "20261120", dateOnly: true } }),
    o("無日期", {}),
    o("晚", { due: { value: "20261130", dateOnly: true } }),
    o("早", { due: { value: "20261120T090000", dateOnly: false, tzid: "Asia/Taipei" } }),
  ];
  expect(sortForPicker(items).map((x) => x.summary)).toEqual(["早", "晚", "無日期", "事件", "完成"]);
});
