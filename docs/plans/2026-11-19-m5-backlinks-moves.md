# M5 反向索引與搬移追蹤 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans.

**Goal:** 筆記裡的參照在任務被搬到另一個清單後仍然有效：插件在本機偵測搬移並記下 alias，chip 照常顯示並加註「已搬移」；使用者可以下「更新參照」指令，把 .md 裡的舊短 ID 改寫成新的。另外建立反向索引（哪些筆記參照了某個短 ID），詳情裡列出這些筆記，「更新參照」也靠它找出要改寫的檔案。

**Spec:** `~/docs/homelab/obsidian-caldav.md`
- §4.1：反向索引是衍生資料，不另外存
- §6.1：程式碼裡的 `cal:` 不算參照
- §6.4：已搬走、可能已搬走、有歧義
- §7.2：反向索引用 `vault.cachedRead` + regex
- §11.1 T4：搬移追蹤的比對規則

## 搬移偵測（引擎）

T4 的事實：iOS 搬清單時，舊集合會 DELETE，新集合會 PUT 一個新 UID。`CREATED` 和 SUMMARY 原樣保留。

### 比對規則
- 每輪同步結束後，對**所有還沒有 alias 的 tombstone** 做比對，不限於本輪的刪除。原因：新集合可能這輪失敗，或者 iOS 的 PUT 在同步途中才到，下一輪才比對得到。
- 候選是所有現存物件中同時符合下列條件的：
  - `collection` 和 tombstone 不同；
  - `uid` 不同；
  - `kind` 相同（舊 tombstone 沒有 kind 時不檢查）；
  - `created` 相同，而且兩邊都有值（不能 undefined 對 undefined）；
  - `summary` 相同。
- 恰好 1 筆：寫入 alias（舊 UID → 新 UID），**偵測當下就持久化**。這樣之後在新清單改標題，alias 也不會失效。
- 0 筆或多筆：不寫入，渲染時再推導。

### 資料
- DB 升到 v3，新增 store `aliases`（keyPath `fromUid`，index `fromShortId`）。
  - 它加進 `CACHE_STORES`，換帳號時會一起清空。它是可以重建的衍生資料。
- Tombstone 新增 `kind`，在 `removeObjects` 時寫入。
- `removeObjects(hrefs, at)`：`at` 由 engine 傳入 `report.startedAt`。
  - 理由：同一輪裡如果 B 比 A 先同步，B 的 `lastSyncAt` 會早於 A 新 tombstone 的 `deletedAt`，普通的刪除就會誤判成「可能已搬走」。
  - 消失的集合（gone-collection）那條路徑也一樣改用 `startedAt`。
- `SyncReport.aliases`：本輪新增的 alias 數。`syncNow` 的重載條件要加上它，否則只有新增 alias 的那一輪不會重繪。

## 渲染時的解析（MemoryIndex + present）

`MemoryIndex.load` 額外讀進 aliases 和 collections，算出 `resolve(id)`，結果依序判斷：
1. **有現存物件**：照舊（ok／有歧義）。
2. **有 tombstone**，沿 alias 鏈找（舊 UID → 新 UID → 若新的也被刪了，再看它的 alias，最多 5 跳）。
   - 找到現存物件就是 **moved**：帶 `obj` 和 `movedFrom`（舊清單）。
3. **沒有 alias，就即時比對**（規則同上）。
   - 多筆：**ambiguous**，`ambiguity: "move"`，列出候選。
   - 恰好 1 筆：這種情況表示引擎還沒跑到；當作 moved 顯示，不寫入。
4. **0 筆，而且有相關的集合還沒同步過這個刪除**：**maybe-moved**。
   - 「相關」指 `components` 包含 tombstone 的 kind，而且不是 tombstone 自己的集合。
   - 「還沒同步過」指沒有 `lastSyncAt`，或 `lastSyncAt < deletedAt`。
5. 其餘：deleted。

`RefView` 的變更：
- 新增 `movedFrom?: string`。
- 新增 `ambiguity?: "shortid" | "move"`。原因：詳情裡「短 ID 對到多筆」這段文字，對搬移造成的歧義是錯的，需要分開。

## 反向索引

