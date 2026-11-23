#!/bin/bash
# M6-2 e2e: vault-a = server (obsidian-caldav server mode + LiveSync), vault-b = device (LiveSync only). DB m6-spike. Radicale temp collections m6-e2e, m6-e2e2.
set -euo pipefail
R=$(cd "$(dirname "$0")" && pwd)
"$R/setup-livesync.sh" >/dev/null
rm -f ~/m6-spike/vault-a/_caldav/*.md
RP=$(cat ~/.config/radicale/password.txt)
for c in m6-e2e m6-e2e2; do curl -s -o /dev/null -w "MKCOL $c %{http_code}\n" -u "ryanw:$RP" -X MKCOL http://127.0.0.1:5232/ryanw/$c/ -H 'Content-Type: application/xml' --data '<?xml version="1.0"?><D:mkcol xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:set><D:prop><D:resourcetype><D:collection/><C:calendar/></D:resourcetype><C:supported-calendar-component-set><C:comp name="VTODO"/></C:supported-calendar-component-set></D:prop></D:set></D:mkcol>'; done
P=~/m6-spike/vault-a/.obsidian/plugins/obsidian-caldav; mkdir -p $P
cp ~/workspace/obsidian-caldav/{main.js,manifest.json,styles.css} $P/
echo '{"serverUrl":"http://127.0.0.1:5232","username":"ryanw","syncIntervalMinutes":600,"defaultCollection":"","mode":"server","projectCollections":["/ryanw/m6-e2e/","/ryanw/m6-e2e2/"]}' > $P/data.json
echo m6-2-setup-done
