#!/bin/sh
set -eu

STATE_MOUNT_PATH=/state

# Railway mounts persistent volumes as root. Repair the fixed mount, then atomically replace this
# privileged shell with a node process that has no root identity, supplementary groups, or caps.
/usr/bin/chown -R node:node "$STATE_MOUNT_PATH"
exec /usr/bin/setpriv \
  --reuid=node \
  --regid=node \
  --clear-groups \
  --bounding-set=-all \
  --no-new-privs \
  /usr/local/bin/node dist/src/index.js "$@"
