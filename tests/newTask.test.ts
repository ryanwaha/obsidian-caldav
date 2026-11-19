import { expect, test } from "vitest";
import { normalizeDue } from "../src/ui/due";

const today = new Date(2026, 10, 19, 10);
test.each([
  [["", ""], {}],
  [["2026-11-24", ""], { date: "2026-11-24", time: undefined }],
  [["2026-11-24", "09:00"], { date: "2026-11-24", time: "09:00" }],
  [["", "09:00"], { date: "2026-11-19", time: "09:00" }],
])("normalizeDue(%j)", ([d, t], expected) => {
  expect(normalizeDue(d, t, today)).toEqual(expected);
});
