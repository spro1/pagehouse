<div align="center">

<img src="docs/images/logo.svg" width="72" height="72" alt="Pagehouse logo">

# Pagehouse

**An on-premises team wiki that small companies and teams run on their own servers.**<br>
Weekly reports, meeting notes and technical docs in one place, inside your own network.

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![CI](https://github.com/spro1/pagehouse/actions/workflows/ci.yml/badge.svg)](https://github.com/spro1/pagehouse/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/spro1/pagehouse?include_prereleases&sort=semver)](https://github.com/spro1/pagehouse/releases)
![Docker | Podman | Kubernetes](https://img.shields.io/badge/runs%20on-Docker%20%7C%20Podman%20%7C%20Kubernetes-2f6feb)
![Air-gapped](https://img.shields.io/badge/air--gapped-supported-2f6feb)

[Is it a fit?](#is-it-a-fit) · [Install](#install) · [Day one](#day-one-checklist) · [Operations](#operations) · [Migrating](#moving-from-another-wiki) · [FAQ](#faq) · [한국어](README.ko.md)

<img src="docs/images/screenshot-light.png" alt="A Pagehouse page with a checklist, a rollout table, a code block and panels" width="100%">

</div>

## Who it's for

- **Companies and teams of 5–200 people** for whom hosted wikis are costly, or who are tired of counting seats at every renewal
- Organizations whose documents **must not live on someone else's servers**: security policy, customer requirements, air-gapped networks
- Teams **without dedicated ops staff** that want something they can put on one server and mostly forget

## Is it a fit?

| | Pagehouse |
|---|---|
| **Where data lives** | Entirely on your server (PostgreSQL and a file volume). The app makes no outbound requests: no external fonts, CDNs or telemetry |
| **No internet** | Install and upgrade from an offline bundle that contains the images |
| **Cost** | Apache-2.0 open source, no seat limits |
| **What you need** | One Linux server with Docker or Podman, or a Kubernetes cluster (Helm chart) |
| **Moving parts** | The app, PostgreSQL and a backup job: three containers, no external services |
| **Data safety** | Trash that never empties itself, version history, daily automatic backups, a backup before every upgrade and restore |
| **Leaving** | Export any space as Markdown plus attachments. Your data isn't tied to a format |
| **Not yet** | SSO (OIDC), real-time co-editing, email notifications; see the [roadmap](#roadmap) |

## Features

| | |
|---|---|
| ✍️ **Editor** | `/` block menu, Markdown shortcuts, tables with merge and split, code highlighting for 25 languages, info and warning panels, to-dos, images and files by paste or drop, `@` mentions |
| 🏠 **Home and notifications** | A landing page with recently viewed pages, new pages, and docs and comments that mention you; an unread counter on the bell |
| 🗂️ **Organize** | Spaces, nested pages with drag and drop, templates (weekly report, meeting notes, tech doc), trash with undo |
| 🔎 **Search** | ⌘K quick search and a full search page: every word must match (Korean included), filters by space, author and date |
| 🔒 **Permissions** | Per-space access (everyone edits, everyone views, private) with member roles, plus per-page view/edit restrictions. What you can't see never appears in search, files or history |
| 💬 **Collaborate** | Comments with replies and resolve, version history with restore, edit-conflict protection |
| 📦 **Migrate** | Import Confluence HTML, Notion, Markdown and HTML; export Markdown plus attachments as a ZIP |
| 📊 **Admin** | Storage use against a limit, disk space, backup status, activity, largest files |
| 🌐 **Interface** | English and Korean, light and dark themes, set per account |

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

## Server sizing

| Team size | CPU / memory | Disk |
|---|---|---|
| up to ~50 | 1 vCPU / 1 GB | 10 GB + attachments |
| up to ~200 | 2 vCPU / 4 GB | 20 GB + attachments |

- Each backup is a full copy and 14 are kept by default, so plan for about `(database + attachments) × 15`.
- These figures are guidelines. With 3,000 pages, the page tree answers in 6 ms and search in 3 ms.

## Install

Requires Docker 24+ or Podman 4+. Pick the option that matches your environment.

### A. One server with internet access

```sh
curl -fsSL https://github.com/spro1/pagehouse/releases/latest/download/install.sh | sh -s -- --dir /opt/pagehouse
```

During the beta, pin the version:

```sh
curl -fsSL https://github.com/spro1/pagehouse/releases/download/v0.1.0-beta.3/install.sh | sh -s -- --dir /opt/pagehouse --version 0.1.0-beta.3
```

The installer:

- writes a `.env` with a random database password (mode 600),
- pulls the images and starts everything,
- waits until it is healthy.

### B. Air-gapped (no internet)

On a machine with internet, download `pagehouse-<version>-offline-amd64.tar.gz` (or `-arm64`) and `SHA256SUMS` from the releases page, copy them to the server, then:

```sh
sha256sum -c SHA256SUMS --ignore-missing
tar xzf pagehouse-<version>-offline-amd64.tar.gz
sh pagehouse-<version>/install.sh --dir /opt/pagehouse
```

The bundle contains the container images; nothing is downloaded.

### C. Kubernetes

```sh
helm install wiki pagehouse-<version>.tgz -n wiki --create-namespace \
  --set ingress.enabled=true --set ingress.host=wiki.example.com
```

This deploys PostgreSQL, a daily backup CronJob and a generated database password. On an air-gapped cluster, point `image.repository` at your registry mirror. Values are in the [installation guide](docs/install.md#3-kubernetes-helm).

## Day-one checklist

1. **Administrator.** Open `http://<server>:3000` and create the first account. It becomes the administrator, and sign-up closes after it.
2. **HTTPS.** Put it behind your reverse proxy (nginx, Caddy, …) and set `BIND_ADDRESS=127.0.0.1` in `.env`. See the [examples](docs/install.md#https).
3. **Invite the team.** In **Admin → People**, create invite links and send them over chat. No mail server is needed.
4. **Spaces.** Create one per team, and make sensitive ones (HR, management) **Private**.
5. **Backups.** In **Admin → Overview**, check that "Last automatic backup" appears. Then copy `/opt/pagehouse/backups` off the server, for example to a NAS.
6. **Storage limit (optional).** Set it in **Admin → Overview**. At the limit, text still saves; only new uploads are refused.
7. **Bring your old docs.** See [moving from another wiki](#moving-from-another-wiki).

## Operations

| Task | How |
|---|---|
| Backup | Automatic every 24 h into `backups/pagehouse-auto-*.tar.gz` (14 kept). Manual: `scripts/backup.sh` |
| Restore | `scripts/restore.sh <backup>`. It backs up the current state first and prints the command to undo |
| Upgrade | `scripts/upgrade.sh [version]`. It backs up first and keeps `.env` and all data. Air-gapped: run the new bundle's `install.sh --dir` |
| Health | `curl localhost:3000/healthz` (includes the version); the Admin page shows storage, backups and activity |
| Logs | `docker compose logs app` |

Data lives in the compose volumes `db` (pages, history, accounts) and `files` (attachments), and backups in the install folder's `backups/`. To use an existing PostgreSQL, see the [installation guide](docs/install.md#using-an-external-postgresql-compose).

## Moving from another wiki

Use **Home → Import** and drop in files or a ZIP.

| From | How to export | What comes across |
|---|---|---|
| **Confluence** | Space tools → Export → HTML | Page tree (from breadcrumbs), attachments and images, info and warning macros as panels, code macros |
| **Notion** | Settings → Export → Markdown & CSV | Subpage tree, images, links between pages |
| **Folders of Markdown / HTML** | ZIP the folder | Folders as parent pages, linked images and files |
| **Pagehouse** | Space menu → Export | Everything: tree, attachments and links |

Import always adds new pages and never touches existing ones. If you don't like the result, move it to the trash and try again.

## Security

- **Nothing leaves your network.** No outbound calls, no telemetry, no externally loaded assets.
- **Permissions are enforced on the server.** A page you can't see answers 404 everywhere: the API, search, attachments, history and export.
- **Browser hardening:**
  - a strict Content-Security-Policy,
  - cross-site write protection,
  - sign-in throttling,
  - uploads served sandboxed, as downloads only.
- **Containers:**
  - The app and database run as non-root users.
  - Images contain no package managers and no unused TLS libraries.
  - CI fails on any fixable CVE (Trivy).
  - Dependabot opens weekly update pull requests.

Please report vulnerabilities privately, as described in [SECURITY.md](SECURITY.md).

## FAQ

**Does it need internet access?**
No. Installing (from the offline bundle), using and upgrading all work without it.

**How many users can it handle?**
There is no seat limit. A single-server setup is aimed at a few hundred people.

**Can people sign in with company accounts (SSO)?**
Not yet; accounts are local and created through invite links. OIDC-based SSO is next on the roadmap.

**Can administrators see private documents?**
Yes. Site administrators can open every space and page, so they can unlock content when needed. Give the admin role sparingly.

**What if the server dies?**
Daily backups accumulate in the server's `backups/` folder. Copy that folder off the server, and you can install on a new machine and run `scripts/restore.sh`.

**Can we move to another tool later?**
Yes. Export any space as standard Markdown files and attachments.

## Roadmap

- SSO (OIDC: Keycloak, Microsoft Entra, Google Workspace, …)
- Real-time co-editing
- Email and chat (webhook) notifications
- API tokens and an MCP server for agents

## Documentation

- [Installation guide](docs/install.md): install options, HTTPS, backup and restore, upgrades, Kubernetes, troubleshooting
- [User guide](docs/user-guide.md): editor, search, permissions, mentions and notifications, import and export, admin
- [Contributing](CONTRIBUTING.md) · [Security policy](SECURITY.md) · [Releasing](docs/releasing.md)

## Development

```sh
npm install
podman run -d --rm --name pagehouse-testdb -e POSTGRES_USER=pagehouse -e POSTGRES_PASSWORD=pagehouse \
  -e POSTGRES_DB=pagehouse_test -p 55432:5432 docker.io/library/postgres:17-alpine
npm test && npm run typecheck
DATABASE_URL=postgres://pagehouse:pagehouse@localhost:55432/pagehouse_test npm run dev
```

Layout:

- `server/`: API and migrations
- `web/`: React + Tiptap editor; UI text lives in `web/i18n.ts`
- `scripts/`: install, upgrade, backup, restore, release
- `charts/pagehouse/`: Helm chart
- `docker/postgres/`: hardened PostgreSQL image

## License

[Apache-2.0](LICENSE): free to use inside your company, modify and redistribute.
