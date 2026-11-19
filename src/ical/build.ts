import ICAL from "ical.js";

export interface NewTodo { uid: string; summary: string; due?: { date: string; time?: string } }

/** E3：帶時間的值寫 TZID=Asia/Taipei 並附 VTIMEZONE；全天用 VALUE=DATE。 */
export const TAIPEI_VTIMEZONE = ["BEGIN:VTIMEZONE", "TZID:Asia/Taipei", "BEGIN:STANDARD", "DTSTART:19700101T000000", "TZOFFSETFROM:+0800", "TZOFFSETTO:+0800", "TZNAME:CST", "END:STANDARD", "END:VTIMEZONE"].join("\r\n");

const utcStamp = (d: Date) => ICAL.Time.fromJSDate(d, true);

/** RFC 5545 §3.1：每行最多 75 octets（ical.js 以字元計，中文會超過）；不切開 UTF-8 字元。 */
export function foldLine(line: string): string {
  const enc = new TextEncoder();
  const out: string[] = [];
  let cur = "", curBytes = 0, limit = 75;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (curBytes + n > limit) { out.push(cur); cur = " "; curBytes = 1; limit = 75; }
    cur += ch; curBytes += n;
  }
  out.push(cur);
  return out.join("\r\n");
}

/** ical.js 序列化後以 octets 重新摺行（見 foldLine）。 */
export function serialize(cal: InstanceType<typeof ICAL.Component>): string {
  const unfolded = cal.toString().replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
  return unfolded.map(foldLine).join("\r\n") + "\r\n";
}

export function buildTodo(t: NewTodo, now: Date): string {
  const cal = new ICAL.Component(["vcalendar", [], []]);
  cal.addPropertyWithValue("version", "2.0");
  cal.addPropertyWithValue("prodid", "-//obsidian-caldav//EN");
  if (t.due?.time) cal.addSubcomponent(new ICAL.Component(ICAL.parse(TAIPEI_VTIMEZONE)));

  const todo = new ICAL.Component("vtodo");
  todo.addPropertyWithValue("uid", t.uid);
  const stamp = utcStamp(now);
  todo.addPropertyWithValue("dtstamp", stamp);
  todo.addPropertyWithValue("created", stamp);
  todo.addPropertyWithValue("last-modified", stamp);
  todo.addPropertyWithValue("summary", t.summary);
  todo.addPropertyWithValue("status", "NEEDS-ACTION");
  if (t.due) {
    const [y, m, d] = t.due.date.split("-").map(Number);
    if (t.due.time) {
      const [h, mi] = t.due.time.split(":").map(Number);
      const prop = todo.addPropertyWithValue("due", ICAL.Time.fromData({ year: y, month: m, day: d, hour: h, minute: mi, second: 0, isDate: false }));
      prop.setParameter("tzid", "Asia/Taipei");
    } else {
      todo.addPropertyWithValue("due", ICAL.Time.fromData({ year: y, month: m, day: d, isDate: true }));
    }
  }
  cal.addSubcomponent(todo);
  return serialize(cal);
}
