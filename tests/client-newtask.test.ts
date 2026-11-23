import { expect, test } from "vitest";
import { listOptions, newTaskFm } from "../src/client/newTaskLogic";

test("newTaskFm: writable fields + _uid/_kind, no _etag", () => {
  expect(newTaskFm({ title: " 交 [[報]] ", list: "tasks", date: "2026-12-01", time: "09:30" }, "uid-1")).toEqual({
    title: "交 [[報]]", status: "needs-action", due: "2026-12-01", due_time: "09:30", list: "tasks", aliases: ["交 ⟦報⟧"], _kind: "VTODO", _uid: "uid-1",
  });
  expect(newTaskFm({ title: "x", list: "tasks" }, "u")).not.toHaveProperty("due");
});
test("newTaskFm rejects bad input", () => {
  expect(() => newTaskFm({ title: "", list: "tasks" }, "u")).toThrow();
  expect(() => newTaskFm({ title: "x", list: "tasks", time: "09:00" }, "u")).toThrow();
  expect(() => newTaskFm({ title: "x", list: "" }, "u")).toThrow();
});
test("listOptions: distinct VTODO lists by frequency", () => {
  expect(listOptions([{ list: "a", _kind: "VTODO" }, { list: "b", _kind: "VTODO" }, { list: "b", _kind: "VTODO" }, { list: "ev", _kind: "VEVENT" }, {}])).toEqual(["b", "a"]);
});
