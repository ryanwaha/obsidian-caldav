import { type RefMatch, findRefs } from "../render/refs";

/**
 * 全文掃描 cal: 參照（反向索引與「更新參照」共用），排除不會被渲染成連結的區塊（§6.1）：
 * frontmatter、fenced code、行內程式碼、%% 註解。被排除的字元換成空白（保留換行與長度），
 * 再交給和渲染器相同的 findRefs，所以位置可以直接對回原文。
 * 有疑義時寧可多排除：漏掉的參照只是不會被改寫，誤改程式碼裡的範例才是傷害。
 */
export function scanRefs(text: string): RefMatch[] {
  if (!text.includes("cal:")) return [];
  const masked = mask(text);
  return findRefs(masked).map((r) => ({ ...r, label: text.slice(r.from + 1, r.from + 1 + r.label.length) }));
}

function mask(text: string): string {
  const out = text.split("");
  const blank = (from: number, to: number) => { for (let i = from; i < to; i++) if (out[i] !== "\n") out[i] = " "; };

  // frontmatter：檔頭第一行是 ---，到下一個 --- 或 ... 為止
  let start = 0;
  const fm = /^---[ \t]*\r?\n[\s\S]*?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(text);
  if (fm) { blank(0, fm[0].length); start = fm[0].length; }

  // fenced code：容許任意縮排與引用前綴（清單、callout 裡的 code block）
  const lines: { from: number; to: number; text: string }[] = [];
  for (let i = start; i <= text.length;) {
    const nl = text.indexOf("\n", i);
    const to = nl === -1 ? text.length : nl;
    lines.push({ from: i, to, text: text.slice(i, to) });
    if (nl === -1) break;
    i = nl + 1;
  }
  let fence: { ch: string; len: number; from: number } | undefined;
  for (const l of lines) {
    const body = l.text.replace(/^(?:[ \t]*>)*[ \t]*/, "");
    const m = /^(`{3,}|~{3,})(.*)$/.exec(body);
    if (!fence) {
      if (m && !(m[1][0] === "`" && m[2].includes("`"))) fence = { ch: m[1][0], len: m[1].length, from: l.from };
    } else if (m && m[1][0] === fence.ch && m[1].length >= fence.len && !m[2].trim()) {
      blank(fence.from, l.to);
      fence = undefined;
    }
  }
  if (fence) blank(fence.from, text.length);

  // 行內程式碼與 %% 註解：由左到右，先出現的先處理
  const s = out.join("");
  for (let i = start; i < s.length;) {
    if (s.startsWith("%%", i)) {
      const end = s.indexOf("%%", i + 2);
      const to = end === -1 ? s.length : end + 2;
      blank(i, to);
      i = to;
    } else if (s[i] === "`") {
      let n = 0;
      while (s[i + n] === "`") n++;
      const close = findCloser(s, i + n, n);
      if (close === -1) { i += n; continue; }
      blank(i, close + n);
      i = close + n;
    } else {
      i++;
    }
  }
  return out.join("");
}

/** 長度恰好為 n 的反引號串；不跨越空白行（段落邊界）。 */
function findCloser(s: string, from: number, n: number): number {
  for (let j = from; j < s.length; j++) {
    if (s[j] === "\n" && /^\n[ \t]*(?:\n|$)/.test(s.slice(j, j + 64))) return -1;
    if (s[j] !== "`") continue;
    let k = 0;
    while (s[j + k] === "`") k++;
    if (k === n) return j;
    j += k - 1;
  }
  return -1;
}
