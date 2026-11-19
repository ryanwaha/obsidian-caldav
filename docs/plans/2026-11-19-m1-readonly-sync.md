# M1 唯讀同步 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 插件能從 Radicale 把所有清單同步進每台裝置的 IndexedDB 快取（含刪除紀錄），並能用短 ID 查到物件；設定頁顯示同步狀態。

**Architecture:** 分成四層，由下往上：HTTP 層（`requestUrl` 包一層，可替換成假 transport 以便測試），CalDAV client（探索、列清單、sync-collection），解析（ical.js → 正規化的 `CalObject`，原文 ICS 原樣保存），快取（IndexedDB）。同步引擎串起這四層。插件本身只負責設定、觸發與狀態顯示。M1 不寫入伺服器、不碰 .md。

**Tech Stack:** TypeScript 7、esbuild、ical.js、vitest + jsdom（提供 DOMParser）+ fake-indexeddb、Obsidian API（`requestUrl`、`app.secretStorage`）。

**Spec:** `~/docs/homelab/obsidian-caldav.md`（§4.2 快取、§6.2 短 ID、§7.2 元件表、§11.1 T3–T5 結果）

## Global Constraints

- `minAppVersion` 為 `1.11.4`（SecretStorage）。`isDesktopOnly: false`。
- 帳密只存在 `app.secretStorage`，ID 固定為 `obsidian-caldav-password`；不寫進 `data.json`。
- 短 ID：`sha256(UID 的 UTF-8)` 前 40 bits，用 Crockford base32 小寫（字母表 `0123456789abcdefghjkmnpqrstvwxyz`）編成 8 個字元。
- 快取與 .ics 一律不放進 vault（§4.2）。IndexedDB 資料庫名稱為 `obsidian-caldav-<app.appId>`。
- 回應標頭一律不分大小寫讀取（T5：iOS 是 `Etag`，桌面是 `etag`）。
- 帳號探索**不使用** `/.well-known/caldav`，直接對使用者填的 server URL 發 PROPFIND（T5：iOS 跟隨 301 時會丟掉 `Authorization`）。
- 所有請求都用 `throw: false`，由呼叫端自己判斷狀態碼；每個請求有 30 秒逾時（`requestUrl` 不能中途取消，只能放棄等待結果）。
- 原文 ICS 原樣存進快取，不重新序列化（§4.4 寫入保留，M4 會用到）。
- 所有測試都不連真的伺服器；Radicale 的實際回應放在 `fixtures/radicale-3.9.2/`，iOS 的 ICS 放在 `fixtures/ios-27.2/`。

## Review Focus

1. **sync-token 過期**（Radicale 回 `403` 加 `<valid-sync-token/>`）→ 自動改做全量同步。原本快取裡有、但全量結果裡沒出現的物件，要轉成刪除紀錄，而不是一筆都不剩或留下幽靈物件。由 Task 6 測試。
2. **伺服器上的清單被刪掉或改名** → 被刪清單的物件全部轉成刪除紀錄；改名只更新 `displayName`。由 Task 6 測試。
3. **無法解析的資源**（壞掉的 ICS、沒有 UID、VJOURNAL）→ 略過這一筆並記錄原因，其他物件照常同步。由 Task 4 和 Task 6 測試。
4. **iPhone 沒開 Tailscale 或逾時** → 同步失敗，但快取完整保留，狀態顯示錯誤；某一個清單出錯也不影響其他清單。由 Task 6 測試。
5. **改了 server URL 或使用者名稱** → 清空快取重建，避免兩個帳號的資料混在一起。由 Task 5 測試。
6. **同時觸發多次同步**（定時、回到前景、手動）→ 同一時間只跑一次，後到的呼叫直接拿到同一個 Promise。由 Task 6 測試。

---

## 檔案結構

