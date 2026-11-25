#!/bin/sh
# Pagehouse installer and upgrader.
#
#   Online:   curl -fsSL https://github.com/__REPO__/releases/latest/download/install.sh | sh
#   Offline:  tar xzf pagehouse-<version>-offline-<arch>.tar.gz && sh pagehouse-<version>/install.sh
#
# Options (or environment variables):
#   --dir DIR          where to install            (PAGEHOUSE_DIR, default ./pagehouse)
#   --version X.Y.Z    version to install          (PAGEHOUSE_VERSION, default latest release)
#   --port N           web port for a new install  (PAGEHOUSE_PORT, default 3000)
#
# Running it again on an existing install upgrades it: it backs up first, keeps .env and all data,
# and only replaces the compose file, scripts and docs.
set -eu

REPO=${PAGEHOUSE_REPO:-__REPO__}
DIR=${PAGEHOUSE_DIR:-}
VERSION=${PAGEHOUSE_VERSION:-}
PORT_NEW=${PAGEHOUSE_PORT:-3000}
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) DIR=$2; shift 2 ;;
    --version) VERSION=${2#v}; shift 2 ;;
    --port) PORT_NEW=$2; shift 2 ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
done

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# 1. A container runtime with compose.
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then CLI=docker; COMPOSE="docker compose"
elif command -v podman >/dev/null 2>&1 && podman compose version >/dev/null 2>&1; then CLI=podman; COMPOSE="podman compose"
else die "Docker (with Compose v2) or Podman (with podman compose) is required. See https://docs.docker.com/engine/install/"
fi

# 2. Get the release bundle: the folder this script sits in, or download it.
# Piped through `curl | sh`, $0 is the shell, not this file: then never treat the current folder as the bundle.
case "$0" in
  *install.sh) here=$(cd "$(dirname "$0")" 2>/dev/null && pwd || echo "") ;;
  *) here="" ;;
esac
if [ -n "$here" ] && [ -f "$here/docker-compose.yml" ] && [ -f "$here/VERSION" ]; then
  bundle=$here
else
  command -v curl >/dev/null 2>&1 || die "curl is required to download Pagehouse"
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  if [ -n "$VERSION" ]; then url="https://github.com/$REPO/releases/download/v$VERSION/pagehouse-$VERSION.tar.gz"
  else url="https://github.com/$REPO/releases/latest/download/pagehouse.tar.gz"; fi
  say "Downloading $url"
  curl -fsSL "$url" | tar -xz -C "$tmp" || die "download failed: $url"
  bundle=$(find "$tmp" -maxdepth 1 -type d -name 'pagehouse-*' | head -1)
  [ -n "$bundle" ] || die "the download did not contain a Pagehouse bundle"
fi
BUNDLE_VERSION=$(cat "$bundle/VERSION")
[ -z "$VERSION" ] || [ "$VERSION" = "$BUNDLE_VERSION" ] || die "bundle is $BUNDLE_VERSION but --version $VERSION was asked for"

# 3. Target folder. Default: next to where you run this, unless that is the bundle itself.
[ -n "$DIR" ] || { if [ "$bundle" = "$here" ] && [ -f "$bundle/.env" ]; then DIR=$bundle; else DIR=$PWD/pagehouse; fi; }
mkdir -p "$DIR"
DIR=$(cd "$DIR" && pwd)
existing=false
[ -f "$DIR/.env" ] && existing=true

# A new install into a folder whose earlier install left its volumes behind: the old database keeps its old
# password, which the new .env wouldn't know, and the app would fail to sign in to it. Stop and explain.
if ! $existing; then
  project=$(basename "$DIR" | tr 'A-Z' 'a-z' | tr -cd 'a-z0-9_-')
  if $CLI volume inspect "${project}_db" >/dev/null 2>&1 </dev/null; then
    die "a database volume from an earlier install (${project}_db) still exists, but $DIR/.env with its password is gone.
  To keep that data: put the old .env back into $DIR and run this again (it then upgrades).
  To start over: delete the old data for good with
    $CLI volume rm ${project}_db ${project}_files
  and run this again."
  fi
fi

