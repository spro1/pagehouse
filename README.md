<div align="center">

<img src="docs/images/logo.svg" width="72" height="72" alt="Pagehouse logo">

# Pagehouse

**The self-hosted team wiki for small companies and teams.**<br>
Weekly reports, meeting notes and technical docs in one page tree, on your own server.

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![CI](https://github.com/spro1/pagehouse/actions/workflows/ci.yml/badge.svg)](https://github.com/spro1/pagehouse/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/spro1/pagehouse?include_prereleases&sort=semver)](https://github.com/spro1/pagehouse/releases)
![Docker | Podman | Kubernetes](https://img.shields.io/badge/runs%20on-Docker%20%7C%20Podman%20%7C%20Kubernetes-2f6feb)

[Install](#install) · [Features](#features) · [Docs](#documentation) · [Contributing](CONTRIBUTING.md) · [한국어](README.ko.md)

<img src="docs/images/screenshot-light.png" alt="A Pagehouse page with a checklist, a rollout table, a code block and panels" width="100%">

</div>

## Why Pagehouse

- **Yours to run.** One `curl | sh` on any Linux box, an offline bundle for closed networks, or a Helm chart. Two containers plus a backup job, no external services, no telemetry.
- **Hard to lose data.** Deletes go to a trash that never empties itself, history keeps the text from before big deletions, unsaved edits survive a dropped connection, and the server backs itself up every day.
- **Comes with your old wiki.** Import Confluence HTML exports, Notion exports, Markdown and HTML, with page trees and attachments.
- **Small.** About 5,000 lines of TypeScript. A 3,000-page space opens its page tree in 6 ms.

## Features

| | |
|---|---|
| ✍️ **Editor** | `/` block menu, Markdown shortcuts, tables with merge and split, code highlighting for 25 languages, info and warning panels, to-dos, images and files by paste or drop |
| 🗂️ **Organize** | Spaces, nested pages with drag and drop, templates (weekly report, meeting notes, tech doc), trash with undo |
| 🔎 **Search** | ⌘K quick search and a full search page: every word must match, filters by space, author and date, results with location and highlights |
| 🔒 **Access** | Invite links, admin and member roles, per-page *view* / *edit* restrictions inherited by subpages and enforced everywhere: tree, search, files, history |
| 💬 **Collaborate** | Comments with replies and resolve, version history with restore, edit-conflict protection |
| 📦 **Import / export** | Confluence, Notion, Markdown, HTML in; Markdown + attachments ZIP out, which also re-imports losslessly |
| 📊 **Admin** | Storage use against a configurable limit, disk space, backup status, activity, largest files |
| 🌐 **Languages** | English and Korean, chosen per account |

<table>
  <tr>
    <td width="50%"><img src="docs/images/screenshot-dark.png" alt="Dark theme"></td>
    <td width="50%"><img src="docs/images/screenshot-search.png" alt="Quick search"></td>
  </tr>
  <tr>
    <td align="center"><sub>Dark theme</sub></td>
    <td align="center"><sub>⌘K quick search</sub></td>
  </tr>
</table>

## Install

Docker 24+ or Podman 4+ is required.

```sh
curl -fsSL https://github.com/spro1/pagehouse/releases/latest/download/install.sh | sh
```

During the beta, install a specific version: `curl -fsSL https://github.com/spro1/pagehouse/releases/download/v0.1.0-beta.1/install.sh | sh -s -- --version 0.1.0-beta.1`

Open `http://<server>:3000` and create the first account; it becomes the administrator. Invite everyone else from **Admin → People**.

| Also available | |
|---|---|
| **Offline (no internet)** | `pagehouse-<version>-offline-{amd64,arm64}.tar.gz` contains the images. Extract and run `install.sh` |
| **Kubernetes** | `helm install wiki pagehouse-<version>.tgz` with PostgreSQL, backups and Ingress |
| **Upgrade** | `scripts/upgrade.sh` backs up first, keeps your data and settings |

See the [installation guide](docs/install.md) for HTTPS, backups, external PostgreSQL and troubleshooting.

## How it works

```
 Browser ──HTTP──▶ app (Node 24, Hono)  ──▶ PostgreSQL 17 (pages, history, accounts, search)
                    │                    ╰─▶ /data volume (attachments, stored once per content hash)
                    ╰── serves the React + Tiptap editor
 backup job ── every 24 h ──▶ ./backups/pagehouse-auto-*.tar.gz  (database + attachments, 14 kept)
```

Pages are stored as ProseMirror JSON, so nothing is lost converting between formats. Search uses PostgreSQL trigram indexes, which handle Korean and other languages without a separate search server.

## Security

- Container images contain no package managers and no unused TLS libraries; CI fails on any fixable CVE ([Trivy](https://trivy.dev)).
- `npm audit`, OSV and Grype report no known vulnerabilities in the dependencies at release time.
- Strict Content-Security-Policy, cross-site write protection, sign-in throttling, uploaded files served sandboxed and as downloads.
- The app and database run as non-root users.

Found a vulnerability? Please report it privately, see [SECURITY.md](SECURITY.md).

## Documentation

- [Installation guide](docs/install.md): requirements, HTTPS, backups, upgrades, Kubernetes, troubleshooting
- [User guide](docs/user-guide.md): editor, search, access, import and export, admin tasks
- [Releasing](docs/releasing.md): for maintainers

## Development

```sh
npm install
podman run -d --rm --name pagehouse-testdb -e POSTGRES_USER=pagehouse -e POSTGRES_PASSWORD=pagehouse \
  -e POSTGRES_DB=pagehouse_test -p 55432:5432 docker.io/library/postgres:17-alpine
npm test            # server and i18n tests (wipes the *_test database)
npm run typecheck
DATABASE_URL=postgres://pagehouse:pagehouse@localhost:55432/pagehouse_test npm run dev
```

| Path | |
|---|---|
| `server/` | HTTP API (Hono), migrations, export, admin stats |
| `web/` | React app and Tiptap editor; `web/i18n.ts` holds all UI text |
| `scripts/` | install, upgrade, backup, restore, release packaging |
| `charts/pagehouse/` | Helm chart |
| `docker/postgres/` | the hardened PostgreSQL image |

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first.

## License

[Apache-2.0](LICENSE)
