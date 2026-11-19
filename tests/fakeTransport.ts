import type { HttpRequest, HttpResponse, Transport } from "../src/caldav/http";

export type Route = HttpResponse | ((req: HttpRequest) => HttpResponse | Promise<HttpResponse>);

/** 依 "METHOD path" 回傳回應；同一 key 給陣列時依序取用（最後一個重複使用）。 */
export function fakeTransport(routes: Record<string, Route | Route[]>) {
  const calls: HttpRequest[] = [];
  const used: Record<string, number> = {};
  const transport: Transport = async (req) => {
    calls.push(req);
    const key = `${req.method} ${new URL(req.url).pathname}`;
    const r = routes[key];
    if (!r) return { status: 404, headers: {}, text: `no route ${key}` };
    let route: Route;
    if (Array.isArray(r)) { const i = used[key] ?? 0; used[key] = i + 1; route = r[Math.min(i, r.length - 1)]; } else route = r;
    return typeof route === "function" ? route(req) : route;
  };
  return { transport, calls };
}

export const xml = (text: string, status = 207): HttpResponse => ({ status, headers: { "Content-Type": "application/xml" }, text });
