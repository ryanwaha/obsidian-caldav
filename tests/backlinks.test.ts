import { describe, expect, test, vi } from "vitest";
import { BacklinkIndex } from "../src/backlinks/index";
import { rewriteRefs } from "../src/backlinks/rewrite";
import { scanRefs } from "../src/backlinks/scan";

const R = "[](cal:5cd3cmqd)";
const ids = (t: string) => scanRefs(t).map((r) => r.id);

describe("scanRefs：排除程式碼、frontmatter、註解", () => {
  test("一般文字裡的參照", () => {
    expect(ids(`a ${R} b [x](cal:x2n6srvv)`)).toEqual(["5cd3cmqd", "x2n6srvv"]);
  });
  test("位置與標籤取自原文", () => {
    const t = `前文 [週報](cal:5cd3cmqd) 後`;
    const [r] = scanRefs(t);
    expect(t.slice(r.from, r.to)).toBe("[週報](cal:5cd3cmqd)");
    expect(r.label).toBe("週報");
  });
  test.each([
    ["fenced ```", "```\n" + R + "\n```\n"],
    ["fenced ~~~ 帶 info", "~~~markdown\n" + R + "\n~~~\n"],
    ["fence 未關閉到檔尾", "```\n" + R + "\n"],
    ["較短的 fence 不能關閉", "````\n```\n" + R + "\n````\n"],
    ["清單裡縮排的 fence", "- a\n    ```\n    " + R + "\n    ```\n"],
    ["引用區塊裡的 fence", "> ```\n> " + R + "\n> ```\n"],
    ["行內程式碼", "看 `" + R + "` 這樣寫"],
    ["雙反引號行內程式碼", "看 `` a ` " + R + " `` 這樣"],
    ["frontmatter", "---\nlink: " + R + "\n---\n本文"],
    ["%% 註解 %%", "a %%" + R + "%% b"],
    ["跨行註解", "%%\n" + R + "\n%%"],
  ])("排除：%s", (_, t) => {
    expect(ids(t)).toEqual([]);
  });
  test("fence 之後的參照照算；不同字元不能關閉", () => {
    expect(ids("```\nx\n```\n" + R)).toEqual(["5cd3cmqd"]);
    expect(ids("```\n~~~\n" + R + "\n```\n" + R)).toEqual(["5cd3cmqd"]);
  });
  test("沒有配對的反引號不吃掉後文", () => {
    expect(ids("一個 ` 反引號 " + R)).toEqual(["5cd3cmqd"]);
  });
  test("行內程式碼不跨段落", () => {
    expect(ids("a `x\n\n" + R + " `")).toEqual(["5cd3cmqd"]);
  });
  test("標籤以行內程式碼開頭仍算參照（同渲染器：看 (cal: 的位置）", () => {
    expect(ids("[`code`](cal:5cd3cmqd)")).toEqual(["5cd3cmqd"]);
  });
  test("frontmatter 只在檔頭", () => {
    expect(ids("本文\n---\n" + R + "\n---\n")).toEqual(["5cd3cmqd"]);
  });
  test("設計文件式的寫法：範例全在程式碼裡 → 0 筆", () => {
    const doc = [
      "# 參照語法", "", "```markdown", "今天和 A 討論了 [](cal:k3f9x2qa)，下週要交。", "這份 [和 A 討論的那份](cal:k3f9x2qa) 先放著。", "```", "",
      "- 行內參照：`[標籤](cal:短ID)`。", "- 例如 `[](cal:x)` 變成 `[交週報（到期 11/24）](cal:x)`。", "- query：`cal:k3f9x2qa?…`。",
    ].join("\n");
    expect(scanRefs(doc)).toEqual([]);
    expect(rewriteRefs(doc, new Map([["k3f9x2qa", "zzzzzzzz"]]))).toEqual({ text: doc, count: 0 });
  });
});

describe("rewriteRefs", () => {
  test("只換 ID；保留標籤與 query；程式碼裡的不動", () => {
    const t = `a [週報](cal:5cd3cmqd?v=1) b \`[](cal:5cd3cmqd)\` c [](cal:5CD3CMQD) d [](cal:x2n6srvv)`;
    const r = rewriteRefs(t, new Map([["5cd3cmqd", "newnewne"]]));
    expect(r.count).toBe(2);
    expect(r.text).toBe(`a [週報](cal:newnewne?v=1) b \`[](cal:5cd3cmqd)\` c [](cal:newnewne) d [](cal:x2n6srvv)`);
  });
  test("沒有對應時原樣回傳", () => {
    expect(rewriteRefs(R, new Map())).toEqual({ text: R, count: 0 });
  });
});

describe("BacklinkIndex", () => {
  test("setFile / notesFor / referencedIds；同檔重複只算一次", () => {
    const b = new BacklinkIndex();
    b.setFile("a.md", `${R} ${R}`);
    b.setFile("b.md", `${R} [](cal:x2n6srvv)`);
    expect(b.notesFor("5CD3CMQD")).toEqual(["a.md", "b.md"]);
    expect([...b.referencedIds()].sort()).toEqual(["5cd3cmqd", "x2n6srvv"]);
  });
  test("修改後舊的對應移除", () => {
    const b = new BacklinkIndex();
    b.setFile("a.md", R);
    b.setFile("a.md", "沒有了");
    expect(b.notesFor("5cd3cmqd")).toEqual([]);
    expect([...b.referencedIds()]).toEqual([]);
  });
  test("rename 與 removeFile", () => {
    const b = new BacklinkIndex();
    b.setFile("a.md", R);
    b.rename("a.md", "dir/c.md");
    expect(b.notesFor("5cd3cmqd")).toEqual(["dir/c.md"]);
    b.removeFile("dir/c.md");
    expect(b.notesFor("5cd3cmqd")).toEqual([]);
  });
  test("onChange 只在對應改變時通知", () => {
    const b = new BacklinkIndex();
    const fn = vi.fn();
    b.onChange(fn);
    b.setFile("a.md", R);
    b.setFile("a.md", `改字 ${R}`);
    b.setFile("x.md", "無參照");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

test("資料夾改名與刪除：路徑前綴整批處理", () => {
  const b = new BacklinkIndex();
  b.setFile("d/a.md", R);
  b.setFile("d/sub/b.md", R);
  b.setFile("dx.md", R);
  b.renameFolder("d", "e");
  expect(b.notesFor("5cd3cmqd")).toEqual(["dx.md", "e/a.md", "e/sub/b.md"]);
  b.removeFolder("e");
  expect(b.notesFor("5cd3cmqd")).toEqual(["dx.md"]);
});

describe("review 修正", () => {
  test("M1：空 frontmatter 不吞掉內文", () => {
    expect(ids("---\n---\n" + R + "\n\n---\nx")).toEqual(["5cd3cmqd"]);
  });
  test("M2：跳脫的反引號不算行內程式碼", () => {
    expect(ids("use \\` here " + R + " and ` later")).toEqual(["5cd3cmqd"]);
  });
  test("M3：HTML 註解裡的不算（和 live preview 一致）", () => {
    expect(ids("<!-- " + R + " -->\n" + "a")).toEqual([]);
  });
  test("M6：rename 未索引的舊路徑回傳 false", () => {
    const b = new BacklinkIndex();
    expect(b.rename("x.txt", "x.md")).toBe(false);
    b.setFile("a.md", R);
    expect(b.rename("a.md", "b.md")).toBe(true);
  });
});
