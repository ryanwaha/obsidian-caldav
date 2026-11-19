/** 只填時間時視為今天（iOS 使用者常只選時間）。 */
export function normalizeDue(date: string | undefined, time: string | undefined, today: Date): { date?: string; time?: string } {
  const d = date?.trim() || undefined, t = time?.trim() || undefined;
  if (!d && !t) return {};
  const pad = (n: number) => String(n).padStart(2, "0");
  return { date: d ?? `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`, time: t };
}
