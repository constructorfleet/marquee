#!/bin/sh
# Drops to uid 1000 before exec'ing the app. Earlier releases ran as root, so an
# upgraded /data is root-owned; a build-stage chown never touches a mount, so fix
# ownership here instead.
set -e

DATA_DIR="${DATA_DIR:-/data}"

# An operator-supplied `user:` already dropped us; respect it and change nothing.
if [ "$(id -u)" != "0" ]; then
  exec "$@"
fi

if ! setpriv --reuid=1000 --regid=1000 --clear-groups true 2>/dev/null; then
  echo "marquee: cannot drop privileges to uid 1000." >&2
  echo "marquee: add 'cap_add: [CHOWN, SETUID, SETGID]', or set 'user: \"1000:1000\"'" >&2
  echo "marquee: once ./data is owned by 1000:1000 and keep all capabilities dropped." >&2
  exit 1
fi

if [ "$(stat -c %u "$DATA_DIR" 2>/dev/null || echo 1000)" != "1000" ]; then
  chown -R 1000:1000 "$DATA_DIR" || true
fi

# SQLite creates marquee.db-wal/-shm beside the database, so the directory itself
# must be writable by uid 1000 — not just the files already in it.
if ! setpriv --reuid=1000 --regid=1000 --clear-groups test -w "$DATA_DIR"; then
  echo "marquee: $DATA_DIR is not writable by uid 1000 and could not be chowned." >&2
  echo "marquee: fix it on the host with: sudo chown -R 1000:1000 ./data" >&2
  echo "marquee: (an NFS/SMB-backed volume needs uid/gid 1000 mapped in the mount options)" >&2
  exit 1
fi

exec setpriv --reuid=1000 --regid=1000 --clear-groups "$@"
