# Upgrade guide

[한국어](upgrading.ko.md)

## How to upgrade

| Installed with | Upgrade |
|---|---|
| One-line install (Docker, Podman) | In the install folder: `scripts/upgrade.sh <version>`, e.g. `scripts/upgrade.sh 0.2.0-beta.2` |
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

### 0.2.0-beta.2 → next (unreleased)

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
