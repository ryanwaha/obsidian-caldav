# M2 行內渲染 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 筆記裡的 `[標籤](cal:xxxxxxxx)` 在 Live Preview 和閱讀模式都顯示成即時的任務／事件（標題或標籤、狀態、日期、重複規則），點擊會開出唯讀的詳情視窗；同步後自動更新。

**Architecture:** 純邏輯和 DOM 分開。純邏輯包括：從文字找參照（`refs.ts`）、把快取資料轉成顯示模型（`present.ts`，含重複規則的中文描述與 VEVENT 的下一次發生），以及記憶體索引（`MemoryIndex`：從 IndexedDB 載入成同步可查的 Map，每次同步後重建並發出變更事件）。DOM 層有三部分：`renderRef()` 產生 chip 元素；Live Preview 用 CM6 ViewPlugin 把參照整段換成 widget（跳過程式碼節點，游標進入時還原原文）；閱讀模式用 post-processor 替換 `a.external-link[href^="cal:"]`。M2 仍然不寫伺服器、不寫 .md。

**Tech Stack:** TypeScript、CodeMirror 6（`@codemirror/view`、`@codemirror/state`、`@codemirror/language`，由 Obsidian 在執行期提供）、ical.js（下一次發生）、vitest + jsdom。

**Spec:** `~/docs/homelab/obsidian-caldav.md`（§6.1 形式、§6.3 標籤、§6.4 渲染、§7.2 渲染器列、§4.1 重複 VTODO 以系列呈現、§5.2 E2／E3、T6／T7 結果）

## Global Constraints

- 參照格式：`[標籤](cal:<8 位 Crockford base32 小寫>)`，後面可接 `?…` query。不認得的 query 一律忽略（§6.1）。比對短 ID 時不分大小寫，查詢前一律轉成小寫。
- 行內程式碼和 code block 裡的參照**不渲染**（§6.1）。
- 標籤空白時顯示即時標題；有標籤時顯示標籤，不顯示即時標題（§6.4）。插件不改動標籤。
- 重複 VTODO 以系列呈現，例如「每週二、三、五・下次 12/16」。VTODO 的「下次」就是 master 的 DUE（E2：iOS 完成時會把 master 往後推）。重複 VEVENT 的「下次」用 ical.js 從現在往後展開。
- 時間顯示：帶 `TZID` 的值照 wall time 顯示，不做換算（E3：一律 `Asia/Taipei`）；結尾為 `Z` 的 UTC 值轉成本機時間顯示；`dateOnly` 只顯示日期。
- M2 實作的狀態：一般、重複系列、已刪除、查無此物、有歧義。待送（M3）、已搬走與可能已搬走（M5）先不做，但顯示模型的 `state` 型別要預留這三種名稱。
- 點擊 chip 時攔截事件，不讓系統去開 `cal:` 網址（§7.2）。
- `styles.css` 從這一版起列為 release 資產。
- 顏色只用 Obsidian 的 CSS 變數（`--text-muted`、`--text-error`、`--interactive-accent` 等），淺色、深色主題都要能看。

## Review Focus

1. **游標進入參照時要還原原文**，否則使用者無法編輯標籤。Task 5 的整合驗證要確認：游標移進去顯示原文，移出去又變回 chip。
2. **參照在程式碼裡**（行內 `` `[](cal:x)` ``、fenced code block）不渲染。Task 3 的測試搭配 Task 5 的 headless 驗證。
3. **同步前就已打開的筆記**：同步完成後 chip 要自動更新，不需要重開筆記。Task 4（索引事件）加上 Task 5／6 的驗證。
4. **快取裡沒有這筆，或設定還沒填**：顯示「查無此物」，不能拋例外，也不能讓整個編輯器壞掉。由 Task 2 測試。
5. **畸形參照**：長度不對、含非法字元（例如 `cal:abc`、`cal:ilou1234`）不當成參照，維持 Obsidian 原本的顯示。由 Task 1 測試。
6. **同一行多個參照，或參照緊鄰其他 Markdown 連結**：位置都要正確。由 Task 1 測試。

---

## 檔案結構

