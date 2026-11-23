import { expect, test } from "vitest";
import { projectFields } from "../src/projection/fields";
import { planReconcile, type ProjAction, type ProjFile, type ReconcileInput } from "../src/projection/plan";
import type { ProjFm } from "../src/projection/types";
import type { Alias, CalObject, CollectionInfo, PendingUpdate, Tombstone } from "../src/types";

const T = "/ryanw/tasks/", W = "/ryanw/work/";
const cols: CollectionInfo[] = [
  { href: T, displayName: "tasks", components: ["VTODO"], lastSyncAt: 1000 },
  { href: W, displayName: "work", components: ["VTODO"], lastSyncAt: 1000 },
];
const o = (uid: string, shortId: string, extra: Partial<CalObject> = {}): CalObject => ({
  href: `${extra.collection ?? T}${uid}.ics`, collection: T, etag: '"e"', uid, shortId, kind: "VTODO",
  summary: uid, created: "20261119T000000Z", hasOverrides: false, ics: `BEGIN:VCALENDAR\r\nBEGIN:VTODO\r\nUID:${uid}\r\nEND:VTODO\r\nEND:VCALENDAR\r\n`, ...extra,
});
const tomb = (uid: string, shortId: string, extra: Partial<Tombstone> = {}): Tombstone => ({
  href: `${T}${uid}.ics`, uid, shortId, collection: T, summary: uid, created: "20261119T000000Z", deletedAt: 900, kind: "VTODO", ...extra,
});
const file = (path: string, fm: Record<string, unknown> | null, bodyEmpty = true): ProjFile => ({ path, fm, bodyEmpty });
async function input(objects: CalObject[], files: ProjFile[], extra: Partial<ReconcileInput> = {}): Promise<ReconcileInput> {
  const projected = new Map<string, ProjFm>();
  for (const x of objects) projected.set(x.uid, await projectFields(x));
  return { objects, projected, tombstones: [], aliases: [], collections: cols, whitelist: [], files, now: 2000, complete: true, pending: new Map(), ...extra };
}
const fmOf = async (x: CalObject) => ({ ...(await projectFields(x)) } as Record<string, unknown>);
const all: ProjAction[][] = [];
const plan = (i: ReconcileInput) => { const r = planReconcile(i); all.push(r); return r; };

test("create-new", async () => {
  const a = o("a", "aaaaaaaa");
  expect(plan(await input([a], []))).toEqual([{ op: "create", path: "_caldav/aaaaaaaa.md", fm: await projectFields(a) }]);
});

test("noop-when-equal", async () => {
  const a = o("a", "aaaaaaaa");
  expect(plan(await input([a], [file("_caldav/aaaaaaaa.md", await fmOf(a))]))).toEqual([]);
});

test("update-only-diff", async () => {
  const a = o("a", "aaaaaaaa"), a2 = o("a", "aaaaaaaa", { summary: "新標題" });
  const r = plan(await input([a2], [file("_caldav/aaaaaaaa.md", await fmOf(a))]));
  expect(r).toHaveLength(1);
  const u = r[0] as Extract<ProjAction, { op: "update" }>;
  expect(u.op).toBe("update");
  expect(Object.keys(u.set).sort()).toEqual(["_hash", "aliases", "title"]);
  expect(u.unset).toEqual([]);
});

test("unset-removed-field", async () => {
  const withDue = o("a", "aaaaaaaa", { due: { value: "20261124T093000", dateOnly: false, tzid: "Asia/Taipei" } });
  const r = plan(await input([o("a", "aaaaaaaa")], [file("_caldav/aaaaaaaa.md", await fmOf(withDue))]));
  const u = r[0] as Extract<ProjAction, { op: "update" }>;
  expect(u.unset.sort()).toEqual(["due", "due_time"]);
});

test("deleted", async () => {
  const a = o("a", "aaaaaaaa");
  const r = plan(await input([], [file("_caldav/aaaaaaaa.md", await fmOf(a))], { tombstones: [tomb("a", "aaaaaaaa")] }));
  expect(r).toEqual([{ op: "update", path: "_caldav/aaaaaaaa.md", set: { _deleted: true }, unset: [] }]);
  const again = { ...(await fmOf(a)), _deleted: true };
  expect(plan(await input([], [file("_caldav/aaaaaaaa.md", again)], { tombstones: [tomb("a", "aaaaaaaa")] }))).toEqual([]);
});

