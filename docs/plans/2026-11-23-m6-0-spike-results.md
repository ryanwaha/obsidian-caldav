# M6-0 實測結果

環境：ryanserver；Radicale 3.9.2（kozea/radicale:3.9.2）；Obsidian 1.13.7（Electron 43.3.0，spike 實例）；LiveSync 0.25.56。日期 2026-11-23。

## S4 Radicale 的 WebDAV MOVE —— ✅ 通過

- `MKCOL /ryanw/m6-spike/`（VTODO）→ 201。
- 在 `test` PUT `m6-spike-move`（含 `X-TEST:keep`）→ 201，ETag `"4c2fcab6…"`。
- `MOVE test/m6-spike-move.ics → m6-spike/m6-spike-move.ics`，`Overwrite: F` → **201**。
  - 新位置 GET 200，內容與搬移前**逐字相同**（`diff` 無差異；UID、X-TEST 保留）。
  - **ETag 不變**（`"4c2fcab6…"`）。Radicale 的 ETag 是內容雜湊，內容不變 ETag 就不變。
  - 舊位置 GET 404。
  - 舊 sync-token 查 `test`：該 href `404 Not Found`；查 `m6-spike`：該 href `200` + 同一 ETag。和普通的「刪除＋新增」在增量同步上看起來一樣。
- `Overwrite: F` 且目的地 href 已存在 → **412**，來源不動。

**對設計的影響**
- §8.4「Obsidian 改 `list` → MOVE，UID 不變」可行，`list` 維持可寫。
- 伺服器同步引擎會把 MOVE 看成「舊集合刪除＋新集合出現」。因為 UID 相同、短 ID 相同，投影檔不需 rename；但搬移偵測（以 UID 不同為前提）不會誤判。實作時要讓「同 UID 在另一集合出現」直接更新投影檔的 `list`，不要先標 `_deleted`。
- MOVE 用 `Overwrite: F`，目的地衝突時 412 → 寫 `_sync: rejected`。

## 版本說明（影響 S1–S6 的解讀）

spike 實例用的是同一個安裝檔（Electron 外殼 1.13.7），但 Obsidian 會把更新的 app（`obsidian-1.15.1.asar`）下載到 user-data-dir，重啟後載入。所以 **S1–S5 實測的 app 版本是 1.15.1**，和 iPhone（1.15.1）相同；正式 headless 實例停在 1.13.7（`~/.config/obsidian` 沒有更新的 asar，版本凍結見 vault `infrastructure/obsidian-versions.md`）。M6 伺服器模式上線前，正式 headless 需要升級或對 1.13.7 重驗。

## S6 headless 下的 secretStorage —— ✅ 通過

- 同樣的 `--password-store=basic`。`setSecret('m6-spike-probe','v1')` 後 `getSecret` → `"v1"`，`listSecrets()` → `["m6-spike-probe"]`。
- 結束實例（新 PID）再啟動，`getSecret` 仍為 `"v1"`。
- 在 user-data-dir 以 grep 找不到明文 `m6-spike-probe` 的值。
- **注意**：`basic` 模式下 Chromium 的 safeStorage 是用固定金鑰混淆，不是真正的加密。任何能以 ryanw 身分讀檔的程序都能還原帳密，安全性等同 600 權限的檔案。對 ryanserver 的威脅模型（單一使用者、docker 群組已等同 root）可接受，但要記在 M6 的已知代價。
- 測試 secret 已清空（API 沒有刪除方法，`setSecret(id,'')`）。

**對設計的影響**：伺服器模式的 CalDAV 帳密用 `app.secretStorage`（沿用 0.5.0 的做法），不需要 §11 的退路。

## 基準：探針與 `processFrontMatter`（Task 3）

- 一次 `processFrontMatter` → `modify` 一次，約 2 ms 後 `metadataCache.changed` 一次。
- **`modify` 觸發當下，`metadataCache` 仍是舊的 frontmatter**（status 還是 needs-action）；`changed` 時才是新值。
- **對設計的影響**：伺服器的上行處理與客戶端的守門，都以 `metadataCache.on('changed')` 為觸發點讀 frontmatter，不在 `modify` 裡讀 metadataCache。刪除、改名仍用 vault 事件。