- `src/backlinks/scan.ts`：`scanRefs(text): RefMatch[]`，純函式，排除以下區塊：
  - frontmatter；
  - fenced code（``` 和 ~~~，結束 fence 至少要和開頭一樣長）；
  - 行內程式碼（同長度的反引號對）；
  - `%%…%%` 註解。
  - 剩下的文字交給既有的 `findRefs`，regex 和渲染器一致。
- `BacklinkIndex`：只在記憶體裡（§4.1），提供下列方法：
  - `setFile(path, text)`
  - `removeFile(path)`
  - `rename(old, new)`
  - `notesFor(id)`
  - `referencedIds()`
  - `onChange`
- 插件側：
  - layout ready 後分批掃描（每 50 個檔案讓出一次），檔案內容不含 `cal:` 就直接跳過。
  - `modify` 依檔案 debounce 500 ms；`create`、`delete`、`rename` 都要處理。
  - 只處理 `.md`。

## 更新參照（P2：使用者明確下指令才寫 .md）

- `rewriteRefs(text, map: Map<oldId, newId>): { text, count }`：
  - 用 `scanRefs` 的位置，從後往前只換掉 8 位 ID，保留標籤和 `?query`；
  - 程式碼裡的不會動。
- 指令「更新參照（已搬移的任務）」：
  1. 從反向索引的 `referencedIds()` 中，挑出 resolve 為 moved 的；
  2. 列出「舊 → 新（標題，N 篇筆記）」，按確認後才寫入；
  3. 每個檔案用 `vault.process` 在回呼內重新掃描、改寫，回報改了幾處。
- 詳情 modal：
  - moved：顯示「已從〈舊清單〉搬到〈新清單〉」和「更新這個參照」按鈕，只改寫這個 ID。
  - 搬移造成的歧義：每個候選有「改指向這一筆」按鈕。這也是明確的指令。
  - 所有狀態都列出「參照此項目的筆記」，點了開啟該筆記。

## Chip

- **moved**：
  - 照常顯示，圖示依類型和是否完成；
  - 加上 class `caldav-ref--moved`，在後面加一個 `↪` 標記；
  - 可以切換完成，也可以編輯（`state` 是 ok 或 moved，而且有 obj）。
- **maybe-moved**：
  - 圖示 `…`；
  - 文字是標籤，沒有標籤就用 tombstone 的標題；
  - 加註「可能已搬移」。

## 已知限制（寫進 commit 和設計稿）

- 快取從沒見過舊物件的裝置（例如新裝置）沒有 tombstone，也就沒有 alias，會顯示「查無此物」。這正是需要「更新參照」把改寫結果寫回 .md 的原因。
- 對舊 href 的待送修改會收到 404，變成失敗（延後處理）。
- 縮排式 code block（4 個空格）不排除，因為 Obsidian 的清單巢狀也用縮排，無法可靠區分。

## Tasks

1. **types／db**：
   - Tombstone 加 `kind`；
   - 新增 `Alias` 型別；
   - DB v3 新增 `aliases` store；
   - `putAliases`、`allAliases`；
   - `removeObjects` 的 `at` 參數。
   - 測試：升級後保留舊資料；換帳號時清空 aliases。
2. **`src/sync/moves.ts`**（純函式）：
   - `matchMove(tomb, objs)` → 候選；
   - `detectAliases(tombs, objs, aliases)` → 新的 alias；
   - `resolveMoved(id, …)` → moved／ambiguous／maybe／deleted。
   - 用表格驅動測試，涵蓋：
     - created 為 undefined；
     - 同一個集合；
     - kind 不同；
     - 多筆；
     - alias 鏈（A→B→A）；
     - 改名後 alias 仍有效；
     - maybe-moved 只看相關的集合；
     - 同一輪裡的順序。
3. **引擎**：
   - 每輪結束時偵測並持久化 alias；
   - `report.aliases`；
   - 用 `startedAt` 當 `deletedAt`。
   - 用 fake transport 測試：
     - 搬移發生在同一輪；
     - 跨兩輪（新集合第一輪失敗）；
     - 普通刪除顯示 deleted，不是 maybe-moved。
4. **MemoryIndex／present**：
   - 讀進 aliases 和 collections，`get(id)` 回傳 resolve 的結果；
   - `present` 產生 moved、maybe-moved、搬移歧義的 RefView。
5. **`src/backlinks/{scan.ts, index.ts, rewrite.ts}`**：
   - 測試涵蓋：
     - frontmatter；
     - fence 長度；
     - ~~~；
     - 行內程式碼；
     - `%%`；
     - 以設計稿 §6.1 的寫法為準的 fixture：掃到 0 個參照，改寫後內容不變；
     - 從後往前改寫，保留標籤和 query；
     - rename 和 delete。
6. **插件 UI**：
   - chip 處理新狀態；
   - 詳情 modal 加上參照筆記清單、搬移說明、改寫按鈕；
   - 「更新參照」指令和確認 modal；
   - vault 事件；
   - `lookup` 顯示搬移資訊。
7. **驗證與發佈 0.5.0**：
   - headless 只在**臨時 vault** 驗證，不碰 LiveSync vault：
     - 反向索引：建立、修改、改名、刪除筆記後，詳情列出的筆記要正確；程式碼裡的參照不算。
     - 反例：同步後在 `/ryanw/test/` DELETE 一筆，再 PUT 一筆 CREATED／SUMMARY 相同、UID 不同的物件。同一個集合不算搬移，要顯示「已刪除」。
     - 不在伺服器上另建集合（會出現在 iPhone 上）；跨集合搬移和改寫由引擎與 rewrite 的單元測試涵蓋。
   - 真正的跨清單搬移在 iPhone 試用時驗證：把被參照的任務從「測試」移到「任務」→ 確認 chip 顯示已搬移 → 執行「更新參照」→ 確認 .md 被改寫。

## Review Focus

1. **普通刪除不能被誤判**為搬移或可能已搬走，包括同一輪同步的順序、只看相關的集合。
2. **alias 只在證據唯一時建立**：created 為 undefined、同一個集合、kind 不同都不能比對。
3. **改寫 .md 只在使用者確認後進行**：
   - 只動 ID；
   - 程式碼、frontmatter、註解裡的不動；
   - 回呼內重新掃描，避免覆蓋使用者剛打的字。
4. **反向索引的成本**：
   - 啟動時分批；
   - 不含 `cal:` 的檔案跳過；
   - modify 有 debounce；
   - 不寫進 vault。
