import type { CalObject } from "../types";

export interface Editable { title: boolean; done: boolean; date: boolean }

/** §4.3：重複 VTODO 不改狀態；重複 VEVENT 與帶 override 的物件不在 Obsidian 編輯。 */
export function editable(o: CalObject): Editable {
  if (o.hasOverrides || (o.kind === "VEVENT" && o.rrule)) return { title: false, done: false, date: false };
  return { title: true, done: o.kind === "VTODO" && !o.rrule, date: true };
}
