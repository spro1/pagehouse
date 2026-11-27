#!/bin/sh
# Replaces the current database with a backup made by backup.sh (or the automatic backup service).
# Before touching anything it backs up the current state to backups/before-restore/, so a wrong restore can be undone.
# Usage: scripts/restore.sh backups/pagehouse-YYYYmmdd-HHMMSS.tar.gz
set -eu
[ $# -eq 1 ] && [ -f "$1" ] || { echo "usage: $0 <backup.tar.gz>" >&2; exit 1; }
backup=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
cd "$(dirname "$0")/.."
. scripts/compose.sh
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
tar -C "$tmp" -xzf "$backup" db.dump files.tar || { echo "not a Pagehouse backup: $1" >&2; exit 1; }

# Shared with Taskhouse, the database holds both products: a backup without Taskhouse would delete its data.
if [ -n "$($COMPOSE exec -T backup psql -Atc "SELECT coalesce(to_regclass('taskhouse.issues'), to_regclass('public.issues'))" </dev/null)" ] &&
   ! $COMPOSE exec -T backup pg_restore -l < "$tmp/db.dump" | grep -Eq ' TABLE (public|taskhouse) issues '; then
  echo "Taskhouse shares this database and is not in $1: restoring it would delete Taskhouse's data. Nothing was changed." >&2
  exit 1
fi

printf 'This replaces ALL current pages, history and accounts with %s.\nThe current state is backed up first. Type "restore" to continue: ' "$1"
read -r answer
[ "$answer" = restore ] || { echo "aborted"; exit 1; }

echo "backing up the current state..."
safety=$(scripts/backup.sh backups/before-restore | tail -1)
[ -s "$safety" ] || { echo "could not back up the current state; nothing was changed" >&2; exit 1; }
echo "current state saved to $safety"

$COMPOSE stop app
$COMPOSE exec -T backup sh -c 'dropdb --force "$PGDATABASE" && createdb "$PGDATABASE"' </dev/null
$COMPOSE exec -T backup sh -c 'pg_restore -d "$PGDATABASE" --no-owner' < "$tmp/db.dump"
# Attachments are stored by content hash and never change, so extracting over the current ones loses nothing.
$COMPOSE run --rm -T --no-deps --entrypoint sh app -c 'tar -C /data -xf -' < "$tmp/files.tar"
$COMPOSE up -d app
echo "restored $1"
echo "to undo: scripts/restore.sh $safety"
