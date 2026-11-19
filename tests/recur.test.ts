import { expect, test } from "vitest";
import { describeRrule } from "../src/render/recur";

test.each([
  ["FREQ=WEEKLY;BYDAY=TU,WE,FR", "每週二、三、五"],
  ["FREQ=WEEKLY", "每週"],
  ["FREQ=DAILY;INTERVAL=2", "每 2 天"],
  ["FREQ=WEEKLY;INTERVAL=2;BYDAY=MO", "每 2 週一"],
  ["FREQ=MONTHLY;BYMONTHDAY=15", "每月 15 日"],
  ["FREQ=YEARLY", "每年"],
  ["FREQ=WEEKLY;UNTIL=20261202", "每週"],
  ["FREQ=MONTHLY;BYDAY=2MO", "重複"],
  ["garbage", "重複"],
])("%s → %s", (r, expected) => {
  expect(describeRrule(r)).toBe(expected);
});
