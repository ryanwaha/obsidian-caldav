import { expect, test } from "vitest";
import { shortId } from "../src/shortid";

test.each([
  ["F17BEA7B-D695-4111-B0FC-481F6BD1EC2A", "5cd3cmqd"],
  ["t1-unknown-fields", "7pmqbjh5"],
  ["85483CE1-1395-4CD0-BF87-7B32BA498B32", "x2n6srvv"],
  ["任務-ü", "ezqk3f50"],
])("shortId(%s) = %s", async (uid, expected) => {
  expect(await shortId(uid)).toBe(expected);
});

test("只用 Crockford 字母表、長度 8", async () => {
  expect(await shortId("x")).toMatch(/^[0-9a-hjkmnp-tv-z]{8}$/);
});