| 檔案 | 職責 |
|---|---|
| `src/render/refs.ts` | `findRefs(text)`、`REF_ID` |
| `src/render/recur.ts` | `describeRrule(rrule)` |
| `src/render/present.ts` | `present()` → `RefView`、`formatDate()`、`nextEventOccurrence()` |
| `src/render/index.ts` | `MemoryIndex` |
| `src/render/chip.ts` | `renderRef(el, view, onClick)` |
| `src/render/livePreview.ts` | CM6 ViewPlugin 與重繪用的 `StateEffect` |
| `src/render/readingMode.ts` | Markdown post-processor |
| `src/render/detailModal.ts` | 點擊後的唯讀詳情 |
| `src/cache/db.ts`（修改） | 新增 `allObjects()`、`allTombstones()` |
| `src/main.ts`（修改） | 註冊渲染器，同步後重建索引 |
| `styles.css` | chip 樣式 |

---

### Task 1: 參照解析

**Files:** Create `src/render/refs.ts`、`tests/refs.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const REF_ID = /^[0-9a-hjkmnp-tv-z]{8}$/;
  export interface RefMatch { from: number; to: number; label: string; id: string; query?: string }
  export function findRefs(text: string, offset = 0): RefMatch[]   // from/to 為 text 內位置加上 offset；id 已轉小寫
  ```
  正規式：`\[([^\]\n]*)\]\(cal:([0-9A-Za-z]{8})(\?[^)\s]*)?\)`，比對到之後再用 `REF_ID` 驗證小寫後的 id。這個函式**不處理**程式碼排除：Live Preview 交給 syntax tree，M5 的全文掃描另外處理。

- [ ] **Step 1: 寫失敗的測試**：
  - `findRefs("今天 [](cal:5cd3cmqd) 下週交")` 得到一筆：`label ""`、`id "5cd3cmqd"`、`from 3`、`to 20`
  - 有標籤：`[和 A 討論的那份](cal:5cd3cmqd)` 的 label 是 `和 A 討論的那份`
  - 大寫 `cal:5CD3CMQD` 的 id 轉成 `5cd3cmqd`
  - query：`[](cal:5cd3cmqd?view=x)` 的 `query` 是 `?view=x`，id 不受影響
  - 同一行兩個參照，再加一個普通連結 `[x](https://a)`，結果只有兩筆，位置都正確
  - `offset`：`findRefs("a [](cal:5cd3cmqd)", 100)[0].from` 是 `102`
  - 不算參照：`cal:abc`（長度不對）、`cal:ilou1234`（含 i、l、o、u）、`[](cal:5cd3cmqdx)`（9 碼）、標籤裡有換行
- [ ] **Step 2–4:** 跑測試（FAIL）→ 實作 → 跑測試（PASS）
- [ ] **Step 5:** Commit `feat(render): find cal: references`

---

### Task 2: 顯示模型（`present`、`describeRrule`、`formatDate`、`nextEventOccurrence`）

**Files:** Create `src/render/recur.ts`、`src/render/present.ts`、`tests/recur.test.ts`、`tests/present.test.ts`

**Interfaces:**
- Consumes: `CalObject`、`Tombstone`（types.ts）
- Produces:
  ```ts
  export type RefState = "ok" | "deleted" | "missing" | "ambiguous" | "pending" | "moved" | "maybe-moved";
  export interface RefView {
    state: RefState;
    id: string;
    text: string;            // 有標籤就用標籤，否則用即時標題；deleted 用刪除紀錄裡的 summary；missing 用 "查無此物"
    kind?: "VTODO" | "VEVENT";
    done?: boolean;          // VTODO：STATUS 為 COMPLETED 或 CANCELLED
    when?: string;           // 例如 "11/24 15:00"、"今天"、"明天 09:00"、"2027/1/5"
    overdue?: boolean;       // 未完成的 VTODO，DUE 早於 now
    recur?: string;          // 例如 "每週二、三、五"
    candidates?: CalObject[];// ambiguous 時提供
    obj?: CalObject;         // ok 時提供
  }
  export function present(id: string, label: string, objs: CalObject[], tombs: Tombstone[], now: Date): RefView
  export function formatDate(d: DateValue, now: Date): string
  export function nextEventOccurrence(obj: CalObject, now: Date): DateValue | undefined   // 只用於重複 VEVENT
  // recur.ts
  export function describeRrule(rrule: string): string
  ```
  規則：
  - `objs.length > 1` → `ambiguous`，`text` 為 `有歧義（N 筆）`
  - `objs.length === 1` → `ok`。VTODO 的 `when` 用 DUE，沒有 DUE 就用 DTSTART。VEVENT 用 DTSTART；重複 VEVENT 改用 `nextEventOccurrence`
  - 沒有 objs 但有 tombs → `deleted`；兩者都沒有 → `missing`
  - `formatDate`：同年省略年份。與 `now` 同一天顯示「今天」、隔天顯示「明天」，帶時間時接在後面（`今天 15:00`）。跨年顯示 `2027/1/5`。UTC 值先轉成本機時間
  - `describeRrule`：FREQ 為 DAILY／WEEKLY／MONTHLY／YEARLY 時分別是「每天／每週／每月／每年」；`INTERVAL=n` 時是「每 n 天」或「每 n 週」；BYDAY 依序轉成「一、二…日」，接在「每週」後面；BYMONTHDAY 寫成「每月 15 日」。其他無法描述的組合一律回傳「重複」

