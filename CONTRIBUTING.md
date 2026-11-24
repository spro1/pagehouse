# Contributing

Thanks for helping. Bug reports, fixes, translations and docs are all welcome.

## Before you start

- For anything bigger than a small fix, open an issue first so we can agree on the approach.
- Security problems: see [SECURITY.md](SECURITY.md), not the issue tracker.

## Setup

```sh
npm install
podman run -d --rm --name pagehouse-testdb -e POSTGRES_USER=pagehouse -e POSTGRES_PASSWORD=pagehouse \
  -e POSTGRES_DB=pagehouse_test -p 55432:5432 docker.io/library/postgres:17-alpine
DATABASE_URL=postgres://pagehouse:pagehouse@localhost:55432/pagehouse_test npm run dev
```

(`docker` works the same as `podman`.)

## Pull requests

- `npm run typecheck` and `npm test` must pass. Add a test for server changes.
- Never lose user data: deletes are soft, history is never rewritten, migrations only add. Migrations live in
  `server/migrations/NNN_name.sql`; never edit one that was released.
- Every UI string goes in `web/i18n.ts`, in both `en` and `ko` (a test checks that every key exists in every language).
- Server errors return a `code` from `ERRORS` in `server/app.ts`, plus an `err.<code>` translation.
- Keep it small: prefer what the platform, PostgreSQL or an existing dependency already does over new code or packages.

## Translations

Copy the `en` block in `web/i18n.ts`, translate the values, and add the language to `LANGS`.