| 檔案 | 職責 |
|---|---|
| `src/shortid.ts` | `shortId(uid)` |
| `src/caldav/http.ts` | `Transport` 型別、`requestUrlTransport()`、`getHeader()`、`basicAuth()` |
| `src/caldav/xml.ts` | 請求 body 產生器、`parseMultistatus()` |
| `src/caldav/client.ts` | `CalDavClient`：`discover()`、`listCollections()`、`syncCollection()` |
| `src/ical/parse.ts` | `parseResource()` → `CalObject` |
| `src/cache/db.ts` | `CacheStore`（IndexedDB） |
| `src/sync/engine.ts` | `SyncEngine.syncAll()` |
| `src/types.ts` | 共用型別：`CalObject`、`DateValue`、`CollectionInfo`、`Tombstone`、`SyncReport` |
| `src/settings.ts` | 設定型別與設定頁 |
| `src/main.ts` | 插件組裝（取代 T5 探測程式） |
| `tests/*.test.ts` | 單元測試 |

## 共用型別（`src/types.ts`，Task 1 建立）

```ts
export interface DateValue { value: string; dateOnly: boolean; tzid?: string }
// value 保持 ICS 原樣：dateOnly 時是 "20261119"，否則是 "20261120T150000"（UTC 則結尾帶 Z）

export interface CalObject {
  href: string; collection: string; etag: string;
  uid: string; shortId: string;
  kind: "VTODO" | "VEVENT";
  summary: string;
  status?: string;        // NEEDS-ACTION / COMPLETED / CANCELLED / IN-PROCESS / CONFIRMED…
  start?: DateValue; due?: DateValue; end?: DateValue;
  completed?: string;     // COMPLETED 的原文
  created?: string;       // CREATED 的原文（M5 搬移比對用）
  rrule?: string;         // RRULE 的原文值
  hasOverrides: boolean;  // 同一資源裡有帶 RECURRENCE-ID 的元件
  ics: string;            // 伺服器回傳的原文，原樣保存
}

export interface CollectionInfo {
  href: string; displayName: string;
  components: ("VTODO" | "VEVENT")[];
  syncToken?: string;     // 上次同步後的 token；undefined 表示還沒同步過
  lastSyncAt?: number;
}

export interface Tombstone {
  href: string; uid: string; shortId: string; collection: string;
  summary: string; created?: string; deletedAt: number;
}

export interface SyncReport {
  startedAt: number; finishedAt: number;
  collections: number; objects: number;
  changed: number; removed: number; skipped: number;
  errors: { collection?: string; message: string }[];
}
```

---

### Task 1: 測試環境、共用型別、短 ID

**Files:**
- Modify: `package.json`（加 `test` script 和 devDependencies：`vitest`、`jsdom`、`fake-indexeddb`；dependencies：`ical.js`）
- Create: `vitest.config.ts`（`environment: "jsdom"`）、`src/types.ts`（照上面的定義）、`src/shortid.ts`、`tests/shortid.test.ts`
- Delete: T5 探測程式在 `src/main.ts` 裡的內容，先換成只有 `onload(){}` 的空殼（Task 7 會補完）

**Interfaces:**
- Produces: `shortId(uid: string): Promise<string>`（用 `crypto.subtle.digest("SHA-256", …)`，Obsidian 和 Node 都有）

- [ ] **Step 1: 寫失敗的測試**

```ts
test.each([
  ["F17BEA7B-D695-4111-B0FC-481F6BD1EC2A", "5cd3cmqd"],
  ["t1-unknown-fields", "7pmqbjh5"],
  ["85483CE1-1395-4CD0-BF87-7B32BA498B32", "x2n6srvv"],
  ["任務-ü", "ezqk3f50"],   // 非 ASCII 必須先轉成 UTF-8
])("shortId(%s) = %s", async (uid, expected) => {
  expect(await shortId(uid)).toBe(expected);
});
test("只用 Crockford 字母表、長度 8", async () => {
  expect(await shortId("x")).toMatch(/^[0-9a-hjkmnp-tv-z]{8}$/);
});
```

- [ ] **Step 2:** `npx vitest run tests/shortid.test.ts`，預期 FAIL（找不到模組）
- [ ] **Step 3:** 實作 `shortId`
- [ ] **Step 4:** 再跑一次，預期 PASS；`npm run build` 也要通過
- [ ] **Step 5:** Commit `feat: short ID and test harness`

---

### Task 2: HTTP 層與 XML

**Files:**
- Create: `src/caldav/http.ts`、`src/caldav/xml.ts`、`tests/xml.test.ts`、`tests/http.test.ts`

