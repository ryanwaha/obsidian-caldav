# M3 插入參照與新建任務 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 在筆記裡可以搜尋既有的任務或事件並插入 `[](cal:…)`；可以新建 VTODO（離線也行），新建的任務先進本機待送佇列，連線後送出。這是插件第一次寫入伺服器，也是唯一一次寫入 .md（插入參照）。

**Architecture:**
- **ICS 產生器**：用 ical.js 產生 ICS，由它處理跳脫和摺行。
- **待送佇列**：存在 IndexedDB 的 `pending` store（DB 版本升到 2）。換帳號（fingerprint 改變）時不清空，每筆記錄自己所屬的 fingerprint。
- **同步引擎**：discover 之後、同步各清單之前，先送出待送項目（flush）。
- **記憶體索引**：一併載入待送項目，chip 依此顯示 `pending` 狀態。
- **插件 UI**：兩個 editor 指令和設定頁的「預設清單」。

**Tech Stack:** 同 M1／M2。

**Spec:** `~/docs/homelab/obsidian-caldav.md`
- §4.2：待送佇列不能被清掉
- §6.3：標籤一律留空
- §6.4：待送狀態
- §7.2：待送佇列列、選取指令列
- §7.3：互動流程，含本機產生 UUIDv4、離線也能選清單
- §5.2 E3：時間寫成 `TZID=Asia/Taipei` 並附 VTIMEZONE，全天用 `VALUE=DATE`，不寫 UTC 也不寫 floating

## Global Constraints

- 插入的內容一律是 `[](cal:<shortId>)`，標籤空白（§6.3）。這是插件對 .md 唯一的寫入，而且只在使用者下指令時發生（P2）。
- 新建的 UID 用 `crypto.randomUUID()`；href 為 `<collection href><uid>.ics`。
- 新建時送 PUT 並帶 `If-None-Match: *`。
  - 201：成功。
  - 412：視為已經送過（UID 是隨機產生的，只可能是上次送出後沒收到回應）。
  - 其他 4xx：標為「失敗」並保留內容，不悄悄丟掉（§7.2）。
  - 5xx 或網路錯誤：保留在佇列，本輪停止 flush。
- 待送項目在換帳號、token 過期全量同步、重建快取時都不清掉（§4.2）。
- M3 只新建 VTODO。事件交給原生客戶端（§4.3：Obsidian 裡只做輕量操作）。

## Review Focus

1. **從 M2 的 v1 資料庫升級**：既有的物件、刪除紀錄和 token 都要保留，並新增 `pending` store。由 Task 2 測試。
2. **送出成功但回應遺失**：重送時收到 412，要當作成功，不能變成「失敗」，也不能產生重複的任務。由 Task 3 測試。
3. **離線新建，之後連線**：chip 先顯示「待送」，連線後變成一般狀態，中間不能閃成「查無此物」。由 Task 3、4 和 headless 驗證。
4. **標題含特殊字元**（`,` `;` `\` 換行、emoji、很長的中文）：送出後再解析回來，必須和原本完全相同。由 Task 1 測試。
5. **換帳號時還有待送項目**：不送到新帳號，也不刪除，狀態欄顯示「屬於其他帳號」。由 Task 2、3 測試。

---

### Task 1: ICS 產生器

**Files:** Create `src/ical/build.ts`、`tests/build.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface NewTodo { uid: string; summary: string; due?: { date: string; time?: string } } // date "2026-11-24"、time "15:00"
  export function buildTodo(t: NewTodo, now: Date): string
  ```
  - 內容：`VCALENDAR`（`VERSION:2.0`、`PRODID:-//obsidian-caldav//EN`）。有帶時間的 due 時，附上 `Asia/Taipei` 的 VTIMEZONE（STANDARD，`+0800`）。
  - VTODO 帶：`UID`、`DTSTAMP`、`CREATED`、`LAST-MODIFIED`（三者都是 UTC）、`SUMMARY`、`STATUS:NEEDS-ACTION`。
  - DUE 的寫法：有時間時寫 `DUE;TZID=Asia/Taipei:YYYYMMDDTHHMM00`；只有日期時寫 `DUE;VALUE=DATE:YYYYMMDD`。

