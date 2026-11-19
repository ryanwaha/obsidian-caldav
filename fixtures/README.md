# Fixtures

從 Radicale 抓下的真實 ICS 樣本（iOS 27.2，2026-11-19），用於解析與 round-trip 測試。

- `ios-27.2/00-baseline/`：iPhone 新增的 5 筆原始物件（VTODO ×3、VEVENT ×2，含重複與全天）。
- `ios-27.2/01-T1-before.ics`：T1 由 curl 寫入、帶未知欄位的 VTODO。
- `ios-27.2/03-T3-*`：T3 初始 sync-collection 回應與 token。
- `ios-27.2/10-after-phone/`：在 iPhone 上執行 T1–T4 後的整個集合（含重複任務完成 11 次產生的副本、跨清單移動後的新 UID）。

位置提醒（`X-APPLE-STRUCTURED-LOCATION`）中的地址與座標已替換為假值，結構與摺行方式保留。
- `radicale-3.9.2/`：Radicale 對 PROPFIND／sync-collection 的實際 XML 回應（含 token 無效時的 403）。`sync-initial-with-data.xml` 的 calendar-data 已展開摺行，位置資料一樣換成假值。