**Interfaces:**
- Produces:
  - `type HttpRequest = { method: string; url: string; headers?: Record<string,string>; body?: string }`
  - `type HttpResponse = { status: number; headers: Record<string,string>; text: string }`
  - `type Transport = (req: HttpRequest) => Promise<HttpResponse>`
  - `requestUrlTransport(timeoutMs = 30000): Transport`：包 `requestUrl({ …, throw: false })`；逾時就 reject `new Error("timeout")`
  - `getHeader(h: Record<string,string>, name: string): string | undefined`：不分大小寫
  - `basicAuth(user: string, pass: string): string`：回傳 `"Basic " + base64(UTF-8)`
  - `propfindBody(props: string[]): string`、`syncCollectionBody(token: string | null, withData: boolean): string`。props 用 `"d:displayname"`、`"c:calendar-home-set"` 這種前綴寫法，`d` = `DAV:`，`c` = `urn:ietf:params:xml:ns:caldav`
  - `parseMultistatus(xml: string): Multistatus`，其中：
    ```ts
    interface MsResponse { href: string; status?: number;            // response 層級的 status（sync-collection 刪除時用）
                           props: Map<string, Element>; }            // 只收 propstat 為 200 的 prop；key 為 "{ns}local"
    interface Multistatus { responses: MsResponse[]; syncToken?: string }
    ```
    用 `DOMParser`（`application/xml`）配合 `getElementsByTagNameNS`，不能用 regex。href 要 `decodeURIComponent`

- [ ] **Step 1: 寫失敗的測試**，資料來自 `fixtures/radicale-3.9.2/`：
  - `propfind-principal.xml`：取出 `{DAV:}current-user-principal` 底下的 href，等於 `/ryanw/`
  - `propfind-collections.xml`：共 3 筆 response；`/ryanw/tasks/` 的 displayname 是 `任務`，`supported-calendar-component-set` 有 VTODO 和 VEVENT；`/ryanw/` 的 displayname 不能出現在 props 裡，因為它在 404 的 propstat 中
  - `sync-initial-with-data.xml`：`syncToken` 以 `http://radicale.org/ns/sync/` 開頭；status 200 的 response 帶 `{urn:ietf:params:xml:ns:caldav}calendar-data`，而且 textContent 含 `BEGIN:VCALENDAR`；被刪除的 response 的 `status` 是 404
  - `getHeader({ Etag: '"a"' }, "etag")` 為 `'"a"'`；`basicAuth("ryanw", "密碼")` 解碼回來還是 `ryanw:密碼`
- [ ] **Step 2:** 跑測試，預期 FAIL
- [ ] **Step 3:** 實作
- [ ] **Step 4:** 跑測試，預期 PASS
- [ ] **Step 5:** Commit `feat: http transport and multistatus parser`

---

### Task 3: CalDAV client

**Files:**
- Create: `src/caldav/client.ts`、`tests/client.test.ts`、`tests/fakeTransport.ts`（依 `method + path` 回傳排好的回應，並記錄收到的請求）

**Interfaces:**
- Consumes: Task 2 的全部
- Produces:
  ```ts
  class TokenExpiredError extends Error {}
  class HttpError extends Error { constructor(public status: number, message: string) }
  class CalDavClient {
    constructor(serverUrl: string, auth: string, transport: Transport)
    discover(): Promise<{ principal: string; home: string }>
    listCollections(home: string): Promise<CollectionInfo[]>   // 只回傳 resourcetype 含 c:calendar 的；components 取交集 VTODO/VEVENT
    syncCollection(href: string, token: string | null): Promise<{
      token: string;
      changed: { href: string; etag: string; ics: string }[];
      removed: string[];   // status 404 的 href
    }>
  }
  ```
  - `discover`：先對 `serverUrl + "/"` PROPFIND `d:current-user-principal`（Depth 0），再對 principal PROPFIND `c:calendar-home-set`
  - `syncCollection`：REPORT，Depth 1，body 為 `syncCollectionBody(token, true)`
  - 403 而且 body 含 `valid-sync-token` 時拋 `TokenExpiredError`；其他非 2xx 拋 `HttpError(status)`；401 的訊息要寫成「帳號或密碼錯誤」
  - 每個請求都帶 `Authorization`，XML 請求帶 `Content-Type: application/xml; charset=utf-8`

