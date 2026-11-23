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
