import { describe, expect, test } from "vitest";
import { findRefs } from "../src/render/refs";

describe("findRefs", () => {
  test("空標籤", () => {
    expect(findRefs("今天 [](cal:5cd3cmqd) 下週交")).toEqual([{ from: 3, to: 19, label: "", id: "5cd3cmqd" }]);
  });
  test("有標籤", () => {
    expect(findRefs("[和 A 討論的那份](cal:5cd3cmqd)")[0].label).toBe("和 A 討論的那份");
  });
  test("大寫轉小寫", () => {
    expect(findRefs("[](cal:5CD3CMQD)")[0].id).toBe("5cd3cmqd");
  });
  test("query 保留但不影響 id", () => {
    const [r] = findRefs("[](cal:5cd3cmqd?view=x)");
    expect(r.id).toBe("5cd3cmqd");
    expect(r.query).toBe("?view=x");
    expect(r.to).toBe("[](cal:5cd3cmqd?view=x)".length);
  });
  test("同一行兩個參照與一個普通連結", () => {
    const t = "a [](cal:5cd3cmqd) b [x](https://a) c [y](cal:x2n6srvv)";
    const rs = findRefs(t);
    expect(rs.map((r) => r.id)).toEqual(["5cd3cmqd", "x2n6srvv"]);
    for (const r of rs) expect(t.slice(r.from, r.to)).toMatch(/^\[[^\]]*\]\(cal:[a-z0-9]{8}\)$/);
  });
  test("offset", () => {
    expect(findRefs("a [](cal:5cd3cmqd)", 100)[0].from).toBe(102);
  });
  test.each(["[](cal:abc)", "[](cal:ilou1234)", "[](cal:5cd3cmqdx)", "[a\nb](cal:5cd3cmqd)", "cal:5cd3cmqd"])("不算參照：%j", (t) => {
    expect(findRefs(t)).toEqual([]);
  });
});
