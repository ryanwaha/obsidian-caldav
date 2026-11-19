import type { RefView } from "./present";

const ICON = (v: RefView) =>
  v.state === "deleted" ? "⌫"
  : v.state === "missing" || v.state === "ambiguous" ? "?"
  : v.kind === "VEVENT" ? "◷"
  : v.done ? "☑" : "☐";

type Handlers = { click: (e: MouseEvent) => void; mousedown: (e: MouseEvent) => void };
const bound = new WeakMap<HTMLElement, Handlers>();

/** 把 el 填成一個參照 chip；可對同一元素重複呼叫。 */
export function renderRef(el: HTMLElement, view: RefView, onClick: (view: RefView) => void): void {
  el.replaceChildren();
  el.className = "caldav-ref";
  el.classList.add(`caldav-ref--${view.state}`);
  if (view.done) el.classList.add("caldav-ref--done");
  if (view.overdue) el.classList.add("caldav-ref--overdue");
  el.setAttribute("data-cal-id", view.id);
  el.title = [view.obj?.summary ?? view.text, view.when, view.recur].filter(Boolean).join(" · ");

  const part = (cls: string, text: string) => {
    const s = el.ownerDocument.createElement("span");
    s.className = `caldav-ref__${cls}`;
    s.textContent = text;
    el.appendChild(s);
  };
  part("icon", ICON(view));
  part("text", view.text);
  if (view.when) part("when", view.when);
  if (view.recur) part("recur", view.recur);

  const old = bound.get(el);
  if (old) { el.removeEventListener("click", old.click); el.removeEventListener("mousedown", old.mousedown); }
  const h: Handlers = {
    click: (e) => { e.preventDefault(); e.stopPropagation(); onClick(view); },
    // 避免 Live Preview 把游標移進參照而展開原文
    mousedown: (e) => { e.preventDefault(); e.stopPropagation(); },
  };
  el.addEventListener("click", h.click);
  el.addEventListener("mousedown", h.mousedown);
  bound.set(el, h);
}