test("maybe-moved-waits", async () => {
  const a = o("a", "aaaaaaaa");
  const lagging = [cols[0], { ...cols[1], lastSyncAt: 100 }];
  expect(plan(await input([], [file("_caldav/aaaaaaaa.md", await fmOf(a))], { tombstones: [tomb("a", "aaaaaaaa")], collections: lagging }))).toEqual([]);
});

test("alias-rename", async () => {
  const old = o("a", "aaaaaaaa"), moved = o("b", "bbbbbbbb", { collection: W, summary: "a" });
  const alias: Alias = { fromUid: "a", fromShortId: "aaaaaaaa", toUid: "b", toShortId: "bbbbbbbb", detectedAt: 950 };
  const r = plan(await input([moved], [file("_caldav/aaaaaaaa.md", await fmOf(old), false)], { tombstones: [tomb("a", "aaaaaaaa")], aliases: [alias] }));
  expect(r[0]).toEqual({ op: "rename", from: "_caldav/aaaaaaaa.md", to: "_caldav/bbbbbbbb.md" });
  expect(r[1]).toMatchObject({ op: "update", path: "_caldav/bbbbbbbb.md", set: { _uid: "b", list: "work" } });
  expect(r).toHaveLength(2);
});

test("move-same-uid", async () => {
  const a = o("a", "aaaaaaaa"), aw = o("a", "aaaaaaaa", { collection: W, href: `${W}a.ics` });
  const r = plan(await input([aw], [file("_caldav/aaaaaaaa.md", await fmOf(a))], { tombstones: [tomb("a", "aaaaaaaa")] }));
  expect(r).toHaveLength(1);
  expect(r[0]).toMatchObject({ op: "update", path: "_caldav/aaaaaaaa.md", set: { list: "work" } });
  expect((r[0] as Extract<ProjAction, { op: "update" }>).set).not.toHaveProperty("_deleted");
});

test("rename-onto-existing-empty", async () => {
  const old = o("a", "aaaaaaaa"), moved = o("b", "bbbbbbbb", { collection: W, summary: "a" });
  const files = [file("_caldav/aaaaaaaa.md", await fmOf(old), false), file("_caldav/bbbbbbbb.md", await fmOf(moved), true)];
  const r = plan(await input([moved], files, { tombstones: [tomb("a", "aaaaaaaa")] }));
  expect(r[0]).toEqual({ op: "merge-into", keep: "_caldav/aaaaaaaa.md", drop: "_caldav/bbbbbbbb.md" });
  expect(r[1]).toEqual({ op: "rename", from: "_caldav/aaaaaaaa.md", to: "_caldav/bbbbbbbb.md" });
  expect(r[2]).toMatchObject({ op: "update", path: "_caldav/bbbbbbbb.md", set: { _uid: "b" } });
});

test("rename-onto-existing-with-body", async () => {
  const old = o("a", "aaaaaaaa"), moved = o("b", "bbbbbbbb", { collection: W, summary: "a" });
  const files = [file("_caldav/aaaaaaaa.md", await fmOf(old), false), file("_caldav/bbbbbbbb.md", await fmOf(moved), false)];
  const r = plan(await input([moved], files, { tombstones: [tomb("a", "aaaaaaaa")] }));
  expect(r).toEqual([{ op: "update", path: "_caldav/aaaaaaaa.md", set: { _sync: "rejected", _sync_msg: "搬移目標已有內容，請手動合併" }, unset: [] }]);
});

test("ambiguous", async () => {
  const old = o("a", "aaaaaaaa");
  const c1 = o("b", "bbbbbbbb", { collection: W, summary: "a" }), c2 = o("c", "cccccccc", { collection: W, summary: "a" });
  const r = plan(await input([c1, c2], [file("_caldav/aaaaaaaa.md", await fmOf(old)), file("_caldav/bbbbbbbb.md", await fmOf(c1)), file("_caldav/cccccccc.md", await fmOf(c2))], { tombstones: [tomb("a", "aaaaaaaa")] }));
  expect(r).toHaveLength(1);
  const u = r[0] as Extract<ProjAction, { op: "update" }>;
  expect(u.set._sync).toBe("rejected");
  expect(u.set._sync_msg).toContain("bbbbbbbb");
  expect(u.set._sync_msg).toContain("cccccccc");
});

