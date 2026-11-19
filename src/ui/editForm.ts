import { toDate } from "../render/present";
import type { CalObject, DateValue, Patch } from "../types";
import { normalizeDue } from "./due";

const pad = (n: number) => String(n).padStart(2, "0");

/** DateValue → 表單欄位（台北 wall time）。 */
export function dateInputOf(d: DateValue | undefined): { date: string; time: string } {
  if (!d) return { date: "", time: "" };
  if (d.dateOnly) return { date: `${d.value.slice(0, 4)}-${d.value.slice(4, 6)}-${d.value.slice(6, 8)}`, time: "" };
  const t = toDate(d);
  return { date: `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`, time: `${pad(t.getHours())}:${pad(t.getMinutes())}` };
}

export interface EditForm { summary: string; done: boolean; date: string; time: string }

/** 只產生真正改過的欄位。 */
export function diffPatch(obj: CalObject, form: EditForm): Patch {
  const patch: Patch = {};
  const summary = form.summary.trim();
  if (summary && summary !== obj.summary) patch.summary = summary;
  const wasDone = obj.status === "COMPLETED" || obj.status === "CANCELLED";
  if (obj.kind === "VTODO" && form.done !== wasDone) patch.done = form.done;
  const cur = dateInputOf(obj.kind === "VTODO" ? obj.due : obj.start);
  const next = normalizeDue(form.date, form.time, new Date());
  const clearingRecurring = !next.date && !!obj.rrule; // 重複任務不能清除日期（§4.3／I2b）
  if (!clearingRecurring && ((next.date ?? "") !== cur.date || (next.time ?? "") !== cur.time)) {
    patch.date = next.date ? (next.time ? { date: next.date, time: next.time } : { date: next.date }) : null;
  }
  return patch;
}