- [ ] 測試（全部以 `parseResource` 解析回來比對）：
  - 有時間：`due` 為 `{ value: "20261124T150000", tzid: "Asia/Taipei" }`，`epoch` 等於 UTC 07:00
  - 只有日期：`due` 為 `{ value: "20261124", dateOnly: true }`
  - 沒有 due：`due` 是 undefined
  - 標題 `a,b;c\d\n第二行 😀` 解析回來完全相同
  - 每一行長度都不超過 75 個位元組（摺行）
  - `created` 的值結尾是 `Z`
- [ ] 實作 → PASS → commit `feat(ical): build new VTODO`

### Task 2: 待送佇列（IndexedDB v2）

**Files:** Modify `src/cache/db.ts`、`src/types.ts`；Test `tests/db.test.ts`

**Interfaces:**
- `types.ts`：
  ```ts
  export interface PendingCreate {
    uid: string; shortId: string; fingerprint: string;
    collection: string; href: string; ics: string;
    summary: string; due?: DateValue;
    createdAt: number; attempts: number;
    state: "queued" | "failed"; lastError?: string;
  }
  ```
- `CacheStore` 新增：
  - `enqueue(p: PendingCreate): Promise<void>`
  - `allPending(): Promise<PendingCreate[]>`
  - `updatePending(p: PendingCreate): Promise<void>`
  - `removePending(uid: string): Promise<void>`
  - `readonly fingerprint: string`
- `open` 的變更：
  - `VERSION = 2`；`onupgradeneeded` 依 `oldVersion` 增量建立 store。
  - fingerprint 改變時清空 `meta`、`collections`、`objects`、`tombstones`，**不清** `pending`。

- [ ] 測試：
  - 先用舊 schema（v1：四個 store）建一個 DB 並寫入資料，再用 `CacheStore.open` 開啟：資料都在，而且可以 `enqueue`
  - `enqueue` 後 `allPending` 拿得到；`updatePending` 改成 failed 後再讀回，結果正確；`removePending` 後就消失
  - 換 fingerprint 重開後：`count()` 是 0，但 `allPending()` 仍然有資料
- [ ] 實作 → PASS → commit `feat(cache): pending queue store (db v2)`

### Task 3: 送出待送項目（client.put 與 engine flush）

**Files:** Modify `src/caldav/client.ts`、`src/sync/engine.ts`、`src/types.ts`（SyncReport 加 `sent: number`、`pendingQueued: number`、`pendingFailed: number`）；Test `tests/client.test.ts`、`tests/engine.test.ts`

**Interfaces:**
- `CalDavClient.put(href: string, ics: string, cond: { ifNoneMatch: true } | { ifMatch: string }): Promise<{ status: number; etag?: string }>`
  - 一律帶 `Content-Type: text/calendar; charset=utf-8`。
  - 401 時丟 `HttpError`；其他狀態碼照實回傳，由呼叫端判斷。
- `SyncEngine.run()`：在 discover 之後、同步各清單之前，依 `createdAt` 排序處理 fingerprint 相符且 `queued` 的項目：
  - **201 或 204**：用 `parseResource(p.ics, { href, etag: res.etag ?? "", collection })` 寫進快取，再 `removePending`，`sent++`。
  - **412**：直接 `removePending`，`sent++`。接下來同步清單時會拿到伺服器上的版本。
  - **其他 4xx**：`state = "failed"`，`lastError = "HTTP <status>"`，`attempts++`。
  - **5xx 或例外**：`attempts++`、記下 `lastError`，保持 queued，並**停止**本輪 flush。這一筆也記進 `report.errors`。
  - 最後統計 `pendingQueued` 和 `pendingFailed`。fingerprint 不符的項目計入 failed，但不修改它們。

- [ ] 測試：
  - client.put：送出的標頭正確，201 時回傳 etag
  - engine：
    - 201：佇列清空，快取查得到該物件，`sent` 為 1，而且 PUT 發生在 REPORT 之前
    - 412：佇列清空，`sent` 為 1
    - 403：佇列中的項目 `state` 變成 failed，`lastError` 為 `HTTP 403`
    - 逾時：佇列裡的兩筆都還是 queued，只嘗試了第一筆，`errors` 裡有一筆
    - fingerprint 不符：不發出 PUT，項目原封不動，計入 `pendingFailed`
- [ ] 實作 → PASS → commit `feat(sync): flush pending creates before collection sync`

