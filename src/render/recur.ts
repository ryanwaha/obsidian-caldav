const DAY: Record<string, string> = { MO: "一", TU: "二", WE: "三", TH: "四", FR: "五", SA: "六", SU: "日" };
const UNIT: Record<string, string> = { DAILY: "天", WEEKLY: "週", MONTHLY: "月", YEARLY: "年" };
const IGNORED = new Set(["UNTIL", "COUNT", "WKST"]);

/** 常見重複規則的中文描述；其他組合一律回傳「重複」。 */
export function describeRrule(rrule: string): string {
  const parts = new Map(rrule.split(";").map((p) => p.split("=") as [string, string]));
  const freq = parts.get("FREQ");
  if (!freq || !UNIT[freq]) return "重複";
  for (const k of parts.keys()) {
    if (k !== "FREQ" && k !== "INTERVAL" && k !== "BYDAY" && k !== "BYMONTHDAY" && !IGNORED.has(k)) return "重複";
  }
  const interval = Number(parts.get("INTERVAL") ?? "1");
  if (!Number.isInteger(interval) || interval < 1) return "重複";
  let base = interval === 1 ? `每${UNIT[freq]}` : `每 ${interval} ${UNIT[freq]}`;
  const byday = parts.get("BYDAY");
  const bymd = parts.get("BYMONTHDAY");
  if (byday) {
    if (freq !== "WEEKLY") return "重複";
    const days = byday.split(",");
    if (!days.every((d) => DAY[d])) return "重複";
    base += days.map((d) => DAY[d]).join("、");
  }
  if (bymd) {
    if (freq !== "MONTHLY" || !/^\d{1,2}$/.test(bymd)) return "重複";
    base += ` ${Number(bymd)} 日`;
  }
  return base;
}
