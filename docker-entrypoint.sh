#!/bin/sh
set -e
# Volumes (Fly, docker-compose bind mounts) are mounted root-owned over /data, so fix
# ownership as root, then drop to the unprivileged node user for the app itself.
[ "$(stat -c %U /data)" = node ] || chown -R node:node /data
exec setpriv --reuid=node --regid=node --init-groups "$@"