## S1 Live Preview 中 wikilink 的節點與 widget —— ✅ 通過（桌面 app 1.15.1）

**先例**：TaskNotes 的 `TaskLinkOverlay.ts` 用正規表示式 `/\[\[([^\]]+)\]\]/g` 掃描全文，再用 `Decoration.replace` 把整個連結換成 widget，游標進入時還原；沒有排除程式碼。M6 不採用，改走 syntax tree。

**節點名稱**（`syntaxTree` 逐行 dump，位置為行內偏移）：

| 內容 | 節點序列 |
|---|---|
| `[[k3f9x2qa\|交週報]]` | `formatting-link_formatting-link-start` → `hmd-internal-link_link-has-alias`（目標）→ `hmd-internal-link_link-alias-pipe` → `hmd-internal-link_link-alias`（標籤）→ `formatting-link_formatting-link-end` |
| `[[k3f9x2qa]]` | `formatting-link_formatting-link-start` → `hmd-internal-link` → `formatting-link_formatting-link-end` |
| `![[k3f9x2qa]]` | `formatting-embed_formatting-link_formatting-link-start` → `hmd-embed_hmd-internal-link` → `formatting-link_formatting-link-end` |
| `[[k3f9x2qa#標題\|甲]]` | 同有標籤的形式，目標節點文字含 `#標題` |
| 行內程式碼、fenced code 裡的 `[[…]]` | 只有 `inline-code`／`hmd-codeblock`，**沒有任何 link 節點** |

**判斷規則（探針實作，M6 沿用）**：遇到 `formatting-link-start` 開始一個連結（名稱含 `formatting-embed` 為嵌入）；第一個名稱含 `hmd-internal-link` 但不含 `link-alias` 的節點是目標；遇到 `formatting-link-end` 時，目標去掉 `#…` 後用 `metadataCache.getFirstLinkpathDest(目標, 來源路徑)` 解析，落在 `_caldav/` 且不是嵌入，就在 `formatting-link-end` 的 `to` 加 `Decoration.widget({ side: 1 })`。程式碼排除是 syntax tree 自然給的，不用另外判斷。

**驗證**（游標在檔尾）：
- chip 數：第 1、2 行各 1，第 3 行 2，行內程式碼 0，fenced code 0，嵌入 0（嵌入整塊渲染成 embed，不加 chip），`[[…#標題|甲]]` 1。✅
- 游標移進第 1 行連結：連結展開為原文 `[[k3f9x2qa|交週報]]`，chip 仍在，位置在 `]]` 之後（`evidence/s1-cursor-in-link.png`）。✅
- 以真實滑鼠點擊 chip：記錄到 `chip-click`；目前檔案仍是 `note.md`，游標停在原處，沒有進入連結。✅（`mousedown` 要 `preventDefault`，`ignoreEvent()` 回傳 `true`）
- 點連結文字：開啟 `_caldav/k3f9x2qa.md`，原生行為不受影響。✅
- 閱讀模式：5 個 `a.internal-link`，`data-href` 分別是 `k3f9x2qa`、`k3f9x2qa`、`k3f9x2qa`、`k3f9x2qb`、`k3f9x2qa#標題`，全部可解析到 `_caldav/`；程式碼與嵌入不產生 `a.internal-link`。✅

**未測（Review Focus 1）—— 👤 iPhone 檢查清單**（M6 客戶端的 chip 做好後，在 iPhone 上確認）：
1. Live Preview 中 chip 出現在連結後面，不換行錯位。
2. 點 chip（☐、日期）只觸發 chip，不開啟連結、不把游標移進連結、不叫出鍵盤。
3. 點連結文字照常開啟投影檔。
4. 游標移進連結時，原文展開，chip 不跳位。
5. 閱讀模式同樣有 chip。

## S2 `[[` 自動完成插入的格式 —— ✅ 通過（桌面 app 1.15.1）

