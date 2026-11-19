import type { CalObject, CollectionInfo, Tombstone } from "../types";

const VERSION = 1;
const STORES = ["meta", "collections", "objects", "tombstones"] as const;
type StoreName = (typeof STORES)[number];

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
}
function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("transaction aborted"));
  });
}

/** 每台裝置一份的衍生快取（設計稿 §4.2）。不放進 vault。 */
export class CacheStore {
  private constructor(private db: IDBDatabase) {}

  /** fingerprint 不同（換了伺服器或帳號）就清空全部再寫入新的。 */
  static async open(name: string, fingerprint: string): Promise<CacheStore> {
    const open = indexedDB.open(name, VERSION);
    open.onupgradeneeded = () => {
      const db = open.result;
      db.createObjectStore("meta");
      db.createObjectStore("collections", { keyPath: "href" });
      const objs = db.createObjectStore("objects", { keyPath: "href" });
      objs.createIndex("shortId", "shortId");
      objs.createIndex("collection", "collection");
      db.createObjectStore("tombstones", { keyPath: "href" }).createIndex("shortId", "shortId");
    };
    const store = new CacheStore(await req(open));
    const tx = store.db.transaction([...STORES], "readwrite");
    const meta = tx.objectStore("meta");
    const current = await req(meta.get("fingerprint"));
    if (current !== fingerprint) {
      for (const s of STORES) tx.objectStore(s).clear();
      meta.put(fingerprint, "fingerprint");
    }
    await done(tx);
    return store;
  }

  private async readAll<T>(store: StoreName, index?: string, key?: IDBValidKey): Promise<T[]> {
    const os = this.db.transaction(store).objectStore(store);
    return req((index ? os.index(index) : os).getAll(key) as IDBRequest<T[]>);
  }

  getCollections(): Promise<CollectionInfo[]> { return this.readAll("collections"); }

  async putCollection(c: CollectionInfo): Promise<void> {
    const tx = this.db.transaction("collections", "readwrite");
    tx.objectStore("collections").put(c);
    await done(tx);
  }

  async deleteCollection(href: string): Promise<void> {
    const tx = this.db.transaction("collections", "readwrite");
    tx.objectStore("collections").delete(href);
    await done(tx);
  }

  async upsertObjects(objs: CalObject[]): Promise<void> {
    if (!objs.length) return;
    const tx = this.db.transaction(["objects", "tombstones"], "readwrite");
    for (const o of objs) {
      tx.objectStore("objects").put(o);
      tx.objectStore("tombstones").delete(o.href);
    }
    await done(tx);
  }

  /** 只處理快取裡有的 href；回傳實際刪除的數量。 */
  async removeObjects(hrefs: string[], now: number): Promise<number> {
    if (!hrefs.length) return 0;
    const tx = this.db.transaction(["objects", "tombstones"], "readwrite");
    const objs = tx.objectStore("objects"), tombs = tx.objectStore("tombstones");
    let removed = 0;
    for (const href of hrefs) {
      const o = (await req(objs.get(href))) as CalObject | undefined;
      if (!o) continue;
      const t: Tombstone = { href, uid: o.uid, shortId: o.shortId, collection: o.collection, summary: o.summary, deletedAt: now };
      if (o.created !== undefined) t.created = o.created;
      tombs.put(t);
      objs.delete(href);
      removed++;
    }
    await done(tx);
    return removed;
  }

  async hrefsInCollection(collection: string): Promise<string[]> {
    const os = this.db.transaction("objects").objectStore("objects");
    return (await req(os.index("collection").getAllKeys(collection))) as string[];
  }

  findByShortId(id: string): Promise<CalObject[]> { return this.readAll("objects", "shortId", id); }
  findTombstonesByShortId(id: string): Promise<Tombstone[]> { return this.readAll("tombstones", "shortId", id); }
  allObjects(): Promise<CalObject[]> { return this.readAll("objects"); }
  allTombstones(): Promise<Tombstone[]> { return this.readAll("tombstones"); }
  count(): Promise<number> { return req(this.db.transaction("objects").objectStore("objects").count()); }
  close(): void { this.db.close(); }
}
