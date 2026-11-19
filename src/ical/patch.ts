import ICAL from "ical.js";
import type { Managed, Patch } from "../types";
import { TAIPEI_VTIMEZONE, foldLine } from "./build";
import { epochIn, zonesOf } from "./parse";

export type { Managed, Patch };

type Comp = InstanceType<typeof ICAL.Component>;
type Prop = InstanceType<typeof ICAL.Property>;

const TAIPEI_OFFSET = 8 * 3600_000; // E3：一律 Asia/Taipei

/** 找出不帶 RECURRENCE-ID 的主元件。 */
function master(root: Comp): Comp | undefined {
  return [...root.getAllSubcomponents("vtodo"), ...root.getAllSubcomponents("vevent")].find((c) => !c.hasProperty("recurrence-id"));
}

function raw(prop: Prop | null): string | undefined {
  if (!prop) return undefined;
  const v = prop.toJSON()[3];
  return typeof v === "string" ? v.replace(/[-:]/g, "") : undefined;
}

function epochOf(prop: Prop, zones: ReturnType<typeof zonesOf>): number | undefined {
  const [, params, type, value] = prop.toJSON() as [string, Record<string, string>, string, string];
  if (typeof value !== "string") return undefined;
  const v = value.replace(/[-:]/g, "");
  const y = +v.slice(0, 4), mo = +v.slice(4, 6), d = +v.slice(6, 8);
  if (type === "date") return Date.UTC(y, mo - 1, d) - TAIPEI_OFFSET;
  const h = +v.slice(9, 11), mi = +v.slice(11, 13), s = +v.slice(13, 15);
  if (v.endsWith("Z")) return Date.UTC(y, mo - 1, d, h, mi, s);
  if (params.tzid) {
    const e = epochIn(zones, params.tzid, y, mo, d, h, mi, s);
    if (e !== undefined) return e;
  }
  return Date.UTC(y, mo - 1, d, h, mi, s) - TAIPEI_OFFSET;
}

const inputEpoch = (i: { date: string; time?: string }) => {
  const [y, mo, d] = i.date.split("-").map(Number);
  const [h, mi] = i.time ? i.time.split(":").map(Number) : [0, 0];
  return Date.UTC(y, mo - 1, d, h, mi) - TAIPEI_OFFSET;
};

/** 用 ical.js 產生單一屬性的一行（未摺行）。 */
function propLine(name: string, value: unknown, params: Record<string, string> = {}): string {
  const p = new ICAL.Property(name);
  for (const [k, v] of Object.entries(params)) p.setParameter(k, v);
  p.setValue(value as never);
  return ICAL.stringify.property(p.toJSON(), ICAL.design.defaultSet, true);
}

/** E3：有時間 → TZID=Asia/Taipei；只有日期 → VALUE=DATE。 */
function dateLine(name: string, src: { date: string; time?: string } | number, dateOnly?: boolean): string {
  let y: number, mo: number, d: number, h = 0, mi = 0, isDate: boolean;
  if (typeof src === "number") {
    const t = new Date(src + TAIPEI_OFFSET);
    [y, mo, d, h, mi] = [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate(), t.getUTCHours(), t.getUTCMinutes()];
    isDate = !!dateOnly;
  } else {
    [y, mo, d] = src.date.split("-").map(Number);
    isDate = !src.time;
    if (src.time) [h, mi] = src.time.split(":").map(Number);
  }
  return isDate
    ? propLine(name, ICAL.Time.fromData({ year: y, month: mo, day: d, isDate: true }))
    : propLine(name, ICAL.Time.fromData({ year: y, month: mo, day: d, hour: h, minute: mi, second: 0, isDate: false }), { tzid: "Asia/Taipei" });
}

const utcLine = (name: string, ms: number) => {
  const t = new Date(ms);
  return propLine(name, ICAL.Time.fromData({ year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate(), hour: t.getUTCHours(), minute: t.getUTCMinutes(), second: t.getUTCSeconds(), isDate: false }, ICAL.Timezone.utcTimezone));
};

