import type { CollectionInfo } from "../types";
import { type HttpResponse, type Transport, getHeader } from "./http";
import { parseMultistatus, propfindBody, syncCollectionBody } from "./xml";

export class TokenExpiredError extends Error {
  constructor() { super("sync-token 已失效"); this.name = "TokenExpiredError"; }
}
export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); this.name = "HttpError"; }
}

const D = "{DAV:}", C = "{urn:ietf:params:xml:ns:caldav}";
const CALDAV = "urn:ietf:params:xml:ns:caldav";

export interface SyncResult {
  token: string;
  changed: { href: string; etag: string; ics: string }[];
  removed: string[];
}

export class CalDavClient {
  private base: string;
  constructor(serverUrl: string, private auth: string, private transport: Transport) {
    this.base = serverUrl.replace(/\/+$/, "");
  }

  private async xmlRequest(method: string, path: string, depth: "0" | "1", body: string): Promise<HttpResponse> {
    const res = await this.transport({
      method,
      url: this.base + path,
      headers: { Authorization: this.auth, Depth: depth, "Content-Type": "application/xml; charset=utf-8" },
      body,
    });
    if (res.status === 401) throw new HttpError(401, "帳號或密碼錯誤");
    return res;
  }

  private static expect207(res: HttpResponse, what: string) {
    if (res.status !== 207) throw new HttpError(res.status, `${what} 失敗（HTTP ${res.status}）`);
  }

  private static hrefIn(el: Element | undefined): string | undefined {
    return el?.getElementsByTagNameNS("DAV:", "href")[0]?.textContent?.trim() || undefined;
  }

  async get(href: string): Promise<{ status: number; ics: string; etag?: string }> {
    const res = await this.transport({ method: "GET", url: this.base + href, headers: { Authorization: this.auth } });
    if (res.status === 401) throw new HttpError(401, "帳號或密碼錯誤");
    const etag = getHeader(res.headers, "etag");
    return etag === undefined ? { status: res.status, ics: res.text } : { status: res.status, ics: res.text, etag };
  }

  /** 回傳狀態碼由呼叫端判斷（201/204 成功、412 前置條件不符）；只有 401 會丟例外。 */
  async put(href: string, ics: string, cond: { ifNoneMatch: true } | { ifMatch: string }): Promise<{ status: number; etag?: string }> {
    const headers: Record<string, string> = { Authorization: this.auth, "Content-Type": "text/calendar; charset=utf-8" };
    if ("ifNoneMatch" in cond) headers["If-None-Match"] = "*";
    else headers["If-Match"] = cond.ifMatch;
    const res = await this.transport({ method: "PUT", url: this.base + href, headers, body: ics });
    if (res.status === 401) throw new HttpError(401, "帳號或密碼錯誤");
    const etag = getHeader(res.headers, "etag");
    return etag === undefined ? { status: res.status } : { status: res.status, etag };
  }

  /** WebDAV MOVE（設計 §8.4，S4）：UID 與 ETag 保留；`Overwrite: F` 目的地已存在時 412。回傳狀態碼。 */
  async move(href: string, destHref: string): Promise<number> {
    const res = await this.transport({ method: "MOVE", url: this.base + href, headers: { Authorization: this.auth, Destination: this.base + destHref, Overwrite: "F" } });
    if (res.status === 401) throw new HttpError(401, "帳號或密碼錯誤");
    return res.status;
  }

  /** 刪除物件（`_request: delete`）；以 If-Match 保證刪的是使用者看到的版本。回傳狀態碼。 */
  async delete(href: string, etag: string): Promise<number> {
    const res = await this.transport({ method: "DELETE", url: this.base + href, headers: { Authorization: this.auth, "If-Match": etag } });
    if (res.status === 401) throw new HttpError(401, "帳號或密碼錯誤");
    return res.status;
  }

  /** 不使用 /.well-known/caldav：iOS 跟隨 301 時會丟掉 Authorization（T5）。 */
  async discover(): Promise<{ principal: string; home: string }> {
    let res = await this.xmlRequest("PROPFIND", "/", "0", propfindBody(["d:current-user-principal"]));
    CalDavClient.expect207(res, "尋找 principal");
    const principal = CalDavClient.hrefIn(parseMultistatus(res.text).responses[0]?.props.get(`${D}current-user-principal`));
    if (!principal) throw new Error("伺服器沒有回報 current-user-principal");
    res = await this.xmlRequest("PROPFIND", principal, "0", propfindBody(["c:calendar-home-set"]));
    CalDavClient.expect207(res, "尋找 calendar-home-set");
    const home = CalDavClient.hrefIn(parseMultistatus(res.text).responses[0]?.props.get(`${C}calendar-home-set`));
    if (!home) throw new Error("伺服器沒有回報 calendar-home-set");
    return { principal, home };
  }

  async listCollections(home: string): Promise<CollectionInfo[]> {
    const res = await this.xmlRequest("PROPFIND", home, "1",
      propfindBody(["d:resourcetype", "d:displayname", "c:supported-calendar-component-set"]));
    CalDavClient.expect207(res, "列出清單");
    const out: CollectionInfo[] = [];
    for (const r of parseMultistatus(res.text).responses) {
      const rt = r.props.get(`${D}resourcetype`);
      if (!rt || rt.getElementsByTagNameNS(CALDAV, "calendar").length === 0) continue;
      const compSet = r.props.get(`${C}supported-calendar-component-set`);
      const names = compSet ? [...compSet.getElementsByTagNameNS(CALDAV, "comp")].map((e) => e.getAttribute("name")) : ["VTODO", "VEVENT"];
      const components = (["VTODO", "VEVENT"] as const).filter((n) => names.includes(n));
      out.push({ href: r.href, displayName: r.props.get(`${D}displayname`)?.textContent?.trim() || r.href, components });
    }
    return out;
  }

  async syncCollection(href: string, token: string | null): Promise<SyncResult> {
    const res = await this.xmlRequest("REPORT", href, "1", syncCollectionBody(token, true));
    if (res.status === 403 && res.text.includes("valid-sync-token")) throw new TokenExpiredError();
    CalDavClient.expect207(res, `同步 ${href}`);
    const ms = parseMultistatus(res.text);
    if (!ms.syncToken) throw new Error(`同步 ${href}：回應沒有 sync-token`);
    const changed: SyncResult["changed"] = [];
    const removed: string[] = [];
    for (const r of ms.responses) {
      if (r.status === 404) { removed.push(r.href); continue; }
      if (r.href.endsWith("/")) continue; // 清單本身
      changed.push({
        href: r.href,
        etag: r.props.get(`${D}getetag`)?.textContent?.trim() ?? "",
        ics: r.props.get(`${C}calendar-data`)?.textContent ?? "",
      });
    }
    return { token: ms.syncToken, changed, removed };
  }
}
