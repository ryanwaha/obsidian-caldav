import { describe, expect, test } from "vitest";
import { parseMultistatus, propfindBody, syncCollectionBody } from "../src/caldav/xml";
import { radicale } from "./fixtures";

const D = "{DAV:}", C = "{urn:ietf:params:xml:ns:caldav}";

describe("parseMultistatus", () => {
  test("principal 的 href", () => {
    const ms = parseMultistatus(radicale("propfind-principal.xml"));
    const el = ms.responses[0].props.get(`${D}current-user-principal`)!;
    expect(el.getElementsByTagNameNS("DAV:", "href")[0].textContent).toBe("/ryanw/");
  });

  test("collections：只收 200 propstat 的 prop", () => {
    const ms = parseMultistatus(radicale("propfind-collections.xml"));
    expect(ms.responses).toHaveLength(3);
    const tasks = ms.responses.find((r) => r.href === "/ryanw/tasks/")!;
    expect(tasks.props.get(`${D}displayname`)!.textContent).toBe("任務");
    const comps = [...tasks.props.get(`${C}supported-calendar-component-set`)!.getElementsByTagNameNS("urn:ietf:params:xml:ns:caldav", "comp")].map((e) => e.getAttribute("name"));
    expect(comps).toEqual(["VTODO", "VEVENT"]);
    const root = ms.responses.find((r) => r.href === "/ryanw/")!;
    expect(root.props.has(`${D}displayname`)).toBe(false);
  });

  test("sync-collection：token、calendar-data、404", () => {
    const ms = parseMultistatus(radicale("sync-initial-with-data.xml"));
    expect(ms.syncToken).toMatch(/^http:\/\/radicale\.org\/ns\/sync\//);
    const ok = ms.responses.filter((r) => r.status === undefined);
    expect(ok.length).toBeGreaterThan(0);
    for (const r of ok) expect(r.props.get(`${C}calendar-data`)!.textContent).toContain("BEGIN:VCALENDAR");
    expect(ms.responses.every((r) => r.status === undefined)).toBe(true);
  });

  test("sync-collection：刪除過的物件以 response 層級 404 列出", () => {
    const ms = parseMultistatus(radicale("sync-initial-etag-only.xml"));
    const gone = ms.responses.filter((r) => r.status === 404);
    expect(gone.length).toBeGreaterThan(0);
    for (const r of gone) expect(r.props.size).toBe(0);
    const ok = ms.responses.filter((r) => r.status === undefined);
    for (const r of ok) expect(r.props.get(`${D}getetag`)!.textContent).toMatch(/^".+"$/);
  });

  test("href 會被 decode", () => {
    const xml = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>/a/%E4%BB%BB%E5%8B%99.ics</d:href><d:status>HTTP/1.1 404 Not Found</d:status></d:response></d:multistatus>`;
    expect(parseMultistatus(xml).responses[0].href).toBe("/a/任務.ics");
  });
});

describe("request bodies", () => {
  test("propfindBody 可被解析且帶命名空間", () => {
    const doc = new DOMParser().parseFromString(propfindBody(["d:displayname", "c:calendar-home-set"]), "application/xml");
    expect(doc.getElementsByTagNameNS("DAV:", "displayname")).toHaveLength(1);
    expect(doc.getElementsByTagNameNS("urn:ietf:params:xml:ns:caldav", "calendar-home-set")).toHaveLength(1);
  });
  test("syncCollectionBody：null token 是空元素，withData 帶 calendar-data", () => {
    const doc = new DOMParser().parseFromString(syncCollectionBody(null, true), "application/xml");
    expect(doc.getElementsByTagNameNS("DAV:", "sync-token")[0].textContent).toBe("");
    expect(doc.getElementsByTagNameNS("urn:ietf:params:xml:ns:caldav", "calendar-data")).toHaveLength(1);
    const doc2 = new DOMParser().parseFromString(syncCollectionBody("http://x/<&>", false), "application/xml");
    expect(doc2.getElementsByTagNameNS("DAV:", "sync-token")[0].textContent).toBe("http://x/<&>");
    expect(doc2.getElementsByTagNameNS("urn:ietf:params:xml:ns:caldav", "calendar-data")).toHaveLength(0);
  });
});
