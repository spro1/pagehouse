<div align="center">

<img src="docs/images/logo.svg" width="72" height="72" alt="Pagehouse logo">

# Pagehouse

**An on-premises team wiki that small organizations and teams run on their own servers.**<br>
Weekly reports, meeting notes and technical docs in one place, inside your own network.<br>
An open-source, self-hosted alternative to Confluence. **[pagehouse website](https://spro1.github.io/pagehouse/)**

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
| **Where data lives** | Entirely on your server (PostgreSQL and a file volume). No external fonts, CDNs or telemetry; the only outbound requests are ones you turn on (SSO, email) and link-card previews (`LINK_PREVIEW=0` turns them off) |
| **No internet** | Install and upgrade from an offline bundle that contains the images |
| **Cost** | Apache-2.0 open source, no seat limits |
| **What you need** | One Linux server with Docker or Podman, or a Kubernetes cluster (Helm chart) |
| **Moving parts** | The app, PostgreSQL and a backup job: three containers, no external services |
| **Data safety** | Trash that never empties itself, version history, daily automatic backups, a backup before every upgrade and restore |
| **Leaving** | Export any space as Markdown or as HTML you can open in a browser, with attachments. Your data isn't tied to a format |
| **Sign-in** | Local accounts with invite links, or OpenID Connect SSO (tested with Keycloak; provider groups can become wiki groups and administrators). Forgotten passwords: an email reset link, or a temporary password from an admin |

## Features

| | |
|---|---|
| ✍️ **Editor** | A formatting toolbar and `/` block menu, Markdown shortcuts, text colors, tables with merged, split and colored cells, images you resize and caption, code highlighting for 45 languages (with a copy button), Mermaid diagrams, info and warning panels, to-dos, link cards, images and files by paste or drop, `@` mentions, an emoji per page |
| 🏠 **Home and notifications** | A landing page with recently viewed pages, new pages, and docs and comments that mention you; watch pages for edits; unread notifications by email (SMTP) or to a Slack, Mattermost or Teams webhook |
| 🗂️ **Organize** | Spaces, nested pages with drag and drop (`⋯` and `+` on every page in the tree), copying with subpages, labels, favorites and recently viewed, built-in templates plus your own, trash with undo |
| 🔎 **Search** | ⌘K quick search and a full search page: every word must match (Korean particles handled, two-syllable Korean words indexed), comments and attachment names included, filters by space, author and date |
| 🔒 **Permissions** | Per-space access (everyone edits, everyone views, private) for people or groups, plus per-page view/edit restrictions. What you can't see never appears in search, files or history |
| 💬 **Collaborate** | Real-time co-editing with live cursors, inline comments on selected text, comments with replies and resolve, version history with diff and restore |
| 🛡️ **Audit log** | Sign-ins (failed ones too), account, group and permission changes, deletions and exports, for admins |
| 👤 **Accounts** | Change your name and profile photo, reset a forgotten password by email (with SMTP), or get a temporary password from an admin that must be changed at first sign-in |
| 🤖 **AI agents** | Built-in MCP server: agents search, read and write pages with a personal API token (expires after 30, 90 or 365 days) and exactly your permissions |
| 📦 **Migrate** | Import Confluence CSV and HTML exports (page tree and order, folders, attachments, labels; code, panels, Jira, drawio and other macros), Notion, Markdown and HTML; export Markdown or HTML ZIPs and pages as PDF |
| 📊 **Admin** | Storage use against a limit, disk space, backup status and retention policy, activity, largest files; SSO set up on a screen; webhooks that send signed page and comment events (failed deliveries are retried, also after a restart); your own name, logo, favicon and accent color |
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

| | CPU | Memory | Disk |
|---|---|---|---|
| **Minimum** (trial, ~20 people) | 1 vCPU | 1 GB | 5 GB + attachments × 15 |
| **Recommended** (~50 people) | 2 vCPU | 2 GB | 20 GB SSD + attachments × 15 |
| **Recommended** (~200 people) | 2–4 vCPU | 4 GB | 50 GB SSD + attachments × 15 |
| **Larger organizations** | Several app instances on Kubernetes | 1–2 GB per instance | External PostgreSQL + shared storage |

- Each backup is a full copy and 14 are kept by default, so plan for about `(database + attachments) × 15`.
- These figures are guidelines. Idle, the app and database use about 50 MB of memory each; with 3,000 pages, the page tree answers in 6 ms and search in 3 ms. Details in the [installation guide](docs/install.md#requirements).

## Install

Requires Docker 24+ or Podman 4+. Pick the option that matches your environment.

### A. One server with internet access

```sh
curl -fsSL https://github.com/spro1/pagehouse/releases/latest/download/install.sh | sh -s -- --dir /opt/pagehouse
```

To install a specific version:

```sh
curl -fsSL https://github.com/spro1/pagehouse/releases/download/v0.4.0/install.sh | sh -s -- --dir /opt/pagehouse --version 0.4.0
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

1. **Administrator.** Open `http://<server>:3000` and create the first account with the setup token the installer printed (also in `docker compose logs app`). It becomes the administrator, and sign-up closes after it.
2. **HTTPS.** Put it behind your reverse proxy (nginx, Caddy, …) and set `BIND_ADDRESS=127.0.0.1` and `TRUST_PROXY=1` in `.env`. See the [examples](docs/install.md#https).
   - Plain HTTP on an IP address works too, but use HTTPS for the sake of the sign-in cookie.
3. **Invite the team.** In **Admin → People**, create invite links and send them over chat. No mail server is needed.
4. **Spaces.** Create one per team, and make sensitive ones (HR, management) **Private**.
5. **Backups.** In **Admin → Overview**, check that "Last automatic backup" appears. Then copy `/opt/pagehouse/backups` off the server, for example to a NAS.
6. **Storage limit (optional).** Set it in **Admin → Overview**. At the limit, text still saves; only new uploads are refused.
7. **Email (optional).** Set `SMTP_URL` in `.env` for notification emails and "Forgot your password?" reset links. Without it, admins issue reset links or temporary passwords in **Admin → People**.
8. **Bring your old docs.** See [moving from another wiki](#moving-from-another-wiki).

## Operations

| Task | How |
|---|---|
| Backup | Automatic every 24 h into `backups/pagehouse-auto-*.tar.gz` (14 kept). Manual: `scripts/backup.sh` |
| Restore | `scripts/restore.sh <backup>`. It backs up the current state first and prints the command to undo |
| Upgrade | Read the [notes per version](docs/upgrading.md), then `scripts/upgrade.sh [version]`. It backs up first and keeps `.env` and all data. Air-gapped: run the new bundle's `install.sh --dir` |
| Health | `curl localhost:3000/healthz` (includes the version); the Admin page shows storage, backups, activity and the audit log |
| Scale out | On Kubernetes, raise `replicaCount` with a ReadWriteMany attachment volume. Live co-editing works across instances through PostgreSQL |
| Logs | `docker compose logs app` |

Data lives in the compose volumes `db` (pages, history, accounts) and `files` (attachments), and backups in the install folder's `backups/`. To use an existing PostgreSQL, see the [installation guide](docs/install.md#using-an-external-postgresql-compose).

## Moving from another wiki

Use **Home → Import** (or the space menu → Import pages) and drop in files or a ZIP, or choose an unzipped folder.

| From | How to export | What comes across |
|---|---|---|
| **Confluence (recommended)** | Space settings → Export → **CSV** | From Confluence's own page source: page and folder tree in order, attachments with their names, labels, links between pages, code, panels, expand, Jira, drawio, tasks and more |
| **Confluence** | Space settings → Export → HTML | Page tree, attachments and images, the common macros |
| **One Confluence page** | Page → Export → Markdown | The text (dynamic macros remain as links) |
| **Notion** | Settings → Export → Markdown & CSV | Subpage tree, images, links between pages |
| **Folders of Markdown / HTML** | ZIP the folder | Folders as parent pages, linked images and files |
| **Pagehouse** | Space menu → Export | Everything: tree, attachments and links |

Import always adds new pages and never touches existing ones. If you don't like the result, move it to the trash and try again.

- When it finishes, anything to check is grouped by reason with what to do: attachments over the 50 MB limit, links to pages in other spaces, and so on.
- Confluence authors, dates, comments, permissions and history don't come across. The CSV export has no user names, so @mentions show as "@user".
- For exports of hundreds of MB, unzip and use **choose a folder**: it's easier on the browser's memory.

## Security

- **Nothing leaves your network unless you say so.** No telemetry or externally loaded assets. Outbound requests happen only for SSO and email you configure, and for link-card previews, which never reach private addresses unless allowed (`LINK_PREVIEW=0` disables them).
- **Permissions are enforced on the server.** A page you can't see answers 404 everywhere: the API, search, attachments, history and export.
- **Browser hardening:**
  - a strict Content-Security-Policy,
  - cross-site write protection,
  - sign-in throttling per address and per account (behind a proxy, set `TRUST_PROXY` so it counts real addresses),
  - uploads served sandboxed, as downloads only.
- **Accounts:**
  - SSO links to existing accounts only through an email the provider has verified.
  - Password-reset requests get the same answer whether or not the account exists.
  - Only admins can move a page out from under a restricted page (which would lift what it inherits).
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
There is no seat limit. A single-server setup is aimed at a few hundred people; on Kubernetes the app can scale out.

**Can people sign in with company accounts (SSO)?**
Yes, with any OpenID Connect provider. Turn it on in **Admin → SSO** with the issuer URL, client ID and secret (or set `OIDC_*` in `.env`). Tested with Keycloak; setup steps in the [SSO guide](docs/sso.md). An account is linked to the person at the provider on the first sign-in, by a verified email; after that a changed email still reaches the same account.

**I forgot my password.**
With email set up, use "Forgot your password?" on the sign-in page. Otherwise an admin creates a reset link or a temporary password in **Admin → People**; signing in with a temporary password asks you to choose your own straight away.

**Can administrators see private documents?**
Yes. Site administrators can open every space and page, so they can unlock content when needed. Give the admin role sparingly.

**What if the server dies?**
Daily backups accumulate in the server's `backups/` folder. Copy that folder off the server, and you can install on a new machine and run `scripts/restore.sh`.

**Can we move to another tool later?**
Yes. Export any space as standard Markdown files and attachments, or as HTML that opens in a browser: space menu → Export space.

## Roadmap

- LDAP / SAML sign-in
- Chat (Slack, Teams, Mattermost) webhooks
- Direct import from a Confluence server over its API, with @mention user mapping
- Full-text search inside attachments (PDF, Office)

## Documentation

- [Installation guide](docs/install.md): install options, HTTPS, backup and restore, upgrades, Kubernetes, troubleshooting
- [Upgrade guide](docs/upgrading.md): database changes, new settings, behaviour changes and rolling back, per version
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

Confluence is a trademark of Atlassian. Pagehouse is not affiliated with or endorsed by Atlassian.
