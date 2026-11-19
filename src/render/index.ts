import type { CacheStore } from "../cache/db";
import { MoveResolver, type Resolution } from "../sync/moves";
import { type CalObject, type CollectionInfo, type PendingCreate, type Tombstone, isUpdate } from "../types";
import { type RefView, present } from "./present";

const EMPTY = Object.freeze({
  objs: Object.freeze([]) as unknown as CalObject[],
  tombs: Object.freeze([]) as unknown as Tombstone[],
  pending: Object.freeze([]) as unknown as PendingCreate[],
});
type Entry = { objs: CalObject[]; tombs: Tombstone[]; pending: PendingCreate[]; move?: Resolution };

/** 快取的記憶體副本：渲染時必須同步取得資料（CM6 decoration 不能等 IndexedDB）。 */
export class MemoryIndex {
  private objs = new Map<string, CalObject[]>();
  private tombs = new Map<string, Tombstone[]>();
  private pending = new Map<string, PendingCreate[]>();
  private resolver = new MoveResolver([], [], [], []);
  private moves = new Map<string, Resolution>();
  private collections = new Map<string, CollectionInfo>();
  private listeners = new Set<() => void>();
  private _version = 0;

  get version(): number { return this._version; }

  async load(cache: CacheStore | undefined): Promise<void> {
    const objs = new Map<string, CalObject[]>();
    const tombs = new Map<string, Tombstone[]>();
    const pending = new Map<string, PendingCreate[]>();
    let resolver = new MoveResolver([], [], [], []);
    let collections: CollectionInfo[] = [];
    if (cache) {
      const [os, ts, ps, as, cs] = await Promise.all([cache.allObjects(), cache.allTombstones(), cache.allPending(), cache.allAliases(), cache.getCollections()]);
      resolver = new MoveResolver(os, ts, as, cs);
      collections = cs;
      for (const o of os) objs.set(o.shortId, [...(objs.get(o.shortId) ?? []), o]);
      for (const t of ts) tombs.set(t.shortId, [...(tombs.get(t.shortId) ?? []), t]);
      for (const p of ps) if (!isUpdate(p)) pending.set(p.shortId, [...(pending.get(p.shortId) ?? []), p]);
    }
    this.objs = objs;
    this.tombs = tombs;
    this.pending = pending;
    this.resolver = resolver;
    this.moves = new Map();
    this.collections = new Map(collections.map((c) => [c.href, c]));
    this.touch();
  }

  /** 資料不變、只要求重繪（例如跨日後「今天／明天」要更新）。 */
  touch(): void {
    this._version++;
    for (const fn of [...this.listeners]) {
      try { fn(); } catch (e) { console.error("[obsidian-caldav] index listener", e); }
    }
  }

  get(id: string): Entry {
    const k = id.toLowerCase();
    const objs = this.objs.get(k), tombs = this.tombs.get(k), pending = this.pending.get(k);
    if (!objs && !tombs && !pending) return EMPTY;
    const e: Entry = { objs: objs ?? [], tombs: tombs ?? [], pending: pending ?? [] };
    if (!objs && !pending && tombs) {
      let m = this.moves.get(k);
      if (!m) { m = this.resolver.resolve(tombs); this.moves.set(k, m); }
      e.move = m;
    }
    return e;
  }

  /** 渲染器用：短 ID → RefView（含搬移解析）。 */
  view(id: string, label: string, now: Date): RefView {
    const { objs, tombs, pending, move } = this.get(id);
    return present(id.toLowerCase(), label, objs, tombs, now, pending, move);
  }

  collectionName(href: string): string { return this.collections.get(href)?.displayName ?? href; }

  /** 供選取指令列出所有物件。 */
  allObjects(): CalObject[] { return [...this.objs.values()].flat(); }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
