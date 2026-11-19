// T5 probe：驗證 requestUrl 能否承載插件依賴的 CalDAV 協定（尤其在 iOS 上）。
// 只對 test collection 寫入，結束前刪除探測物件。之後會被正式架構取代。
import { App, Modal, Notice, Platform, Plugin, PluginSettingTab, Setting, apiVersion, requestUrl } from "obsidian";

interface Settings {
  serverUrl: string; // e.g. https://host:8448
  username: string;
  testCollection: string; // 相對於 calendar-home 的名稱
}
const DEFAULTS: Settings = { serverUrl: "", username: "", testCollection: "test" };
const SECRET_ID = "obsidian-caldav-password";

interface Row { step: string; ok: boolean; detail: string }

function b64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin);
}

function header(h: Record<string, string>, name: string): [string | undefined, string | undefined] {
  const key = Object.keys(h).find((k) => k.toLowerCase() === name.toLowerCase());
  return [key, key ? h[key] : undefined];
}

function firstTag(xml: string, local: string): string | undefined {
  const m = xml.match(new RegExp(`<(?:[A-Za-z0-9]+:)?${local}[^>]*>([\\s\\S]*?)</(?:[A-Za-z0-9]+:)?${local}>`));
  return m?.[1].trim();
}

export default class CalDavPlugin extends Plugin {
  settings: Settings = DEFAULTS;

  async onload() {
    this.settings = Object.assign({}, DEFAULTS, await this.loadData());
    this.addSettingTab(new CalDavSettingTab(this.app, this));
    this.addCommand({ id: "t5-probe", name: "T5：執行 CalDAV 連線探測", callback: () => this.runProbe() });
  }

  async saveSettings() { await this.saveData(this.settings); }

  async runProbe() {
    const rows: Row[] = [];
    const add = (step: string, ok: boolean, detail: string) => rows.push({ step, ok, detail });
    const env = `apiVersion=${apiVersion} iOS=${Platform.isIosApp} android=${Platform.isAndroidApp} mobile=${Platform.isMobile}`;
    const hasSecret = typeof (this.app as any).secretStorage?.getSecret === "function";
    add("環境", true, env);
    add("secretStorage 存在", hasSecret, String(hasSecret));
    const pw = hasSecret ? this.app.secretStorage.getSecret(SECRET_ID) : null;
    const { serverUrl, username, testCollection } = this.settings;
    if (!serverUrl || !username || !pw) {
      add("設定", false, "請先在設定頁填 server URL、使用者名稱與密碼");
      new ResultModal(this.app, rows).open();
      return;
    }
    const base = serverUrl.replace(/\/+$/, "");
    const auth = "Basic " + b64(`${username}:${pw}`);
    const req = async (method: string, url: string, body?: string, headers: Record<string, string> = {}) => {
      const t0 = Date.now();
      const r = await requestUrl({
        url: url.startsWith("http") ? url : base + url,
        method,
        body,
        headers: { Authorization: auth, ...(body ? { "Content-Type": method === "PUT" ? "text/calendar; charset=utf-8" : "application/xml; charset=utf-8" } : {}), ...headers },
        throw: false,
      });
      return { r, ms: Date.now() - t0 };
    };
    const propfind = (props: string) => `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop>${props}</d:prop></d:propfind>`;

    try {
      // 1. well-known 轉址：GET 與 PROPFIND 各自是否被跟隨
      let { r, ms } = await req("GET", "/.well-known/caldav");
      add("GET /.well-known/caldav", r.status < 400, `status=${r.status} location=${header(r.headers, "location")[1] ?? "-"} (${ms}ms；200/207 表示有跟隨轉址，301 表示沒跟隨)`);
      ({ r, ms } = await req("PROPFIND", "/.well-known/caldav", propfind("<d:current-user-principal/>"), { Depth: "0" }));
      add("PROPFIND /.well-known/caldav", r.status < 400, `status=${r.status} location=${header(r.headers, "location")[1] ?? "-"} (${ms}ms)`);

      // 2. 探索 principal → calendar-home-set → collections
      ({ r, ms } = await req("PROPFIND", "/", propfind("<d:current-user-principal/>"), { Depth: "0" }));
      const principal = firstTag(firstTag(r.text, "current-user-principal") ?? "", "href");
      add("current-user-principal", r.status === 207 && !!principal, `status=${r.status} href=${principal} bodyType=${typeof r.text} len=${r.text.length}`);
      ({ r, ms } = await req("PROPFIND", principal ?? `/${username}/`, propfind("<c:calendar-home-set/>"), { Depth: "0" }));
      const home = firstTag(firstTag(r.text, "calendar-home-set") ?? "", "href");
      add("calendar-home-set", r.status === 207 && !!home, `status=${r.status} href=${home}`);
      ({ r, ms } = await req("PROPFIND", home ?? `/${username}/`, propfind("<d:resourcetype/><d:displayname/><d:sync-token/>"), { Depth: "1" }));
      const names = [...r.text.matchAll(/<(?:[A-Za-z0-9]+:)?displayname>([^<]*)</g)].map((m) => m[1]);
      add("列出 collections", r.status === 207, `status=${r.status} displaynames=${names.join(",")} (${ms}ms)`);

      // 3. sync-collection（空 token = 初始同步）
      const coll = `${(home ?? `/${username}/`).replace(/\/?$/, "/")}${testCollection}/`;
      ({ r, ms } = await req("REPORT", coll, `<?xml version="1.0" encoding="utf-8"?><d:sync-collection xmlns:d="DAV:"><d:sync-token/><d:sync-level>1</d:sync-level><d:prop><d:getetag/></d:prop></d:sync-collection>`, { Depth: "1" }));
      const token = firstTag(r.text, "sync-token");
      const count = (r.text.match(/<(?:[A-Za-z0-9]+:)?response>/g) ?? []).length;
      add("REPORT sync-collection", r.status === 207 && !!token, `status=${r.status} items=${count} token=${token?.slice(-12)} (${ms}ms)`);

      // 4. 寫入路徑：建立 → 錯 ETag 得 412 → 正確 ETag 更新 → 刪除
      const uid = `t5-probe-${Date.now()}`;
      const href = `${coll}${uid}.ics`;
      const ics = (summary: string) => ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//obsidian-caldav//T5//EN", "BEGIN:VTODO", `UID:${uid}`, "DTSTAMP:20261119T000000Z", `SUMMARY:${summary}`, "END:VTODO", "END:VCALENDAR", ""].join("\r\n");
      ({ r, ms } = await req("PUT", href, ics("T5 探測"), { "If-None-Match": "*" }));
      const [etagKey, etag] = header(r.headers, "etag");
      add("PUT 新建 (If-None-Match:*)", r.status === 201, `status=${r.status} etag 鍵名=${etagKey} 值=${etag?.slice(0, 14)}…`);
      ({ r, ms } = await req("PUT", href, ics("T5 不該寫入"), { "If-Match": '"bogus"' }));
      add("PUT 錯 ETag → 412", r.status === 412, `status=${r.status}（throw:false 下可讀到）`);
      ({ r, ms } = await req("PUT", href, ics("T5 已更新"), { "If-Match": etag ?? "" }));
      const [, etag2] = header(r.headers, "etag");
      add("PUT 正確 ETag", r.status >= 200 && r.status < 300, `status=${r.status} 新 etag=${etag2?.slice(0, 14)}… 不同於舊=${etag2 !== etag}`);
      ({ r, ms } = await req("REPORT", coll, `<?xml version="1.0" encoding="utf-8"?><d:sync-collection xmlns:d="DAV:"><d:sync-token>${token}</d:sync-token><d:sync-level>1</d:sync-level><d:prop><d:getetag/></d:prop></d:sync-collection>`, { Depth: "1" }));
      add("REPORT 增量（舊 token）", r.status === 207 && r.text.includes(uid), `status=${r.status} 包含探測物件=${r.text.includes(uid)}`);
      ({ r, ms } = await req("DELETE", href, undefined, { "If-Match": etag2 ?? "" }));
      add("DELETE 探測物件", r.status >= 200 && r.status < 300, `status=${r.status}`);
    } catch (e) {
      add("例外", false, String(e instanceof Error ? `${e.name}: ${e.message}` : e));
    }
    console.log("[obsidian-caldav] T5", rows);
    new ResultModal(this.app, rows).open();
  }
}