- [ ] **Step 1: 寫失敗的測試**（全部用 fakeTransport 和 radicale fixtures）：
  - `discover()` 回傳 `{ principal: "/ryanw/", home: "/ryanw/" }`，而且第一個請求的 URL 是 `serverUrl + "/"`，不是 `/.well-known/caldav`
  - `listCollections("/ryanw/")` 回傳 2 個清單（`/ryanw/` 自己不算）
  - `syncCollection` 遇到 `sync-invalid-token-403.xml` 會 reject `TokenExpiredError`
  - `syncCollection` 遇到 401 會 reject `HttpError`，`status === 401`
  - `syncCollection(href, null)` 對 `sync-initial-with-data.xml`：`changed` 裡每筆都有非空的 `etag` 和 `ics`，`removed` 裡的 href 都是 404 的那些
- [ ] **Step 2–4:** 跑測試（FAIL）→ 實作 → 跑測試（PASS）
- [ ] **Step 5:** Commit `feat: caldav client (discover, collections, sync-collection)`

---

### Task 4: ICS 解析

**Files:**
- Create: `src/ical/parse.ts`、`tests/parse.test.ts`

**Interfaces:**
- Produces: `parseResource(ics: string, meta: { href: string; etag: string; collection: string }): Promise<CalObject | { skip: string }>`
  - 用 ical.js 解析。主元件是第一個**不帶** RECURRENCE-ID 的 VTODO 或 VEVENT；如果每個元件都帶 RECURRENCE-ID（只有 override），就取第一個，`hasOverrides = true`
  - 沒有 VTODO/VEVENT、沒有 UID、解析失敗時，回傳 `{ skip: 原因 }`，不 throw
  - `DateValue` 直接取屬性原文和 `TZID` 參數，`dateOnly` 依 `VALUE=DATE` 判斷，不做時區換算

- [ ] **Step 1: 寫失敗的測試**（fixtures 在 `fixtures/ios-27.2/`）：
  - `10-after-phone/test/F17BEA7B-….ics`（test2 master）：`kind` 是 `VTODO`，`rrule` 是 `FREQ=WEEKLY;BYDAY=TU,WE,FR`，`due` 是 `{ value: "20261216T150000", dateOnly: false, tzid: "Asia/Taipei" }`，`status` 是 `NEEDS-ACTION`，`shortId` 是 `5cd3cmqd`，`created` 是 `20261119T064923Z`
  - `10-after-phone/test/76F72A6F-….ics`（完成副本）：`status` 是 `COMPLETED`，`completed` 有值，`rrule` 是 undefined
  - `00-baseline/1000FF97-….ics`（全天重複事件）：`kind` 是 `VEVENT`，`start` 是 `{ value: "20261119", dateOnly: true }`
  - `10-after-phone/tasks/CD14C2C1-….ics`（帶位置提醒）：解析成功，而且回傳的 `ics` 跟輸入的字串完全相同
  - 自己構造：master 加上一個 `RECURRENCE-ID` override 的 VEVENT，`hasOverrides` 為 true，summary 取 master 的
  - 自己構造：只有 VJOURNAL、缺 UID、亂碼字串，三種都回傳 `{ skip }`
- [ ] **Step 2–4:** FAIL → 實作 → PASS
- [ ] **Step 5:** Commit `feat: parse iCalendar resources into CalObject`

---

### Task 5: IndexedDB 快取

**Files:**
- Create: `src/cache/db.ts`、`tests/db.test.ts`（開頭加 `import "fake-indexeddb/auto"`）

