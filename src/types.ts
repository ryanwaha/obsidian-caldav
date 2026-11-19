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
  /** 本輪送出的待送新建 */
  sent: number;
  /** 本輪結束時，仍在佇列（queued）與失敗（failed，含屬於其他帳號）的數量 */
  pendingQueued: number; pendingFailed: number;
  /** 無法解析而略過的資源；已在快取的保留舊版，不視為刪除 */
  skippedItems: { href: string; reason: string }[];
  errors: { collection?: string; message: string; name?: string }[];
}

/** 本機待送的新建（§4.2：重建快取時不能被清掉）。舊資料沒有 op 欄位，視為 create。 */
export interface PendingCreate {
  op?: "create";
  uid: string; shortId: string;
  /** 建立時的帳號；換帳號後不送到新帳號 */
  fingerprint: string;
  collection: string; href: string; ics: string;
  summary: string; due?: DateValue;
  createdAt: number; attempts: number;
  state: "queued" | "failed"; lastError?: string;
}

/** 插件管理的欄位（§4.3）。date 為 null 表示清除日期。 */
export interface Patch { summary?: string; done?: boolean; date?: { date: string; time?: string } | null }
export interface Managed { summary: string; done: boolean; date?: string }

/** 待送的修改：每個物件最多一筆（key 為 "upd:" + href），後來的修改合併進 patch。 */
export interface PendingUpdate {
  op: "update";
  uid: string; objUid: string; shortId: string; fingerprint: string;
  collection: string; href: string;
  /** 修改前的伺服器版本：412 時用來判斷伺服器改了哪些欄位 */
  baseIcs: string; baseEtag: string;
  patch: Patch; summary: string;
  createdAt: number; attempts: number;
  state: "queued" | "failed" | "conflict"; lastError?: string;
  conflict?: { serverIcs: string; serverEtag: string; base: Managed; mine: Managed; server: Managed };
}

export type PendingOp = PendingCreate | PendingUpdate;
export const isUpdate = (p: PendingOp): p is PendingUpdate => p.op === "update";
