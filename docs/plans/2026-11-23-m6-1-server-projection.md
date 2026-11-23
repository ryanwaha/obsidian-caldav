# M6-1 伺服器端投影（下行）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 伺服器模式能把 CalDAV 物件完整投影成 `_caldav/<短ID>.md` 並持續跟上伺服器的變化（新增、修改、刪除、iOS 搬清單、MOVE），body 永遠不被動到；同時先用兩個小實測確認 M6-2（上行與衝突）的可行性。

**Architecture:** 投影是「對帳」而不是事件驅動：每輪同步後，從快取算出每個物件應有的 frontmatter（`projectFields`），和 `_caldav/` 裡現有檔案的 frontmatter 比對，產生最少的動作（`planReconcile`，純函式），再由 Obsidian 膠合層（`ProjectionWriter`）以 `processFrontMatter`／`vault.create`／`fileManager.renameFile` 執行。檔案與物件以 frontmatter 的 `_uid` 對應，不以檔名對應，所以檔名一旦決定就穩定。

**Tech Stack:** TypeScript、ical.js、vitest + fake-indexeddb（純邏輯）、spike 實例 + playwright-core（整合驗證，沿用 `spike/m6-probe/`）。

**Spec:** `docs/plans/2026-11-23-m6-server-projection-design.md`（§6 投影檔、§7.1、§8.1、§8.4、§8.5、§8.7）；實測結果 `docs/plans/2026-11-23-m6-0-spike-results.md`。

## Global Constraints

- 不在 M6-1 改動客戶端（0.5.0）行為；新程式只在 `mode: "server"` 時啟用。`mode` 預設 `"client"`。
- 投影目錄 `_caldav`（常數 `PROJ_DIR`）；檔名 `<短ID>.md`。
- 伺服器對投影檔的既有檔案只用 `app.fileManager.processFrontMatter` 寫入；新檔用 `vault.create`（body 為空）；改名只用 `app.fileManager.renameFile`。**任何情況下不得改寫 body、不得刪除投影檔。**
- 日期欄位（設計 §6.2，已確認）：`due`／`start`／`end` 為 `YYYY-MM-DD`；`due_time`／`start_time`／`end_time` 為 `HH:mm`（字串）；沒有 `*_time` 表示全天。時間一律換算成 Asia/Taipei 本地時間。
- frontmatter 只在受管欄位的值改變時寫入（空轉同步不碰檔案）。
- 開發與整合驗證只用 spike 實例與臨時 vault（`~/m6-spike/`），Radicale 只用 `/ryanw/test/` 與臨時集合，CouchDB 只用臨時資料庫；不碰 `markdowns`、正式 vault、正式實例。結束時清理並附驗證輸出（沿用 M6-0 的清理步驟）。
- 每個 Task 結束 `npm test` 全綠、`npm run build` 通過。

## Review Focus

1. **iOS 搬清單時新 UID 的投影比搬移偵測更早出現**（設計 §8.4）：不得留下兩個檔案或遺失任一 body → Task 5 測 `rename-onto-existing-empty`。
2. **兩個物件短 ID 相同**：檔名不得互相覆蓋，重啟後檔名不變 → Task 5 測 `collision-stable`。
3. **使用者在 `_caldav/` 手動放了沒有 `_uid` 的檔案**：不刪、不改 body，只標 rejected → Task 5 測 `foreign-file`。
4. **集合被移出白名單**：既有投影檔不刪，標 rejected 後不再更新 → Task 5 測 `whitelist-removed`。
5. **UTC 或其他時區的 DUE**：換算成台北本地日期與時間，跨日正確 → Task 3 測 `utc-crosses-midnight`。

---

### Task 1: 實測 A — 以程式解決 LiveSync 衝突

**Files:**
- Create: `spike/m6-probe/driver/s7.mjs`
- Modify: `docs/plans/2026-11-23-m6-0-spike-results.md`（新增 `## S7`）

