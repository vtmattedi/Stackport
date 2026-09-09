#!/bin/sh
# Runs as root at container start (see Dockerfile). Docker Compose's default project
# network/namespace means the host's /var/run/docker.sock group ownership varies by
# distro/install, so it can't be baked into the image at build time — this aligns the
# `node` user with whatever GID the socket actually has at *runtime*, then drops
# privileges. If the socket isn't mounted (e.g. someone runs the image without it),
# this is a no-op and the app starts anyway; Docker-dependent actions will simply fail
# at call time with a normal "cannot connect to the Docker daemon" error.
set -e

SOCKET=/var/run/docker.sock

if [ -S "$SOCKET" ]; then
  SOCKET_GID="$(stat -c '%g' "$SOCKET")"
  SOCKET_GROUP="$(getent group "$SOCKET_GID" | cut -d: -f1)"
  if [ -z "$SOCKET_GROUP" ]; then
    SOCKET_GROUP=dockerhost
    groupadd -g "$SOCKET_GID" "$SOCKET_GROUP"
  fi
  usermod -aG "$SOCKET_GROUP" node
fi

# Bind-mounted host directories (./data, ./logs in docker-compose.system.yml) bring
# whatever ownership they had on the host — e.g. a fresh `mkdir logs` on the host is
# root-owned by default, which crash-loops the app on startup (EACCES writing
# logs/app.log) since it runs as the non-root `node` user. Non-recursive and cheap
# (single directory, not its contents): only the top-level directories need to be
# node-writable for it to create files/subdirs inside them itself (which then
# already come out node-owned) — chowning potentially large, already-populated
# project checkouts under data/ recursively on every start would be needlessly slow.
[ -d /app/data ] && chown node:node /app/data
[ -d /app/logs ] && chown node:node /app/logs

exec gosu node "$@"
