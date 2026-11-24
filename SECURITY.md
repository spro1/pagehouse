# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Report them privately through
GitHub: **Security → Report a vulnerability** on this repository (private vulnerability reporting).

Include what you found, how to reproduce it, and the version (`curl <your-wiki>/healthz` shows it).
We aim to acknowledge reports within 3 working days and to ship a fix for confirmed issues as soon as we can,
crediting you in the release notes unless you prefer otherwise.

## Supported versions

Security fixes go into the latest release. Upgrade with `scripts/upgrade.sh` (it backs up first).

## What we do

- Every pull request runs `npm audit` and scans both container images with Trivy; a fixable vulnerability fails the build.
- Dependabot opens update pull requests for npm packages, base images and GitHub Actions every week.
- Images ship without package managers and run as non-root users.
