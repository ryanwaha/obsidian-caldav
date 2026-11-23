/** alias 會被 `[[` 自動完成原樣插入成連結標籤（S2）；`[[`、`]]`、換行會破壞連結語法，替換掉。 */
export function sanitizeAlias(title: string): string {
  return title.replace(/\[\[/g, "⟦").replace(/\]\]/g, "⟧").replace(/\r?\n/g, " ");
}