- [ ] **Step 1: 寫失敗的測試**。`now` 固定為 `new Date(2026, 10, 19, 10, 0)`（本機時間），測試前設定 `process.env.TZ = "Asia/Taipei"`（寫在 `vitest.config.ts` 的 `env`）：
  - `describeRrule`：
    - `FREQ=WEEKLY;BYDAY=TU,WE,FR` → `每週二、三、五`
    - `FREQ=WEEKLY` → `每週`
    - `FREQ=DAILY;INTERVAL=2` → `每 2 天`
    - `FREQ=MONTHLY;BYMONTHDAY=15` → `每月 15 日`
    - `FREQ=YEARLY` → `每年`
    - `FREQ=WEEKLY;UNTIL=20261202` → `每週`
    - `FREQ=MONTHLY;BYDAY=2MO` → `重複`
  - `formatDate`：
    - `{20261119T150000, tzid}` → `今天 15:00`
    - `{20261120T090000, tzid}` → `明天 09:00`
    - `{20261124T150000, tzid}` → `11/24 15:00`
    - `{20261119, dateOnly}` → `今天`
    - `{20270105, dateOnly}` → `2027/1/5`
    - `{20261120T040000Z}`（UTC）→ `明天 12:00`
  - `present` 用 fixtures 解析出的 `CalObject`（直接呼叫 `parseResource`）：
    - test2 master、空標籤 → `state ok`、`text "test2"`、`recur "每週二、三、五"`、`when "12/16 15:00"`、`done false`
    - 同一筆、標籤為 `"週報"` → `text "週報"`
    - 完成副本 → `done true`、`overdue false`
    - 自己構造 DUE 在 `20261118T090000` 且 NEEDS-ACTION 的 VTODO → `overdue true`
    - 兩筆 objs → `ambiguous`、`text "有歧義（2 筆）"`
    - 只有 tomb（summary `"暫存刪除"`）→ `deleted`、`text "暫存刪除"`；空標籤時要用 summary，有標籤時用標籤
    - 什麼都沒有 → `missing`、`text "查無此物"`
  - `nextEventOccurrence`：
    - baseline 的 test4（`FREQ=WEEKLY`、全天、DTSTART 為 20261119）在 now = 2026-11-20 時 → `{ value: "20261126", dateOnly: true }`
    - 自己構造帶 TZID 的每週事件，DTSTART 為 `20261117T100000`，now = 2026-11-19 → `20261124T100000`
    - 已經過了 `UNTIL` → `undefined`
- [ ] **Step 2–4:** FAIL → 實作 → PASS
- [ ] **Step 5:** Commit `feat(render): presentation model, rrule text, dates`

---

### Task 3: chip DOM 與詳情視窗的內容

**Files:** Create `src/render/chip.ts`、`tests/chip.test.ts`、`styles.css`

**Interfaces:**
- Consumes: `RefView`
- Produces: `renderRef(el: HTMLElement, view: RefView, onClick: (view: RefView) => void): void`。它會清空 `el`，再填入：
  - 外層 class `caldav-ref`，加上 `caldav-ref--<state>`，`done`、`overdue` 時另加 `caldav-ref--done`、`caldav-ref--overdue`
  - 子元素依序：
    1. `.caldav-ref__icon`：VTODO 未完成 `☐`、完成 `☑`、VEVENT `◷`、deleted `⌫`、missing 和 ambiguous `?`
    2. `.caldav-ref__text`：`view.text`
    3. `.caldav-ref__when`（有值才出現）
    4. `.caldav-ref__recur`（有值才出現）
  - `el.setAttribute("data-cal-id", view.id)`；`title` 屬性放 tooltip（完整標題加日期）
  - `click` 時呼叫 `preventDefault()`、`stopPropagation()`，再呼叫 `onClick(view)`；`mousedown` 也要 `preventDefault`，避免 Live Preview 把游標移進參照
