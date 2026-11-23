import { writableHash } from "../projection/fields";

export interface ChipView {
  kind: "VTODO" | "VEVENT"; title: string;
  checkbox?: { checked: boolean; enabled: boolean };
  date?: string;
  light: "ok" | "pending" | "rejected" | "conflict" | "deleted";
  message?: string;
  titleChanged: boolean;
  /** 可以從 chip 修改（伺服器還沒建立的新任務、已刪除的任務都不行，review I1） */
  editable: boolean;
}

const str = (v: unknown) => (v == null || v === "" ? undefined : String(v));
const md = (d: string) => { const [, m, day] = d.split("-"); return `${+m}/${+day}`; };

/** 投影檔 frontmatter → chip 顯示內容（設計 §7.2）。純函式；只讀 frontmatter，不連 CalDAV。 */
export function chipView(fm: Record<string, unknown>, label: string | undefined, _now: Date): ChipView {
  const kind = fm._kind === "VEVENT" ? "VEVENT" : "VTODO";
  const title = str(fm.title) ?? "";
  const deleted = fm._deleted === true;
  let date: string | undefined;
  if (kind === "VTODO") {
    const due = str(fm.due);
    if (due) date = `${md(due)}${str(fm.due_time) ? ` ${fm.due_time}` : ""}`;
  } else {
    const s = str(fm.start), e = str(fm.end);
    if (s) {
      date = `${md(s)}${str(fm.start_time) ? ` ${fm.start_time}` : ""}`;
      if (e && e === s && str(fm.end_time)) date += `–${fm.end_time}`;
      else if (e && e !== s) date += `–${md(e)}${str(fm.end_time) ? ` ${fm.end_time}` : ""}`;
    }
  }
  if (str(fm._rrule)) date = `${fm._rrule}${date ? `・${date}` : ""}`;

  let light: ChipView["light"] = "ok";
  let message: string | undefined;
  if (deleted) light = "deleted";
  else if (fm._sync === "conflict") {
    light = "conflict";
    const c = (fm._conflict ?? {}) as Record<string, { mine?: unknown; theirs?: unknown }>;
    message = Object.entries(c).map(([k, v]) => `${k}：你的「${v.mine ?? "空"}」／伺服器「${v.theirs ?? "空"}」`).join("；") || "有衝突";
  } else if (fm._sync === "rejected") { light = "rejected"; message = str(fm._sync_msg); }
  else if (!str(fm._etag) || (str(fm._hash) && writableHash(fm) !== String(fm._hash))) light = "pending";

  const alias = Array.isArray(fm.aliases) && fm.aliases.length ? String(fm.aliases[0]) : title;
  const created = !!str(fm._etag);
  const view: ChipView = { kind, title, light, titleChanged: label !== undefined && label !== alias, editable: created && !deleted };
  if (date) view.date = date;
  if (message) view.message = message;
  if (kind === "VTODO") view.checkbox = { checked: fm.status === "completed", enabled: view.editable && !str(fm._rrule) };
  return view;
}
