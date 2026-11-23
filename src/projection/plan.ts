import { MoveResolver } from "../sync/moves";
import type { Alias, CalObject, CollectionInfo, DateValue, Managed, PendingUpdate, Tombstone } from "../types";
import { toLocalParts } from "./dates";
import { inclusiveEnd } from "./fields";
import { PROJ_DIR, type ProjFm, WRITABLE_KEYS } from "./types";

export interface ProjFile { path: string; fm: Record<string, unknown> | null; bodyEmpty: boolean }
export type ProjAction =
  | { op: "create"; path: string; fm: ProjFm }
  | { op: "update"; path: string; set: Partial<ProjFm>; unset: string[] }
  | { op: "rename"; from: string; to: string }
  /** 把 drop 的 body 附加到 keep 後刪除 drop。只在 drop 由系統新建且 body 為空時產生（設計 §8.4）。 */
  | { op: "merge-into"; keep: string; drop: string };

export interface ReconcileInput {
  objects: CalObject[];
  /** key = uid */
  projected: Map<string, ProjFm>;
  tombstones: Tombstone[]; aliases: Alias[]; collections: CollectionInfo[];
  /** 集合 href；空陣列 = 全部 */
  whitelist: string[];
  files: ProjFile[];
  now: number;
  /** 上一輪同步無錯誤，且範圍內每個集合都同步過。不完整時，沒有 tombstone 的檔案不標刪除（review I3）。 */
  complete: boolean;
  /** 伺服器上該物件的待送修改（key = objUid），M6-2 三方對帳 */
  pending: Map<string, PendingUpdate>;
  /** 伺服器有快照的路徑；同一 _uid 有多個檔案時優先保留這些 */
  known?: Set<string>;
}

const MSG_FOREIGN = "不是投影檔";
const MSG_OUT_OF_SCOPE = "集合不在投影範圍";
const MSG_MOVE_HAS_BODY = "搬移目標已有內容，請手動合併";
/** 對帳自己產生的 rejected 訊息；狀態恢復時由對帳清除 */
const RECONCILE_MSGS = new Set([MSG_FOREIGN, MSG_OUT_OF_SCOPE, MSG_MOVE_HAS_BODY]);

/** 受管欄位：投影會設定或清除的鍵。M6-2 的 `_conflict`、`_request` 不在此列，對帳不碰。 */
const MANAGED = ["title", "status", "due", "due_time", "start", "start_time", "end", "end_time", "list",
  "aliases", "_kind", "_uid", "_notes", "_rrule", "_etag", "_hash", "_sync", "_sync_msg", "_deleted", "_conflict"];

const norm = (v: unknown) => (v == null ? null : Array.isArray(v) ? JSON.stringify(v.map(String)) : typeof v === "object" ? JSON.stringify(v) : String(v));

function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (const ch of new TextEncoder().encode(s)) { h ^= ch; h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36).padStart(7, "0");
}

function diff(cur: Record<string, unknown>, want: ProjFm): { set: Partial<ProjFm>; unset: string[] } {
  const w = want as unknown as Record<string, unknown>;
  const set: Record<string, unknown> = {};
  const unset: string[] = [];
  for (const k of MANAGED) {
    if (k in w) { if (norm(cur[k]) !== norm(w[k])) set[k] = w[k]; }
    else if (k in cur && cur[k] !== undefined) unset.push(k);
  }
  return { set: set as Partial<ProjFm>, unset };
}

/** managedValues 的日期字串（"date|tzid|20261124" 或 "date-time|Asia/Taipei|20261124T093000"）→ DateValue */
function managedDate(s: string | undefined): DateValue | undefined {
  if (!s) return undefined;
  const [type, tzid, value] = s.split("|");
  return { value, dateOnly: type === "date", ...(tzid ? { tzid } : {}) };
}

