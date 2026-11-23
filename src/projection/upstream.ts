import { editable } from "../ical/editable";
import type { CalObject, CollectionInfo, Patch } from "../types";
import { listName, WRITABLE_KEYS } from "./types";

export type UpstreamResult =
  | { kind: "none" }
  | { kind: "body-only" }
  | { kind: "send"; patch: Patch; move?: string }
  /** 不送出；呼叫端以 base 的值回滾可寫欄位，寫 `_sync: rejected` 與訊息 */
  | { kind: "reject"; message: string }
  | { kind: "request"; request: "delete" | "dismiss-conflict" };

export const SYSTEM_KEYS = ["aliases", "_kind", "_uid", "_notes", "_rrule", "_etag", "_hash", "_sync", "_sync_msg", "_deleted", "_conflict"];
const STATUSES = new Set(["needs-action", "in-process", "completed", "cancelled"]);
const REQUESTS = new Set(["delete", "dismiss-conflict"]);
const MSG_RECURRING_TODO = "重複任務的完成請在提醒事項操作";
const MSG_RECURRING_EVENT = "重複事件請在行事曆 App 修改";

const norm = (v: unknown): string | null => (v == null || v === "" ? null : Array.isArray(v) ? JSON.stringify(v.map(String)) : String(v));
const str = (v: unknown): string | undefined => (v == null || v === "" ? undefined : String(v));

function validDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}
const validTime = (s: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s);

function addDay(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d) + 86_400_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}`;
}

class Reject extends Error {}

/** 日期＋時間兩欄 → Patch 的日期值；兩者皆空為 null（設計 §6.2）。 */
export function dueOf(fm: Record<string, unknown>): { due: { date: string; time?: string } | null } | { error: string } {
  try { return { due: dateValue(str(fm.due), str(fm.due_time), "到期") }; } catch (e) { if (e instanceof Reject) return { error: e.message }; throw e; }
}

function dateValue(date: string | undefined, time: string | undefined, label: string): { date: string; time?: string } | null {
  if (!date && !time) return null;
  if (!date) throw new Reject(`${label}：有時間但沒有日期`);
  if (!validDate(date)) throw new Reject(`${label}：日期格式要是 YYYY-MM-DD（${date}）`);
  if (time !== undefined && !validTime(time)) throw new Reject(`${label}：時間格式要是 HH:mm（${time}）`);
  return time ? { date, time } : { date };
}

/**
 * 三方比對的上行判斷（設計 §8.2）：mine = 檔案目前的 frontmatter，base = 伺服器上次寫出的投影。
 * 只看 mine 與 base 的差異；obj（快取的最新版本）只用來判斷可寫性與找清單，不當成 base。
 */
export function planUpstream(i: {
  mine: Record<string, unknown>; base: Record<string, unknown>; bodyChanged: boolean;
  obj: CalObject | undefined; collections: CollectionInfo[];
}): { result: UpstreamResult; rollbackSystemKeys: string[] } {
  const { mine, base, obj } = i;
  const rollbackSystemKeys = SYSTEM_KEYS.filter((k) => norm(mine[k]) !== norm(base[k]));
  const req = str(mine._request);
  if (req !== undefined && !REQUESTS.has(req)) rollbackSystemKeys.push("_request");
  if (req !== undefined && REQUESTS.has(req)) return { result: { kind: "request", request: req as "delete" | "dismiss-conflict" }, rollbackSystemKeys };

  const changed = new Set<string>(WRITABLE_KEYS.filter((k) => norm(mine[k]) !== norm(base[k])));
  if (!changed.size) return { result: i.bodyChanged ? { kind: "body-only" } : { kind: "none" }, rollbackSystemKeys };

  try {
    if (!obj || base._deleted === true) throw new Reject("任務已刪除");
    const ed = editable(obj);
    const isTodo = obj.kind === "VTODO";
    const patch: Patch = {};
    let move: string | undefined;

    if (changed.has("title")) {
      if (!ed.title) throw new Reject(MSG_RECURRING_EVENT);
      const t = str(mine.title);
      if (!t) throw new Reject("標題不能是空的");
      patch.summary = t;
    }
    if (isTodo) {
      for (const k of ["start", "start_time", "end", "end_time"]) if (changed.has(k)) throw new Reject("任務沒有開始／結束欄位，請用 due");
      if (changed.has("status")) {
        if (obj.rrule) throw new Reject(MSG_RECURRING_TODO);
        const s = str(mine.status)?.toLowerCase();
        if (!s || !STATUSES.has(s)) throw new Reject(`狀態只能是 ${[...STATUSES].join("、")}（${mine.status ?? "空"}）`);
        patch.status = s;
      }
      if (changed.has("due") || changed.has("due_time")) {
        if (!ed.date) throw new Reject(MSG_RECURRING_TODO);
        const v = dateValue(str(mine.due), str(mine.due_time), "到期");
        if (v === null && obj.rrule) throw new Reject("重複任務不能清除日期");
        patch.date = v;
      }
    } else {
      for (const k of ["status", "due", "due_time"]) if (changed.has(k)) throw new Reject("事件沒有狀態與 due，請用 start／end");
      if (changed.has("start") || changed.has("start_time")) {
        if (!ed.date) throw new Reject(MSG_RECURRING_EVENT);
        const v = dateValue(str(mine.start), str(mine.start_time), "開始");
        if (v === null) throw new Reject("事件必須有開始時間");
        patch.date = v;
      }
      if (changed.has("end") || changed.has("end_time")) {
        if (!ed.date) throw new Reject(MSG_RECURRING_EVENT);
        const v = dateValue(str(mine.end), str(mine.end_time), "結束");
        patch.end = v && !v.time ? { date: addDay(v.date) } : v; // 全天：含當天 → DTEND 不含當天
      }
    }
    if (changed.has("list")) {
      const name = str(mine.list);
      const hits = i.collections.filter((c) => listName(c.href) === name && c.components.includes(obj.kind));
      if (hits.length !== 1) throw new Reject(`找不到清單：${name ?? "空"}`);
      if (hits[0].href !== obj.collection) move = hits[0].href;
    }
    const result: UpstreamResult = move ? { kind: "send", patch, move } : { kind: "send", patch };
    return { result, rollbackSystemKeys };
  } catch (e) {
    if (e instanceof Reject) return { result: { kind: "reject", message: e.message }, rollbackSystemKeys };
    throw e;
  }
}