以真實鍵盤在 Live Preview 輸入 `[[` + 查詢字串（中文用 `insertText`），從建議清單按 Enter 選取：

| 查詢 | 建議清單 | 插入結果 |
|---|---|---|
| `交週` | `交週報` `_caldav/k3f9x2qa`（只有 alias 那一項） | `[[k3f9x2qa\|交週報]]` |
| `繳費` | `繳費：電費 \| 十一月 #帳單` `_caldav/k3f9x2qb` | `[[k3f9x2qb\|繳費：電費 \| 十一月 #帳單]]` |

- 設定：`useMarkdownLinks: false`、`newLinkFormat: "shortest"`。D3 的「快照標籤由自動完成自然產生」成立。
- **特殊字元（Review Focus 5）**：alias 原樣插入，不跳脫。
  - `|`：只有第一個 `|` 分隔目標與標籤；`metadataCache` 的 `link` 為 `k3f9x2qb`，`displayText` 為完整標籤；閱讀模式解析正確。✅
  - `#`：Live Preview 會把標籤裡的 `#帳單` 上色成 hashtag，但 `metadataCache` 的 `tags` 為空，**不會變成筆記標籤**。只影響外觀。
  - `：` 等全形字元無影響。
- **對設計的影響**：已驗證的字元（`：`、`|`、`#`）不需清理。未測：標題含 `[[`、`]]`、換行，以及連結放在 Markdown 表格裡（`|` 會切斷表格）；投影時 alias 至少要替換 `[[`、`]]`、換行。S1 的判斷規則（目標 = 第一個不含 `link-alias` 的 `hmd-internal-link` 節點）在標籤含 hashtag 節點時仍正確。

## S3 Properties 與 Bases 編輯產生的事件 —— ✅ 通過（桌面 app 1.15.1），附一項設計問題

以真實點擊與輸入操作（日期欄以 `fill` 填值，Chromium 原生 date picker 彈窗不在 DOM 裡，點不到；手動點選 picker 理論上同樣在確認時才寫入，但未實測）：

| 操作 | 事件 | 寫入時機 | 寫入的原始文字 |
|---|---|---|---|
| Properties 改 `title`（打字＋Enter） | modify ×1、changed ×1（+5 ms） | 按 Enter 時；打字過程不寫 | `title: 交週報二` |
| Properties 改 `due`（date input） | modify ×1、changed ×1（+3 ms） | **失焦時**才寫；只在輸入框裡改值不會寫 | `due: 2026-12-01` |
| Properties 改 `due` 為 datetime | modify ×1、changed ×1 | 失焦時 | `due: 2026-12-01T09:30:00`（本地時間，帶秒，無時區） |
| Bases 表格改 `status` 儲存格 | modify ×1、changed ×1（+13 ms） | Enter | `status: completed` |
| Bases 表格改 `due`（datetime） | modify ×1、changed ×1（+9 ms） | Enter | `due: 2026-12-24T10:00:00` |
| body 打一行字 | 打完約 2 s 後 modify ×1、changed ×1（編輯器自動存檔） | 自動存檔 | body 改變，frontmatter 不動 |

- **Bases 表格可以直接編輯**：儲存格本身就是 Properties 的 widget（`.metadata-property-value`），寫入路徑相同。
- 每次「確認」只產生一組 modify + changed，事件間隔最大 18 ms；**沒有逐字寫入**。
- **debounce 建議**：伺服器以 `changed` 為觸發，依檔案 debounce **1 s**（規則：單次編輯內最大間隔 18 ms × 2，下限 1 s）。用途是合併連續幾個欄位的修改，以及 LiveSync 逐筆送達的修改。
- body 編輯只產生 body 變化，伺服器比對 frontmatter 沒變就不動 CalDAV（設計 §8.2 已涵蓋）。

### ⚠️ 設計問題：同一個 property 只能有一種型別