**Interfaces:**
- Produces（給 M6-2）：一段經實測可行的程式，給定 `_caldav/x.md` 處於 LiveSync 衝突狀態時，以指定的內容結束衝突，兩端最終檔案一致、CouchDB 無 `_conflicts`。

- [ ] **Step 1:** 依 M6-0 Task 7 的方式重建環境（`m6-spike` 資料庫、vault-a／vault-b、DBNAME 檢查），用 `s5.mjs fm_same_field` 製造衝突
- [ ] **Step 2:** 在**沒有對話框的那一端**（模擬 headless 伺服器）探索 `services.database._localDatabase.getConflictedDoc(path, rev)` 與 LiveSync 解衝突的內部流程（讀 `obsidian-livesync/main.js` 中「Use Base／Use Conflicted」按鈕呼叫的函式），找出能「寫入指定內容並刪除落敗版本」的呼叫序列
- [ ] **Step 3:** 驗證：以程式寫入「frontmatter 取 A 的 `status`、body 取兩邊合併」後，30 s 內兩端檔案逐字相同，CouchDB `?conflicts=true` 無 `_conflicts`，另一端的對話框自行消失或可安全關閉
Expected: 三項都成立。**不成立 → 停止並向使用者回報**（設計 §8.7 的前提不成立，需要重新決策）
- [ ] **Step 4:** 記錄呼叫序列、用到的內部名稱與 LiveSync 版本（0.25.56），寫入 `## S7`；Commit `spike(m6): S7 programmatic LiveSync conflict resolution`

---

### Task 2: 實測 B — 相鄰欄位合併、`due_time` 寫入原文

**Files:** Modify: `spike/m6-probe/driver/s5.mjs`（新增情境）、結果紀錄 `## S8`

- [ ] **Step 1:** 投影檔換成完整 §6.2 格式（含 `_etag`、`_hash`、`_sync` 等），新增兩個情境：`fm_adjacent`（A 改 `title`、B 改緊鄰的 `status`）、`fm_server_meta`（A 改 `status`，B 改 `_etag`＋`_hash`＋`_sync`，模擬伺服器重新投影）
- [ ] **Step 2:** 跑兩個情境，記錄是否自動合併（判定方式同 S5）
- [ ] **Step 3:** 在 Properties 與 Bases 各編輯一次 `due_time`（輸入 `09:30`），`cat` 檔案記錄原文是否帶引號；再以 `processFrontMatter` 寫入 `'09:30'` 記錄原文
- [ ] **Step 4:** 寫入 `## S8`，並依結果更新設計 §8.7（相鄰欄位若不能合併，寫明伺服器應把系統欄位與可寫欄位分開：例如重新投影時若可寫欄位不變，只更新系統欄位）；Commit `spike(m6): S8 adjacent-field merge, due_time format`

---

### Task 3: 日期換算與 alias 清理

**Files:**
- Create: `src/projection/dates.ts`、`src/projection/alias.ts`
- Test: `tests/projection-dates.test.ts`

**Interfaces:**
- Produces:
  - `toLocalParts(d: DateValue): { date: string; time?: string }`（`date` 為 `YYYY-MM-DD`，`time` 為 `HH:mm`；`dateOnly` 時沒有 `time`）
  - `sanitizeAlias(title: string): string`

- [ ] **Step 1: 寫失敗的測試**

