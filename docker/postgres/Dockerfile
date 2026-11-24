# PostgreSQL for Pagehouse: the official image with patched OS packages and without gosu.
# gosu only switches root -> postgres at startup and ships an old Go runtime that scanners flag (60+ CVEs).
# Running as the postgres user from the start makes the entrypoint skip it entirely.
# Existing data volumes are already owned by postgres (uid 70), so this is a drop-in replacement.
FROM docker.io/library/postgres:17-alpine
RUN apk upgrade --no-cache && rm -f /usr/local/bin/gosu
USER postgres
