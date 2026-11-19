import type { CacheStore } from "../cache/db";
import type { CalObject, Tombstone } from "../types";

const EMPTY = { objs: [] as CalObject[], tombs: [] as Tombstone[] };

/** 快取的記憶體副本：渲染時必須同步取得資料（CM6 decoration 不能等 IndexedDB）。 */
export class MemoryIndex {
  private objs = new Map<string, CalObject[]>();
  private tombs = new Map<string, Tombstone[]>();
  private listeners = new Set<() => void>();
  private _version = 0;

  get version(): number { return this._version; }

  async load(cache: CacheStore | undefined): Promise<void> {
    const objs = new Map<string, CalObject[]>();
    const tombs = new Map<string, Tombstone[]>();
    if (cache) {
      const [os, ts] = await Promise.all([cache.allObjects(), cache.allTombstones()]);
      for (const o of os) objs.set(o.shortId, [...(objs.get(o.shortId) ?? []), o]);
      for (const t of ts) tombs.set(t.shortId, [...(tombs.get(t.shortId) ?? []), t]);
    }
    this.objs = objs;
    this.tombs = tombs;
    this._version++;
    for (const fn of [...this.listeners]) {
      try { fn(); } catch (e) { console.error("[obsidian-caldav] index listener", e); }
    }
  }

  get(id: string): { objs: CalObject[]; tombs: Tombstone[] } {
    const k = id.toLowerCase();
    const objs = this.objs.get(k), tombs = this.tombs.get(k);
    return objs || tombs ? { objs: objs ?? [], tombs: tombs ?? [] } : EMPTY;
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
