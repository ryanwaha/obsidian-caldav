/** 投影檔（設計 §6）。 */
export const PROJ_DIR = "_caldav";
export const WRITABLE_KEYS = ["title", "status", "due", "due_time", "start", "start_time", "end", "end_time", "list"] as const;
export type WritableKey = (typeof WRITABLE_KEYS)[number];

export interface ProjFm {
  title: string; status?: string;
  due?: string; due_time?: string; start?: string; start_time?: string; end?: string; end_time?: string;
  list: string; aliases: string[];
  _kind: "VTODO" | "VEVENT"; _uid: string; _notes?: string; _rrule?: string;
  _etag: string; _hash: string; _sync: "ok" | "rejected" | "conflict"; _sync_msg?: string; _deleted: boolean;
}

export const listName = (collectionHref: string) => collectionHref.replace(/\/+$/, "").split("/").pop()!;
