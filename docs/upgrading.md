# Upgrade guide

[한국어](upgrading.ko.md)

## How to upgrade

| Installed with | Upgrade |
|---|---|
| One-line install (Docker, Podman) | In the install folder: `scripts/upgrade.sh <version>`, e.g. `scripts/upgrade.sh 0.4.0` |
| Offline bundle | Extract the new bundle and run `sh pagehouse-<version>/install.sh --dir <install folder>` |
| Kubernetes (Helm) | `helm upgrade <name> pagehouse-<version>.tgz -n <namespace> --reuse-values` |

**What the upgrade does:**
1. Backs up the current state first (`backups/before-upgrade/`).
2. Replaces `docker-compose.yml`, `.env.example`, the scripts and the docs with the new version's.
3. Leaves `.env` and your data (database and attachment volumes, backups) alone. New settings missing from `.env` run on their defaults; copy the ones you need over from `.env.example`.
4. Restarts on the new image. Database changes (migrations) apply automatically when the app starts.

**Check:** `curl localhost:<port>/healthz` shows the new version number.

**Rolling back:**
- Migrations only go forward, so don't just start the previous image again.
- To roll back, restore the backup taken right before the upgrade:
  ```sh
  scripts/restore.sh backups/before-upgrade/<file>
  ```
- Then set `PAGEHOUSE_VERSION` in `.env` back to the previous version and run `docker compose up -d`.

**Skipping versions:** you can upgrade across several versions at once; every missing migration applies in order. Read the notes for **every version you skip** below.

## Notes per version

### 0.4.0 → 0.5.0

