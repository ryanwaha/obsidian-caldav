import { MoveResolver } from "../sync/moves";
import type { Alias, CalObject, CollectionInfo, Tombstone } from "../types";
import { PROJ_DIR, type ProjFm } from "./types";

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
}

const MSG_FOREIGN = "不是投影檔";
const MSG_OUT_OF_SCOPE = "集合不在投影範圍";
const MSG_MOVE_HAS_BODY = "搬移目標已有內容，請手動合併";

/** 受管欄位：投影會設定或清除的鍵。M6-2 的 `_conflict`、`_request` 不在此列，對帳不碰。 */
const MANAGED = ["title", "status", "due", "due_time", "start", "start_time", "end", "end_time", "list",
  "aliases", "_kind", "_uid", "_notes", "_rrule", "_etag", "_hash", "_sync", "_sync_msg", "_deleted"];

const norm = (v: unknown) => (v == null ? null : Array.isArray(v) ? JSON.stringify(v.map(String)) : String(v));

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

const update = (path: string, set: Partial<ProjFm>, unset: string[] = []): ProjAction => ({ op: "update", path, set, unset });

/** 對帳：快取應有的投影 vs `_caldav/` 現有檔案 → 最少的動作（設計 §8）。永不產生刪除檔案的動作（merge-into 的空檔除外）。 */
export function planReconcile(input: ReconcileInput): ProjAction[] {
  const out: ProjAction[] = [];
  const inScope = (col: string) => input.whitelist.length === 0 || input.whitelist.includes(col);
  const byUid = new Map<string, ProjFile>();
  const used = new Set(input.files.map((f) => f.path));

  for (const f of input.files) {
    const uid = f.fm?._uid;
    if (typeof uid === "string" && uid) { if (!byUid.has(uid)) byUid.set(uid, f); continue; }
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
    const want = input.projected.get(o.uid);
    if (!want) continue;
    if (!cur) { out.push({ op: "create", path: alloc(o), fm: want }); continue; }
    const d = diff(cur.fm!, want);
    if (Object.keys(d.set).length || d.unset.length) out.push(update(cur.path, d.set, d.unset));
  }
  return out;
}