```ts
test("date-only", () => expect(toLocalParts({ value: "20261124", dateOnly: true })).toEqual({ date: "2026-11-24" }));
test("taipei local", () => expect(toLocalParts({ value: "20261124T093000", dateOnly: false, tzid: "Asia/Taipei" })).toEqual({ date: "2026-11-24", time: "09:30" }));
test("utc-crosses-midnight", () => expect(toLocalParts({ value: "20261123T170000Z", dateOnly: false, epoch: Date.UTC(2026, 10, 23, 17) })).toEqual({ date: "2026-11-24", time: "01:00" }));
test("other tz via epoch", () => expect(toLocalParts({ value: "20261124T090000", dateOnly: false, tzid: "Europe/Berlin", epoch: Date.UTC(2026, 10, 24, 8) })).toEqual({ date: "2026-11-24", time: "16:00" }));
test("floating (no tzid, no Z) treated as local", () => expect(toLocalParts({ value: "20261124T093000", dateOnly: false })).toEqual({ date: "2026-11-24", time: "09:30" }));
test("sanitizeAlias", () => {
  expect(sanitizeAlias("繳費：電費 | 十一月 #帳單")).toBe("繳費：電費 | 十一月 #帳單");
  expect(sanitizeAlias("a [[b]] c\nd")).toBe("a ⟦b⟧ c d");
});
```

- [ ] **Step 2:** `npx vitest run tests/projection-dates.test.ts` → FAIL（模組不存在）
- [ ] **Step 3:** 實作。`toLocalParts`：`dateOnly` 直接切字串；`tzid === "Asia/Taipei"` 或無 tzid 且不以 `Z` 結尾 → 直接切字串；其餘用 `epoch` 加 8 小時以 UTC 欄位格式化（台北無日光節約）。`epoch` 不存在時退回直接切字串。`sanitizeAlias`：`[[`→`⟦`、`]]`→`⟧`、`\r?\n`→空白
- [ ] **Step 4:** 測試 PASS；`npm test` 全綠
- [ ] **Step 5:** Commit `feat(projection): local date parts and alias sanitizing`

---

### Task 4: 物件 → frontmatter（`projectFields`）

**Files:**
- Create: `src/projection/types.ts`、`src/projection/fields.ts`
- Test: `tests/projection-fields.test.ts`（物件用 `tests/msBuilder.ts` 的 `todo()` 建立，再經 `parseResource` 解析）

**Interfaces:**
- Consumes: `toLocalParts`、`sanitizeAlias`（Task 3）；`describeRrule`（`src/render/recur.ts`）；`editable`（`src/ical/editable.ts`）
- Produces（`src/projection/types.ts`）：

```ts
export const PROJ_DIR = "_caldav";
export const WRITABLE_KEYS = ["title", "status", "due", "due_time", "start", "start_time", "end", "end_time", "list"] as const;
export type WritableKey = (typeof WRITABLE_KEYS)[number];
export interface ProjFm {
  title: string; status?: string;
  due?: string; due_time?: string; start?: string; start_time?: string; end?: string; end_time?: string;
  list: string; aliases: string[];
  _kind: "VTODO" | "VEVENT"; _uid: string; _notes?: string; _rrule?: string;
  _etag: string; _hash: string; _sync: "ok" | "rejected" | "conflict"; _sync_msg?: string; _deleted: boolean;
}
export const listName = (collectionHref: string) => collectionHref.replace(/\/+$/, "").split("/").pop()!;
```

  - `projectFields(o: CalObject): Promise<ProjFm>`（`src/projection/fields.ts`）
  - `writableHash(fm: Pick<ProjFm, WritableKey>): Promise<string>`：依 `WRITABLE_KEYS` 順序取值（缺值為 `null`）→ `JSON.stringify` → SHA-256 → hex 前 16 碼

