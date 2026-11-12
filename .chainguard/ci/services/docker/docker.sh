#!/bin/sh
set -eu
if [ "$(id -u)" != 0 ]; then
  echo "the docker service needs a check that runs as root" >&2
  exit 1
fi
dockerd --host=unix:///var/run/docker.sock \
  --data-root=/var/lib/chainguard-microvm/docker --storage-driver=overlay2 &
daemon=$!
trap 'kill "$daemon" 2>/dev/null || true' EXIT
trap 'exit 1' HUP INT TERM
until docker info >/dev/null 2>&1; do
  kill -0 "$daemon" 2>/dev/null || exit 1
  sleep 0.1
done
printf '\n::service-ready::\n'
wait "$daemon"
exit 1
