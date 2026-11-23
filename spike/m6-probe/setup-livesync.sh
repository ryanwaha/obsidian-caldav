#!/bin/bash
# Recreate the two-vault LiveSync spike environment (vault-a, vault-b -> CouchDB db m6-spike). Never touches markdowns.
set -euo pipefail
set -a; . ~/docker/couchdb/.env; set +a
R=$(cd "$(dirname "$0")" && pwd); SRC=/ssd-pool/obsidian/obsidian/.obsidian/plugins/obsidian-livesync
curl -s -u "$COUCHDB_USER:$COUCHDB_PASSWORD" -X PUT http://localhost:5984/m6-spike; echo
mkdir -p ~/m6-spike/userdata
for v in a b; do
  V=~/m6-spike/vault-$v; mkdir -p $V/_caldav $V/.obsidian/plugins/obsidian-livesync $V/.obsidian/plugins/m6-probe
  cp $SRC/main.js $SRC/manifest.json $SRC/styles.css $V/.obsidian/plugins/obsidian-livesync/
  python3 - "$V/.obsidian/plugins/obsidian-livesync/data.json" "spike-$v" <<'PY'
import json, os, sys
json.dump({"remoteType":"","couchDB_URI":"http://localhost:5984","couchDB_USER":os.environ["COUCHDB_USER"],"couchDB_PASSWORD":os.environ["COUCHDB_PASSWORD"],
 "couchDB_DBNAME":"m6-spike","liveSync":False,"syncOnStart":False,"encrypt":False,"usePathObfuscation":False,"deviceAndVaultName":sys.argv[2],
 "disableMarkdownAutoMerge":False,"resolveConflictsByNewerFile":False,"writeDocumentsIfConflicted":False,"syncInternalFiles":False,"usePluginSync":False,
 "isConfigured":True,"permitEmptyPassphrase":False},open(sys.argv[1],"w"))
PY
  chmod 600 $V/.obsidian/plugins/obsidian-livesync/data.json
  (cd ~/workspace/obsidian-caldav && node spike/m6-probe/esbuild.mjs $V/.obsidian/plugins/m6-probe/main.js) && cp $R/manifest.json $V/.obsidian/plugins/m6-probe/
  echo '{"alwaysUpdateLinks": true}' > $V/.obsidian/app.json
done
cat > ~/m6-spike/vault-a/_caldav/k3f9x2qa.md <<'MD'
---
title: 交週報
status: needs-action
due: 2026-11-24
due_time: "09:30"
list: tasks
aliases:
  - 交週報
_kind: VTODO
_uid: m6-spike-a
_etag: '"e1"'
_hash: 0000000000000001
_sync: ok
_deleted: false
---
會議紀錄一行
MD
python3 - <<'PY'
import json, os
p=os.path.expanduser('~/m6-spike/userdata/obsidian.json')
json.dump({"vaults":{"a0000000000000a1":{"path":os.path.expanduser('~/m6-spike/vault-a'),"ts":1,"open":True},"b0000000000000b2":{"path":os.path.expanduser('~/m6-spike/vault-b'),"ts":2,"open":True}}},open(p,'w'))
PY
echo setup-done