/** Managed（衝突比對用）→ 投影欄位名，供 `_conflict` 使用 */
function managedFields(kind: "VTODO" | "VEVENT", m: Managed): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { title: m.summary };
  const put = (key: string, d: DateValue | undefined) => { if (!d) { out[key] = undefined; out[`${key}_time`] = undefined; return; } const p = toLocalParts(d); out[key] = p.date; out[`${key}_time`] = p.time; };
  if (kind === "VTODO") { out.status = m.status ? m.status.toLowerCase() : undefined; put("due", managedDate(m.date)); }
  else { put("start", managedDate(m.date)); const e = managedDate(m.end); put("end", e && e.dateOnly ? inclusiveEnd(e) : e); }
  return out;
}

function conflictOf(kind: "VTODO" | "VEVENT", c: NonNullable<PendingUpdate["conflict"]>): Record<string, { mine: string | null; theirs: string | null }> {
  const mine = managedFields(kind, c.mine), theirs = managedFields(kind, c.server);
  const out: Record<string, { mine: string | null; theirs: string | null }> = {};
  for (const k of Object.keys(mine)) if ((mine[k] ?? null) !== (theirs[k] ?? null)) out[k] = { mine: mine[k] ?? null, theirs: theirs[k] ?? null };
  return out;
}

const KEEP_WHILE_QUEUED = new Set<string>([...WRITABLE_KEYS, "aliases", "_hash"]);

const update = (path: string, set: Partial<ProjFm>, unset: string[] = []): ProjAction => ({ op: "update", path, set, unset });

