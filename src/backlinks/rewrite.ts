import { scanRefs } from "./scan";

/**
 * 把參照的短 ID 依 map 改寫（P2：只在使用者下指令時呼叫）。只換 8 位 ID，標籤與 ?query 不動；
 * 程式碼、frontmatter、註解裡的不動。從後往前替換，位置不會位移。
 */
export function rewriteRefs(text: string, map: Map<string, string>): { text: string; count: number } {
  let out = text, count = 0;
  for (const r of scanRefs(text).reverse()) {
    const to = map.get(r.id);
    if (!to) continue;
    const at = r.from + r.label.length + 7; // "[" + label + "](cal:"
    out = out.slice(0, at) + to + out.slice(at + 8);
    count++;
  }
  return { text: out, count };
}
