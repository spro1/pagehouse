# Releasing (maintainers)

1. Update `version` in `package.json` (CI refuses a tag that doesn't match it) and `charts/pagehouse/Chart.yaml`.
2. Commit, then tag and push:

   ```sh
   git tag v0.2.0 && git push origin v0.2.0
   ```

3. `.github/workflows/release.yml` then:
   - builds `linux/amd64` and `linux/arm64` images and pushes `ghcr.io/<owner>/pagehouse:0.2.0` and `:latest`
   - runs `scripts/make-release.sh` per architecture, which stamps the image and repository names into the bundle
   - packages the Helm chart with the image set
   - publishes a GitHub Release with `install.sh`, `pagehouse.tar.gz`, `pagehouse-0.2.0.tar.gz`,
     `pagehouse-0.2.0-offline-{amd64,arm64}.tar.gz`, `pagehouse-0.2.0.tgz` and `SHA256SUMS`

4. On first release, make the GHCR package public: GitHub → Packages → pagehouse → Package settings → Change visibility.

Build the same files locally to check them before tagging:

```sh
docker build --build-arg VERSION=0.2.0 -t ghcr.io/acme/pagehouse:0.2.0 .
sh scripts/make-release.sh 0.2.0 ghcr.io/acme/pagehouse acme/pagehouse --offline amd64
sh release/pagehouse-0.2.0/install.sh --dir /tmp/ph-test --port 3999
```

Migrations: add `server/migrations/NNN_name.sql`. They run once, in order, inside a transaction, when the app starts. Never edit a released migration and never drop or rewrite user data in one; add columns and backfill instead.
