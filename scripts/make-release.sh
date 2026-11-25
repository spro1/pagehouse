#!/bin/sh
# Builds the release files into ./release. CI runs this on every version tag; it also works locally.
#
#   scripts/make-release.sh VERSION IMAGE REPO [--offline ARCH]
#     VERSION   e.g. 0.2.0
#     IMAGE     registry image without tag, e.g. ghcr.io/acme/pagehouse
#     REPO      GitHub owner/name, e.g. acme/pagehouse (used by install.sh to download)
#     --offline ARCH   also write pagehouse-VERSION-offline-ARCH.tar.gz with the container images inside
#                      (IMAGE:VERSION must exist locally for that platform)
#
# Output:
#   release/pagehouse-VERSION.tar.gz   compose file, scripts, docs (what install.sh downloads)
#   release/pagehouse.tar.gz           same, stable name for "latest"
#   release/install.sh                 the one-line installer
#   release/pagehouse-VERSION-offline-ARCH.tar.gz   bundle + images, for networks without internet
set -eu
[ $# -ge 3 ] || { sed -n '2,16p' "$0"; exit 1; }
VERSION=${1#v}; IMAGE=$2; REPO=$3; OFFLINE=
[ "${4:-}" = "--offline" ] && OFFLINE=${5:?arch required after --offline}
cd "$(dirname "$0")/.."
if command -v docker >/dev/null 2>&1; then CLI=docker; else CLI=podman; fi

out=release
stage=$out/pagehouse-$VERSION
mkdir -p "$stage/scripts" "$stage/docs"
cp LICENSE README.md README.ko.md .env.example "$stage/"
cp docs/install.md docs/install.ko.md docs/user-guide.md docs/user-guide.ko.md docs/upgrading.md docs/upgrading.ko.md docs/sso.md docs/sso.ko.md "$stage/docs/"
cp scripts/backup.sh scripts/restore.sh scripts/compose.sh scripts/upgrade.sh "$stage/scripts/"
echo "$VERSION" > "$stage/VERSION"
# Stamp the published image and repository into the user-facing files.
sed -e "s#\${PAGEHOUSE_IMAGE:-localhost/pagehouse}#\${PAGEHOUSE_IMAGE:-$IMAGE}#" \
    -e "s#\${PAGEHOUSE_POSTGRES_IMAGE:-localhost/pagehouse-postgres}#\${PAGEHOUSE_POSTGRES_IMAGE:-$IMAGE-postgres}#g" \
    docker-compose.yml > "$stage/docker-compose.yml"
sed "s#__REPO__#$REPO#g" scripts/install.sh > "$stage/install.sh"
sed -i.bak "s#__REPO__#$REPO#g" "$stage/scripts/upgrade.sh" && rm -f "$stage/scripts/upgrade.sh.bak"
sed -i.bak "s#^PAGEHOUSE_VERSION=.*#PAGEHOUSE_VERSION=$VERSION#" "$stage/.env.example" && rm -f "$stage/.env.example.bak"
chmod +x "$stage/install.sh" "$stage"/scripts/*.sh
grep -q "$IMAGE" "$stage/docker-compose.yml" || { echo "failed to stamp the image into docker-compose.yml" >&2; exit 1; }

tar -C "$out" --exclude "pagehouse-$VERSION/images" -czf "$out/pagehouse-$VERSION.tar.gz" "pagehouse-$VERSION"
cp "$out/pagehouse-$VERSION.tar.gz" "$out/pagehouse.tar.gz"
cp "$stage/install.sh" "$out/install.sh"
echo "$out/pagehouse-$VERSION.tar.gz"

if [ -n "$OFFLINE" ]; then
  mkdir -p "$stage/images"
  # CI puts single-architecture archives here first (see release.yml); locally the images are saved now.
  [ -s "$stage/images/pagehouse.tar" ] || $CLI save -o "$stage/images/pagehouse.tar" "$IMAGE:$VERSION"
  [ -s "$stage/images/postgres.tar" ] || $CLI save -o "$stage/images/postgres.tar" "$IMAGE-postgres:17"
  tar -C "$out" -czf "$out/pagehouse-$VERSION-offline-$OFFLINE.tar.gz" "pagehouse-$VERSION"
  echo "$out/pagehouse-$VERSION-offline-$OFFLINE.tar.gz"
fi