const nameOf = (line: string) => line.match(/^[A-Za-z0-9-]+/)?.[0].toUpperCase() ?? "";

/** 主元件在展開後各行中的範圍，以及其中巢狀子元件（VALARM 等）的範圍。 */
function locateMaster(lines: string[]): { start: number; end: number } {
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^BEGIN:(VTODO|VEVENT)$/i);
    if (!m) continue;
    let depth = 0, j = i, hasRid = false;
    for (; j < lines.length; j++) {
      if (/^BEGIN:/i.test(lines[j])) depth++;
      else if (/^END:/i.test(lines[j])) { depth--; if (depth === 0) break; }
      else if (depth === 1 && nameOf(lines[j]) === "RECURRENCE-ID") hasRid = true;
    }
    if (!hasRid) return { start: i, end: j };
    i = j;
  }
  throw new Error("沒有可修改的 VTODO／VEVENT");
}

/**
 * 以原始 ICS 為底，逐行修補 patch 指定的欄位（§4.4）。
 * 沒動到的行一個字元都不改（ical.js 重新序列化會改寫 iOS 的 X-ADDRESS 等參數）。
 */
export function applyPatch(ics: string, patch: Patch, now: Date): string {
  const root = new ICAL.Component(ICAL.parse(ics));
  const comp = master(root);
  if (!comp) throw new Error("沒有可修改的 VTODO／VEVENT");
  const zones = zonesOf(root);
  const isTodo = comp.name === "vtodo";
  const recurring = comp.hasProperty("rrule");
  const hasOverrides = [...root.getAllSubcomponents("vtodo"), ...root.getAllSubcomponents("vevent")].some((c) => c.hasProperty("recurrence-id"));

  // §4.3 在資料層也擋下（物件可能在修改送出前，被其他客戶端改成重複項目）
  if (hasOverrides || (!isTodo && recurring)) throw new Error("重複事件請在行事曆 App 修改");
  if (isTodo && recurring && patch.done !== undefined) throw new Error("重複任務的完成請在提醒事項操作");
  if (isTodo && recurring && patch.date === null) throw new Error("重複任務不能清除日期");

  const lines = ics.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  const { start, end } = locateMaster(lines);

  // 主元件自己這一層的行（不含巢狀子元件），以 index 表示
  const own: number[] = [];
  for (let i = start + 1, depth = 0; i < end; i++) {
    if (/^BEGIN:/i.test(lines[i])) depth++;
    else if (/^END:/i.test(lines[i])) depth--;
    else if (depth === 0) own.push(i);
  }
  const drop = new Set<number>();
  const add: string[] = [];
  const remove = (...names: string[]) => { for (const i of own) if (names.includes(nameOf(lines[i]))) drop.add(i); };
  const replaceLines = new Map<number, string>();

  if (patch.summary !== undefined) { remove("SUMMARY"); add.push(propLine("summary", patch.summary)); }

  if (patch.done !== undefined && isTodo) {
    remove("STATUS", "COMPLETED", "PERCENT-COMPLETE");
    if (patch.done) {
      add.push(propLine("status", "COMPLETED"), utcLine("completed", now.getTime()), propLine("percent-complete", 100));
    } else {
      add.push(propLine("status", "NEEDS-ACTION"));
    }
  }

  let needTaipei = false;
  if (patch.date !== undefined) {
    const target = isTodo ? "DUE" : "DTSTART";
    const oldProp = comp.getFirstProperty(target.toLowerCase());
    const startProp = comp.getFirstProperty("dtstart");
    const oldEpoch = oldProp ? epochOf(oldProp, zones) : undefined;
    const startFollows = isTodo && oldProp && startProp && raw(startProp) === raw(oldProp) && startProp.getParameter("tzid") === oldProp.getParameter("tzid");
    if (patch.date === null) {
      remove(target);
      if (startFollows) remove("DTSTART");
    } else {
      const newEpoch = inputEpoch(patch.date);
      remove(target);
      add.push(dateLine(target.toLowerCase(), patch.date));
      if (startFollows) { remove("DTSTART"); add.push(dateLine("dtstart", patch.date)); }
      needTaipei = !!patch.date.time;
      if (oldEpoch !== undefined) {
        const delta = newEpoch - oldEpoch;
        const formChanged = (oldProp!.type === "date") !== !patch.date.time;
        // 形式改變時比照 iOS：有時間提醒在到期時，全天提醒在當天 09:00；否則平移
        const to = formChanged ? (patch.date.time ? newEpoch : newEpoch + 9 * 3600_000) : undefined;
        shiftAlarms(lines, start, end, delta, to, replaceLines);
        const endProp = !isTodo ? comp.getFirstProperty("dtend") : null;
        if (endProp) {
          const endEpoch = epochOf(endProp, zones);
          remove("DTEND");
          if (endEpoch !== undefined && !formChanged) add.push(dateLine("dtend", endEpoch + delta, endProp.type === "date"));
          else add.push(dateLine("dtend", newEpoch + (patch.date.time ? 3600_000 : 86_400_000), !patch.date.time));
        }
      }
    }
    if (!isTodo && comp.hasProperty("sequence")) {
      remove("SEQUENCE");
      add.push(propLine("sequence", (Number(comp.getFirstPropertyValue("sequence")) || 0) + 1));
    }
  }

  remove("DTSTAMP", "LAST-MODIFIED");
  add.push(utcLine("dtstamp", now.getTime()), utcLine("last-modified", now.getTime()));

  const out: string[] = [];
  const hasTaipei = root.getAllSubcomponents("vtimezone").some((z) => z.getFirstPropertyValue("tzid") === "Asia/Taipei");
  for (let i = 0; i < lines.length; i++) {
    if (i === start && needTaipei && !hasTaipei) out.push(...TAIPEI_VTIMEZONE.split("\r\n"));
    if (i === end) out.push(...add);
    if (drop.has(i)) continue;
    out.push(replaceLines.get(i) ?? lines[i]);
  }
  return out.map(foldLine).join("\r\n") + "\r\n";
}