test("collision-stable", async () => {
  const a = o("a", "samesame"), b = o("b", "samesame");
  const r1 = plan(await input([a, b], []));
  const paths = r1.map((x) => (x as Extract<ProjAction, { op: "create" }>).path);
  expect(new Set(paths).size).toBe(2);
  expect(paths).toContain("_caldav/samesame.md");
  const r1b = plan(await input([b, a], []));
  expect(r1b.map((x) => (x as Extract<ProjAction, { op: "create" }>).path).sort()).toEqual([...paths].sort());
  const files = await Promise.all(r1.map(async (x) => { const c = x as Extract<ProjAction, { op: "create" }>; return file(c.path, { ...c.fm }); }));
  expect(plan(await input([b, a], files))).toEqual([]);
});

test("foreign-file", async () => {
  expect(plan(await input([], [file("_caldav/foreign.md", { note: 1 }, false)]))).toEqual([
    { op: "update", path: "_caldav/foreign.md", set: { _sync: "rejected", _sync_msg: "不是投影檔" }, unset: [] },
  ]);
  expect(plan(await input([], [file("_caldav/foreign.md", { _sync: "rejected", _sync_msg: "不是投影檔" }, false)]))).toEqual([]);
  expect(plan(await input([], [file("_caldav/empty.md", null)]))).toHaveLength(1);
});

test("whitelist-removed", async () => {
  const a = o("a", "aaaaaaaa"), b = o("b", "bbbbbbbb", { collection: W });
  const r = plan(await input([a, b], [file("_caldav/aaaaaaaa.md", await fmOf(a))], { whitelist: [W] }));
  expect(r).toEqual([
    { op: "update", path: "_caldav/aaaaaaaa.md", set: { _sync: "rejected", _sync_msg: "集合不在投影範圍" }, unset: [] },
    { op: "create", path: "_caldav/bbbbbbbb.md", fm: await projectFields(b) },
  ]);
  const marked = { ...(await fmOf(a)), _sync: "rejected", _sync_msg: "集合不在投影範圍" };
  expect(plan(await input([a], [file("_caldav/aaaaaaaa.md", marked)], { whitelist: [W] }))).toEqual([]);
});

test("rejected-cleared-when-back-in-scope", async () => {
  const a = o("a", "aaaaaaaa");
  const marked = { ...(await fmOf(a)), _sync: "rejected", _sync_msg: "集合不在投影範圍" };
  expect(plan(await input([a], [file("_caldav/aaaaaaaa.md", marked)]))).toEqual([{ op: "update", path: "_caldav/aaaaaaaa.md", set: { _sync: "ok" }, unset: ["_sync_msg"] }]);
});

test("no-tombstone-incomplete-cache-does-not-mark-deleted", async () => {
  const a = o("a", "aaaaaaaa");
  expect(plan(await input([], [file("_caldav/aaaaaaaa.md", await fmOf(a))], { complete: false }))).toEqual([]);
  expect(plan(await input([], [file("_caldav/aaaaaaaa.md", await fmOf(a))], { complete: true }))).toEqual([{ op: "update", path: "_caldav/aaaaaaaa.md", set: { _deleted: true }, unset: [] }]);
});

test("moved-to-out-of-scope-collection: no rename, marked out of scope, stable", async () => {
  const old = o("a", "aaaaaaaa"), moved = o("b", "bbbbbbbb", { collection: W, summary: "a" });
  const i = await input([moved], [file("_caldav/aaaaaaaa.md", await fmOf(old), false)], { tombstones: [tomb("a", "aaaaaaaa")], whitelist: [T] });
  expect(plan(i)).toEqual([{ op: "update", path: "_caldav/aaaaaaaa.md", set: { _sync: "rejected", _sync_msg: "集合不在投影範圍" }, unset: [] }]);
  const marked = { ...(await fmOf(old)), _sync: "rejected", _sync_msg: "集合不在投影範圍" };
  expect(plan({ ...i, files: [file("_caldav/aaaaaaaa.md", marked, false)] })).toEqual([]);
});

const pend = (uid: string, state: PendingUpdate["state"], extra: Partial<PendingUpdate> = {}): PendingUpdate => ({
  op: "update", uid: `upd:${T}${uid}.ics`, objUid: uid, shortId: "x", fingerprint: "fp", collection: T, href: `${T}${uid}.ics`,
  baseIcs: "", baseEtag: '"e"', patch: { summary: "我的標題" }, summary: "我的標題", createdAt: 0, attempts: 0, state, ...extra,
});

