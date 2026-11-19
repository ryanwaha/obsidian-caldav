export interface HttpRequest { method: string; url: string; headers?: Record<string, string>; body?: string }
export interface HttpResponse { status: number; headers: Record<string, string>; text: string }
export type Transport = (req: HttpRequest) => Promise<HttpResponse>;

/** 標頭一律不分大小寫讀取（T5：iOS 是 Etag、桌面是 etag）。 */
export function getHeader(h: Record<string, string>, name: string): string | undefined {
  const key = Object.keys(h).find((k) => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : h[key];
}

export function basicAuth(user: string, pass: string): string {
  let bin = "";
  for (const b of new TextEncoder().encode(`${user}:${pass}`)) bin += String.fromCharCode(b);
  return "Basic " + btoa(bin);
}