- [ ] **Step 1: 寫失敗的測試**（每個 test 一個斷言重點）
  - `vtodo all-day`：`DUE;VALUE=DATE:20261124`、`STATUS:NEEDS-ACTION` → `{ title, status: "needs-action", due: "2026-11-24", list: "tasks", aliases: [title], _kind: "VTODO", _deleted: false, _sync: "ok" }`，沒有 `due_time`
  - `vtodo timed`：`DUE;TZID=Asia/Taipei:20261124T093000` → `due: "2026-11-24", due_time: "09:30"`
  - `vevent`：`DTSTART`／`DTEND` 帶時間 → `start`、`start_time`、`end`、`end_time`，沒有 `status`、`due`
  - `description → _notes`：`DESCRIPTION:第一行\n第二行` → `_notes: "第一行\n第二行"`；沒有 DESCRIPTION 時沒有 `_notes` 鍵
  - `rrule → _rrule`：`RRULE:FREQ=WEEKLY;BYDAY=MO` → `_rrule` 等於 `describeRrule` 的輸出
  - `alias sanitized`：SUMMARY 含 `[[x]]` → `aliases: ["⟦x⟧"]`，`title` 保留原文
  - `hash stable`：同一物件兩次 `projectFields` 的 `_hash` 相同；改 SUMMARY 後不同；`writableHash` 與 key 插入順序無關
  - `etag`：`_etag` 等於 `o.etag`
- [ ] **Step 2:** 執行 → FAIL
- [ ] **Step 3:** 實作 `projectFields`：`status` 為 STATUS 小寫；DESCRIPTION 用 ical.js 從 `o.ics` 取第一個元件的值；VEVENT 的 `end` 取 DTEND（沒有時不寫）
- [ ] **Step 4:** PASS；`npm test` 全綠
- [ ] **Step 5:** Commit `feat(projection): project CalDAV objects to frontmatter`

---

### Task 5: 對帳計畫（`planReconcile`）

**Files:**
- Create: `src/projection/plan.ts`
- Test: `tests/projection-plan.test.ts`

**Interfaces:**
- Consumes: `ProjFm`、`WRITABLE_KEYS`、`PROJ_DIR`、`listName`（Task 4）；`Tombstone`、`Alias`、`CollectionInfo`（`src/types.ts`）；`MoveResolver`（`src/sync/moves.ts`）
- Produces：

```ts
export interface ProjFile { path: string; fm: Record<string, unknown> | null; bodyEmpty: boolean }
export type ProjAction =
  | { op: "create"; path: string; fm: ProjFm }
  | { op: "update"; path: string; set: Partial<ProjFm>; unset: string[] }
  | { op: "rename"; from: string; to: string }
  | { op: "merge-into"; keep: string; drop: string };   // 把 drop 的 body 附加到 keep 後刪除 drop（只在 drop 的 body 為空或兩者皆由系統新建時）
export interface ReconcileInput {
  projected: Map<string, ProjFm & { shortId: string; collection: string }>;   // key = uid
  tombstones: Tombstone[]; aliases: Alias[]; collections: CollectionInfo[];
  whitelist: string[];          // 集合 href；空陣列 = 全部
  files: ProjFile[];            // PROJ_DIR 底下現有的 .md
  now: number;
}
export function planReconcile(input: ReconcileInput): ProjAction[];
```

規則（依序）：
1. 以 `files[i].fm._uid` 建立 uid → 檔案的對應。`fm` 為 null 或沒有 `_uid` 的檔案：若 `_sync` 不是 `"rejected"`，產生 `update{ set: {_sync:"rejected", _sync_msg:"不是投影檔"} }`；不做其他事。
2. 每個 `projected` 物件，所屬集合不在白名單（白名單非空時）→ 跳過（不建立）。已有檔案者：若 `_sync_msg` 不是 `"集合不在投影範圍"` 就標 rejected 並寫此訊息，之後不再更新。
3. 物件已有檔案 → 比對受管欄位（`ProjFm` 的所有鍵，`_sync_msg` 除外但 rejected 狀態要清除）：不同的進 `set`，物件沒有而檔案有的受管鍵進 `unset`；全部相同則不產生動作。
4. 物件沒有檔案 → 先看搬移：存在 `alias.toUid === uid` 且 `alias.fromUid` 有檔案 → `rename{ from: 舊檔, to: PROJ_DIR/新短ID.md }`，之後再依規則 3 更新（同一輪產生兩個動作，`update.path` 用新路徑）。否則 `create`。
   - 檔名：`<短ID>.md`；若此檔名已被其他 uid 的檔案佔用或本輪已分配 → 改用 `<短ID>-<uid 的 sha 第 9–10 碼>` …（實作者決定具體字元，要求：決定性、只看 uid）。
