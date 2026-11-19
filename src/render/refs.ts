/** 短 ID：8 位 Crockford base32 小寫（設計稿 §6.2）。 */
export const REF_ID = /^[0-9a-hjkmnp-tv-z]{8}$/;

export interface RefMatch { from: number; to: number; label: string; id: string; query?: string }

const PATTERN = /\[([^\]\n]*)\]\(cal:([0-9A-Za-z]{8})(\?[^)\s]*)?\)/g;

/** 找出 text 裡的 cal: 參照。不處理程式碼排除（由呼叫端負責）。 */
export function findRefs(text: string, offset = 0): RefMatch[] {
  const out: RefMatch[] = [];
  for (const m of text.matchAll(PATTERN)) {
    const id = m[2].toLowerCase();
    if (!REF_ID.test(id)) continue;
    const r: RefMatch = { from: offset + m.index!, to: offset + m.index! + m[0].length, label: m[1], id };
    if (m[3]) r.query = m[3];
    out.push(r);
  }
  return out;
}
