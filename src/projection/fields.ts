import ICAL from "ical.js";
import { describeRrule } from "../render/recur";
import type { CalObject, DateValue } from "../types";
import { sanitizeAlias } from "./alias";
import { toLocalParts } from "./dates";
import { listName, type ProjFm, WRITABLE_KEYS, type WritableKey } from "./types";

/** 可寫欄位依固定順序正規化後的 SHA-256 前 16 hex（設計 §6.2 `_hash`；客戶端與伺服器共用）。 */
export async function writableHash(fm: Partial<Record<WritableKey, unknown>>): Promise<string> {
  const canon = JSON.stringify(WRITABLE_KEYS.map((k) => (fm[k] == null ? null : String(fm[k]))));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canon)));
  return [...digest.slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function description(ics: string): string | undefined {
  try {
    const root = new ICAL.Component(ICAL.parse(ics));
    const comp = root.getFirstSubcomponent("vtodo") ?? root.getFirstSubcomponent("vevent");
    const v = comp?.getFirstPropertyValue("description");
    return v == null || String(v) === "" ? undefined : String(v);
  } catch {
    return undefined;
  }
}

/** 全天 VEVENT 的 DTEND 不含當天（RFC 5545）；投影成含當天的結束日，寫回時加一天（設計 §6.2，比照 Full Calendar）。 */
export function inclusiveEnd(d: DateValue): DateValue {
  const v = d.value;
  const t = new Date(Date.UTC(+v.slice(0, 4), +v.slice(4, 6) - 1, +v.slice(6, 8)) - 86_400_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return { ...d, value: `${t.getUTCFullYear()}${p(t.getUTCMonth() + 1)}${p(t.getUTCDate())}` };
}

function putDate(fm: Record<string, unknown>, key: string, d: DateValue | undefined) {
  if (!d) return;
  const p = toLocalParts(key === "end" && d.dateOnly ? inclusiveEnd(d) : d);
  fm[key] = p.date;
  if (p.time) fm[`${key}_time`] = p.time;
}

/** CalDAV 物件 → 投影檔 frontmatter（設計 §6.2）。 */
export async function projectFields(o: CalObject): Promise<ProjFm> {
  const fm: Record<string, unknown> = { title: o.summary };
  if (o.kind === "VTODO") {
    if (o.status) fm.status = o.status.toLowerCase();
    putDate(fm, "due", o.due);
  } else {
    putDate(fm, "start", o.start);
    putDate(fm, "end", o.end);
  }
  fm.list = listName(o.collection);
  fm.aliases = [sanitizeAlias(o.summary)];
  fm._kind = o.kind;
  fm._uid = o.uid;
  const notes = description(o.ics);
  if (notes !== undefined) fm._notes = notes;
  if (o.rrule) fm._rrule = describeRrule(o.rrule);
  fm._etag = o.etag;
  fm._hash = await writableHash(fm as Partial<Record<WritableKey, unknown>>);
  fm._sync = "ok";
  fm._deleted = false;
  return fm as unknown as ProjFm;
}
