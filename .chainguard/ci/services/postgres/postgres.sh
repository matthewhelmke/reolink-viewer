#!/bin/sh
set -eu
: "${PGDATA:=/tmp/postgres}"
: "${PGPORT:=5432}"
export PGDATA PGPORT
# PostgreSQL refuses to run as root, so run it as a postgres account.
if [ "$(id -u)" = 0 ]; then
  id postgres >/dev/null 2>&1 || adduser -S -D -H -s /bin/sh postgres
  mkdir -p "$PGDATA"
  chown postgres "$PGDATA"
  chmod 700 "$PGDATA"
  exec su-exec postgres sh "$0"
fi
if [ ! -f "$PGDATA/PG_VERSION" ]; then
  initdb --no-sync --pgdata="$PGDATA" --username=postgres --auth=trust --encoding=UTF8 --locale=C
fi
postgres -D "$PGDATA" -h 127.0.0.1 -p "$PGPORT" -k "$PGDATA" &
daemon=$!
trap 'kill "$daemon" 2>/dev/null || true' EXIT
trap 'exit 1' HUP INT TERM
until pg_isready -h 127.0.0.1 -p "$PGPORT" -U postgres >/dev/null 2>&1; do
  kill -0 "$daemon" 2>/dev/null || exit 1
  sleep 0.1
done
printf '\n::service-ready::\n'
wait "$daemon"
exit 1
