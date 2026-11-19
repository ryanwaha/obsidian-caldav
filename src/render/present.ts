import ICAL from "ical.js";
import type { CalObject, DateValue, Tombstone } from "../types";
import { describeRrule } from "./recur";

export type RefState = "ok" | "deleted" | "missing" | "ambiguous" | "pending" | "moved" | "maybe-moved";
export interface RefView {
  state: RefState;
  id: string;
  text: string;
  kind?: "VTODO" | "VEVENT";
  done?: boolean;
  when?: string;
  overdue?: boolean;
  recur?: string;
  candidates?: CalObject[];
  obj?: CalObject;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** DateValue → 本機 Date。帶 TZID 或 floating 的值視為本機 wall time（E3：一律 Asia/Taipei）。 */
export function toDate(d: DateValue): Date {
  const v = d.value;
  const y = +v.slice(0, 4), m = +v.slice(4, 6) - 1, day = +v.slice(6, 8);
  if (d.dateOnly) return new Date(y, m, day);
  const h = +v.slice(9, 11), mi = +v.slice(11, 13), s = +v.slice(13, 15);
  return v.endsWith("Z") ? new Date(Date.UTC(y, m, day, h, mi, s)) : new Date(y, m, day, h, mi, s);
}

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

export function formatDate(d: DateValue, now: Date): string {
  const t = toDate(d);
  const diff = Math.round((startOfDay(t).getTime() - startOfDay(now).getTime()) / 86_400_000);
  const day = diff === 0 ? "今天" : diff === 1 ? "明天"
    : t.getFullYear() === now.getFullYear() ? `${t.getMonth() + 1}/${t.getDate()}`
    : `${t.getFullYear()}/${t.getMonth() + 1}/${t.getDate()}`;
  return d.dateOnly ? day : `${day} ${pad(t.getHours())}:${pad(t.getMinutes())}`;
}

/** 重複 VEVENT 從 now 起的下一次（全天事件當天仍算）。 */
export function nextEventOccurrence(obj: CalObject, now: Date): DateValue | undefined {
  if (obj.kind !== "VEVENT" || !obj.rrule || !obj.start) return undefined;
  try {
    const root = new ICAL.Component(ICAL.parse(obj.ics));
    const master = root.getAllSubcomponents("vevent").find((c) => !c.hasProperty("recurrence-id"));
    if (!master) return undefined;
    const it = new ICAL.Event(master).iterator();
    const threshold = obj.start.dateOnly ? startOfDay(now) : now;
    for (let i = 0, t = it.next(); t && i < 5000; i++, t = it.next()) {
      const value = t.isDate
        ? `${t.year}${pad(t.month)}${pad(t.day)}`
        : `${t.year}${pad(t.month)}${pad(t.day)}T${pad(t.hour)}${pad(t.minute)}${pad(t.second)}${obj.start.value.endsWith("Z") ? "Z" : ""}`;
      const dv: DateValue = { value, dateOnly: t.isDate };
      if (obj.start.tzid) dv.tzid = obj.start.tzid;
      if (toDate(dv) >= threshold) return dv;
    }
  } catch {
    // 無法展開時不顯示下一次
  }
  return undefined;
}

export function present(id: string, label: string, objs: CalObject[], tombs: Tombstone[], now: Date): RefView {
  if (objs.length > 1) return { state: "ambiguous", id, text: `有歧義（${objs.length} 筆）`, candidates: objs };
  if (objs.length === 0) {
    if (tombs.length) return { state: "deleted", id, text: label || tombs[0].summary || "（無標題）" };
    return { state: "missing", id, text: label || "查無此物" };
  }
  const o = objs[0];
  const view: RefView = { state: "ok", id, text: label || o.summary || "（無標題）", kind: o.kind, obj: o };
  if (o.rrule) view.recur = describeRrule(o.rrule);
  let date: DateValue | undefined;
  if (o.kind === "VTODO") {
    view.done = o.status === "COMPLETED" || o.status === "CANCELLED";
    date = o.due ?? o.start;
    if (o.due && !view.done) {
      view.overdue = o.due.dateOnly ? toDate(o.due) < startOfDay(now) : toDate(o.due) < now;
    } else {
      view.overdue = false;
    }
  } else {
    date = o.rrule ? nextEventOccurrence(o, now) : o.start;
  }
  if (date) view.when = formatDate(date, now);
  return view;
}