- `styles.css`：
  - chip 是 inline，帶細邊框和圓角，`cursor: pointer`
  - `--done` 的文字加刪除線、顏色用 `--text-muted`
  - `--overdue` 的日期用 `--text-error`
  - `--deleted` 和 `--missing` 用 `--text-faint`
  - `--ambiguous` 用 `--text-warning`

- [ ] **Step 1: 寫失敗的測試**（jsdom）：
  - ok 加 done → 有 `caldav-ref--done`，icon 是 `☑`，`when` 和 `recur` 兩個元素都存在
  - missing → 沒有 `when` 元素，text 是 `查無此物`
  - click 時 onClick 被呼叫一次，事件的 `defaultPrevented` 為 true
  - 對同一個 el 呼叫兩次 `renderRef`，不會出現重複的子元素
- [ ] **Step 2–4:** FAIL → 實作 → PASS
- [ ] **Step 5:** Commit `feat(render): ref chip element and styles`

---

### Task 4: 記憶體索引

**Files:** Modify `src/cache/db.ts`（新增 `allObjects(): Promise<CalObject[]>`、`allTombstones(): Promise<Tombstone[]>`）；Create `src/render/index.ts`、`tests/index.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export class MemoryIndex {
    load(cache: CacheStore | undefined): Promise<void>  // undefined 時清空；完成後觸發 listeners
    get(id: string): { objs: CalObject[]; tombs: Tombstone[] }   // 同步查詢；id 會先轉小寫
    onChange(fn: () => void): () => void                // 回傳取消訂閱的函式
    readonly version: number                            // 每次 load 加 1，讓 widget 用 eq() 判斷要不要重繪
  }
  ```

- [ ] **Step 1: 寫失敗的測試**（fake-indexeddb）：
  - 載入後 `get` 拿得到物件和刪除紀錄；用大寫 id 也查得到
  - `onChange` 在 load 後被呼叫；呼叫取消函式之後就不再被呼叫
  - `load(undefined)` 之後 `get` 回傳兩個空陣列，`version` 加 1
  - `allObjects`、`allTombstones` 的數量與 upsert／remove 的結果一致
- [ ] **Step 2–4:** FAIL → 實作 → PASS
- [ ] **Step 5:** Commit `feat(render): in-memory index over the cache`

---

### Task 5: Live Preview

**Files:** Create `src/render/livePreview.ts`；Modify `package.json`（devDependency 加 `@codemirror/language`；esbuild 已把 `@codemirror/*` 設成 external）

**Interfaces:**
- Consumes: `findRefs`、`present`、`renderRef`、`MemoryIndex`
- Produces: `livePreviewExtension(index: MemoryIndex, onClick: (v: RefView) => void): Extension`，以 `Prec.highest` 包住（T7：優先權要高於 Obsidian 自己的連結 decoration）

行為：
- 只掃描 `view.visibleRanges`，以行為單位呼叫 `findRefs(lineText, line.from)`
- 跳過程式碼：用 `syntaxTree(state).resolveInner(pos, 1)` 往上找，節點名稱含 `code`（不分大小寫）就跳過。Obsidian 實際的節點名稱在 Step 1 先查清楚，結果記進 ledger
- 選取範圍（任一 range，包括游標）與參照的 `[from, to]` 有交集時不裝飾，顯示原文
- 用 `Decoration.replace({ widget })` 換掉整段參照。Widget 的 `eq()` 比對 `id`、`label` 和 `index.version`
- 在 `docChanged`、`selectionSet`、`viewportChanged`，以及收到 `refreshEffect` 時重建。`refreshEffect` 是 `StateEffect.define<null>()`，由 main.ts 在索引變更時，對所有 Markdown leaf 的 `editor.cm` dispatch

