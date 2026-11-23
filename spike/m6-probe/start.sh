#!/bin/sh
# Spike Obsidian instance: isolated from production (own user-data-dir, display :98, CDP on 127.0.0.1:9223)
exec xvfb-run --server-num=98 --server-args="-screen 0 1600x1000x24" /opt/Obsidian/obsidian \
  --user-data-dir="$HOME/m6-spike/userdata" --remote-debugging-port=9223 --disable-gpu --password-store=basic
