# obsidian-caldav

Inline references from Obsidian notes to CalDAV tasks and events. CalDAV stays the single source of truth; notes only hold `[label](cal:xxxxxxxx)` references.

**Status: pre-alpha.** Current build (0.0.x) is only a connectivity probe (T5) that checks whether Obsidian's `requestUrl` can carry PROPFIND / REPORT / conditional PUT on each platform.

## Install (BRAT)

BRAT → Add beta plugin → `ryanwaha/obsidian-caldav`.

## T5 probe

Settings → server URL (`https://host:port`), username, password (stored in Obsidian SecretStorage, never in the vault). Then run the command **T5：執行 CalDAV 連線探測**. It writes one temporary VTODO to the test collection and deletes it.

## License

MIT