5. 搬移時新 uid 的檔案已存在（新物件先被投影了）：`merge-into{ keep: 舊檔, drop: 新檔 }`（舊檔保留身分與連結），再對舊檔 `rename` 到新檔原本的路徑，再 `update`。drop 的 body 不為空時改為不合併、兩檔都保留，舊檔標 `_sync: rejected`、`_sync_msg: "搬移目標已有內容，請手動合併"`。
6. 有檔案、物件已不在 `projected` → 用 `MoveResolver` 判斷：`maybe` → 不動作；`moved` → 由規則 4 處理；`ambiguous` → `_sync: rejected`，`_sync_msg` 列出候選短 ID；`deleted` 或找不到 tombstone → `set{ _deleted: true }`（已是 true 則不動作）。**永不產生刪除檔案的動作。**

- [ ] **Step 1: 寫失敗的測試**（每項一個 test，名稱即規則）
  - `create-new`：一個物件、沒有檔案 → `[create _caldav/<id>.md]`
  - `noop-when-equal`：檔案 fm 與投影相同 → `[]`
  - `update-only-diff`：只有 `title` 不同 → `set` 只有 `title`、`aliases`、`_hash`（以及 `_etag` 若不同），`unset` 為空
  - `unset-removed-field`：物件拿掉 DUE → `unset` 含 `due`、`due_time`
  - `deleted`：檔案存在、物件不存在、tombstone 存在且無候選 → `set { _deleted: true }`
  - `maybe-moved-waits`：有相關集合尚未同步過刪除 → `[]`
  - `alias-rename`：alias old→new、舊檔存在 → `[rename old→new, update…]`
  - `move-same-uid`：同 uid 換集合（MOVE）→ 只 `update { list }`，沒有 rename、沒有 `_deleted`
  - `rename-onto-existing-empty`（Review Focus 1）：新 uid 已有空 body 檔 → `merge-into` + `rename` + `update`
  - `rename-onto-existing-with-body`：新檔 body 非空 → 兩檔保留，舊檔 rejected 訊息如規則 5
  - `ambiguous`：兩個候選 → rejected，訊息含兩個短 ID
  - `collision-stable`（Review Focus 2）：兩 uid 同短 ID → 兩個不同檔名；把輸入順序反轉，第一個已有檔案者保留 8 碼檔名
  - `foreign-file`（Review Focus 3）：沒有 `_uid` 的檔 → 只有 rejected update
  - `whitelist-removed`（Review Focus 4）：集合不在白名單 → 不建立；已有檔案者 rejected，第二次執行（訊息已寫入）→ `[]`
  - `never-delete`：任意輸入的輸出都沒有刪除檔案的 op（對上面全部 fixture 斷言）
- [ ] **Step 2:** 執行 → FAIL
- [ ] **Step 3:** 實作 `planReconcile`
- [ ] **Step 4:** PASS；`npm test` 全綠
- [ ] **Step 5:** Commit `feat(projection): reconcile plan`

---

### Task 6: 伺服器模式膠合與整合驗證

**Files:**
- Create: `src/projection/writer.ts`
- Modify: `src/settings.ts`（`mode: "client" | "server"`，預設 `"client"`；`projectCollections: string[]`，預設 `[]`；設定頁加兩個欄位）、`src/main.ts`（server 模式：每輪 `syncNow` 之後呼叫 `writer.reconcile()`；`onLayoutReady` 時設定 property 型別）
- Create: `spike/m6-probe/driver/m6-1-e2e.mjs`

