import { expect, test } from "vitest";
import { basicAuth, getHeader } from "../src/caldav/http";

test("getHeader 不分大小寫", () => {
  expect(getHeader({ Etag: '"a"' }, "etag")).toBe('"a"');
  expect(getHeader({ etag: '"b"' }, "ETag")).toBe('"b"');
  expect(getHeader({}, "etag")).toBeUndefined();
});

test("basicAuth 用 UTF-8", () => {
  const h = basicAuth("ryanw", "密碼");
  expect(h.startsWith("Basic ")).toBe(true);
  const bytes = Uint8Array.from(atob(h.slice(6)), (c) => c.charCodeAt(0));
  expect(new TextDecoder().decode(bytes)).toBe("ryanw:密碼");
});
