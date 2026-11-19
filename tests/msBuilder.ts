/** 產生 sync-collection 的 multistatus 回應（格式比照 Radicale）。 */
export function todo(uid: string, summary = uid, extra: string[] = []): string {
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VTODO", `UID:${uid}`, `SUMMARY:${summary}`, "CREATED:20261119T000000Z", ...extra, "END:VTODO", "END:VCALENDAR", ""].join("\r\n");
}
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
export function syncMs(token: string, items: { href: string; etag?: string; ics: string }[], removed: string[] = []): string {
  const ok = items.map((i) => `<response><href>${i.href}</href><propstat><prop><getetag>${i.etag ?? '"1"'}</getetag><C:calendar-data>${esc(i.ics)}</C:calendar-data></prop><status>HTTP/1.1 200 OK</status></propstat></response>`);
  const gone = removed.map((h) => `<response><href>${h}</href><status>HTTP/1.1 404 Not Found</status></response>`);
  return `<?xml version='1.0' encoding='utf-8'?><multistatus xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><sync-token>${token}</sync-token>${ok.join("")}${gone.join("")}</multistatus>`;
}