**Interfaces:**
- Consumes: `projectFields`（Task 4）、`planReconcile`（Task 5）、`CacheStore.allObjects/allTombstones/allAliases/getCollections`
- Produces: `class ProjectionWriter { constructor(app: App, cache: CacheStore, whitelist: () => string[]); reconcile(): Promise<{ created: number; updated: number; renamed: number; merged: number }>; static setPropertyTypes(app: App): void }`

行為：
- `reconcile()`：確保 `PROJ_DIR` 存在 → 讀快取 → `projectFields` → 從 `metadataCache` 讀 `PROJ_DIR` 下每個 .md 的 frontmatter 與 body 是否為空（`cachedRead` 去掉 frontmatter 後 `trim()===""`）→ `planReconcile` → 依序執行：`create` 用 `vault.create(path, "---\n---\n")` 再 `processFrontMatter` 設值；`update` 用 `processFrontMatter`（`set` 逐鍵賦值、`unset` 逐鍵 delete）；`rename` 用 `fileManager.renameFile`；`merge-into` 讀 drop 的 body 附加到 keep 末尾（`vault.process` 只改 body 區段）後 `fileManager.trashFile(drop)`——這是唯一允許刪檔的地方，且只在 drop 由系統新建且 body 為空時（規則 5）
- 同一輪 reconcile 進行中再被呼叫時，排隊到結束後再跑一次（不並行）
- `setPropertyTypes`：`due`、`start`、`end` → `date`；`due_time`、`start_time`、`end_time`、`list`、`status` → `text`；`aliases` 不動
- 開始 reconcile 前檢查「自動更新內部連結」（`app.vault.getConfig("alwaysUpdateLinks")`），關閉時 Notice 警告且跳過 rename 類動作

- [ ] **Step 1:** 實作 `writer.ts`、settings、main.ts 接線。這是 Obsidian 膠合程式，純邏輯已由 Task 3–5 覆蓋，由 Step 3 的整合驗證把關
- [ ] **Step 2:** `npm test` 全綠、`npm run build` 通過
- [ ] **Step 3: 整合驗證**（spike 實例 + 臨時 vault `vault-s`，不接 LiveSync；插件 build 後放入；設定 server 模式、Radicale `http://127.0.0.1:5232`、白名單 `/ryanw/m6-e2e/`；用 curl 在臨時集合 `/ryanw/m6-e2e/`、`/ryanw/m6-e2e2/` 操作），每項附 `cat` 或 eval 輸出：
  1. 建 2 筆（一筆全天、一筆帶時間＋DESCRIPTION）→ 同步 → `_caldav/` 有 2 檔，frontmatter 符合 Task 4 規則，body 空
  2. 在其中一檔 body 寫 `我的筆記`；`note.md` 寫 `[[<id>|標題]]`；curl 改 SUMMARY → 同步 → `title`、`aliases` 更新，body 原樣，modify 次數 1
  3. 再同步一次、伺服器無變化 → 檔案 mtime 不變（空轉不寫）
  4. 模擬 iOS 搬清單：curl 在 e2e2 PUT 新 UID（同 CREATED、SUMMARY），DELETE 原物件；e2e2 也加入白名單 → 同步 → 舊檔被 rename 為新短 ID，body 保留，`note.md` 的連結自動改成新短 ID，`list` 為 `m6-e2e2`
  5. curl `MOVE` 另一筆到 e2e2 → 同步 → 檔名不變、`list` 更新、`_deleted` 為 false
  6. curl DELETE 一筆 → 同步 → `_deleted: true`，檔案與 body 仍在
  7. 手動在 `_caldav/` 建 `foreign.md`（無 `_uid`、有 body）→ 同步 → 只多了 `_sync: rejected`，body 原樣
  8. 重啟 spike 實例後再同步 → 無任何寫入（檔名、內容穩定）
- [ ] **Step 4:** 清理（spike 實例、`~/m6-spike`、兩個臨時集合），附驗證輸出
- [ ] **Step 5:** Commit `feat(projection): server mode writer and wiring`