class ResultModal extends Modal {
  constructor(app: App, private rows: Row[]) { super(app); }
  onOpen() {
    const { contentEl } = this;
    const pass = this.rows.filter((r) => r.ok).length;
    contentEl.createEl("h3", { text: `T5 結果：${pass}/${this.rows.length} 通過` });
    for (const r of this.rows) {
      const p = contentEl.createEl("p");
      p.createEl("strong", { text: `${r.ok ? "✅" : "❌"} ${r.step}` });
      p.createEl("br");
      p.createSpan({ text: r.detail });
      p.style.userSelect = "text";
    }
    new Setting(contentEl).addButton((b) => b.setButtonText("複製結果").onClick(async () => {
      await navigator.clipboard.writeText(this.rows.map((r) => `${r.ok ? "OK" : "NG"} ${r.step}: ${r.detail}`).join("\n"));
      new Notice("已複製");
    }));
  }
  onClose() { this.contentEl.empty(); }
}

class CalDavSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: CalDavPlugin) { super(app, plugin); }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl).setName("Server URL").setDesc("例如 https://host:8448（不含路徑）")
      .addText((t) => t.setValue(this.plugin.settings.serverUrl).onChange(async (v) => { this.plugin.settings.serverUrl = v.trim(); await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("使用者名稱")
      .addText((t) => t.setValue(this.plugin.settings.username).onChange(async (v) => { this.plugin.settings.username = v.trim(); await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("密碼").setDesc("存在本機 SecretStorage，不寫入 vault、不同步")
      .addText((t) => {
        t.inputEl.type = "password";
        t.setPlaceholder(this.app.secretStorage?.getSecret(SECRET_ID) ? "（已設定）" : "");
        t.onChange((v) => { if (v) this.app.secretStorage.setSecret(SECRET_ID, v); });
      });
    new Setting(containerEl).setName("測試 collection").setDesc("calendar-home 底下的名稱")
      .addText((t) => t.setValue(this.plugin.settings.testCollection).onChange(async (v) => { this.plugin.settings.testCollection = v.trim(); await this.plugin.saveSettings(); }));
  }
}