Database changes apply automatically. Read the sign-in length change below (set `SESSION_HOURS=720` to keep 30 days); the changes:
- **API tokens expire.** New tokens last 30, 90 (default) or 365 days. Tokens made before this version keep working until revoked. Tokens of people who sign in by SSO stop after 30 days without an SSO sign-in (`TOKEN_SSO_GRACE_DAYS`).
- **SSO groups.** At each sign-in, the provider's `groups` claim (`OIDC_GROUPS_CLAIM`) becomes the person's wiki groups; groups that don't exist are created. Memberships added by hand stay. An optional administrator group (`OIDC_ADMIN_GROUP` or Admin → SSO) grants admin. Providers that don't send the claim see no change. See the [SSO guide](sso.md#groups-and-administrators).
- **SSO checks the ID token** (issuer, audience, expiry and a per-sign-in nonce). Providers that follow OpenID Connect need no change.
- **Webhook retries survive restarts** and wait 1, 4, 16 and 64 minutes. Requests also carry `X-Event` and `X-Signature` (same values as `X-Pagehouse-Event` and `X-Pagehouse-Signature`, which stay).
- **Two-syllable Korean searches** ("배포", "장애") use an index. The upgrade builds it once, which can take a moment on a large wiki.
- **New installs** ask for a setup token when creating the first account (printed in the log, or `SETUP_TOKEN`).
- **SSO finds accounts by the provider's user id (`sub`).** Each existing account is linked by its verified email at its next SSO sign-in, as before; after that, a changed email at the provider still signs in to the same account (the wiki email is not changed). An account with the same email that is already linked to another provider user is refused. Linking and creating accounts still need a verified email.
- **Account tables move to their own schema.** `users`, `sessions`, `groups` and `group_members` move from `public` to `accounts` at the first start, with their rows; the SSO setting moves to `accounts.settings`. Nothing changes in use, and this is what lets Pagehouse [share accounts with Taskhouse](install.md#using-pagehouse-together-with-taskhouse). The database user needs the `CREATE` privilege on the database (its owner has it), or the app stops at the first start with `permission denied for database`. With more than one app instance, instances still on the old version fail once the first new one has started: stop them all before the upgrade. SQL you run by hand must name the schema (`accounts.users`). The app sets its `search_path` when it connects, so a connection pooler in front must pass the `options` startup parameter through. An older version can't read the new layout: to go back, restore the backup taken before the upgrade.
- **Sign-ins last one day by default** instead of 30 days, so people sign in again daily. To keep the old behavior, set `SESSION_HOURS=720` in `.env`. Sessions started before the upgrade keep their original expiry.

### 0.3.1 → 0.4.0

No database or settings changes.
- **Branding.** Admin → **Branding** sets your organization's name, logo and accent color. The name becomes the browser tab title and shows on the sign-in screen, the sidebar and in email subjects; the logo is also the favicon. See the [user guide](user-guide.md#for-administrators).
- **Unused files are cleaned up.** Replaced or removed profile photos and logos are deleted from the `files` volume (checked hourly; attachments are never deleted). If you run an external database, restore it together with the `files` volume.

### 0.3.0 → 0.3.1

No database or settings changes.
- **Sidebar**: hide it with the button at its top right or Cmd/Ctrl+\\, and drag its edge to make it wider (up to 40% of the window). Both are remembered per browser.
- **Text keeps its width**: when the page area gets narrow (for example a wider sidebar), the table of contents on the right hides first; pages without one no longer reserve its column.
- **Scrollbars** appear only while hovering the sidebar or scrolling the page.
- **Fixed:** on laptop-sized windows the toolbar's **+ Insert**, color and link menus opened under the sidebar.

### 0.2.0-beta.5 → 0.3.0

No database changes. One new optional setting.
- **Monitoring.** Admin → Overview shows **Server health** (database, memory, server delay, recent errors, waiting notifications, overdue backup). For Prometheus, set `METRICS_TOKEN` in `.env` and scrape `/metrics`; see [Monitoring](monitoring.md). Without the token, `/metrics` stays off.
- **Fixed: picking a block from the `/` menu (for example a table), or closing ⌘K search, could crash the page** in recent Chrome and Edge with "This screen couldn't be shown". Nothing was lost; reloading brought the page back.
- **Installer:** a new install into a folder whose earlier install left its database behind now stops and explains what to do, instead of failing later with `auth_failed`.
- **Product page** at https://spro1.github.io/pagehouse/.
- From this version `releases/latest` points at it, so the one-line install no longer needs `--version`.

### 0.2.0-beta.4 → 0.2.0-beta.5

Fixes only; no database or settings changes.
- **`scripts/upgrade.sh` stopped right after the pre-upgrade backup** and reported nothing, so the version didn't change (the backup step swallowed the rest of the piped installer). If an upgrade left you on the old version, just run `scripts/upgrade.sh 0.3.1`: the new installer works with the old script, and the extra backups it left in `backups/before-upgrade/` are harmless.
- **The first automatic backup of a new install failed** when nothing had been uploaded yet; the next try came a day later. Manual backups (`scripts/backup.sh`) and the Kubernetes backup job had the same problem.

### 0.2.0-beta.3 → 0.2.0-beta.4

- Database: migration `023` (webhooks) runs automatically at start. Other settings go into the existing `settings` table.
- **SSO can be set up in Admin → SSO.** Saving applies it at once, without a restart.
- If you already set SSO in `.env`, it keeps working: environment variables win over the screen, which shows them read-only. To manage it on the screen, remove the `OIDC_*` lines from `.env` and enter the same values there.
- **Signing out also signs out of the SSO provider.** Allow the wiki address ending in `/` as a post-logout redirect URI at the provider (Keycloak: *Valid post logout redirect URIs*), or the provider will refuse the return. People signed in before the upgrade need to sign in once more. See the [SSO guide](sso.md).
- **New `SECRET_KEY` in `.env`**, added automatically by the upgrade. It encrypts the SSO client secret in the database; a secret saved earlier is encrypted the next time it's read. Keep a copy of `.env`: backups don't contain the key. Manual or Helm installs: set `SECRET_KEY` to a long random value yourself (e.g. `openssl rand -hex 32`).
- **Backup policy in Admin → Overview**: interval, how many automatic backups to keep, and optional age limits, including for manual and pre-upgrade backups. `BACKUP_INTERVAL_HOURS` / `BACKUP_KEEP` stay as defaults. The compose file changed, so the upgrade recreates the backup container (it takes a backup right away).
- **Webhooks** (migration `023`): Admin → Webhooks sends page and comment events as signed JSON, and each person can post their notifications to a chat webhook in Settings. Personal webhooks can't reach internal addresses unless `WEBHOOK_ALLOW` lists them.

### 0.2.0-beta.2 → 0.2.0-beta.3

- No database or setting changes.
- **Editor:** the toolbar gains text color, background color, underline, alignment, link and clear-formatting buttons. Markdown export drops colors (Markdown has no way to express them); HTML export keeps them.
- **Confluence HTML import:**
  - Attachments keep their real file names.
  - `.txt` files in the attachments folder no longer become pages.
  - Jira links show just the issue key.

### 0.2.0-beta.1 → 0.2.0-beta.2

- No database or setting changes.
- The app runs on **Node 26** instead of 24. Only the image changes; nothing to do.

### 0.1.0-beta.3 → 0.2.0-beta.1

A big one. Check the following before upgrading.

**13 database migrations (010–022) apply automatically:** groups, inline comments, templates, watching and email, search indexes, API tokens, live-editing state, the audit log, labels, favorites, page icons and profiles. Existing data isn't changed; tables and columns are only added.

**On first start:** the search text is rebuilt once, in the background (a few minutes for thousands of pages). Search can be a little less precise until it finishes.

**Settings to check:**

| If | Do |
|---|---|
| You run behind a reverse proxy (nginx, …) | **Let WebSockets through** (live co-editing): the [nginx example](install.md#https) has the `Upgrade` and `Connection` headers and `proxy_read_timeout`. Without it editing still works, but saves the old way instead of live |
| You run behind a reverse proxy | Set `TRUST_PROXY=1` in `.env`, so sign-in throttling and the audit log see real client addresses |
| You'll use SSO (OIDC) | The provider must send `email_verified`; for providers that don't (some Entra ID setups) set `OIDC_TRUST_EMAIL=1` |
| You want password-reset emails | Set `SMTP_URL`, `SMTP_FROM` and `PUBLIC_URL` |
| Kubernetes | With the ingress on, `TRUST_PROXY=1` is set for you. Raise the ingress controller's WebSocket timeout (nginx-ingress: `proxy-read-timeout: "3600"`) |

**Behaviour changes:**
- Only admins can move a page **out from under a restricted page**, since that would lift the restrictions it inherits.
- Saving through the API or an import while someone is editing that page live can be refused with `409 conflict`; retry a moment later.
- People with view-only access can no longer resolve other people's comment threads.

### 0.1.0-beta.1 or beta.2 → 0.1.0-beta.3

- No database changes; only the image changes.
