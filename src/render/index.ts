import type { CacheStore } from "../cache/db";
import { type CalObject, type PendingCreate, type Tombstone, isUpdate } from "../types";

const EMPTY = Object.freeze({
  objs: Object.freeze([]) as unknown as CalObject[],
  tombs: Object.freeze([]) as unknown as Tombstone[],
  pending: Object.freeze([]) as unknown as PendingCreate[],
});
type Entry = { objs: CalObject[]; tombs: Tombstone[]; pending: PendingCreate[] };

/** 快取的記憶體副本：渲染時必須同步取得資料（CM6 decoration 不能等 IndexedDB）。 */
export class MemoryIndex {
  private objs = new Map<string, CalObject[]>();
  private tombs = new Map<string, Tombstone[]>();
  private pending = new Map<string, PendingCreate[]>();
  private listeners = new Set<() => void>();
  private _version = 0;

  get version(): number { return this._version; }

  async load(cache: CacheStore | undefined): Promise<void> {
    const objs = new Map<string, CalObject[]>();
    const tombs = new Map<string, Tombstone[]>();
    const pending = new Map<string, PendingCreate[]>();
    if (cache) {
      const [os, ts, ps] = await Promise.all([cache.allObjects(), cache.allTombstones(), cache.allPending()]);
      for (const o of os) objs.set(o.shortId, [...(objs.get(o.shortId) ?? []), o]);
      for (const t of ts) tombs.set(t.shortId, [...(tombs.get(t.shortId) ?? []), t]);
      for (const p of ps) if (!isUpdate(p)) pending.set(p.shortId, [...(pending.get(p.shortId) ?? []), p]);
    }
    this.objs = objs;
    this.tombs = tombs;
    this.pending = pending;
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
    return objs || tombs || pending ? { objs: objs ?? [], tombs: tombs ?? [], pending: pending ?? [] } : EMPTY;
  }

  /** 供選取指令列出所有物件。 */
  allObjects(): CalObject[] { return [...this.objs.values()].flat(); }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
