import type { CacheStore } from "../cache/db";
import { applyPatch } from "../ical/patch";
import { parseResource } from "../ical/parse";
import type { CalObject, Patch, PendingUpdate } from "../types";

/**
 * 伺服器模式：把投影檔上的修改排入 0.5.0 的待送佇列（同一物件一筆，後來的修改合併）。
 * 先算樂觀版本：§4.3 不允許的修改在這裡丟出例外，不會進佇列。
 * 衝突中又修改：使用者看到的是投影出來的伺服器值，所以以衝突當下的伺服器版本為新基準（同 0.5.0「用我的」）。
 */
export async function enqueuePatch(cache: CacheStore, obj: CalObject, patch: Patch, now: Date): Promise<void> {
  const cur = (await cache.getObject(obj.href)) ?? obj;
  const optimisticIcs = applyPatch(cur.ics, patch, now);
  const key = `upd:${cur.href}`;
  const existing = (await cache.getPending(key)) as PendingUpdate | undefined;
  const op: PendingUpdate = existing
    ? {
      ...existing, patch: { ...existing.patch, ...patch }, summary: patch.summary ?? existing.summary, rev: (existing.rev ?? 0) + 1,
      ...(existing.state === "conflict" && existing.conflict ? { baseIcs: existing.conflict.serverIcs, baseEtag: existing.conflict.serverEtag } : {}),
      state: "queued", conflict: undefined, lastError: undefined,
    }
    : {
      op: "update", uid: key, objUid: cur.uid, shortId: cur.shortId, fingerprint: cache.fingerprint, collection: cur.collection, href: cur.href,
      baseIcs: cur.ics, baseEtag: cur.etag, patch, summary: patch.summary ?? cur.summary, rev: 1, createdAt: now.getTime(), attempts: 0, state: "queued",
    };
  await cache.updatePending(op);
  const optimistic = await parseResource(optimisticIcs, { href: cur.href, etag: cur.etag, collection: cur.collection });
  if (!("skip" in optimistic)) await cache.upsertObjects([optimistic]);
}
