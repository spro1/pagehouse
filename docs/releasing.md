# Releasing (maintainers)

Branches: features and fixes for the next version are merged (by pull request) into `release/<version>`.
`main` moves only at a release, so it always matches the latest published version.

1. Start the cycle: create the branch from `main` and push it (the `release/*` ruleset then protects it).

   ```sh
   git checkout main && git pull && git checkout -b release/0.2.0 && git push -u origin release/0.2.0
   ```

2. Before releasing, in a pull request to the release branch: set `version` in `package.json` (CI refuses a tag
   that doesn't match it), `charts/pagehouse/Chart.yaml` and the install commands in the READMEs and in `site/index.html` / `site/en.html`, and turn the
   "next (unreleased)" section of `docs/upgrading.md` / `docs/upgrading.ko.md` into this version's notes.
3. Open a pull request from `release/0.2.0` to `main` and merge it once CI passes.
4. Tag the merge commit on `main` and push the tag:

   ```sh
   git checkout main && git pull && git tag v0.2.0 && git push origin v0.2.0
   ```

5. Start the next cycle with a new `release/<next version>` branch from `main`, and delete the old one.

Merging into `main` also republishes the product page (`site/`) to GitHub Pages (`.github/workflows/pages.yml`).

Pushing the tag runs `.github/workflows/release.yml`, which:
   - builds `linux/amd64` and `linux/arm64` images and pushes `ghcr.io/<owner>/pagehouse:0.2.0` and `:latest`
   - runs `scripts/make-release.sh` per architecture, which stamps the image and repository names into the bundle
   - packages the Helm chart with the image set
   - publishes a GitHub Release with `install.sh`, `pagehouse.tar.gz`, `pagehouse-0.2.0.tar.gz`,
     `pagehouse-0.2.0-offline-{amd64,arm64}.tar.gz`, `pagehouse-0.2.0.tgz` and `SHA256SUMS`

On the very first release, make the GHCR package public: GitHub → Packages → pagehouse → Package settings → Change visibility.

Build the same files locally to check them before tagging:

```sh
docker build --build-arg VERSION=0.2.0 -t ghcr.io/acme/pagehouse:0.2.0 .
sh scripts/make-release.sh 0.2.0 ghcr.io/acme/pagehouse acme/pagehouse --offline amd64
sh release/pagehouse-0.2.0/install.sh --dir /tmp/ph-test --port 3999
```

Migrations: add `server/migrations/NNN_name.sql`. They run once, in order, inside a transaction, when the app starts. Never edit a released migration and never drop or rewrite user data in one; add columns and backfill instead.
