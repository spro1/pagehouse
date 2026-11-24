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
$COMPOSE exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB"' > "$tmp/db.dump"
$COMPOSE exec -T app tar -C /data -cf - files > "$tmp/files.tar"
tar -C "$tmp" -czf "$out" db.dump files.tar
echo "$out"
