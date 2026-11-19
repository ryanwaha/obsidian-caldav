import { describe, expect, test } from "vitest";
import { MoveResolver, detectAliases, moveCandidates } from "../src/sync/moves";
import type { Alias, CalObject, CollectionInfo, Tombstone } from "../src/types";

const A = "/ryanw/test/", B = "/ryanw/tasks/", E = "/ryanw/events/";
const obj = (uid: string, extra: Partial<CalObject> = {}): CalObject => ({
  href: `${B}${uid}.ics`, collection: B, etag: '"1"', uid, shortId: `s${uid}`.padEnd(8, "0").slice(0, 8), kind: "VTODO",
  summary: "交週報", created: "20261101T000000Z", hasOverrides: false, ics: "", ...extra,
});
const tomb = (uid: string, extra: Partial<Tombstone> = {}): Tombstone => ({
  href: `${A}${uid}.ics`, uid, shortId: `t${uid}`.padEnd(8, "0").slice(0, 8), collection: A, summary: "交週報",
  created: "20261101T000000Z", kind: "VTODO", deletedAt: 100, ...extra,
});
const col = (href: string, lastSyncAt: number | undefined, components: ("VTODO" | "VEVENT")[] = ["VTODO"]): CollectionInfo =>
  ({ href, displayName: href, components, ...(lastSyncAt === undefined ? {} : { lastSyncAt }) });
const synced = [col(A, 200), col(B, 200), col(E, 50, ["VEVENT"])];

describe("moveCandidates", () => {
  test.each<[string, Partial<CalObject>, Partial<Tombstone>, number]>([
    ["created＋summary 相同、不同集合", {}, {}, 1],
    ["同一個集合不算", { collection: A }, {}, 0],
    ["同 UID 不算", { uid: "old" }, {}, 0],
    ["kind 不同", { kind: "VEVENT" }, {}, 0],
    ["舊 tombstone 沒有 kind：不檢查", { kind: "VEVENT" }, { kind: undefined }, 1],
    ["summary 不同", { summary: "別的" }, {}, 0],
    ["created 不同", { created: "20261102T000000Z" }, {}, 0],
    ["物件沒有 created", { created: undefined }, {}, 0],
    ["兩邊都沒有 created：不能比對", { created: undefined }, { created: undefined }, 0],
  ])("%s", (_, o, t, n) => {
    expect(moveCandidates(tomb("old", t), [obj("new", o)])).toHaveLength(n);
  });
});

describe("detectAliases", () => {
  test("唯一候選 → 新 alias；多筆或已有 alias 都不寫", () => {
    const tombs = [tomb("t1"), tomb("t2", { summary: "兩筆" }), tomb("t3", { summary: "已有" })];
    const objs = [obj("n1"), obj("n2a", { summary: "兩筆" }), obj("n2b", { summary: "兩筆", collection: E, kind: "VTODO" }), obj("n3", { summary: "已有" })];
    const existing: Alias[] = [{ fromUid: "t3", fromShortId: "x", toUid: "n3", toShortId: "y", detectedAt: 1 }];
    const out = detectAliases(tombs, objs, existing, 999);
    expect(out).toEqual([{ fromUid: "t1", fromShortId: tombs[0].shortId, toUid: "n1", toShortId: obj("n1").shortId, detectedAt: 999 }]);
  });
  test("舊 UID 仍然存在（例如保留 UID 的客戶端搬移）：不寫 alias", () => {
    expect(detectAliases([tomb("same")], [obj("same", { href: `${B}x.ics` }), obj("other")], [], 1)).toEqual([]);
  });
});

