import { describe, expect, test, vi } from "vitest";
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

test("pending 與 failed", () => {
  const el = document.createElement("span");
  renderRef(el, { state: "pending", id: "x", text: "新", kind: "VTODO" }, () => {});
  expect(el.querySelector(".caldav-ref__icon")!.textContent).toBe("⇡");
  expect(el.classList.contains("caldav-ref--pending")).toBe(true);
  renderRef(el, { state: "pending", id: "x", text: "新", kind: "VTODO", failed: true }, () => {});
  expect(el.classList.contains("caldav-ref--failed")).toBe(true);
});

describe("icon toggle", () => {
  const obj = { href: "/h", collection: "/c/", etag: "", uid: "u", shortId: "x", kind: "VTODO" as const, summary: "s", hasOverrides: false, ics: "" };
  test("可切換的任務：點圖示呼叫 onToggle，不開詳情", () => {
    const el = document.createElement("span");
    const click = vi.fn(), toggle = vi.fn();
    renderRef(el, { ...ok, obj }, click, toggle);
    (el.querySelector(".caldav-ref__icon") as HTMLElement).click();
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(click).not.toHaveBeenCalled();
    (el.querySelector(".caldav-ref__text") as HTMLElement).click();
    expect(click).toHaveBeenCalledTimes(1);
    expect(el.querySelector(".caldav-ref__icon")!.classList.contains("caldav-ref__icon--toggle")).toBe(true);
  });
  test("重複任務：點圖示開詳情", () => {
    const el = document.createElement("span");
    const click = vi.fn(), toggle = vi.fn();
    renderRef(el, { ...ok, obj: { ...obj, rrule: "FREQ=WEEKLY" } }, click, toggle);
    (el.querySelector(".caldav-ref__icon") as HTMLElement).click();
    expect(toggle).not.toHaveBeenCalled();
    expect(click).toHaveBeenCalledTimes(1);
  });
});

describe("M5 狀態", () => {
  const obj = { href: "/b/n.ics", collection: "/b/", etag: '"1"', uid: "n", shortId: "nnnnnnnn", kind: "VTODO" as const, summary: "交週報", hasOverrides: false, ics: "" };
  test("moved：照常顯示圖示、可切換完成，並加註已搬移", () => {
    const el = document.createElement("span");
    const toggle = vi.fn(), click = vi.fn();
    renderRef(el, { state: "moved", id: "oldoldol", text: "交週報", kind: "VTODO", done: false, obj, movedFrom: "/a/" }, click, toggle);
    expect(el.classList.contains("caldav-ref--moved")).toBe(true);
    expect(el.querySelector(".caldav-ref__icon")!.textContent).toBe("☐");
    expect(el.querySelector(".caldav-ref__moved")!.textContent).toBe("↪");
    expect(el.title).toContain("已搬移");
    (el.querySelector(".caldav-ref__icon") as HTMLElement).click();
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(click).not.toHaveBeenCalled();
  });
  test("maybe-moved：… 圖示，加註可能已搬移，不可切換", () => {
    const el = document.createElement("span");
    const toggle = vi.fn(), click = vi.fn();
    renderRef(el, { state: "maybe-moved", id: "oldoldol", text: "舊標題" }, click, toggle);
    expect(el.querySelector(".caldav-ref__icon")!.textContent).toBe("…");
    expect(el.querySelector(".caldav-ref__when")!.textContent).toBe("可能已搬移");
    (el.querySelector(".caldav-ref__icon") as HTMLElement).click();
    expect(toggle).not.toHaveBeenCalled();
    expect(click).toHaveBeenCalledTimes(1);
  });
});