- Obsidian 的 property 型別是**整個 vault 一個**（`.obsidian/types.json`），而 `.obsidian/` 不經 LiveSync 同步，每台裝置各自一份。
- 實測：
  - `due` 型別為 `date` 時，`2026-12-24T10:00:00` 顯示成 `2026-12-24`，**時間被藏起來**，在那格編輯就會丟掉時間。
  - 型別為 `datetime` 時，`2026-11-30` 顯示成 `2026-11-30T00:00`，編輯後會寫成帶時間，**全天變成定時**（違反 E3「保留原本形式」）。
- 設計 §6.2 讓 `due` 同時承載 date 與 datetime，在 Properties／Bases 上不可行。提議改法（待使用者確認，見 Task 8）：
  - `due`（型別 `date`）：一律只放日期；
  - `due_time`（型別 `text`，`HH:mm`）：有時間才有值。沒有 `due_time` 就是全天（`VALUE=DATE`），有就是 `TZID=Asia/Taipei` 的定時。
  - VEVENT 的 `start`／`end` 同理拆成 `start`、`start_time`、`end`、`end_time`。
  - 客戶端與伺服器模式啟動時，以 `app.metadataTypeManager.setType` 設定這些欄位的型別（每台裝置各自需要，因為 `types.json` 不同步）。

## S5 LiveSync 同時修改同一檔案 —— ⚠️ 部分通過

**環境**：spike 實例裡兩個 vault（`vault-a`、`vault-b`），LiveSync 0.25.56 接專用資料庫 `m6-spike`（`markdowns` 的 `update_seq` 全程維持 149525，未被觸及）。合併相關設定照正式伺服器 vault：`disableMarkdownAutoMerge: false`（自動合併開）、`resolveConflictsByNewerFile: false`、`writeDocumentsIfConflicted: false`、`showMergeDialogOnlyOnActive: false`、不加密。

**方法**：兩邊 `closeReplication()` 暫停 → 各自修改同一個 `_caldav/k3f9x2qa.md` → 兩邊 `openReplication()` 恢復 → 等 30 s，比對兩邊檔案並查 CouchDB 的 `?conflicts=true`。

| 情境 | 結果 |
|---|---|
| A 改 frontmatter（`status`），B 在 body 加一行 | ✅ 自動合併，兩邊逐字相同且包含兩邊的修改；無對話框；伺服器上的 `_conflicts` 數秒後自動清除 |
| A 改 `title`，B 改 `due`（不同欄位，中間隔一行） | ✅ 同上。**相鄰行未測**，M6-1 補測 |
| A、B 把 `status` 改成不同值（同一行） | ❌ 無法自動合併：A 跳出 LiveSync 的「Conflicting changes」對話框（逐字 diff，畫面上兩個值混成 `cancellompleted`，選項 Use Base／Use Conflicted／Concat both／Not now）；B 沒有對話框；**兩邊檔案不一致**，伺服器保留衝突版本 |

**觀察**
- LiveSync 對 CouchDB 保留的 `_` 前綴會跳脫：`_caldav/x.md` 的文件 id 是 `/_caldav/x.md`。目錄名 `_caldav/` 可用。
- 設計 §10 擔心的「使用者寫 body、伺服器改 frontmatter」**不會造成衝突**，這是最常見的情況。
- 會衝突的只有「同一行被兩邊改成不同值」。在 M6 裡這代表：使用者在裝置上改某欄位的同時（LiveSync 延遲約數秒內），伺服器因為原生客戶端的修改而重寫同一欄位。機率低，但**發生時對話框可能跳在 headless 伺服器上，沒人能按**，衝突就一直卡著。
- LiveSync 有內部方法 `getConflictedDoc`、`tryAutoMerge`（`services.database._localDatabase`），沒有公開、穩定的「以指定內容解衝突」API。

