import { WRITABLE_KEYS } from "./types";

const norm = (v: unknown) => (v == null || v === "" ? null : typeof v === "object" ? JSON.stringify(v) : String(v));
const SEP = "\n\n---\n（LiveSync 衝突合併）\n\n";

/**
 * LiveSync 衝突（同一行兩邊不同值）的合併規則（設計 §8.7）：
 * frontmatter 以伺服器最後寫出的版本為準；兩版中與它不同的可寫欄位放進 `_conflict` 交給使用者；
 * body 相同取其一，不同就串接（不丟任何一邊）。只差系統欄位 → 沒有 `_conflict`。
 */
export function mergeConflictVersions(
  serverFm: Record<string, unknown>,
  a: { fm: Record<string, unknown> | null; body: string },
  b: { fm: Record<string, unknown> | null; body: string },
): { fm: Record<string, unknown>; body: string } {
  const fm: Record<string, unknown> = JSON.parse(JSON.stringify(serverFm));
  const conflict: Record<string, { mine: string | null; theirs: string | null }> = {};
  for (const k of WRITABLE_KEYS) {
    for (const v of [a, b]) {
      if (!v.fm || k in conflict) continue;
      if (norm(v.fm[k]) !== norm(serverFm[k])) conflict[k] = { mine: norm(v.fm[k]), theirs: norm(serverFm[k]) };
    }
  }
  delete fm._conflict;
  if (Object.keys(conflict).length) { fm._sync = "conflict"; fm._conflict = conflict; }
  const body = a.body === b.body ? a.body : `${a.body.replace(/\s*$/, "")}${SEP}${b.body}`;
  return { fm, body };
}
