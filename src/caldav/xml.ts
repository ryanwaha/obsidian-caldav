const NS: Record<string, string> = { d: "DAV:", c: "urn:ietf:params:xml:ns:caldav" };
const HEAD = `<?xml version="1.0" encoding="utf-8"?>`;
const XMLNS = `xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"`;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** props 用前綴寫法，例如 "d:displayname"、"c:calendar-home-set"。 */
export function propfindBody(props: string[]): string {
  return `${HEAD}<d:propfind ${XMLNS}><d:prop>${props.map((p) => `<${p}/>`).join("")}</d:prop></d:propfind>`;
}

export function syncCollectionBody(token: string | null, withData: boolean): string {
  const tok = token ? `<d:sync-token>${esc(token)}</d:sync-token>` : "<d:sync-token/>";
  return `${HEAD}<d:sync-collection ${XMLNS}>${tok}<d:sync-level>1</d:sync-level><d:prop><d:getetag/>${withData ? "<c:calendar-data/>" : ""}</d:prop></d:sync-collection>`;
}

export interface MsResponse {
  href: string;
  /** response 層級的 status（sync-collection 刪除時出現） */
  status?: number;
  /** 只收 200 propstat 的 prop；key 為 "{ns}local" */
  props: Map<string, Element>;
}
export interface Multistatus { responses: MsResponse[]; syncToken?: string }

const statusCode = (s: string | null | undefined) => {
  const m = s?.match(/\s(\d{3})\s?/);
  return m ? Number(m[1]) : undefined;
};

/** 只取直接子元素，避免抓到巢狀結構裡的同名元素。 */
function children(el: Element, ns: string, local: string): Element[] {
  return [...el.children].filter((c) => c.namespaceURI === ns && c.localName === local);
}

export function parseMultistatus(xml: string): Multistatus {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const root = doc.documentElement;
  if (!root || root.getElementsByTagName("parsererror").length || root.localName === "parsererror") {
    throw new Error("無法解析 multistatus XML");
  }
  const responses: MsResponse[] = children(root, NS.d, "response").map((resp) => {
    const href = decodeURIComponent(children(resp, NS.d, "href")[0]?.textContent?.trim() ?? "");
    const status = statusCode(children(resp, NS.d, "status")[0]?.textContent);
    const props = new Map<string, Element>();
    for (const ps of children(resp, NS.d, "propstat")) {
      if (statusCode(children(ps, NS.d, "status")[0]?.textContent) !== 200) continue;
      const prop = children(ps, NS.d, "prop")[0];
      if (!prop) continue;
      for (const p of [...prop.children]) props.set(`{${p.namespaceURI}}${p.localName}`, p);
    }
    return { href, status, props };
  });
  const tok = children(root, NS.d, "sync-token")[0]?.textContent?.trim();
  return { responses, syncToken: tok || undefined };
}
