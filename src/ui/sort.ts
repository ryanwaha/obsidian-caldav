import { toDate } from "../render/present";
import type { CalObject } from "../types";

export const isDone = (o: CalObject) => o.kind === "VTODO" && (o.status === "COMPLETED" || o.status === "CANCELLED");

/** 排序：未完成 VTODO（依到期日，無日期在後）→ VEVENT → 已完成。 */
export function sortForPicker(objs: CalObject[]): CalObject[] {
  const rank = (o: CalObject) => (isDone(o) ? 2 : o.kind === "VTODO" ? 0 : 1);
  const key = (o: CalObject) => { const d = o.due ?? o.start; return d ? toDate(d).getTime() : Number.MAX_SAFE_INTEGER; };
  return [...objs].sort((a, b) => rank(a) - rank(b) || key(a) - key(b) || a.summary.localeCompare(b.summary));
}

