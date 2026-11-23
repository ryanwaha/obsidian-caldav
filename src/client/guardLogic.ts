import { SYSTEM_KEYS } from "../projection/upstream";

export type ConflictMap = Record<string, { mine: string | null; theirs: string | null }>;

/** 衝突對話框的寫入（設計 D8）：用我的 → 把 mine 寫回可寫欄位；用伺服器的 → 只寫 `_request: dismiss-conflict`（M6-3 review focus 5） */
export function conflictWrites(c: ConflictMap, choice: "mine" | "server"): { set: Record<string, unknown>; unset: string[] } {
  if (choice === "server") return { set: { _request: "dismiss-conflict" }, unset: [] };
  const set: Record<string, unknown> = {}, unset: string[] = [];
  for (const [k, v] of Object.entries(c)) { if (v.mine == null) unset.push(k); else set[k] = v.mine; }
  return { set, unset };
}

export interface StorageAccessManager { isFileProcessing(path: string): boolean; recentlyTouched(f: { path: string; stat: { mtime: number; size: number } }): boolean }

/** S9：LiveSync 正在寫或剛寫過 → 遠端帶來的；兩者皆否 → 本機動作。拿不到 LiveSync 內部 API 時回傳 undefined（不判斷）。 */
export function isLocal(sam: StorageAccessManager | undefined, f: { path: string; stat: { mtime: number; size: number } }): boolean | undefined {
  if (!sam || typeof sam.isFileProcessing !== "function" || typeof sam.recentlyTouched !== "function") return undefined;
  return !sam.isFileProcessing(f.path) && !sam.recentlyTouched(f);
}

const norm = (v: unknown) => (v == null || v === "" ? null : typeof v === "object" ? JSON.stringify(v) : String(v));
export function systemKeysChanged(prev: Record<string, unknown>, next: Record<string, unknown>): string[] {
  return SYSTEM_KEYS.filter((k) => norm(prev[k]) !== norm(next[k]));
}