# 4. Existing install: back up before changing anything.
if $existing && [ -f "$DIR/scripts/backup.sh" ]; then
  # Every command that could read stdin gets </dev/null: under `curl | sh` stdin is the rest of this script,
  # and a command reading it (compose exec does) would swallow it, ending the install early without an error.
  if (cd "$DIR" && $COMPOSE ps --status running --services 2>/dev/null </dev/null | grep -qx app); then
    say "Existing install found in $DIR. Backing up before upgrading..."
    (cd "$DIR" && COMPOSE="$COMPOSE" sh scripts/backup.sh backups/before-upgrade </dev/null) || die "backup failed; nothing was changed"
  fi
fi

# 5. Copy bundle files. .env, backups and data volumes are never touched.
if [ "$bundle" != "$DIR" ]; then
  for f in docker-compose.yml .env.example VERSION LICENSE README.md README.ko.md install.sh; do
    [ -f "$bundle/$f" ] && cp "$bundle/$f" "$DIR/$f"
  done
  mkdir -p "$DIR/scripts" "$DIR/docs"
  cp "$bundle"/scripts/*.sh "$DIR/scripts/"
  [ -d "$bundle/docs" ] && cp "$bundle"/docs/* "$DIR/docs/"
fi
mkdir -p "$DIR/backups"

# 6. Settings. A new install gets a random database password; an upgrade only moves the version.
if ! $existing; then
  pw=$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')
  sk=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')
  sed -e "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$pw/" \
      -e "s/^SECRET_KEY=.*/SECRET_KEY=$sk/" \
      -e "s/^PORT=.*/PORT=$PORT_NEW/" \
      -e "s/^PAGEHOUSE_VERSION=.*/PAGEHOUSE_VERSION=$BUNDLE_VERSION/" "$DIR/.env.example" > "$DIR/.env"
  chmod 600 "$DIR/.env"
  say "Created $DIR/.env with a random database password"
else
  # Older installs have no SECRET_KEY (encrypts stored secrets such as the SSO client secret).
  grep -q '^SECRET_KEY=.' "$DIR/.env" || { sed -i.bak '/^SECRET_KEY=/d' "$DIR/.env" && rm -f "$DIR/.env.bak"; echo "SECRET_KEY=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')" >> "$DIR/.env"; say "Added SECRET_KEY to $DIR/.env"; }
  grep -q '^PAGEHOUSE_VERSION=' "$DIR/.env" || echo "PAGEHOUSE_VERSION=$BUNDLE_VERSION" >> "$DIR/.env"
  sed -i.bak "s/^PAGEHOUSE_VERSION=.*/PAGEHOUSE_VERSION=$BUNDLE_VERSION/" "$DIR/.env" && rm -f "$DIR/.env.bak"
fi

# 7. Images: load them from an offline bundle, otherwise pull.
cd "$DIR"
if ls "$bundle"/images/*.tar >/dev/null 2>&1; then
  for img in "$bundle"/images/*.tar; do say "Loading $(basename "$img")"; $CLI load -q -i "$img" >/dev/null </dev/null; done
else
  say "Pulling images"
  $COMPOSE pull -q 2>/dev/null </dev/null || $COMPOSE pull </dev/null
fi

# 8. Start and wait until healthy.
say "Starting Pagehouse $BUNDLE_VERSION"
$COMPOSE up -d --remove-orphans </dev/null
port=$(sed -n 's/^PORT=//p' .env); port=${port:-3000}
i=0
until curl -fsS "http://127.0.0.1:$port/healthz" >/dev/null 2>&1; do
  i=$((i + 1))
  [ $i -lt 90 ] || die "Pagehouse did not become healthy. Check: cd $DIR && $COMPOSE logs app"
  sleep 2
done

echo
say "Pagehouse $BUNDLE_VERSION is running: http://$(hostname 2>/dev/null || echo localhost):$port"
if $existing; then
  echo "    Upgraded. The pre-upgrade backup is in $DIR/backups/before-upgrade/"
else
  echo "    Open it and create the first account; it becomes the administrator."
fi
echo "    Folder: $DIR   Backups: $DIR/backups (automatic, every ${BACKUP_INTERVAL_HOURS:-24}h)"
echo "    Guides: $DIR/docs/install.md, $DIR/docs/user-guide.md"
