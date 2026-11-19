import ICAL from "ical.js";
import { shortId } from "../shortid";
import type { CalObject, DateValue } from "../types";

type Comp = InstanceType<typeof ICAL.Component>;

type Zones = Map<string, InstanceType<typeof ICAL.Timezone>>;

/** 收集 ICS 內附的 VTIMEZONE。 */
export function zonesOf(root: Comp): Zones {
  const zones: Zones = new Map();
  for (const vtz of root.getAllSubcomponents("vtimezone")) {
    try {
      const tz = new ICAL.Timezone(vtz);
      if (tz.tzid) zones.set(tz.tzid, tz);
    } catch { /* 壞掉的 VTIMEZONE 就不換算 */ }
  }
  return zones;
}

/** 以指定時區解讀 wall time，回傳絕對時間（ms）。 */
export function epochIn(zones: Zones, tzid: string, y: number, mo: number, d: number, h: number, mi: number, s: number): number | undefined {
  const tz = zones.get(tzid);
  if (!tz) return undefined;
  try {
    return ICAL.Time.fromData({ year: y, month: mo, day: d, hour: h, minute: mi, second: s, isDate: false }, tz).toUnixTime() * 1000;
  } catch { return undefined; }
}

/** 取 jCal 形式的日期值，轉回 ICS 原文格式；有 VTIMEZONE 時另算絕對時間。 */
function dateValue(comp: Comp, name: string, zones: Zones = new Map()): DateValue | undefined {
  const prop = comp.getFirstProperty(name);
  if (!prop) return undefined;
  const [, params, type, value] = prop.toJSON() as [string, Record<string, string>, string, string];
  if (typeof value !== "string") return undefined;
  const dateOnly = type === "date";
  const out: DateValue = { value: value.replace(/[-:]/g, ""), dateOnly };
  if (params.tzid) {
    out.tzid = params.tzid;
    if (!dateOnly) {
      const v = out.value;
      const epoch = epochIn(zones, params.tzid, +v.slice(0, 4), +v.slice(4, 6), +v.slice(6, 8), +v.slice(9, 11), +v.slice(11, 13), +v.slice(13, 15));
      if (epoch !== undefined) out.epoch = epoch;
    }
  }
  return out;
}

/** 屬性原文值（ICS 序列化後冒號之後的部分）。 */
function rawValue(comp: Comp, name: string): string | undefined {
  const prop = comp.getFirstProperty(name);
  if (!prop) return undefined;
  const date = dateValue(comp, name);
  if (date) return date.value;
  const line = ICAL.stringify.property(prop.toJSON(), ICAL.design.defaultSet, true);
  return line.slice(line.indexOf(":") + 1);
}

function text(comp: Comp, name: string): string | undefined {
  const v = comp.getFirstPropertyValue(name);
  return v == null ? undefined : String(v);
}

export async function parseResource(
  ics: string,
  meta: { href: string; etag: string; collection: string },
): Promise<CalObject | { skip: string }> {
  if (!ics.trim()) return { skip: "內容是空的" };
  let comps: Comp[];
  let zones: Zones;
  try {
    const root = new ICAL.Component(ICAL.parse(ics));
    zones = zonesOf(root);
    comps = [...root.getAllSubcomponents("vtodo"), ...root.getAllSubcomponents("vevent")];
  } catch (e) {
    return { skip: `ICS 解析失敗：${e instanceof Error ? e.message : String(e)}` };
  }
  if (comps.length === 0) return { skip: "沒有 VTODO 或 VEVENT" };
  const master = comps.find((c) => !c.hasProperty("recurrence-id"));
  const main = master ?? comps[0];
  const uid = text(main, "uid");
  if (!uid) return { skip: "缺少 UID" };

  const obj: CalObject = {
    href: meta.href, collection: meta.collection, etag: meta.etag,
    uid, shortId: await shortId(uid),
    kind: main.name === "vtodo" ? "VTODO" : "VEVENT",
    summary: text(main, "summary") ?? "",
    hasOverrides: !master || comps.some((c) => c.hasProperty("recurrence-id")),
    ics,
  };
  const set = <K extends keyof CalObject>(k: K, v: CalObject[K] | undefined) => { if (v !== undefined) obj[k] = v; };
  set("status", text(main, "status"));
  set("start", dateValue(main, "dtstart", zones));
  set("due", dateValue(main, "due", zones));
  set("end", dateValue(main, "dtend", zones));
  set("completed", rawValue(main, "completed"));
  set("created", rawValue(main, "created"));
  set("rrule", rawValue(main, "rrule"));
  return obj;
}