**Interfaces:**
- Produces:
  ```ts
  class CacheStore {
    static open(name: string, fingerprint: string): Promise<CacheStore> // fingerprint 不同就清空所有 store 再寫入新的
    getCollections(): Promise<CollectionInfo[]>
    putCollection(c: CollectionInfo): Promise<void>
    deleteCollection(href: string): Promise<void>                       // 只刪清單本身；裡面的物件由引擎處理
    upsertObjects(objs: CalObject[]): Promise<void>                     // 同一 href 若在刪除紀錄裡，要一併移除
    removeObjects(hrefs: string[], now: number): Promise<number>        // 只處理快取裡有的；轉成 Tombstone；回傳實際刪除的數量
    hrefsInCollection(collection: string): Promise<string[]>
    findByShortId(id: string): Promise<CalObject[]>
    findTombstonesByShortId(id: string): Promise<Tombstone[]>
    count(): Promise<number>
    close(): void
  }
  ```
  - store 有四個：`meta`（fingerprint）、`collections`（keyPath `href`）、`objects`（keyPath `href`，索引 `shortId`、`collection`）、`tombstones`（keyPath `href`，索引 `shortId`）
  - 每次寫入都是一個 transaction，要嘛整批成功、要嘛整批失敗

- [ ] **Step 1: 寫失敗的測試**：
  - upsert 兩筆後，用短 ID 查得到；同一 href 再 upsert 一次會覆蓋，不會多出一筆
  - `removeObjects` 後，`findByShortId` 是空的，`findTombstonesByShortId` 有一筆，`summary` 和 `created` 都有保留；不在快取裡的 href 不會產生刪除紀錄，回傳值是實際刪除的數量
  - 被刪除的 href 重新 upsert 之後，它的刪除紀錄會消失
  - 用同一個 fingerprint 重開，資料還在；換一個 fingerprint 重開，`count()` 是 0，清單也是空的
- [ ] **Step 2–4:** FAIL → 實作 → PASS
- [ ] **Step 5:** Commit `feat: IndexedDB cache with tombstones`

---

### Task 6: 同步引擎

**Files:**
- Create: `src/sync/engine.ts`、`tests/engine.test.ts`

**Interfaces:**
- Consumes: `CalDavClient`（Task 3）、`parseResource`（Task 4）、`CacheStore`（Task 5）
- Produces:
  ```ts
  class SyncEngine {
    constructor(client: CalDavClient, cache: CacheStore, now?: () => number)
    syncAll(): Promise<SyncReport>   // single-flight：執行中再被呼叫，回傳同一個 Promise
    get lastReport(): SyncReport | undefined
  }
  ```
  流程：
  1. `discover()`，接著 `listCollections(home)`
  2. 快取有、伺服器沒有的清單：該清單的物件全部 `removeObjects`，再 `deleteCollection`
  3. 每個清單**分別**處理，彼此錯誤隔離：
     - 拿 `syncToken`（可能是 undefined）呼叫 `syncCollection`
     - 收到 `TokenExpiredError`：改用 `null` 重新同步（全量），然後把「快取裡有、但全量結果的 changed 裡沒有」的 href 也一起移除
     - `changed` 交給 `parseResource`，結果是 `skip` 的計入 `skipped`；如果這個 href 原本在快取裡，要從快取移除（它已經不是可用的物件了）
     - 寫入快取以後，才更新該清單的 `syncToken` 和 `lastSyncAt`。順序不能反：寫入失敗時 token 不前進，下次會重新拿到同樣的變更
  4. 連 `discover` 或 `listCollections` 都失敗時（例如逾時），回傳 `errors` 只有一筆、其他數字都是 0 的 report，快取不動

- [ ] **Step 1: 寫失敗的測試**（fakeTransport 加上 fake-indexeddb，每個測試都用新的 DB 名稱）：
  - 初次同步：用 radicale fixtures 跑完，`count()` 等於 changed 裡能解析的數量，兩個清單都有 `syncToken`
  - 增量同步：第二次的回應刪掉一筆、改掉一筆，結果是刪除紀錄多一筆，改掉的那筆 etag 已更新
  - token 過期：第一次回 403 `valid-sync-token`，第二次（空 token）的回應裡少了一筆快取有的物件 → 那筆變成刪除紀錄，`errors` 為空
  - 清單消失：第二次 `listCollections` 只剩 `tasks`，原本 `test` 裡的物件全部變成刪除紀錄
  - 錯誤隔離：`test` 的 REPORT 回 500，`tasks` 照樣同步成功；report 的 `errors` 有一筆，`collection` 是 `/ryanw/test/`；`test` 的 `syncToken` 沒有被更新
  - 離線：transport 一律 reject `timeout`，快取的數量不變，`errors[0].message` 含 `timeout`
  - 無法解析：changed 裡有一筆亂碼，`skipped` 是 1，其他物件照常寫入
  - single-flight：連續呼叫兩次 `syncAll()`，拿到的是同一個 Promise，transport 只收到一輪請求
