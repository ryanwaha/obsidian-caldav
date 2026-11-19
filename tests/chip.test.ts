import { expect, test, vi } from "vitest";
import { renderRef } from "../src/render/chip";
import type { RefView } from "../src/render/present";

const ok: RefView = { state: "ok", id: "5cd3cmqd", text: "test2", kind: "VTODO", done: true, when: "12/16 15:00", recur: "每週二", overdue: false };

test("ok + done", () => {
  const el = document.createElement("span");
  renderRef(el, ok, () => {});
  expect(el.classList.contains("caldav-ref")).toBe(true);
  expect(el.classList.contains("caldav-ref--ok")).toBe(true);
  expect(el.classList.contains("caldav-ref--done")).toBe(true);
  expect(el.querySelector(".caldav-ref__icon")!.textContent).toBe("☑");
  expect(el.querySelector(".caldav-ref__text")!.textContent).toBe("test2");
  expect(el.querySelector(".caldav-ref__when")!.textContent).toBe("12/16 15:00");
  expect(el.querySelector(".caldav-ref__recur")!.textContent).toBe("每週二");
  expect(el.getAttribute("data-cal-id")).toBe("5cd3cmqd");
  expect(el.title).toContain("test2");
});

test("overdue 加 class", () => {
  const el = document.createElement("span");
  renderRef(el, { ...ok, done: false, overdue: true }, () => {});
  expect(el.classList.contains("caldav-ref--overdue")).toBe(true);
  expect(el.querySelector(".caldav-ref__icon")!.textContent).toBe("☐");
});

test.each([
  [{ state: "missing", id: "x", text: "查無此物" }, "?"],
  [{ state: "ambiguous", id: "x", text: "有歧義（2 筆）" }, "?"],
  [{ state: "deleted", id: "x", text: "舊" }, "⌫"],
  [{ state: "ok", id: "x", text: "會", kind: "VEVENT" }, "◷"],
] as [RefView, string][])("icon %#", (view, icon) => {
  const el = document.createElement("span");
  renderRef(el, view, () => {});
  expect(el.querySelector(".caldav-ref__icon")!.textContent).toBe(icon);
  expect(el.querySelector(".caldav-ref__when")).toBeNull();
  expect(el.querySelector(".caldav-ref__recur")).toBeNull();
});

test("click 攔截並呼叫 onClick；mousedown 也 preventDefault", () => {
  const el = document.createElement("span");
  const fn = vi.fn();
  renderRef(el, ok, fn);
  const click = new MouseEvent("click", { bubbles: true, cancelable: true });
  el.dispatchEvent(click);
  expect(fn).toHaveBeenCalledTimes(1);
  expect(fn).toHaveBeenCalledWith(ok);
  expect(click.defaultPrevented).toBe(true);
  const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
  el.dispatchEvent(down);
  expect(down.defaultPrevented).toBe(true);
});

test("重複呼叫不會累積子元素、不重複觸發", () => {
  const el = document.createElement("span");
  const fn = vi.fn();
  renderRef(el, ok, fn);
  renderRef(el, { ...ok, state: "missing", text: "查無此物" }, fn);
  expect(el.querySelectorAll(".caldav-ref__text")).toHaveLength(1);
  expect(el.classList.contains("caldav-ref--ok")).toBe(false);
  el.click();
  expect(fn).toHaveBeenCalledTimes(1);
});
