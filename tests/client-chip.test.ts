import { expect, test } from "vitest";
import { chipView } from "../src/client/chip";
import { writableHash } from "../src/projection/fields";

const now = new Date(2026, 10, 23);
const base = (o: Record<string, unknown> = {}) => {
  const fm: Record<string, unknown> = { title: "交週報", status: "needs-action", due: "2026-11-24", list: "tasks", aliases: ["交週報"], _kind: "VTODO", _uid: "u", _etag: '"e"', _sync: "ok", _deleted: false, ...o };
  if (!("_hash" in o)) fm._hash = writableHash(fm);
  return fm;
};

test("todo-open", () => expect(chipView(base(), "交週報", now)).toMatchObject({ kind: "VTODO", title: "交週報", checkbox: { checked: false, enabled: true }, date: "11/24", light: "ok", titleChanged: false }));
test("todo-completed-checked", () => expect(chipView(base({ status: "completed" }), undefined, now).checkbox).toEqual({ checked: true, enabled: true }));
test("timed date", () => expect(chipView(base({ due_time: "09:30" }), undefined, now).date).toBe("11/24 09:30"));
test("recurring-checkbox-disabled", () => {
  const v = chipView(base({ _rrule: "每週" }), undefined, now);
  expect(v.checkbox).toEqual({ checked: false, enabled: false });
  expect(v.date).toBe("每週・11/24");
});
test("deleted-readonly", () => {
  const v = chipView(base({ _deleted: true }), undefined, now);
  expect(v.light).toBe("deleted");
  expect(v.checkbox?.enabled).toBe(false);
});
test("pending-when-hash-differs", () => {
  const fm = base(); fm.title = "改了還沒送";
  expect(chipView(fm, undefined, now).light).toBe("pending");
});
test("pending-when-not-yet-created", () => expect(chipView(base({ _etag: undefined, _hash: undefined }), undefined, now).light).toBe("pending"));
test("rejected-message", () => expect(chipView(base({ _sync: "rejected", _sync_msg: "重複任務的完成請在提醒事項操作" }), undefined, now)).toMatchObject({ light: "rejected", message: "重複任務的完成請在提醒事項操作" }));
test("conflict-light", () => {
  const v = chipView(base({ _sync: "conflict", _conflict: { title: { mine: "A", theirs: "交週報" } } }), undefined, now);
  expect(v.light).toBe("conflict");
  expect(v.message).toContain("A");
});
test("event-no-checkbox", () => {
  const v = chipView({ title: "會議", start: "2026-11-24", start_time: "10:00", end: "2026-11-24", end_time: "11:30", list: "work", _kind: "VEVENT", _uid: "e", _etag: '"e"', _sync: "ok", _deleted: false, _hash: writableHash({ title: "會議", start: "2026-11-24", start_time: "10:00", end: "2026-11-24", end_time: "11:30", list: "work" }) }, undefined, now);
  expect(v.checkbox).toBeUndefined();
  expect(v.date).toBe("11/24 10:00–11:30");
});
test("title-changed", () => {
  expect(chipView(base({ title: "新標題", aliases: ["新標題"] }), "交週報", now).titleChanged).toBe(true);
  expect(chipView(base(), "交週報", now).titleChanged).toBe(false);
});

test("unsent create: no edits until the server has created it", () => {
  const v = chipView(base({ _etag: undefined, _hash: undefined }), undefined, now);
  expect(v.light).toBe("pending");
  expect(v.checkbox?.enabled).toBe(false);
  expect(v.editable).toBe(false);
  expect(chipView(base(), undefined, now).editable).toBe(true);
});
