import type { DateValue } from "../types";

const TAIPEI_OFFSET_MS = 8 * 3600_000; // Asia/Taipei has no DST

/** IANA 時區在某個時刻相對 UTC 的位移（ms）；時區不認得時丟錯。 */
function tzOffset(ts: number, tz: string): number {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    .formatToParts(new Date(ts)).map((p) => [p.type, p.value]));
  return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second) - ts;
}

/** 由 ICS 原文值算絕對時間：Z 結尾用 UTC；有 TZID（但沒有 VTIMEZONE 算出的 epoch）時用 IANA 時區。算不出來回傳 undefined。 */
function epochOf(d: DateValue): number | undefined {
  if (d.epoch !== undefined) return d.epoch;
  const v = d.value;
  const wall = Date.UTC(+v.slice(0, 4), +v.slice(4, 6) - 1, +v.slice(6, 8), +v.slice(9, 11), +v.slice(11, 13), +v.slice(13, 15));
  if (v.endsWith("Z")) return wall;
  if (!d.tzid) return undefined;
  try {
    const first = wall - tzOffset(wall, d.tzid);
    return wall - tzOffset(first, d.tzid);
  } catch {
    return undefined;
  }
}

/** ICS 日期 → 台北本地的 `YYYY-MM-DD` 與（非全天時）`HH:mm`（設計 §6.2）。 */
export function toLocalParts(d: DateValue): { date: string; time?: string } {
  const v = d.value;
  const date = `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
  if (d.dateOnly) return { date };
  const wall = { date, time: `${v.slice(9, 11)}:${v.slice(11, 13)}` };
  if (d.tzid === "Asia/Taipei" || (!d.tzid && !v.endsWith("Z"))) return wall;
  const epoch = epochOf(d);
  if (epoch === undefined) return wall;
  const t = new Date(epoch + TAIPEI_OFFSET_MS);
  const p = (n: number) => String(n).padStart(2, "0");
  return { date: `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}`, time: `${p(t.getUTCHours())}:${p(t.getUTCMinutes())}` };
}
