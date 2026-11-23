import { type App, type EventRef, TFile } from "obsidian";
import { parseYaml } from "obsidian";
import type { Session } from "../session";
import { enqueuePatch } from "./enqueue";
import { splitFrontmatter } from "./frontmatter";
import { planUpstream } from "./upstream";
import type { ProjectionWriter } from "./writer";
import { PROJ_DIR, WRITABLE_KEYS } from "./types";

const DEBOUNCE_MS = 1000; // S3：單次編輯只有一組 modify＋changed；1 s 合併連續修改

/** 伺服器模式：投影檔被修改 → 三方比對 → 寫回 CalDAV（設計 §8.2）。 */
export class UpstreamRunner {
  private timers = new Map<string, number>();
  private chain: Promise<void> = Promise.resolve();

  constructor(private app: App, private getSession: () => Promise<Session | undefined>, private writer: ProjectionWriter, private syncSoon: () => void) {}

  start(register: (r: EventRef) => void): void {
    register(this.app.metadataCache.on("changed", (f) => {
      if (f.parent?.path !== PROJ_DIR || f.extension !== "md") return;
      window.clearTimeout(this.timers.get(f.path));
      this.timers.set(f.path, window.setTimeout(() => {
        this.timers.delete(f.path);
        this.chain = this.chain.then(() => this.process(f.path)).catch((e) => console.warn("[obsidian-caldav] 上行失敗", f.path, e));
      }, DEBOUNCE_MS));
    }));
  }

  private async process(path: string): Promise<void> {
    const session = await this.getSession();
    const f = this.app.vault.getAbstractFileByPath(path);
    if (!session || !(f instanceof TFile)) return;
    const { cache, engine } = session;
    const { fm, body } = splitFrontmatter(await this.app.vault.read(f), parseYaml);
    if (!fm || typeof fm._uid !== "string") return;
    const snap = await cache.getProjection(path);
    if (!snap) { await this.writer.snapshot(path); return; }
    const obj = (await cache.allObjects()).find((o) => o.uid === fm._uid);
    const { result, rollbackSystemKeys } = planUpstream({ mine: fm, base: snap.fm, bodyChanged: body !== snap.body, obj, collections: await cache.getCollections() });

    const set: Record<string, unknown> = {};
    const unset: string[] = [];
    const restore = (k: string) => { if (k in snap.fm) set[k] = snap.fm[k]; else unset.push(k); };
    for (const k of rollbackSystemKeys) restore(k);
    const reject = (message: string) => { for (const k of WRITABLE_KEYS) restore(k); set._sync = "rejected"; set._sync_msg = message; };

    switch (result.kind) {
      case "none":
      case "body-only":
        break;
      case "send": {
        try {
          if (Object.keys(result.patch).length) await enqueuePatch(cache, obj!, result.patch, new Date());
          if (result.move) {
            const name = obj!.href.split("/").pop()!;
            const st = await engine.client.move(obj!.href, `${result.move}${name}`);
            if (st < 200 || st >= 300) reject(`搬移清單失敗（HTTP ${st}）`);
          }
          if (set._sync !== "rejected" && (fm._sync === "rejected" || fm._sync === "conflict")) { set._sync = "ok"; unset.push("_sync_msg"); }
          this.syncSoon();
        } catch (e) {
          reject(e instanceof Error ? e.message : String(e));
        }
        break;
      }
      case "reject":
        reject(result.message);
        break;
      case "request": {
        unset.push("_request");
        if (result.request === "delete") {
          if (!obj) { set._sync = "rejected"; set._sync_msg = "任務已刪除"; break; }
          const st = await engine.client.delete(obj.href, obj.etag);
          if (st >= 200 && st < 300) this.syncSoon();
          else { set._sync = "rejected"; set._sync_msg = st === 412 ? "伺服器上的版本已變更，請重新確認後再刪除" : `刪除失敗（HTTP ${st}）`; }
        } else {
          const p = obj && (await cache.getPending(`upd:${obj.href}`));
          if (p) await cache.removePending(p.uid);
          if (obj) await engine.refreshObject(obj.href, obj.collection).catch(() => {});
          set._sync = "ok"; unset.push("_conflict", "_sync_msg");
          this.syncSoon();
        }
        break;
      }
    }
    if (Object.keys(set).length || unset.length) await this.writer.writeFm(path, set, unset);
    else await this.writer.snapshot(path);
  }
}
