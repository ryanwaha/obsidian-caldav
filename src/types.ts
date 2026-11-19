/** ICS 原文值：dateOnly 時為 "20261119"，否則為 "20261120T150000"（UTC 結尾帶 Z）。 */
export interface DateValue {
  value: string; dateOnly: boolean; tzid?: string;
  /** 依 ICS 內附的 VTIMEZONE 算出的絕對時間（ms）；沒有對應 VTIMEZONE 時不提供 */
  epoch?: number;
}

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

/** 本機待送的新建（§4.2：重建快取時不能被清掉）。 */
export interface PendingCreate {
  uid: string; shortId: string;
  /** 建立時的帳號；換帳號後不送到新帳號 */
  fingerprint: string;
  collection: string; href: string; ics: string;
  summary: string; due?: DateValue;
  createdAt: number; attempts: number;
  state: "queued" | "failed"; lastError?: string;
}
