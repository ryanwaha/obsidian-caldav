import type { CacheStore } from "../cache/db";
import type { PendingUpdate } from "../types";
import { enqueuePatch, rehome } from "./enqueue";
import { applySetUnset } from "./snapshot";
import { planUpstream } from "./upstream";
import { WRITABLE_KEYS } from "./types";

export interface UpstreamDeps {
  cache: CacheStore;
  move(href: string, destHref: string): Promise<number>;
  del(href: string, etag: string): Promise<number>;
  refresh(href: string, collection: string): Promise<void>;
  /** 寫 frontmatter（set/unset）；快照由這裡另外存，寫入函式不得重讀檔案 */
  writeFm(path: string, set: Record<string, unknown>, unset: string[]): Promise<void>;
  syncSoon(): void;
  now(): Date;
}

const ok = (st: number) => st >= 200 && st < 300;

/**
 * 上行的核心（設計 §8.2），與 Obsidian 無關以便測試。
 * fm/body 是這一次處理讀到的檔案內容；新的快照只由它與伺服器寫回的 set/unset 推導（review C1）。
 */
export async function processUpstream(path: string, fm: Record<string, unknown>, body: string, d: UpstreamDeps): Promise<void> {
  const { cache } = d;
  const snap = await cache.getProjection(path);
  if (typeof fm._uid !== "string") return;
  if (!snap) {
    // 同一個 uid 在別處已有快照 → 這是改名或複製出來的檔，交給 guard／對帳處理，不當成新的 base（review I4）
    if ((await cache.projectionsByUid(fm._uid)).length) return;
    await cache.putProjection({ path, uid: fm._uid, fm: applySetUnset(fm, {}, []), body, writtenAt: Date.now() });
    return;
  }
  const obj = (await cache.allObjects()).find((o) => o.uid === snap.uid); // review I7：用快照的 uid
  const { result, rollbackSystemKeys } = planUpstream({ mine: fm, base: snap.fm, bodyChanged: body !== snap.body, obj, collections: await cache.getCollections() });

  const set: Record<string, unknown> = {};
  const unset: string[] = [];
  const restore = (k: string) => { if (k in snap.fm) set[k] = snap.fm[k]; else unset.push(k); };
  for (const k of rollbackSystemKeys) restore(k);
  const restoreWritable = () => { for (const k of WRITABLE_KEYS) if (String(fm[k] ?? "") !== String(snap.fm[k] ?? "")) restore(k); };
  const reject = (message: string) => { restoreWritable(); set._sync = "rejected"; set._sync_msg = message; };
  /** 這次被接受的可寫值：成為新快照 */
  const accepted: Record<string, unknown> = {};

  switch (result.kind) {
    case "none":
    case "body-only":
      break;
    case "send": {
      let target = obj!;
      let moveFailed: string | undefined;
      try {
        if (result.move) {
          const name = target.href.split("/").pop()!;
          const st = await d.move(target.href, `${result.move}${name}`);
          if (ok(st)) target = await rehome(cache, target, `${result.move}${name}`, result.move);
          else moveFailed = `搬移清單失敗（HTTP ${st}）`;
        }
        if (Object.keys(result.patch).length) await enqueuePatch(cache, target, result.patch, d.now());
      } catch (e) {
        reject(e instanceof Error ? e.message : String(e));
        break;
      }
      for (const k of WRITABLE_KEYS) {
        if (k === "list" && moveFailed) continue;
        if (k in fm) accepted[k] = fm[k]; else accepted[k] = undefined;
      }
      if (moveFailed) { restore("list"); set._sync = "rejected"; set._sync_msg = moveFailed; }
      else if (fm._sync === "rejected" || fm._sync === "conflict") { set._sync = "ok"; unset.push("_sync_msg", "_conflict"); }
      d.syncSoon();
      break;
    }
    case "reject":
      reject(result.message);
      break;
    case "request": {
      unset.push("_request");
      restoreWritable(); // 同一次修改裡的可寫欄位不送出，也不能被吸收
      if (result.request === "delete") {
        if (!obj || !obj.etag) { set._sync = "rejected"; set._sync_msg = obj ? "尚未同步完成，稍後再刪除" : "任務已刪除"; break; }
        const st = await d.del(obj.href, obj.etag);
        if (ok(st)) d.syncSoon();
        else { set._sync = "rejected"; set._sync_msg = st === 412 ? "伺服器上的版本已變更，請重新確認後再刪除" : `刪除失敗（HTTP ${st}）`; }
      } else {
        const p = obj && ((await cache.getPending(`upd:${obj.href}`)) as PendingUpdate | undefined);
        if (p && p.state === "conflict") await cache.removePending(p.uid);
        if (obj) await d.refresh(obj.href, obj.collection).catch(() => {});
        set._sync = "ok"; unset.push("_conflict", "_sync_msg");
        d.syncSoon();
      }
      break;
    }
  }
  const baseFm = { ...snap.fm };
  for (const [k, v] of Object.entries(accepted)) { if (v === undefined) delete baseFm[k]; else baseFm[k] = v; }
  const nextFm = applySetUnset(baseFm, set, unset);
  if (Object.keys(set).length || unset.length) await d.writeFm(path, set, unset);
  await cache.putProjection({ path, uid: snap.uid, fm: nextFm, body, writtenAt: Date.now() });
}