- [ ] **Step 1:** 在 headless 臨時 vault 裡用 `obsidian eval` 查出 Obsidian 對 inline code 和 fenced code 用的 syntax tree 節點名稱，記進 ledger
- [ ] **Step 2:** 實作。這是 CM6 膠合程式，純邏輯已由 Task 1–4 覆蓋，這裡由 Step 3 的 headless 驗證把關
- [ ] **Step 3:** headless 驗證。臨時 vault 裡放 `m2.md`，內容逐行如下：
  1. `空標籤 [](cal:5cd3cmqd)`
  2. `有標籤 [週報](cal:5cd3cmqd)`
  3. `兩個 [](cal:5cd3cmqd) 和 [](cal:zzzzzzzz)`（`zzzzzzzz` 不存在）
  4. `` 行內 `[](cal:5cd3cmqd)` ``
  5. fenced code block，內容為 `[](cal:5cd3cmqd)`
  6. `畸形 [](cal:abc)`

  在 Live Preview 讀取 DOM（游標放在檔尾的空行），確認：
  - `.caldav-ref` 有 4 個（第 1、2 行各 1 個，第 3 行 2 個），其中 1 個的 class 是 `caldav-ref--missing`
  - 第 4、5 行沒有被渲染
  - 游標移進第 1 行的參照時，`.caldav-ref` 變成 3 個；移回檔尾後恢復 4 個
  - 用 curl 把 test2 的 SUMMARY 改成 `test2-改`，再呼叫 `syncNow`：不需要重開筆記，chip 的文字就變成 `test2-改`。驗證完把標題改回 `test2`
- [ ] **Step 4:** Commit `feat(render): live preview widgets`

---

### Task 6: 閱讀模式、詳情視窗、插件組裝、發佈 0.2.0

**Files:** Create `src/render/readingMode.ts`、`src/render/detailModal.ts`；Modify `src/main.ts`、`manifest.json` 和 `package.json`（version `0.2.0`）、`README.md`

**Interfaces:**
- `readingModeProcessor(index: MemoryIndex, onClick): MarkdownPostProcessor`：選取 `a.external-link[href^="cal:"]`，用 `findRefs` 解析 `` `[${a.textContent}](${a.getAttribute("href")})` `` 取得 id 和 query（無效的就略過）；建一個 `span`，用 `renderRef` 填入後取代 `<a>`。另外用 `MarkdownRenderChild` 訂閱 `index.onChange` 自動重繪，卸載時取消訂閱
- `DetailModal(app, view: RefView)`：唯讀顯示以下內容：
  - 標題
  - 類型、狀態
  - 開始、到期、結束（各用 `formatDate`）
  - 重複規則（`describeRrule` 加上原文）
  - 清單名稱
  - 備註：用 ical.js 取 `DESCRIPTION`，純文字顯示
  - 短 ID、UID
  
  ambiguous 時逐一列出候選，deleted 時顯示刪除時間。
- main.ts：
  - `index = new MemoryIndex()`
  - 每次 `syncNow` 完成後（不論成敗），用目前 session 的 cache 執行 `index.load(cache)`；設定不完整時 `load(undefined)`
  - 啟動時先 `load` 一次，這樣離線開啟也能看到快取
  - `index.onChange` 時對所有 Markdown leaf 的 `editor.cm` dispatch `refreshEffect`
  - 註冊 `registerEditorExtension(livePreviewExtension(...))` 和 `registerMarkdownPostProcessor(readingModeProcessor(...))`
  - onClick 開啟 `DetailModal`

- [ ] **Step 1:** 實作
- [ ] **Step 2:** `npm test` 與 `npm run build` 都通過
- [ ] **Step 3:** headless 驗證閱讀模式：同一份 `m2.md` 切到 preview，`.caldav-ref` 的數量與 Live Preview 一致，程式碼裡的沒有渲染，畸形參照仍然是原本的連結。用 DOM 觸發 click，確認開出 `.modal`，而且沒有開啟任何外部網址
- [ ] **Step 4:** 移除臨時 vault；push；`gh release create 0.2.0 main.js manifest.json styles.css`
- [ ] **Step 5:** 交給使用者 iPhone 試用清單：在任一筆記寫 `[](cal:5cd3cmqd)`，在 Live Preview 和閱讀模式都要看到 chip；點擊開詳情；在提醒事項改標題後回到 Obsidian，chip 自動更新（這是 iOS 上的 T7）
