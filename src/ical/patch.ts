import ICAL from "ical.js";
import { TAIPEI_VTIMEZONE, serialize } from "./build";
import { epochIn, zonesOf } from "./parse";

type Comp = InstanceType<typeof ICAL.Component>;
type Prop = InstanceType<typeof ICAL.Property>;

/** 插件管理的欄位（§4.3：只做輕量編輯）。date 為 null 表示清除日期。 */
export interface Patch {
  summary?: string;
  done?: boolean;
  date?: { date: string; time?: string } | null;
}

export interface Managed { summary: string; done: boolean; date?: string }

const TAIPEI_OFFSET = 8 * 3600_000; // E3：一律 Asia/Taipei
const pad = (n: number) => String(n).padStart(2, "0");

function master(root: Comp): Comp | undefined {
  return [...root.getAllSubcomponents("vtodo"), ...root.getAllSubcomponents("vevent")].find((c) => !c.hasProperty("recurrence-id"));
}

/** 屬性值的原文（jCal → ICS 格式），例如 "20261124T150000"、"20261124"、"20261124T070000Z"。 */
function raw(prop: Prop | null): string | undefined {
  if (!prop) return undefined;
  const v = prop.toJSON()[3];
  return typeof v === "string" ? v.replace(/[-:]/g, "") : undefined;
}

/** 日期屬性的絕對時間（ms）。全天與 floating 視為台北時間（E3）。 */
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

/** 以 E3 的形式寫入：有時間 → TZID=Asia/Taipei；只有日期 → VALUE=DATE。 */
function setDate(comp: Comp, name: string, epochOrInput: { date: string; time?: string } | number, dateOnly?: boolean): void {
  comp.removeAllProperties(name);
  let y: number, mo: number, d: number, h = 0, mi = 0, isDate: boolean;
  if (typeof epochOrInput === "number") {
    const t = new Date(epochOrInput + TAIPEI_OFFSET);
    [y, mo, d, h, mi] = [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate(), t.getUTCHours(), t.getUTCMinutes()];
    isDate = !!dateOnly;
  } else {
    [y, mo, d] = epochOrInput.date.split("-").map(Number);
    isDate = !epochOrInput.time;
    if (epochOrInput.time) [h, mi] = epochOrInput.time.split(":").map(Number);
  }
  const prop = comp.addPropertyWithValue(name, ICAL.Time.fromData(isDate ? { year: y, month: mo, day: d, isDate: true } : { year: y, month: mo, day: d, hour: h, minute: mi, second: 0, isDate: false }));
  if (!isDate) prop.setParameter("tzid", "Asia/Taipei");
}

const inputEpoch = (i: { date: string; time?: string }) => {
  const [y, mo, d] = i.date.split("-").map(Number);
  const [h, mi] = i.time ? i.time.split(":").map(Number) : [0, 0];
  return Date.UTC(y, mo - 1, d, h, mi) - TAIPEI_OFFSET;
};

/** 絕對時間的提醒跟著平移；iOS 的位置提醒（X-APPLE-PROXIMITY）不動。 */
function shiftAlarms(comp: Comp, delta: number): void {
  for (const alarm of comp.getAllSubcomponents("valarm")) {
    if (alarm.hasProperty("x-apple-proximity")) continue;
    const trig = alarm.getFirstProperty("trigger");
    if (!trig || trig.type !== "date-time") continue;
    const v = raw(trig)!;
    const ms = Date.UTC(+v.slice(0, 4), +v.slice(4, 6) - 1, +v.slice(6, 8), +v.slice(9, 11), +v.slice(11, 13), +v.slice(13, 15)) + delta;
    const t = new Date(ms);
    trig.setValue(ICAL.Time.fromData({ year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate(), hour: t.getUTCHours(), minute: t.getUTCMinutes(), second: t.getUTCSeconds(), isDate: false }, ICAL.Timezone.utcTimezone));
  }
}

