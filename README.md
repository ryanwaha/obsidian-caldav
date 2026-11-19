# obsidian-caldav

Inline references from Obsidian notes to CalDAV tasks and events. CalDAV stays the single source of truth; notes only hold `[label](cal:xxxxxxxx)` references.

**Status: pre-alpha (M2).** 0.2.x syncs all calendar collections into a per-device IndexedDB cache and renders `[label](cal:xxxxxxxx)` references inline (Live Preview and reading mode) with live title, status, date and recurrence. Clicking a reference opens a read-only detail view. Nothing is written to the server or to notes yet.

## Install (BRAT)

BRAT → Add beta plugin → `ryanwaha/obsidian-caldav`.

## Setup

Settings → server URL (`https://host:port`, no path; `.well-known` is not used), username, password (stored in Obsidian SecretStorage, never in the vault). Sync runs on startup, every N minutes, and whenever Obsidian returns to the foreground.

Commands: **立即同步**, **以短 ID 查詢**.

References inside inline code or code blocks are not rendered. Moving the cursor into a reference in Live Preview shows its source so the label can be edited.

## License

MIT
