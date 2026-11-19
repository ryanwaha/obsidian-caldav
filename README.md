# obsidian-caldav

Inline references from Obsidian notes to CalDAV tasks and events. CalDAV stays the single source of truth; notes only hold `[label](cal:xxxxxxxx)` references.

**Status: pre-alpha (M1).** 0.1.x syncs all calendar collections into a per-device IndexedDB cache (sync-token, with full resync when the token expires) and lets you look objects up by short ID. Nothing is written to the server or to notes yet.

## Install (BRAT)

BRAT → Add beta plugin → `ryanwaha/obsidian-caldav`.

## Setup

Settings → server URL (`https://host:port`, no path; `.well-known` is not used), username, password (stored in Obsidian SecretStorage, never in the vault). Sync runs on startup, every N minutes, and whenever Obsidian returns to the foreground.

Commands: **立即同步**, **以短 ID 查詢**.

## License

MIT
