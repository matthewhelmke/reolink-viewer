#!/bin/sh
set -eu
redis-server --bind 127.0.0.1 --port 6379 --save "" --appendonly no &
daemon=$!
trap 'kill "$daemon" 2>/dev/null || true' EXIT
trap 'exit 1' HUP INT TERM
until redis-cli -h 127.0.0.1 -p 6379 ping >/dev/null 2>&1; do
  kill -0 "$daemon" 2>/dev/null || exit 1
  sleep 0.1
done
printf '\n::service-ready::\n'
wait "$daemon"
exit 1
