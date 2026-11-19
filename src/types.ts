/** ICS 原文值：dateOnly 時為 "20261119"，否則為 "20261120T150000"（UTC 結尾帶 Z）。 */
export interface DateValue { value: string; dateOnly: boolean; tzid?: string }

export interface CalObject {
  href: string; collection: string; etag: string;
  uid: string; shortId: string;
  kind: "VTODO" | "VEVENT";
  summary: string;
  status?: string;
  start?: DateValue; due?: DateValue; end?: DateValue;
  completed?: string;
  /** CREATED 原文（M5 搬移比對用） */
  created?: string;
  rrule?: string;
  /** 同一資源中有帶 RECURRENCE-ID 的元件 */
  hasOverrides: boolean;
  /** 伺服器回傳的原文，原樣保存 */
  ics: string;
}

export interface CollectionInfo {
  href: string; displayName: string;
  components: ("VTODO" | "VEVENT")[];
  /** undefined 表示尚未同步過 */
  syncToken?: string;
  lastSyncAt?: number;
}

export interface Tombstone {
  href: string; uid: string; shortId: string; collection: string;
  summary: string; created?: string; deletedAt: number;
}

export interface SyncReport {
  startedAt: number; finishedAt: number;
  collections: number; objects: number;
  changed: number; removed: number; skipped: number;
  /** 無法解析而略過的資源；已在快取的保留舊版，不視為刪除 */
  skippedItems: { href: string; reason: string }[];
  errors: { collection?: string; message: string; name?: string }[];
}
