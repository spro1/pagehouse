#!/bin/sh
# End-to-end install and upgrade, the way users do it, against this commit's build:
#   1. install the latest published release and add data (page, attachment, comment)
#   2. upgrade it with this commit's bundle, run the way `curl | sh` runs it (installer on stdin)
#   3. check the version, the data, the pre-upgrade backup and SECRET_KEY
#   4. a fresh install of this build must write its first automatic backup
# Needs the images IMAGE:0.0.0-ci and IMAGE-postgres:17 built locally (CI does that).
# Leaves the upgraded install on port 3000 and writes E2E_EMAIL / E2E_PASSWORD for the browser tests.
set -eu
cd "$(dirname "$0")/.."
REPO=${GITHUB_REPOSITORY:-spro1/pagehouse}
IMAGE=ghcr.io/$REPO
VERSION=0.0.0-ci
WORK=${RUNNER_TEMP:-/tmp}/pagehouse-e2e
PORT=${E2E_PORT:-3000}
H=http://localhost:$PORT
step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
fail() { printf '\033[31mFAIL: %s\033[0m\n' "$*" >&2; exit 1; }
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then COMPOSE="docker compose"; else COMPOSE="podman compose"; fi
rm -rf "$WORK" && mkdir -p "$WORK"

step "Latest published release"
auth=""; [ -n "${GITHUB_TOKEN:-}" ] && auth="authorization: Bearer $GITHUB_TOKEN"
OLD=$(curl -fsSL ${auth:+-H "$auth"} "https://api.github.com/repos/$REPO/releases?per_page=1" | sed -n 's/.*"tag_name": *"v\([^"]*\)".*/\1/p' | head -1)
[ -n "$OLD" ] || fail "could not find the latest release"
echo "$OLD"

step "Install $OLD"
curl -fsSL -o "$WORK/old-install.sh" "https://github.com/$REPO/releases/download/v$OLD/install.sh"
sh "$WORK/old-install.sh" --dir "$WORK/up" --version "$OLD" --port "$PORT" </dev/null

step "Add data"
PW=$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')
EMAIL=e2e@example.com
J="$WORK/cookies"
api() { curl -fsS -b "$J" -c "$J" -H 'content-type: application/json' "$@"; }
api -d "{\"email\":\"$EMAIL\",\"name\":\"E2E\",\"password\":\"$PW\"}" "$H/api/auth/register" >/dev/null
SPACE=$(api "$H/api/spaces" | sed -n 's/^\[{"id":\([0-9]*\).*/\1/p')
PAGE=$(api -d "{\"spaceId\":$SPACE,\"title\":\"Before upgrade\"}" "$H/api/pages" | sed -n 's/^{"id":\([0-9]*\).*/\1/p')
api -X PUT -d '{"title":"Before upgrade","version":1,"doc":{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"survives the upgrade"}]}]}}' "$H/api/pages/$PAGE" >/dev/null
printf 'attachment body' > "$WORK/a.txt"
FILE=$(curl -fsS -b "$J" -F "file=@$WORK/a.txt;type=text/plain" "$H/api/pages/$PAGE/attachments" | sed -n 's/.*"url":"\([^"]*\)".*/\1/p')
api -d '{"body":"comment from before"}' "$H/api/pages/$PAGE/comments" >/dev/null
echo "page $PAGE, file $FILE"

step "Build this commit's bundle"
sh scripts/make-release.sh "$VERSION" "$IMAGE" "$REPO" --offline amd64 >/dev/null
BUNDLE=$PWD/release/pagehouse-$VERSION

step "Upgrade: installer read from stdin, as with curl | sh"
PAGEHOUSE_BUNDLE=$BUNDLE PAGEHOUSE_DIR=$WORK/up sh < "$BUNDLE/install.sh"

step "Check the upgrade"
got=$(curl -fsS "$H/healthz")
echo "$got" | grep -q "\"version\":\"$VERSION\"" || fail "still running the old version: $got"
rm -f "$J"
api -d "{\"email\":\"$EMAIL\",\"password\":\"$PW\"}" "$H/api/auth/login" >/dev/null || fail "can't sign in after the upgrade"
api "$H/api/pages/$PAGE" | grep -q 'survives the upgrade' || fail "page content lost"
[ "$(curl -fsS -b "$J" "$H$FILE")" = "attachment body" ] || fail "attachment lost"
api "$H/api/pages/$PAGE/comments" | grep -q 'comment from before' || fail "comment lost"
ls "$WORK/up/backups/before-upgrade/"*.tar.gz >/dev/null 2>&1 || fail "no pre-upgrade backup"
grep -q '^SECRET_KEY=.' "$WORK/up/.env" || fail "SECRET_KEY not added"
echo "ok: $OLD -> $VERSION with data intact"

step "Fresh install writes its first backup"
sh "$BUNDLE/install.sh" --dir "$WORK/fresh" --port $((PORT + 1)) </dev/null
i=0
until (cd "$WORK/fresh" && $COMPOSE logs backup 2>/dev/null) | grep -q 'backup written'; do
  i=$((i + 1)); [ $i -lt 60 ] || { (cd "$WORK/fresh" && $COMPOSE logs backup); fail "no first backup"; }
  sleep 2
done
(cd "$WORK/fresh" && $COMPOSE down -v >/dev/null 2>&1)
echo "ok"

# For the browser tests that run next against the upgraded install.
if [ -n "${GITHUB_ENV:-}" ]; then
  echo "::add-mask::$PW"
  { echo "E2E_EMAIL=$EMAIL"; echo "E2E_PASSWORD=$PW"; echo "BASE_URL=$H"; } >> "$GITHUB_ENV"
else
  echo "E2E_EMAIL=$EMAIL E2E_PASSWORD=$PW BASE_URL=$H"
fi
