import ICAL from "ical.js";
import { epochIn, zonesOf } from "../ical/parse";
import type { CalObject, DateValue, PendingCreate, Tombstone } from "../types";
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
  /** pending 且伺服器拒收 */
  failed?: boolean;
  candidates?: CalObject[];
  obj?: CalObject;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** DateValue → 本機 Date。帶 TZID 或 floating 的值視為本機 wall time（E3：一律 Asia/Taipei）。 */
export function toDate(d: DateValue): Date {
  if (d.epoch !== undefined) return new Date(d.epoch);
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

const DAY_MS = 86_400_000;
const memo = new Map<string, DateValue | undefined>();

/**
 * 只有 DAILY／WEEKLY 且沒有 COUNT 的規則可以快轉：把 DTSTART 往後移整數個週期，
 * 間隔對齊與星期幾都不變。回傳要移動的天數。
 */
function fastForwardDays(rrule: string, start: Date, now: Date): number {
  const parts = new Map(rrule.split(";").map((p) => p.split("=") as [string, string]));
  if (parts.has("COUNT") || parts.has("BYSETPOS")) return 0;
  const freq = parts.get("FREQ");
  const interval = Number(parts.get("INTERVAL") ?? "1");
  if (!Number.isInteger(interval) || interval < 1) return 0;
  const period = freq === "DAILY" ? interval : freq === "WEEKLY" ? 7 * interval : 0;
  if (!period) return 0;
  const behind = Math.floor((startOfDay(now).getTime() - startOfDay(start).getTime()) / DAY_MS) - period; // 留一個週期的餘裕
  return behind > 0 ? Math.floor(behind / period) * period : 0;
}

/** 重複 VEVENT 從 now 起的下一次（全天事件當天仍算）。結果依 href、etag、當天日期快取。 */
export function nextEventOccurrence(obj: CalObject, now: Date): DateValue | undefined {
  if (obj.kind !== "VEVENT" || !obj.rrule || !obj.start) return undefined;
  const key = `${obj.href}|${obj.etag}|${obj.uid}|${now.toDateString()}|${obj.start.dateOnly ? "" : now.getHours() * 60 + now.getMinutes()}`;
  if (memo.has(key)) return memo.get(key);
  const result = computeNext(obj, now);
  if (memo.size > 1000) memo.clear();
  memo.set(key, result);
  return result;
}

function computeNext(obj: CalObject, now: Date): DateValue | undefined {
  try {
    const root = new ICAL.Component(ICAL.parse(obj.ics));
    const zones = zonesOf(root);
    const found = root.getAllSubcomponents("vevent").find((c) => !c.hasProperty("recurrence-id"));
    if (!found) return undefined;
    const master = new ICAL.Component(found.toJSON());
    const shift = fastForwardDays(obj.rrule!, toDate(obj.start!), now);
    if (shift) {
      const prop = master.getFirstProperty("dtstart")!;
      const t = (prop.getFirstValue() as InstanceType<typeof ICAL.Time>).clone();
      t.adjust(shift, 0, 0, 0);
      prop.setValue(t);
    }
    const it = new ICAL.Event(master).iterator();
    const threshold = obj.start!.dateOnly ? startOfDay(now) : now;
    const utc = obj.start!.value.endsWith("Z");
    for (let i = 0, t = it.next(); t && i < 5000; i++, t = it.next()) {
      const value = t.isDate
        ? `${t.year}${pad(t.month)}${pad(t.day)}`
        : `${t.year}${pad(t.month)}${pad(t.day)}T${pad(t.hour)}${pad(t.minute)}${pad(t.second)}${utc ? "Z" : ""}`;
      const dv: DateValue = { value, dateOnly: t.isDate };
      if (obj.start!.tzid) {
        dv.tzid = obj.start!.tzid;
        if (!t.isDate) {
          const epoch = epochIn(zones, dv.tzid, t.year, t.month, t.day, t.hour, t.minute, t.second);
          if (epoch !== undefined) dv.epoch = epoch;
        }
      }
      if (toDate(dv) >= threshold) return dv;
    }
  } catch {
    // 無法展開時不顯示下一次
  }
  return undefined;
}

export function present(id: string, label: string, objs: CalObject[], tombs: Tombstone[], now: Date, pending: PendingCreate[] = []): RefView {
  if (objs.length === 0 && pending.length) {
    const p = pending[0];
    const view: RefView = { state: "pending", id, text: label || p.summary || "（無標題）", kind: "VTODO", done: false };
    if (p.due) view.when = formatDate(p.due, now);
    if (p.state === "failed") view.failed = true;
    return view;
  }
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
