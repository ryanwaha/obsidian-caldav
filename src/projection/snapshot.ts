import { PROJ_DIR, WRITABLE_KEYS } from "./types";

const norm = (v: unknown) => (v == null || v === "" ? null : typeof v === "object" ? JSON.stringify(v) : String(v));

/**
 * 快照（三方比對的 base）只由「伺服器自己寫了什麼」推導，永不重讀檔案（review C1）：
 * 重讀會把還沒被上行處理的使用者修改吸收成 base，修改就此無聲遺失。
 */
export function applySetUnset(old: Record<string, unknown>, set: Record<string, unknown>, unset: string[]): Record<string, unknown> {
  const next: Record<string, unknown> = JSON.parse(JSON.stringify(old));
  Object.assign(next, JSON.parse(JSON.stringify(set)));
  for (const k of unset) delete next[k];
  delete next._request;
  return next;
}

/**
 * 投影檔被刪除時怎麼處理（review I4）。遠端改名到伺服器是「刪除＋建立」（S9）：
 * 同 _uid 的新檔沒有快照 → 把它改回原路徑；同 _uid 已有快照的檔存在 → 那才是主檔，不還原；都沒有 → 由快照還原。
 */
export function chooseRestore(uid: string, others: { path: string; uid: string; hasSnap: boolean }[]):
  { kind: "rename-back"; from: string } | { kind: "restore" } | { kind: "skip" } {
  const same = others.filter((o) => o.uid === uid);
  if (same.some((o) => o.hasSnap)) return { kind: "skip" };
  if (same.length) return { kind: "rename-back", from: same[0].path };
  return { kind: "restore" };
}

/** 可寫欄位和快照不同 = 使用者修改尚未被上行處理。沒有真正待送的那些要重新排進上行（review I5）。 */
export function dirtyPaths(
  files: { path: string; fm: Record<string, unknown> | null }[],
  snaps: Map<string, Record<string, unknown>>,
  pendingUids: Set<string>,
): { dirtyUids: Set<string>; orphanPaths: string[] } {
  const dirtyUids = new Set<string>();
  const orphanPaths: string[] = [];
  for (const f of files) {
    const uid = f.fm?._uid;
    const snap = snaps.get(f.path);
    if (typeof uid !== "string" || !snap) continue;
    if (WRITABLE_KEYS.some((k) => norm(f.fm![k]) !== norm(snap[k]))) {
      dirtyUids.add(uid);
      if (!pendingUids.has(uid)) orphanPaths.push(f.path);
    }
  }
  return { dirtyUids, orphanPaths };
}

/** 最近被寫入的投影檔路徑；衝突掃描只看這些（review I6）。 */
export class RecentPaths {
  private set = new Set<string>();
  add(p: string): void { this.set.add(p); }
  drain(): string[] { const out = [...this.set]; this.set.clear(); return out; }
}

/** LiveSync 的文件 id → 投影檔路徑（`_` 開頭的路徑在 CouchDB 會加 `/` 跳脫，S5）；不是投影檔（直接位於投影目錄的 .md）回傳 undefined。 */
export function pathFromDocId(id: string): string | undefined {
  const p = id.startsWith("/") ? id.slice(1) : id;
  return p.startsWith(`${PROJ_DIR}/`) && p.endsWith(".md") && !p.slice(PROJ_DIR.length + 1).includes("/") ? p : undefined;
}

/**
 * 伺服器兜底還原的條件（M6-3 e2e 發現的來回拉鋸）：裝置上的插件會立刻自己改回；伺服器若同時還原，兩邊的還原在 LiveSync 互相衝突。
 * 所以伺服器等寬限期後，只在「檔案仍不存在，且 LiveSync 資料庫裡這份文件目前也是刪除狀態」時才還原。
 */
export function serverRestoreDecision(s: { existsNow: boolean; db: "deleted" | "live" | "unknown" }): boolean {
  return !s.existsNow && s.db !== "live";
}
