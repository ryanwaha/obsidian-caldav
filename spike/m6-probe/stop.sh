#!/bin/sh
# Stop the spike instance and its Xvfb :98 (never touches production :99)
pkill -f 'remote-debugging-port=9223' ; pkill -f '^Xvfb :98 ' ; sleep 1
pgrep -fa 'remote-debugging-port=9223|^Xvfb :98 ' || echo stopped