**建議（待 M6-1 定案）**
1. **縮小窗口**：伺服器在檔案最近 N 秒內收到遠端修改時延後重寫（N 取 LiveSync 延遲上限，建議 10 s），並且先處理完上行再重新投影。
2. **伺服器端不得留下卡住的衝突**：伺服器模式偵測 `_caldav/` 檔案的 LiveSync 衝突，以程式解決：frontmatter 取伺服器（CalDAV）的值，裝置那一版的不同值寫進 `_conflict` 交給客戶端的 M6 衝突對話框（D8），body 兩邊不同時串接。M6-1 需要先做一個小實測：確認 LiveSync 內部 API 能否做到，以及跨版本的穩定性；做不到時的退路是伺服器的 LiveSync 對 `_caldav/` 以外不變、但改用「新檔案勝出」只針對 `_caldav/`（需確認 LiveSync 有沒有路徑層級的設定）。
3. 裝置之間（iPhone 對 Windows）同一行的衝突是 LiveSync 本來就有的行為，不是 M6 新增的，維持由使用者在 LiveSync 對話框解決。

**👤 待使用者提供（Review Focus 3）**：iPhone 與 Windows 上 LiveSync 的這三個設定值：`disableMarkdownAutoMerge`、`resolveConflictsByNewerFile`、`writeDocumentsIfConflicted`（設定畫面的「Conflict resolution」一節）。正式伺服器 vault 為 false／false／false。

## 清理（Task 8）—— 2026-11-23

- spike 實例：`stop.sh` → `stopped`；`~/m6-spike` 已刪除（內含測試用 LiveSync `data.json`）。
- CouchDB：`DELETE /m6-spike` → `{"ok":true}`；`_all_dbs` → `["_replicator","_users","markdowns"]`。
- Radicale：`DELETE /ryanw/m6-spike/` → 200；PROPFIND `/ryanw/` 只剩 `tasks/`、`test/`；`test` 裡 `m6-spike` 開頭的物件數 0。
- 正式實例：`~/.config/obsidian/obsidian.json` 只有主 vault（`updateDisabled: true`，即 1.13.7 凍結的來源）；`obsidian.service` active。

## S7 以程式解決 LiveSync 衝突 —— ✅ 通過（M6-1 Task 1；Obsidian 1.13.7、LiveSync 0.25.56）

- 環境：`spike/m6-probe/setup-livesync.sh` 重建兩個 vault + `m6-spike` 資料庫；`s5.mjs fm_same_field` 製造衝突（A：`status: completed`，B：`status: cancelled`）→ CouchDB `_conflicts: ["2-7e80…"]`。這次兩端都**沒有**跳出對話框（衝突靜靜留著，兩邊檔案不一致）。
- 呼叫序列（取自 LiveSync 自己「Concat both」按鈕的路徑，`driver/s7.mjs`），在 B 端（模擬 headless 伺服器）執行：
  1. `doc = core.localDatabase.getDBEntry(path, { conflicts: true }, false, true, true)` → `doc._conflicts` 是落敗版本清單；`data` 可能是字串或字串陣列（要 `join("")`）。
  2. `other = core.localDatabase.getDBEntry(path, { rev }, false, true, true)` 讀另一版。
  3. 依策略組出最終內容（本測：`status` 取 `completed`，其餘取目前版）。
  4. `core.databaseFileAccess.storeContent(path, content)` → `true`。
  5. `core.services.conflict.resolveByDeletingRevision(path, rev, "m6-server")` → `Symbol(auto_merged)`。
- 30 s 後：兩端檔案**逐字相同**、`status` 都是 `completed`；CouchDB `?conflicts=true` 無 `_conflicts`（rev 4-…）；兩端都沒有對話框。
- 這些都是 LiveSync 的**內部** API（`core.localDatabase`、`core.databaseFileAccess`、`core.services.conflict`），LiveSync 升級時可能變動。M6-2 實作要：啟動時做特徵檢查（方法都存在才啟用自動解衝突，否則 Notice 並停用自動解衝突，交回 LiveSync 對話框），並把 LiveSync 版本列入 `infrastructure/obsidian-versions.md` 的凍結清單。

### 順帶發現（S8 的前導）
`processFrontMatter` 往返之後：`due_time: "09:30"` → `due_time: 09:30`（引號消失）；`_hash: 0000000000000001` → `_hash: 1`（被當成數字，前導零遺失）。見 S8。
