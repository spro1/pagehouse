#!/bin/sh
# Upgrade an installed Pagehouse in place. Backs up first; keeps .env and all data.
# Usage (run inside the install folder):
#   scripts/upgrade.sh              latest release
#   scripts/upgrade.sh 0.2.0        a specific version
# Offline: extract the new offline bundle and run its install.sh with --dir pointing here.
set -eu
cd "$(dirname "$0")/.."
[ -f .env ] || { echo "run this inside a Pagehouse install folder (no .env here)" >&2; exit 1; }
repo=$(sed -n 's/^REPO=${PAGEHOUSE_REPO:-\(.*\)}$/\1/p' install.sh 2>/dev/null)
[ -n "$repo" ] || repo=__REPO__
url="https://github.com/$repo/releases/latest/download/install.sh"
[ $# -ge 1 ] && url="https://github.com/$repo/releases/download/v${1#v}/install.sh"
command -v curl >/dev/null 2>&1 || { echo "curl is required" >&2; exit 1; }
# Saved to a file first: piped into sh, anything in it that reads stdin would eat the rest of the script.
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
curl -fsSL "$url" -o "$tmp"
PAGEHOUSE_DIR="$PWD" PAGEHOUSE_VERSION="${1:-}" sh "$tmp" </dev/null