test("pending-keeps-mine", async () => {
  const a = o("a", "aaaaaaaa", { summary: "伺服器新標題", etag: '"e2"' });
  const mine = { ...(await fmOf(o("a", "aaaaaaaa"))), title: "我的標題" };
  const r = plan(await input([a], [file("_caldav/aaaaaaaa.md", mine)], { pending: new Map([["a", pend("a", "queued")]]) }));
  for (const x of r) {
    const u = x as Extract<ProjAction, { op: "update" }>;
    expect(u.set).not.toHaveProperty("title");
    expect(u.set).not.toHaveProperty("aliases");
    expect(u.set).not.toHaveProperty("_hash");
  }
});

test("pending-conflict-projects-conflict", async () => {
  const a = o("a", "aaaaaaaa", { summary: "伺服器標題" });
  const p = pend("a", "conflict", { conflict: { serverIcs: "", serverEtag: '"e"', base: { summary: "原", status: "" }, mine: { summary: "我的標題", status: "" }, server: { summary: "伺服器標題", status: "" } } });
  const r = plan(await input([a], [file("_caldav/aaaaaaaa.md", { ...(await fmOf(a)), title: "我的標題" })], { pending: new Map([["a", p]]) }));
  const u = r[0] as Extract<ProjAction, { op: "update" }>;
  expect(u.set).toMatchObject({ title: "伺服器標題", _sync: "conflict", _conflict: { title: { mine: "我的標題", theirs: "伺服器標題" } } });
});

test("pending-failed-projects-rejected", async () => {
  const a = o("a", "aaaaaaaa");
  const r = plan(await input([a], [file("_caldav/aaaaaaaa.md", { ...(await fmOf(a)), title: "我的標題" })], { pending: new Map([["a", pend("a", "failed", { lastError: "HTTP 403" })]]) }));
  expect((r[0] as Extract<ProjAction, { op: "update" }>).set).toMatchObject({ title: "a", _sync: "rejected", _sync_msg: "HTTP 403" });
});

test("conflict-cleared-after-resolution", async () => {
  const a = o("a", "aaaaaaaa");
  const p = pend("a", "queued");
  const r = plan(await input([a], [file("_caldav/aaaaaaaa.md", { ...(await fmOf(a)), _sync: "conflict", _conflict: { title: { mine: "x", theirs: "a" } } })], { pending: new Map([["a", p]]) }));
  expect(r).toEqual([{ op: "update", path: "_caldav/aaaaaaaa.md", set: { _sync: "ok" }, unset: ["_conflict"] }]);
});

test("duplicate-uid-file-marked-rejected", async () => {
  const a = o("a", "aaaaaaaa");
  const r = plan(await input([a], [file("_caldav/aaaaaaaa.md", await fmOf(a)), file("_caldav/copy.md", await fmOf(a), false)]));
  expect(r).toEqual([{ op: "update", path: "_caldav/copy.md", set: { _sync: "rejected", _sync_msg: "重複的投影檔（與 _caldav/aaaaaaaa.md 相同 _uid）" }, unset: [] }]);
  const k = plan(await input([a], [file("_caldav/aaaaaaaa.md", await fmOf(a)), file("_caldav/0new.md", await fmOf(a))], { known: new Set(["_caldav/aaaaaaaa.md"]) }));
  expect(k).toEqual([{ op: "update", path: "_caldav/0new.md", set: { _sync: "rejected", _sync_msg: "重複的投影檔（與 _caldav/aaaaaaaa.md 相同 _uid）" }, unset: [] }]);
});

test("upstream-rejection-persists", async () => {
  const a = o("a", "aaaaaaaa");
  const rejected = { ...(await fmOf(a)), _sync: "rejected", _sync_msg: "重複任務的完成請在提醒事項操作" };
  expect(plan(await input([a], [file("_caldav/aaaaaaaa.md", rejected)]))).toEqual([]);
});

test("livesync-conflict-marker-persists", async () => {
  const a = o("a", "aaaaaaaa");
  const marked = { ...(await fmOf(a)), _sync: "conflict", _conflict: { title: { mine: "裝置版", theirs: "a" } } };
  expect(plan(await input([a], [file("_caldav/aaaaaaaa.md", marked)]))).toEqual([]);
});

test("never-delete", () => {
  for (const r of all) for (const a of r) expect(["create", "update", "rename", "merge-into"]).toContain(a.op);
});
