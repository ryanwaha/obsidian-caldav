import type { Alias, CalObject, CollectionInfo, Tombstone } from "../types";

/**
 * 搬移比對（T4）：iOS 搬清單 = 舊集合 DELETE + 新集合 PUT 新 UID，CREATED 與 SUMMARY 原樣保留。
 * 兩邊都要有 CREATED；undefined 對 undefined 不算證據。
 */
export function moveCandidates(t: Tombstone, objs: Iterable<CalObject>): CalObject[] {
  if (!t.created) return [];
  const out: CalObject[] = [];
  for (const o of objs) {
    if (o.collection === t.collection || o.uid === t.uid) continue;
    if (t.kind && o.kind !== t.kind) continue;
    if (o.created !== t.created || o.summary !== t.summary) continue;
    out.push(o);
  }
  return out;
}

/** 對還沒有 alias 的 tombstone 比對；恰好一筆候選才建立。舊 UID 仍存在（保留 UID 的搬移）就不需要 alias。 */
export function detectAliases(tombs: Tombstone[], objs: CalObject[], aliases: Alias[], now: number): Alias[] {
  const known = new Set(aliases.map((a) => a.fromUid));
  const live = new Set(objs.map((o) => o.uid));
  const out: Alias[] = [];
  for (const t of tombs) {
    if (known.has(t.uid) || live.has(t.uid)) continue;
    const c = moveCandidates(t, objs);
    if (c.length !== 1) continue;
    known.add(t.uid);
    out.push({ fromUid: t.uid, fromShortId: t.shortId, toUid: c[0].uid, toShortId: c[0].shortId, detectedAt: now });
  }
  return out;
}

export type Resolution =
  | { kind: "moved"; obj: CalObject; from: Tombstone }
  | { kind: "ambiguous"; candidates: CalObject[]; from: Tombstone }
  | { kind: "maybe"; from: Tombstone }
  | { kind: "deleted"; from: Tombstone };

const MAX_HOPS = 5;

/** 渲染時解析「已刪除」的短 ID：沿 alias 鏈找，找不到再即時比對，最後判斷是否還有集合沒同步完。 */
export class MoveResolver {
  private byUid = new Map<string, CalObject[]>();
  private tombByUid = new Map<string, Tombstone>();
  private alias = new Map<string, Alias>();

  constructor(private objs: CalObject[], tombs: Tombstone[], aliases: Alias[], private collections: CollectionInfo[]) {
    for (const o of objs) this.byUid.set(o.uid, [...(this.byUid.get(o.uid) ?? []), o]);
    for (const t of tombs) this.tombByUid.set(t.uid, t);
    for (const a of aliases) this.alias.set(a.fromUid, a);
  }

  resolve(tombs: Tombstone[]): Resolution {
    const from = tombs.reduce((a, b) => (b.deletedAt > a.deletedAt ? b : a));
    return this.follow(from, from, new Set());
  }

  private follow(origin: Tombstone, t: Tombstone, seen: Set<string>): Resolution {
    seen.add(t.uid);
    const a = this.alias.get(t.uid);
    if (a && seen.size <= MAX_HOPS && !seen.has(a.toUid)) {
      const live = this.byUid.get(a.toUid) ?? [];
      if (live.length === 1) return { kind: "moved", obj: live[0], from: origin };
      if (live.length > 1) return { kind: "ambiguous", candidates: live, from: origin };
      const next = this.tombByUid.get(a.toUid);
      if (next) return this.follow(origin, next, seen);
    }
    const c = moveCandidates(t, this.objs);
    if (c.length === 1) return { kind: "moved", obj: c[0], from: origin };
    if (c.length > 1) return { kind: "ambiguous", candidates: c, from: origin };
    return this.lagging(t) ? { kind: "maybe", from: origin } : { kind: "deleted", from: origin };
  }

  /** 還有相關集合（可能收到搬過去的物件）在這筆刪除之後沒有同步完。 */
  private lagging(t: Tombstone): boolean {
    return this.collections.some((c) =>
      c.href !== t.collection
      && (!t.kind || c.components.includes(t.kind))
      && (c.lastSyncAt === undefined || c.lastSyncAt < t.deletedAt));
  }
}
