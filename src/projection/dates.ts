import type { DateValue } from "../types";

const TAIPEI_OFFSET_MS = 8 * 3600_000; // Asia/Taipei has no DST

/** ICS 日期 → 台北本地的 `YYYY-MM-DD` 與（非全天時）`HH:mm`（設計 §6.2）。 */
export function toLocalParts(d: DateValue): { date: string; time?: string } {
  const v = d.value;
  const date = `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
  if (d.dateOnly) return { date };
  const local = d.tzid === "Asia/Taipei" || (!d.tzid && !v.endsWith("Z"));
  if (local || d.epoch === undefined) return { date, time: `${v.slice(9, 11)}:${v.slice(11, 13)}` };
  const t = new Date(d.epoch + TAIPEI_OFFSET_MS);
  const p = (n: number) => String(n).padStart(2, "0");
  return { date: `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}`, time: `${p(t.getUTCHours())}:${p(t.getUTCMinutes())}` };
}