describe("MoveResolver", () => {
  test("有 alias：改名後仍解析到新物件", () => {
    const n = obj("n1", { summary: "改過名" });
    const r = new MoveResolver([n], [tomb("t1")], [{ fromUid: "t1", fromShortId: "x", toUid: "n1", toShortId: n.shortId, detectedAt: 1 }], synced);
    expect(r.resolve([tomb("t1")])).toMatchObject({ kind: "moved", obj: n, from: { uid: "t1" } });
  });
  test("alias 鏈 A→B→A", () => {
    const t1 = tomb("u1"), t2 = tomb("u2", { collection: B, href: `${B}u2.ics` });
    const u3 = obj("u3", { collection: A, href: `${A}u3.ics`, summary: "第三次改名" });
    const aliases: Alias[] = [
      { fromUid: "u1", fromShortId: "a", toUid: "u2", toShortId: "b", detectedAt: 1 },
      { fromUid: "u2", fromShortId: "b", toUid: "u3", toShortId: "c", detectedAt: 2 },
    ];
    expect(new MoveResolver([u3], [t1, t2], aliases, synced).resolve([t1])).toMatchObject({ kind: "moved", obj: u3 });
  });
  test("alias 迴圈不會無限跟隨", () => {
    const t1 = tomb("u1"), t2 = tomb("u2");
    const aliases: Alias[] = [
      { fromUid: "u1", fromShortId: "a", toUid: "u2", toShortId: "b", detectedAt: 1 },
      { fromUid: "u2", fromShortId: "b", toUid: "u1", toShortId: "a", detectedAt: 2 },
    ];
    expect(new MoveResolver([], [t1, t2], aliases, synced).resolve([t1]).kind).toBe("deleted");
  });
  test("沒有 alias：即時比對唯一 → moved；多筆 → ambiguous", () => {
    expect(new MoveResolver([obj("n1")], [], [], synced).resolve([tomb("t1")]).kind).toBe("moved");
    const r = new MoveResolver([obj("n1"), obj("n2", { collection: "/x/" })], [], [], synced).resolve([tomb("t1")]);
    expect(r).toMatchObject({ kind: "ambiguous" });
    expect(r.kind === "ambiguous" && r.candidates.map((o) => o.uid)).toEqual(["n1", "n2"]);
  });
  test("0 筆：相關集合都已在刪除之後同步過 → deleted", () => {
    expect(new MoveResolver([], [], [], synced).resolve([tomb("t1")]).kind).toBe("deleted");
  });
  test("0 筆：有相關集合還沒同步到刪除之後 → maybe", () => {
    expect(new MoveResolver([], [], [], [col(A, 200), col(B, 50)]).resolve([tomb("t1")]).kind).toBe("maybe");
    expect(new MoveResolver([], [], [], [col(A, 200), col(B, undefined)]).resolve([tomb("t1")]).kind).toBe("maybe");
  });
  test("maybe 只看相關集合：VEVENT 專用集合落後不影響任務；自己的集合不算", () => {
    expect(new MoveResolver([], [], [], [col(A, 50), col(B, 200), col(E, 50, ["VEVENT"])]).resolve([tomb("t1")]).kind).toBe("deleted");
  });
  test("舊 tombstone 沒有 kind：所有其他集合都算相關", () => {
    expect(new MoveResolver([], [], [], [col(A, 200), col(B, 200), col(E, 50, ["VEVENT"])]).resolve([tomb("t1", { kind: undefined })]).kind).toBe("maybe");
  });
  test("同一輪：deletedAt = 本輪開始時間，同輪較早同步的集合（lastSyncAt ≥ 開始）不算落後", () => {
    expect(new MoveResolver([], [], [], [col(A, 100), col(B, 100)]).resolve([tomb("t1", { deletedAt: 100 })]).kind).toBe("deleted");
  });
  test("多筆 tombstone：取最新刪除的那筆", () => {
    const old = tomb("t0", { summary: "舊的", deletedAt: 10 }), recent = tomb("t1", { deletedAt: 100 });
    expect(new MoveResolver([obj("n1")], [], [], synced).resolve([old, recent])).toMatchObject({ kind: "moved", from: { uid: "t1" } });
  });
});