function ensureTaipei(root: Comp): void {
  if (root.getAllSubcomponents("vtimezone").some((z) => z.getFirstPropertyValue("tzid") === "Asia/Taipei")) return;
  root.addSubcomponent(new ICAL.Component(ICAL.parse(TAIPEI_VTIMEZONE)));
}

const utcNow = (now: Date) => ICAL.Time.fromJSDate(now, true);

/** 以原始 ICS 為底，只修補 patch 指定的欄位（§4.4）。 */
export function applyPatch(ics: string, patch: Patch, now: Date): string {
  const root = new ICAL.Component(ICAL.parse(ics));
  const comp = master(root);
  if (!comp) throw new Error("沒有可修改的 VTODO／VEVENT");
  const zones = zonesOf(root);
  const isTodo = comp.name === "vtodo";

  if (patch.summary !== undefined) {
    comp.removeAllProperties("summary");
    comp.addPropertyWithValue("summary", patch.summary);
  }

  if (patch.done !== undefined && isTodo) {
    comp.removeAllProperties("status");
    comp.removeAllProperties("completed");
    comp.removeAllProperties("percent-complete");
    if (patch.done) {
      comp.addPropertyWithValue("status", "COMPLETED");
      comp.addPropertyWithValue("completed", utcNow(now));
      comp.addPropertyWithValue("percent-complete", 100);
    } else {
      comp.addPropertyWithValue("status", "NEEDS-ACTION");
    }
  }

  if (patch.date !== undefined) {
    const target = isTodo ? "due" : "dtstart";
    const oldProp = comp.getFirstProperty(target);
    const oldEpoch = oldProp ? epochOf(oldProp, zones) : undefined;
    const startFollows = isTodo && oldProp && comp.getFirstProperty("dtstart")
      && raw(comp.getFirstProperty("dtstart")) === raw(oldProp)
      && comp.getFirstProperty("dtstart")!.getParameter("tzid") === oldProp.getParameter("tzid");
    if (patch.date === null) {
      comp.removeAllProperties(target);
      if (startFollows) comp.removeAllProperties("dtstart");
    } else {
      const newEpoch = inputEpoch(patch.date);
      setDate(comp, target, patch.date);
      if (startFollows) setDate(comp, "dtstart", patch.date);
      if (patch.date.time) ensureTaipei(root);
      if (oldEpoch !== undefined) {
        const delta = newEpoch - oldEpoch;
        shiftAlarms(comp, delta);
        const end = !isTodo ? comp.getFirstProperty("dtend") : null;
        if (end) {
          const endEpoch = epochOf(end, zones);
          const sameForm = (oldProp!.type === "date") === !patch.date.time;
          if (endEpoch !== undefined && sameForm) setDate(comp, "dtend", endEpoch + delta, end.type === "date");
          else setDate(comp, "dtend", newEpoch + (patch.date.time ? 3600_000 : 86_400_000), !patch.date.time);
        }
      }
    }
    if (!isTodo && comp.hasProperty("sequence")) {
      const seq = Number(comp.getFirstPropertyValue("sequence")) || 0;
      comp.removeAllProperties("sequence");
      comp.addPropertyWithValue("sequence", seq + 1);
    }
  }

  for (const name of ["dtstamp", "last-modified"]) {
    comp.removeAllProperties(name);
    comp.addPropertyWithValue(name, utcNow(now));
  }
  return serialize(root);
}

/** 衝突比對用：插件管理的欄位目前的值。 */
export function managedValues(ics: string): Managed {
  const root = new ICAL.Component(ICAL.parse(ics));
  const comp = master(root);
  if (!comp) return { summary: "", done: false };
  const isTodo = comp.name === "vtodo";
  const status = String(comp.getFirstPropertyValue("status") ?? "");
  const out: Managed = {
    summary: String(comp.getFirstPropertyValue("summary") ?? ""),
    done: isTodo && (status === "COMPLETED" || status === "CANCELLED"),
  };
  const date = raw(comp.getFirstProperty(isTodo ? "due" : "dtstart"));
  if (date) out.date = date;
  return out;
}
