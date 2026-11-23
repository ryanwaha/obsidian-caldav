/**
 * 投影檔的 frontmatter 切分（不依賴 Obsidian，方便測試）。
 * 開頭必須是 `---` 行；結尾是第一個「整行只有 `---`」的行。行中或行尾的 `---`、
 * 區塊字串裡縮排的 `---` 都不算結尾（review C2）。
 */
export function splitFrontmatter(text: string, parse: (yaml: string) => unknown): { fm: Record<string, unknown> | null; body: string } {
  const lines = text.split("\n");
  if (lines[0].replace(/\r$/, "").trimEnd() !== "---") return { fm: null, body: text };
  let end = -1;
  for (let i = 1; i < lines.length; i++) if (lines[i].replace(/\r$/, "").trimEnd() === "---") { end = i; break; }
  if (end < 0) return { fm: null, body: text };
  const yaml = lines.slice(1, end).map((l) => l.replace(/\r$/, "")).join("\n");
  const body = lines.slice(end + 1).join("\n");
  let fm: unknown = null;
  try { fm = yaml.trim() ? parse(yaml) : {}; } catch { fm = null; }
  return { fm: fm && typeof fm === "object" && !Array.isArray(fm) ? (fm as Record<string, unknown>) : null, body };
}

/** 新投影檔的完整內容：一次寫入，不會出現沒有 `_uid` 的中間狀態（review I4）。 */
export function newFileContent(fm: object, stringify: (o: object) => string): string {
  const y = stringify(fm);
  return `---\n${y.endsWith("\n") ? y : `${y}\n`}---\n`;
}