/** 主元件內 VALARM 的絕對時間 TRIGGER：設為 to 或平移 delta。iOS 位置提醒（X-APPLE-PROXIMITY）不動。 */
function shiftAlarms(lines: string[], start: number, end: number, delta: number, to: number | undefined, out: Map<number, string>): void {
  for (let i = start + 1; i < end; i++) {
    if (!/^BEGIN:VALARM$/i.test(lines[i])) continue;
    let j = i + 1;
    while (j < end && !/^END:VALARM$/i.test(lines[j])) j++;
    const block = lines.slice(i + 1, j);
    if (!block.some((l) => nameOf(l) === "X-APPLE-PROXIMITY")) {
      for (let k = i + 1; k < j; k++) {
        const m = lines[k].match(/^TRIGGER;(?:[^:]*;)?VALUE=DATE-TIME(?:;[^:]*)?:(\d{8}T\d{6})Z$/i);
        if (!m) continue;
        const v = m[1];
        const ms = to ?? Date.UTC(+v.slice(0, 4), +v.slice(4, 6) - 1, +v.slice(6, 8), +v.slice(9, 11), +v.slice(11, 13), +v.slice(13, 15)) + delta;
        out.set(k, utcLine("trigger", ms).replace(/^TRIGGER:/, "TRIGGER;VALUE=DATE-TIME:"));
      }
    }
    i = j;
  }
}

/** 衝突比對用：插件管理的欄位目前的值。 */
export function managedValues(ics: string): Managed {
  const root = new ICAL.Component(ICAL.parse(ics));
  const comp = master(root);
  if (!comp) return { summary: "", status: "" };
  const isTodo = comp.name === "vtodo";
  const out: Managed = {
    summary: String(comp.getFirstPropertyValue("summary") ?? ""),
    status: String(comp.getFirstPropertyValue("status") ?? ""),
  };
  const prop = comp.getFirstProperty(isTodo ? "due" : "dtstart");
  if (prop) out.date = `${prop.type}|${prop.getParameter("tzid") ?? ""}|${raw(prop)}`;
  return out;
}
