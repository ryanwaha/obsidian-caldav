import { Plugin, TAbstractFile, TFile } from "obsidian";

declare global { interface Window { __m6log: unknown[] } }
const DIR = "_caldav/";

export default class M6Probe extends Plugin {
  async onload() {
    window.__m6log = [];
    const log = (ev: string, file: TAbstractFile, extra: Record<string, unknown> = {}) => {
      if (!file.path.startsWith(DIR) && !(extra.oldPath as string | undefined)?.startsWith(DIR)) return;
      const fm = file instanceof TFile ? this.app.metadataCache.getFileCache(file)?.frontmatter ?? null : null;
      const rec = { t: Date.now(), ev, path: file.path, fm: fm ? { ...fm } : null, ...extra };
      window.__m6log.push(rec);
      console.log("[m6-probe]", JSON.stringify(rec));
    };
    this.app.workspace.onLayoutReady(() => {
      for (const ev of ["modify", "create", "delete"] as const)
        this.registerEvent(this.app.vault.on(ev as "modify", (f) => log(ev, f)));
      this.registerEvent(this.app.vault.on("rename", (f, oldPath) => log("rename", f, { oldPath })));
      this.registerEvent(this.app.metadataCache.on("changed", (f) => log("changed", f)));
    });
    this.addCommand({ id: "clear-log", name: "Clear log", callback: () => { window.__m6log = []; } });
  }
}
