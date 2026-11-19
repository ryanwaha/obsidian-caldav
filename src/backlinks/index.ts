import { scanRefs } from "./scan";

/** 反向索引：短 ID → 參照它的筆記。只在記憶體裡，由掃描 vault 衍生（§4.1）。 */
export class BacklinkIndex {
  private byFile = new Map<string, string[]>();
  private byId = new Map<string, Set<string>>();
  private listeners = new Set<() => void>();

  /** 回傳對應是否改變。 */
  setFile(path: string, text: string): boolean {
    const ids = [...new Set(scanRefs(text).map((r) => r.id))].sort();
    const old = this.byFile.get(path) ?? [];
    if (old.length === ids.length && old.every((x, i) => x === ids[i])) return false;
    this.drop(path, old);
    if (ids.length) {
      this.byFile.set(path, ids);
      for (const id of ids) (this.byId.get(id) ?? this.byId.set(id, new Set()).get(id)!).add(path);
    }
    this.emit();
    return true;
  }

  removeFile(path: string): void {
    const old = this.byFile.get(path);
    if (!old) return;
    this.drop(path, old);
    this.emit();
  }

  rename(from: string, to: string): void {
    const ids = this.byFile.get(from);
    if (!ids) return;
    this.drop(from, ids);
    const existing = this.byFile.get(to);
    if (existing) this.drop(to, existing);
    this.byFile.set(to, ids);
    for (const id of ids) (this.byId.get(id) ?? this.byId.set(id, new Set()).get(id)!).add(to);
    this.emit();
  }

  /** 資料夾改名：底下所有已索引的檔案一起改路徑。 */
  renameFolder(from: string, to: string): void {
    for (const path of [...this.byFile.keys()]) if (path.startsWith(`${from}/`)) this.rename(path, to + path.slice(from.length));
  }

  removeFolder(path: string): void {
    for (const p of [...this.byFile.keys()]) if (p.startsWith(`${path}/`)) this.removeFile(p);
  }

  notesFor(id: string): string[] { return [...(this.byId.get(id.toLowerCase()) ?? [])].sort(); }
  referencedIds(): Iterable<string> { return this.byId.keys(); }
  clear(): void { this.byFile.clear(); this.byId.clear(); this.emit(); }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private drop(path: string, ids: string[]) {
    this.byFile.delete(path);
    for (const id of ids) {
      const s = this.byId.get(id);
      s?.delete(path);
      if (s && !s.size) this.byId.delete(id);
    }
  }

  private emit() { for (const fn of [...this.listeners]) { try { fn(); } catch (e) { console.error("[obsidian-caldav] backlink listener", e); } } }
}
