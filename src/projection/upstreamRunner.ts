import { type App, type EventRef, parseYaml, TFile } from "obsidian";
import type { Session } from "../session";
import { splitFrontmatter } from "./frontmatter";
import { PROJ_DIR } from "./types";
import { processUpstream } from "./upstreamCore";
import type { ProjectionWriter } from "./writer";

const DEBOUNCE_MS = 1000; // S3：單次編輯只有一組 modify＋changed；1 s 合併連續修改

/** 伺服器模式：投影檔被修改 → 三方比對 → 寫回 CalDAV（設計 §8.2）。邏輯在 upstreamCore。 */
export class UpstreamRunner {
  private timers = new Map<string, number>();
  private chain: Promise<void> = Promise.resolve();

  constructor(private app: App, private getSession: () => Promise<Session | undefined>, private writer: ProjectionWriter, private syncSoon: () => void) {}

  start(register: (r: EventRef) => void): void {
    register(this.app.metadataCache.on("changed", (f) => {
      if (f.parent?.path === PROJ_DIR && f.extension === "md") this.schedule(f.path);
    }));
  }

  schedule(path: string): void {
    window.clearTimeout(this.timers.get(path));
    this.timers.set(path, window.setTimeout(() => {
      this.timers.delete(path);
      this.chain = this.chain.then(() => this.process(path)).catch((e) => console.warn("[obsidian-caldav] 上行失敗", path, e));
    }, DEBOUNCE_MS));
  }

  private async process(path: string): Promise<void> {
    const session = await this.getSession();
    const f = this.app.vault.getAbstractFileByPath(path);
    if (!session || !(f instanceof TFile)) return;
    const { fm, body } = splitFrontmatter(await this.app.vault.read(f), parseYaml);
    if (!fm) return;
    const { cache, engine } = session;
    await processUpstream(path, fm, body, {
      cache, now: () => new Date(),
      move: (h, dest) => engine.client.move(h, dest),
      del: (h, etag) => engine.client.delete(h, etag),
      refresh: (h, c) => engine.refreshObject(h, c),
      writeFm: (p, set, unset) => this.writer.writeFmOnly(p, set, unset),
      syncSoon: this.syncSoon,
    });
  }
}
