#!/bin/sh
# Writes one file holding the database and all attachments: ./backups/pagehouse-YYYYmmdd-HHMMSS.tar.gz
# Usage: scripts/backup.sh [output-dir]
set -eu
cd "$(dirname "$0")/.."
. scripts/compose.sh
outdir=${1:-backups}
mkdir -p "$outdir"
out="$outdir/pagehouse-$(date +%Y%m%d-%H%M%S).tar.gz"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# Database first: attachments are written before their DB row, so every file the dump refers to already exists.
# Through the backup service: it reaches the database in every layout (also when the database is Taskhouse's).
$COMPOSE exec -T backup pg_dump -Fc </dev/null > "$tmp/db.dump"
# A new install has no files folder until the first upload.
$COMPOSE exec -T app sh -c 'mkdir -p /data/files && tar -C /data -cf - files' </dev/null > "$tmp/files.tar"
tar -C "$tmp" -czf "$out" db.dump files.tar
echo "$out"
