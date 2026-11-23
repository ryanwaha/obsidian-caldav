import { sanitizeAlias } from "../projection/alias";
import { dueOf } from "../projection/upstream";

export interface NewTaskFields { title: string; list: string; date?: string; time?: string }

/** 裝置新建的投影檔 frontmatter（設計 D9）：沒有 `_etag`，伺服器看到後才送到 CalDAV */
export function newTaskFm(i: NewTaskFields, uid: string): Record<string, unknown> {
  const title = i.title.trim();
  if (!title) throw new Error("標題不能是空的");
  if (!i.list) throw new Error("請選擇清單");
  const d = dueOf({ due: i.date || undefined, due_time: i.time || undefined });
  if ("error" in d) throw new Error(d.error);
  const fm: Record<string, unknown> = { title, status: "needs-action" };
  if (d.due) { fm.due = d.due.date; if (d.due.time) fm.due_time = d.due.time; }
  Object.assign(fm, { list: i.list, aliases: [sanitizeAlias(title)], _kind: "VTODO", _uid: uid });
  return fm;
}

/** 清單選項：現有投影檔中 VTODO 的 `list` 值，依出現次數排序（取代設計 §6.1 的 _lists.md） */
export function listOptions(fms: Record<string, unknown>[]): string[] {
  const n = new Map<string, number>();
  for (const fm of fms) if (fm._kind === "VTODO" && typeof fm.list === "string" && fm.list) n.set(fm.list, (n.get(fm.list) ?? 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([k]) => k);
}
