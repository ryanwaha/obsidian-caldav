# obsidian-caldav

Inline references from Obsidian notes to CalDAV tasks and events. CalDAV stays the single source of truth; notes only hold `[label](cal:xxxxxxxx)` references.

**Status: pre-alpha (M3).** 0.3.x syncs all calendar collections into a per-device IndexedDB cache, renders `[label](cal:xxxxxxxx)` references inline, lets you insert references to existing tasks/events, and create new tasks (queued locally when offline, sent on the next sync). Editing existing objects comes in M4.

## Install (BRAT)

BRAT → Add beta plugin → `ryanwaha/obsidian-caldav`.

## Setup

Settings → server URL (`https://host:port`, no path; `.well-known` is not used), username, password (stored in Obsidian SecretStorage, never in the vault). Sync runs on startup, every N minutes, and whenever Obsidian returns to the foreground.

Commands: **插入任務／事件參照**, **新建任務並插入參照**, **立即同步**, **以短 ID 查詢**.

References inside inline code or code blocks are not rendered. Moving the cursor into a reference in Live Preview shows its source so the label can be edited.

## License

MIT
