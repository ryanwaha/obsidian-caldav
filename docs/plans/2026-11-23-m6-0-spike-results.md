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
