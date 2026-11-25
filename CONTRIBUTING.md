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

## How changes get in

Work for the next version collects on a release branch, `release/<version>` (e.g. `release/0.2.0`), and `main`
only moves when a version is released, so `main` always matches the latest release.

1. Fork the repository (or create a branch, if you're a maintainer) and open a pull request against the current
   `release/*` branch. Fixes that must go out on their own get a new release branch for a patch version.
2. CI (`test` and `image`) must pass, and the branch must be up to date with its target.
3. A maintainer (see `.github/CODEOWNERS`) reviews it, and every review thread must be resolved. Approvals aren't
   enforced yet because there is one maintainer; raise `required_approving_review_count` in the ruleset when
   there are more.
4. It's merged as one squashed commit. Direct pushes and force pushes to `main` and `release/*` are refused,
   `main` can't be deleted, and only maintainers create release tags (`v*`).
5. To release, a maintainer opens a pull request from `release/<version>` to `main`; see
   [docs/releasing.md](docs/releasing.md).

The rules are kept in `.github/rulesets/`. A maintainer applies them with:

```sh
gh api -X POST repos/spro1/pagehouse/rulesets --input .github/rulesets/main.json
gh api -X POST repos/spro1/pagehouse/rulesets --input .github/rulesets/release.json
gh api -X POST repos/spro1/pagehouse/rulesets --input .github/rulesets/tags.json
```

## Pull requests

- `npm run typecheck` and `npm test` must pass. Add a test for server changes.
- CI also runs end-to-end tests (`e2e` job): it installs the latest release, upgrades it to your build the way
  users do, checks the data survived, and drives the app in a browser. To run them yourself:
  ```sh
  docker build --build-arg VERSION=0.0.0-ci -t ghcr.io/spro1/pagehouse:0.0.0-ci .
  docker build -t ghcr.io/spro1/pagehouse-postgres:17 docker/postgres
  sh e2e/upgrade.sh                 # prints E2E_EMAIL, E2E_PASSWORD and BASE_URL at the end
  npx playwright install chromium
  E2E_EMAIL=… E2E_PASSWORD=… BASE_URL=… npm run e2e
  ```
  The browser tests also run against `npm run dev` with any admin account.
- Never lose user data: deletes are soft, history is never rewritten, migrations only add. Migrations live in
  `server/migrations/NNN_name.sql`; never edit one that was released.
- Every UI string goes in `web/i18n.ts`, in both `en` and `ko` (a test checks that every key exists in every language).
- Server errors return a `code` from `ERRORS` in `server/app.ts`, plus an `err.<code>` translation.
- Keep it small: prefer what the platform, PostgreSQL or an existing dependency already does over new code or packages.

## Translations

Copy the `en` block in `web/i18n.ts`, translate the values, and add the language to `LANGS`.
