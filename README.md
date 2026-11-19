# obsidian-caldav

Inline references from Obsidian notes to CalDAV tasks and events. CalDAV stays the single source of truth; notes only hold `[label](cal:xxxxxxxx)` references.

**Status: alpha (M5).** 0.4.x syncs all calendar collections into a per-device IndexedDB cache, renders `[label](cal:xxxxxxxx)` references inline, inserts references, creates tasks (offline-capable), and edits title / status / date. Edits patch the original iCalendar data and keep everything else; on a 412 the plugin merges automatically when the server changed other fields and asks you to choose when it changed the same field. Recurring events and per-occurrence overrides are edited in your calendar app.

0.5 tracks tasks moved between lists (iOS gives a moved task a new UID): when an old object disappears and exactly one object with the same CREATED and SUMMARY appears in another list, the plugin keeps a local alias and shows the reference as moved (↪). **更新參照** rewrites the old short IDs in your notes after you confirm (only the ID changes; refs inside code, frontmatter and comments are left alone). The detail view lists the notes that reference an item. A device that never saw the old object can't resolve the alias, so run 更新參照 on a device that did.

## Install (BRAT)

BRAT → Add beta plugin → `ryanwaha/obsidian-caldav`.

## Setup

Settings → server URL (`https://host:port`, no path; `.well-known` is not used), username, password (stored in Obsidian SecretStorage, never in the vault). Sync runs on startup, every N minutes, and whenever Obsidian returns to the foreground.

Commands: **插入任務／事件參照**, **新建任務並插入參照**, **立即同步**, **以短 ID 查詢**, **更新參照（已搬移的任務）**.

Click a task's checkbox icon to toggle completion; click elsewhere on a reference for details and editing. References inside inline code or code blocks are not rendered. Moving the cursor into a reference in Live Preview shows its source so the label can be edited.

## License

MIT
