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

printf 'This replaces ALL current pages, history and accounts with %s.\nThe current state is backed up first. Type "restore" to continue: ' "$1"
read -r answer
[ "$answer" = restore ] || { echo "aborted"; exit 1; }

echo "backing up the current state..."
safety=$(scripts/backup.sh backups/before-restore | tail -1)
[ -s "$safety" ] || { echo "could not back up the current state; nothing was changed" >&2; exit 1; }
echo "current state saved to $safety"

$COMPOSE stop app
$COMPOSE exec -T db sh -c 'dropdb -U "$POSTGRES_USER" --force "$POSTGRES_DB" && createdb -U "$POSTGRES_USER" "$POSTGRES_DB"'
$COMPOSE exec -T db sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner' < "$tmp/db.dump"
# Attachments are stored by content hash and never change, so extracting over the current ones loses nothing.
$COMPOSE run --rm -T --no-deps --entrypoint sh app -c 'tar -C /data -xf -' < "$tmp/files.tar"
$COMPOSE up -d app
echo "restored $1"
echo "to undo: scripts/restore.sh $safety"