### Task 4: 索引與 chip 的待送狀態

**Files:** Modify `src/render/index.ts`、`src/render/present.ts`、`src/render/chip.ts`、`styles.css`；Test `tests/index.test.ts`、`tests/present.test.ts`、`tests/chip.test.ts`

**Interfaces:**
- `MemoryIndex.get(id)` 回傳 `{ objs, tombs, pending: PendingCreate[] }`，`load` 時一併讀取 `allPending()`。
- `present(id, label, objs, tombs, now, pending = [])`：
  - objs 是空的、但有 pending → `state "pending"`，`text` 依序取 label、`p.summary`；有 due 時顯示 `when`。
  - pending 的 `state` 為 failed 時，另設 `failed: true`（`RefView` 新增欄位）。
- chip：
  - pending 的圖示為 `⇡`，加上 class `caldav-ref--pending`；failed 另加 `caldav-ref--failed`。
  - CSS：pending 用虛線框；failed 用 `--text-error`。

- [ ] 測試：
  - index：pending 項目可以用短 ID 查到
  - present：只有 pending 時 `state` 為 `"pending"`、`text` 為 summary、`when` 正確；failed 時 `failed` 為 true；objs 和 pending 同時存在時以 objs 為準，`state` 為 ok
  - chip：pending 的圖示和 class 正確
- [ ] 實作 → PASS → commit `feat(render): pending state`

### Task 5: 指令與設定、headless 驗證、發佈 0.3.0

**Files:** Create `src/ui/pickModal.ts`、`src/ui/newTaskModal.ts`；Modify `src/main.ts`、`src/settings.ts`、`manifest.json`、`package.json`、`README.md`

- **設定**：新增 `defaultCollection: string`（href，預設為空）。設定頁有一個下拉選單，選項是快取中支援 VTODO 的清單；沒有設定時，新建任務預設用第一個支援 VTODO 的清單。
- **`insert-ref`「插入任務／事件參照」**（`editorCallback`）：
  - 用 `FuzzySuggestModal<CalObject>` 搜尋索引裡所有物件。
  - 排序：未完成的 VTODO 在前，依到期日；接著是 VEVENT；已完成的最後。
  - 每一列顯示：圖示、標題、日期、清單名稱。
  - 選定後 `editor.replaceSelection("[](cal:<shortId>)")`。如果這個短 ID 對到多筆，另外用 Notice 提醒。
- **`new-task`「新建任務並插入參照」**（`editorCallback`）：
  - Modal 欄位：標題（必填）、日期（`input type=date`）、時間（`input type=time`，只有填了日期才有效）、清單（下拉，從快取讀取，離線也能選）。
  - 送出時的順序：
    1. `uid = crypto.randomUUID()`
    2. `buildTodo`
    3. `enqueue`（fingerprint 用目前 session 的）
    4. `index` 重新載入
    5. 在 editor 插入 `[](cal:<shortId>)`
    6. 背景執行 `syncNow(false, "新建")`
  - 設定還沒填時，用 Notice 提示並中止。
- **狀態欄**：顯示待送和失敗的數量，並列出失敗項目（標題加原因）；另有「重試失敗項目」按鈕，按下後把 fingerprint 相符的 failed 項目改回 queued 並同步。
- [ ] `npm test`、`npm run build` 都通過。
- [ ] headless 驗證（臨時 vault；伺服器透過本機 TCP 轉送埠 `127.0.0.1:5299 → 5232` 連線，關掉轉送就能模擬離線）：
  1. 連線狀態下新建「M3 測試 a,b;c」，時間是明天 09:00：.md 多一行 `[](cal:…)`，chip 一開始可能是 pending，同步後變成 ok；用 curl GET 到的 ICS 有 `DUE;TZID=Asia/Taipei:…T090000`，標題完全相同
  2. 關掉轉送，新建「離線任務」：chip 顯示 `caldav-ref--pending`，狀態欄顯示待送 1
  3. 重開轉送並同步：chip 變成 ok，待送 0，伺服器上找得到這一筆
  4. 插入指令：搜尋「M3 測試」，選取後插入的短 ID 正確
  5. 清理：DELETE 測試建立的物件；移除臨時 vault；停掉轉送
- [ ] 發佈：push 後執行 `gh release create 0.3.0 main.js manifest.json styles.css`
