# Sourced by the other scripts: picks docker compose or podman compose, or $COMPOSE if set.
if [ -z "${COMPOSE:-}" ]; then
  if command -v docker >/dev/null 2>&1; then COMPOSE="docker compose"
  elif command -v podman >/dev/null 2>&1; then COMPOSE="podman compose"
  else echo "docker or podman is required" >&2; exit 1; fi
fi
