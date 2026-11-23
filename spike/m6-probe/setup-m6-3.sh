#!/bin/bash
# M6-3 e2e: like M6-2, plus obsidian-caldav in client mode on the device (vault-b).
set -euo pipefail
R=$(cd "$(dirname "$0")" && pwd)
"$R/setup-m6-2.sh" >/dev/null
P=~/m6-spike/vault-b/.obsidian/plugins/obsidian-caldav; mkdir -p $P
cp ~/workspace/obsidian-caldav/{main.js,manifest.json,styles.css} $P/
echo '{"mode":"client","serverUrl":"","username":"","syncIntervalMinutes":600,"defaultCollection":"","projectCollections":[]}' > $P/data.json
echo m6-3-setup-done