- [ ] **Step 2–4:** FAIL → 實作 → PASS
- [ ] **Step 5:** Commit `feat: sync engine with token expiry fallback and per-collection isolation`

---

### Task 7: 插件組裝與設定頁

**Files:**
- Create: `src/settings.ts`
- Modify: `src/main.ts`、`manifest.json`（version `0.1.0`）、`package.json`（version `0.1.0`）、`README.md`（拿掉 T5 的說明，改寫 M1 的用法）

**Interfaces:**
- Consumes: Task 2–6
- Produces（設定）：`interface Settings { serverUrl: string; username: string; syncIntervalMinutes: number }`，預設 `{ "", "", 5 }`

行為：
- 啟動流程：`onLayoutReady` 之後，如果設定齊全，就用 fingerprint `${serverUrl}|${username}` 開啟 `CacheStore`、建立 `SyncEngine`，並馬上同步一次
- 自動同步：`registerInterval` 每 `syncIntervalMinutes` 分鐘一次；`document` 的 `visibilitychange` 變成 visible 時也同步一次，用 `registerDomEvent` 註冊
- 指令：
  - `sync-now`「CalDAV：立即同步」：完成後用 Notice 顯示 `已同步 N 筆（變更 a、刪除 b）`，或顯示錯誤
  - `lookup-short-id`「CalDAV：以短 ID 查詢」：跳出輸入框，查到時用 Notice 顯示 kind、summary、status、due、清單名稱。查不到但有刪除紀錄就顯示「已刪除：summary」，都沒有就顯示「查無此物」。這個指令給 M1 驗收用
- 設定頁：Server URL、使用者名稱、密碼（寫進 SecretStorage，placeholder 顯示「已設定」）、同步間隔，以及狀態區塊（上次同步時間、物件數、各清單名稱、最近的錯誤）和「立即同步」按鈕。改 server URL 或使用者名稱後，下次同步會用新的 fingerprint 重開快取
- `onunload` 時關閉 DB

- [ ] **Step 1:** 實作。這一層是 Obsidian 膠合程式，不寫單元測試，由 Task 8 做整合驗證
- [ ] **Step 2:** `npm test` 全部通過，`npm run build` 通過
- [ ] **Step 3:** Commit `feat: plugin wiring, settings and status (0.1.0)`

---

### Task 8: headless 整合驗證與發佈

不新增檔案，只做驗證與發佈。

- [ ] **Step 1:** 照 T5 的方式開臨時 vault（在 scratchpad 底下），放入 `main.js` 和 `manifest.json`，`data.json` 指向 `http://127.0.0.1:5232`
- [ ] **Step 2:** 用 `obsidian eval` 驗證以下項目，每一項都要有輸出作為證據：
  - 設好 secret、執行同步後，`count()` 等於 Radicale 上兩個清單的物件總數（用 `find /ssd-pool/config/radicale/data/collections/collection-root/ryanw -name '*.ics' | wc -l` 對照）
  - 查 `5cd3cmqd` 得到 test2
  - 用 curl 在 `test` 裡 PUT 一筆，再 DELETE 另一筆暫存物件，然後同步：增量正確，被刪的那筆查得到刪除紀錄。暫存物件要在測試結束前清掉
  - 把該清單的 `syncToken` 改成無效值後同步：自動改做全量同步，數量不變
- [ ] **Step 3:** 關閉並移除臨時 vault，確認 `obsidian.json` 只剩主 vault
- [ ] **Step 4:** 推上 GitHub，執行 `gh release create 0.1.0 main.js manifest.json`
- [ ] **Step 5:** 把 iPhone 試用清單交給使用者：BRAT 更新 → 設定頁看到物件數 → 在 iPhone 提醒事項新增一筆 → 回 Obsidian（觸發前景同步）→ 用「以短 ID 查詢」查新的那筆（短 ID 由我從伺服器算出來提供）