/** 對帳：快取應有的投影 vs `_caldav/` 現有檔案 → 最少的動作（設計 §8）。永不產生刪除檔案的動作（merge-into 的空檔除外）。 */
export function planReconcile(input: ReconcileInput): ProjAction[] {
  const out: ProjAction[] = [];
  const inScope = (col: string) => input.whitelist.length === 0 || input.whitelist.includes(col);
  const byUid = new Map<string, ProjFile>();
  const used = new Set(input.files.map((f) => f.path));

  const known = input.known ?? new Set<string>();
  const rank = (f: ProjFile) => (known.has(f.path) ? 0 : 1);
  for (const f of [...input.files].sort((x, y) => rank(x) - rank(y) || (x.path < y.path ? -1 : x.path > y.path ? 1 : 0))) {
    const uid = f.fm?._uid;
    if (typeof uid === "string" && uid) {
      const first = byUid.get(uid);
      if (!first) { byUid.set(uid, f); continue; }
      const msg = `重複的投影檔（與 ${first.path} 相同 _uid）`;
      if (f.fm?._sync !== "rejected" || f.fm?._sync_msg !== msg) out.push(update(f.path, { _sync: "rejected", _sync_msg: msg }));
      continue;
    }
    if (f.fm?._sync !== "rejected" || f.fm?._sync_msg !== MSG_FOREIGN) out.push(update(f.path, { _sync: "rejected", _sync_msg: MSG_FOREIGN }));
  }

  const alloc = (o: CalObject): string => {
    let p = `${PROJ_DIR}/${o.shortId}.md`;
    if (used.has(p)) p = `${PROJ_DIR}/${o.shortId}-${fnv1a(o.uid)}.md`;
    used.add(p);
    return p;
  };

  const objects = [...input.objects].sort((a, b) => (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0));
  const live = new Map<string, CalObject>();
  for (const o of objects) if (!live.has(o.uid)) live.set(o.uid, o);

  const resolver = new MoveResolver(objects, input.tombstones, input.aliases, input.collections);
  /** 經搬移決定的檔案：新 uid → 目前（rename 後）的檔案 */
  const moved = new Map<string, ProjFile>();

  for (const [uid, f] of byUid) {
    if (live.has(uid)) continue;
    const fm = f.fm!;
    const tombs = input.tombstones.filter((t) => t.uid === uid);
    if (!tombs.length) { if (input.complete && fm._deleted !== true) out.push(update(f.path, { _deleted: true })); continue; }
    const res = resolver.resolve(tombs);
    if (res.kind === "maybe") continue;
    if (res.kind === "deleted") { if (fm._deleted !== true) out.push(update(f.path, { _deleted: true })); continue; }
    if (res.kind === "ambiguous") {
      const msg = `搬移目標不唯一：${res.candidates.map((c) => c.shortId).join("、")}`;
      if (fm._sync !== "rejected" || fm._sync_msg !== msg) out.push(update(f.path, { _sync: "rejected", _sync_msg: msg }));
      continue;
    }
    const target = res.obj;
    if (moved.has(target.uid)) continue;
    if (!inScope(target.collection)) {
      // 搬到白名單外：不改名（改了也不會更新 _uid，每輪都會再解析一次），只標記（review I5）
      if (fm._sync !== "rejected" || fm._sync_msg !== MSG_OUT_OF_SCOPE) out.push(update(f.path, { _sync: "rejected", _sync_msg: MSG_OUT_OF_SCOPE }));
      continue;
    }
    const existing = byUid.get(target.uid);
    if (existing) {
      if (!existing.bodyEmpty) {
        if (fm._sync !== "rejected" || fm._sync_msg !== MSG_MOVE_HAS_BODY) out.push(update(f.path, { _sync: "rejected", _sync_msg: MSG_MOVE_HAS_BODY }));
        continue;
      }
      out.push({ op: "merge-into", keep: f.path, drop: existing.path });
      out.push({ op: "rename", from: f.path, to: existing.path });
      moved.set(target.uid, { path: existing.path, fm, bodyEmpty: f.bodyEmpty });
    } else {
      used.delete(f.path);
      const to = alloc(target);
      if (to !== f.path) out.push({ op: "rename", from: f.path, to });
      moved.set(target.uid, { path: to, fm, bodyEmpty: f.bodyEmpty });
    }
  }

  for (const o of live.values()) {
    const cur = moved.get(o.uid) ?? byUid.get(o.uid);
    if (!inScope(o.collection)) {
      if (cur && (cur.fm!._sync !== "rejected" || cur.fm!._sync_msg !== MSG_OUT_OF_SCOPE)) out.push(update(cur.path, { _sync: "rejected", _sync_msg: MSG_OUT_OF_SCOPE }));
      continue;
    }
    const base = input.projected.get(o.uid);
    if (!base) continue;
    if (!cur) { out.push({ op: "create", path: alloc(o), fm: base }); continue; }
    const p = input.pending.get(o.uid);
    let want: ProjFm = base;
    if (p?.state === "conflict" && p.conflict) want = { ...base, _sync: "conflict", _conflict: conflictOf(o.kind, p.conflict) } as ProjFm;
    else if (p?.state === "failed") want = { ...base, _sync: "rejected", _sync_msg: p.lastError ?? "寫回失敗" };
    const d = diff(cur.fm!, want);
    // 上行被拒絕的標記（值已回滾）保留到使用者下一次被接受的修改，由上行執行器清除；對帳自己的訊息不在此列
    if (!p && cur.fm!._sync === "rejected" && !RECONCILE_MSGS.has(String(cur.fm!._sync_msg ?? ""))) {
      delete (d.set as Record<string, unknown>)._sync;
      delete (d.set as Record<string, unknown>)._sync_msg;
      d.unset = d.unset.filter((k) => k !== "_sync_msg");
    }
    // LiveSync 衝突由伺服器合併後寫下的 `_conflict`：保留到使用者處理（dismiss 或再次修改），不可被對帳清掉（§8.7）
    if (!p && cur.fm!._sync === "conflict") {
      delete (d.set as Record<string, unknown>)._sync;
      delete (d.set as Record<string, unknown>)._conflict;
      d.unset = d.unset.filter((k) => k !== "_conflict");
    }
    if (p?.state === "queued") {
      // 使用者的修改還在送出途中：不蓋掉（review focus 2）
      for (const k of Object.keys(d.set)) if (KEEP_WHILE_QUEUED.has(k)) delete (d.set as Record<string, unknown>)[k];
      d.unset = d.unset.filter((k) => !KEEP_WHILE_QUEUED.has(k));
    }
    if (Object.keys(d.set).length || d.unset.length) out.push(update(cur.path, d.set, d.unset));
  }
  return out;
}
