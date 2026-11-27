# Installation guide

[한국어](install.ko.md)

Pagehouse runs as three containers: the app, PostgreSQL, and a backup job. Settings live in one `.env` file.

| Method | Use it when |
|---|---|
| [1. One-line install](#1-one-line-install) | A Linux or macOS server with internet access |
| [2. Offline install](#2-offline-install-no-internet) | A closed network with no internet |
| [3. Kubernetes (Helm)](#3-kubernetes-helm) | You already run a cluster |
| [4. From source](#4-from-source) | You develop Pagehouse or build your own image |

In the commands below, `spro1/pagehouse` is the GitHub repository Pagehouse is published from.

## Requirements

| Size | CPU | Memory | Disk | Notes |
|---|---|---|---|---|
| **Minimum** (trial, ~20 people) | 1 vCPU | 1 GB | 5 GB + attachments × 15 | HDD is fine |
| **Recommended** (~50 people) | 2 vCPU | 2 GB | 20 GB SSD + attachments × 15 | |
| **Recommended** (~200 people) | 2–4 vCPU | 4 GB | 50 GB SSD + attachments × 15 | Teams that co-edit and import a lot |
| **Larger organizations** | Several app instances | 1–2 GB per instance | External PostgreSQL + shared storage | Kubernetes `replicaCount`, ReadWriteMany volume |

- **Measured:** idle, the app uses about 50 MB of memory and the database about 50 MB; the images are about 190 MB (app) and 300 MB (database). The rest of the memory goes to PostgreSQL's cache and to exports and imports. At 3,000 pages the page tree answered in 6 ms and search in 3 ms.
- **Disk:** each backup is a full copy (database + attachments) and 14 are kept by default, so plan for `(database + attachments) × 15`. Less if you move backups off the server.
- **CPU architectures:** amd64 (x86_64) and arm64

| Software | Supported | Notes |
|---|---|---|
| Container runtime | Docker 24+ with Compose v2, or Podman 4+ with `podman compose` | Tested on Podman 6.0 |
| Kubernetes | 1.21+ (the chart uses `batch/v1` CronJobs), Helm 3 | ReadWriteMany storage to run several instances |
| External PostgreSQL | 14+, with the `pg_trgm` extension | Optional |
| Browser | Current Chrome, Edge, Firefox, Safari | Importing an export of hundreds of MB needs 1–2 GB of free browser memory (less if you unzip it and choose the folder) |

## 1. One-line install

```sh
curl -fsSL https://github.com/spro1/pagehouse/releases/latest/download/install.sh | sh
```

This creates `./pagehouse`, writes a `.env` with a random database password, pulls the images, starts everything and waits until it is healthy. Options:

```sh
curl -fsSL .../install.sh | sh -s -- --dir /opt/pagehouse --port 8080 --version 0.2.0
```

Prefer to read the script first? Download it, read it, then run `sh install.sh`.

Open `http://<server>:3000`. **The first account you create becomes the administrator**, and sign-up closes right after. Creating it asks for the **setup token**: the installer prints it at the end, and it is in the app's log (`docker compose logs app | grep 'setup token'`). Set `SETUP_TOKEN` in `.env` beforehand to choose it yourself. It is only needed for that first account. Invite everyone else from **Admin → Invite people**.

## 2. Offline install (no internet)

On a machine with internet, download from the release page:

- `pagehouse-<version>-offline-amd64.tar.gz` (most servers) or `-arm64` (ARM servers)
- `SHA256SUMS`, to check the file after copying it

Copy the file to the server, then:

```sh
sha256sum -c SHA256SUMS --ignore-missing     # optional: verify the copy
tar xzf pagehouse-<version>-offline-amd64.tar.gz
sh pagehouse-<version>/install.sh --dir /opt/pagehouse
```

The bundle contains the container images, so nothing is downloaded. To upgrade later, do the same with the new bundle and the same `--dir`.

## 3. Kubernetes (Helm)

Download `pagehouse-<version>.tgz` from the release page.

```sh
helm install wiki pagehouse-<version>.tgz -n wiki --create-namespace \
  --set ingress.enabled=true --set ingress.host=wiki.example.com \
  --set ingress.annotations."nginx\.ingress\.kubernetes\.io/proxy-body-size"=50m
```

What you get: the app (one replica), a PostgreSQL StatefulSet, a daily backup CronJob writing to its own volume, and a Secret with a generated database password. Useful values:

| Value | Default | Meaning |
|---|---|---|
| `image.repository` | the published image | Point at a registry mirror for closed networks |
| `replicaCount` + `persistence.accessMode=ReadWriteMany` | 1 | Several app pods (needs a ReadWriteMany storage class for attachments). Live co-editing works across pods through PostgreSQL |
| `persistence.size` / `postgresql.size` / `backup.size` | 10Gi / 10Gi / 20Gi | Volume sizes |
| `postgresql.enabled=false` + `externalDatabase.url` | | Use your own PostgreSQL 14+ |
| `backup.schedule` / `backup.keep` | `0 3 * * *` / 14 | Backup timing and retention |
| `allowSignup` | false | Open sign-up |

**Data safety:** `helm uninstall` keeps the database volume, attachments volume, backup volume and the database Secret. Upgrades reuse the existing database password. Delete those objects yourself only when you really mean to erase everything.

Upgrade: `helm upgrade wiki pagehouse-<new>.tgz -n wiki --reuse-values`.

## 4. From source

```sh
git clone https://github.com/spro1/pagehouse && cd pagehouse
cp .env.example .env        # set POSTGRES_PASSWORD, and uncomment COMPOSE_FILE to build locally
docker compose up -d --build
```

## Configuration (`.env`)

Restart after changing it: `docker compose up -d`.

| Variable | Default | Meaning |
|---|---|---|
| `POSTGRES_PASSWORD` | generated by the installer | Database password. Changing it later also needs a change inside Postgres. |
| `SECRET_KEY` | generated by the installer | Encrypts stored secrets (the SSO client secret). Not in the database or backups, so **keep a copy of `.env` somewhere safe**: restoring onto a server with a different key means entering the SSO secret again. Older installs get one on upgrade. |
| `PORT` | `3000` | Port on the host |
| `BIND_ADDRESS` | `0.0.0.0` | `127.0.0.1` to accept connections only from a reverse proxy on the same machine |
| `ALLOW_SIGNUP` | `0` | `1` lets anyone who can reach the site create an account |
| `PUBLIC_URL` | (from the request) | Address people use, e.g. `https://wiki.example.com`. Used for sign-on redirects and links in email |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | empty | **Usually set in Admin → SSO instead** (see the [SSO guide](sso.md)). Set here, they win over the screen, which becomes read-only. Single sign-on with any OpenID Connect provider. Redirect URI: `<PUBLIC_URL>/api/auth/oidc/callback` |
| `OIDC_LABEL` | `SSO` | Text on the sign-in button |
| `OIDC_AUTO_CREATE` | `1` | `0` lets in only people who already have an account with that email |
| `PASSWORD_LOGIN` | `1` | `0` with SSO on: only administrators can still sign in with a password |
| `OIDC_GROUPS_CLAIM` | `groups` | Claim with the person's groups at the provider; copied to wiki groups at each sign-in ([SSO guide](sso.md#groups-and-administrators)) |
| `OIDC_ADMIN_GROUP` | empty | Members of this provider group become administrators |
| `TOKEN_SSO_GRACE_DAYS` | `30` | API tokens of someone who signs in by SSO stop working after this many days without an SSO sign-in (they were probably removed at the provider) |
| `SETUP_TOKEN` | generated | Token the first (administrator) account needs. Without it one is generated and printed in the log |
| `SESSION_HOURS` | `24` (one day) | How long a sign-in lasts. `720` keeps people signed in for 30 days, as before 0.5.0 |
| `COOKIE_DOMAIN` | empty | Only when sharing accounts with Taskhouse on another subdomain: the parent domain, so one sign-in covers both ([details](#using-pagehouse-together-with-taskhouse)) |
| `TRUST_PROXY` | `0` | Number of reverse proxies in front. Set `1` behind a proxy so sign-in throttling and the audit log see real client addresses; `0` for direct connections (the Helm chart sets `1` when ingress is on) |
| `OIDC_TRUST_EMAIL` | `0` | An account is linked or created at the first SSO sign-in by email, so only emails the provider marks verified are accepted for that. `1` for providers that never send `email_verified` (some Entra ID setups) — only if users can't change their email there |
| `SMTP_URL`, `SMTP_FROM` | empty | Notification emails and "Forgot your password?" reset links. For example `smtp://user:pass@mail.example.com:587`. Links in mail need `PUBLIC_URL` |
| `METRICS_TOKEN` | empty | Turns on `/metrics` (Prometheus) for scrapers that send it as a bearer token. See [Monitoring](monitoring.md) |
| `WEBHOOK_ALLOW` | empty | Internal hosts that personal notification webhooks may post to, e.g. `chat.corp.local,.corp.local`. Private and loopback addresses are refused otherwise. Admin webhooks may reach any host |
| `LINK_PREVIEW` / `LINK_PREVIEW_ALLOW` | `1` / empty | Link cards fetch a pasted link's title and image from the server. Private and loopback addresses are refused unless listed, e.g. `jira.corp.local,.gitlab.corp.local` |
| `PAGEHOUSE_VERSION` | set by the installer | Image version. Upgrades change it |
| `BACKUP_INTERVAL_HOURS` / `BACKUP_KEEP` | `24` / `14` | Defaults for automatic backup timing and retention. **Admin → Overview → Backup policy** overrides them without a restart |

## HTTPS

Put Pagehouse behind a reverse proxy that terminates TLS. The proxy must forward `X-Forwarded-Proto` (so login cookies get `Secure`) and allow uploads up to 50 MB. Set `BIND_ADDRESS=127.0.0.1` so the plain port isn't reachable from outside.

**Caddy** (certificates automatically):

```
wiki.example.com {
    reverse_proxy localhost:3000
}
```

**nginx**:

```nginx
server {
    listen 443 ssl;
    server_name wiki.example.com;
    # ssl_certificate ...; ssl_certificate_key ...;
    client_max_body_size 50m;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        # Live co-editing uses WebSockets.
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 1h;
    }
}
```

## How your data is protected

Pagehouse is built so that nothing you write is lost without you asking for it:

| Risk | Protection |
|---|---|
| Deleting a page | Goes to the trash with the pages inside it. Restore any time; there is no automatic emptying. An **Undo** appears right after deleting |
| Deleting a comment | Hidden, not erased. **Undo** right after deleting |
| Accidentally wiping a page's content | Every save that removes a noticeable amount of content starts a new history entry, so the earlier text stays in **History** |
| Restoring an old version | The current content is kept as its own history entry first |
| Network drop, closed tab, edit conflict | Unsaved edits are kept in the browser and offered back the next time the page opens |
| Server or disk failure, `docker compose down -v` | Automatic backups into `./backups` on the host every 24 hours (14 kept). Copy that folder off the server |
| Upgrade goes wrong | The installer backs up before upgrading (`backups/before-upgrade/`) |
| Restoring the wrong backup | `restore.sh` backs up the current state first (`backups/before-restore/`) and prints the command to undo |
| `helm uninstall` | Volumes and the database Secret are kept |

## Backup and restore

Automatic backups need nothing from you: one when the stack starts, then every `BACKUP_INTERVAL_HOURS`. Files are named `backups/pagehouse-auto-<time>.tar.gz` (time in UTC). Copy them off the server regularly, for example with a nightly `rsync` to a NAS.

**Backup policy** (Admin → Overview): how often automatic backups run, how many to keep, and optionally deleting automatic backups or manual and pre-upgrade backups (`backups/pagehouse-<time>.tar.gz`, `backups/before-upgrade/`) older than a number of days. Manual backups are kept forever unless you set that. Old backups are deleted only after a new backup succeeds. Other files in `backups/` are never touched. On Kubernetes the schedule comes from `backup.schedule` in the Helm values; the retention settings apply there too.

Take a backup by hand at any time:

```sh
scripts/backup.sh                    # backups/pagehouse-<time>.tar.gz
```

Restore. This replaces the current pages, history and accounts, after backing up the current state:

```sh
scripts/restore.sh backups/pagehouse-auto-20261124-030000.tar.gz
```

Test a restore on a spare machine now and then. A backup you have never restored is a guess.

## Upgrade

What to check for each version (database changes, new settings, behaviour changes) is in the [upgrade guide](upgrading.md).

```sh
cd /opt/pagehouse
scripts/upgrade.sh            # latest release
scripts/upgrade.sh 0.2.0      # a specific version
```

The upgrade backs up first, keeps `.env` and all data, pulls the new image and restarts. Database changes apply automatically when the app starts. If something goes wrong: set `PAGEHOUSE_VERSION` in `.env` back to the old version, run `scripts/restore.sh backups/before-upgrade/<file>`.

Offline: run the new offline bundle's `install.sh --dir /opt/pagehouse`.

## Using an external PostgreSQL (compose)

PostgreSQL 14+ with the `pg_trgm` extension available. The first start runs `CREATE EXTENSION pg_trgm`, so either let the user create extensions or run it once as a superuser. The user also needs the `CREATE` privilege on the database (its owner has it): the app creates the schemas `pagehouse` and `accounts` there. In `docker-compose.yml`, set the app's `DATABASE_URL`, remove the `db` service and the `depends_on` blocks. The automatic backup service and scripts cover the bundled database only; back up an external database with `pg_dump` and the `files` volume separately, and restore them together: the app deletes profile photos and logos that were replaced, so a database restored without its files can show a missing photo or logo (attachments are never deleted).

## Using Pagehouse together with Taskhouse

Pagehouse and [Taskhouse](https://github.com/spro1/taskhouse) are separate products that can share their accounts, the way two products of one suite do. They share them when both use **the same PostgreSQL database** (the same `DATABASE_URL`). Each product keeps its own tables in its own schema (`pagehouse`, `taskhouse`); people, passwords, sign-ins, groups and the SSO settings live once, in the `accounts` schema.

| Shared | Per product |
|---|---|
| Accounts (name, email, password, disabled or not) | Who is an administrator, and every other role and permission |
| Sign-ins: signing in or out of one does the same in the other | API tokens |
| Groups and their members | Pages, issues, attachments, webhooks, audit log, every other setting |
| SSO settings (Admin → SSO in either product) | |

**Installing the two together (one server, compose).** Install either product the usual way. Then add the other with its installer and `--share-with`, naming the folder of the first. It does not matter which one comes first, and for a new server the steps are the same: install one, add the other.

```sh
# Taskhouse is installed in /opt/taskhouse. Add Pagehouse:
curl -fsSL https://github.com/spro1/pagehouse/releases/latest/download/install.sh | sh -s -- --share-with /opt/taskhouse --port 3001

# Pagehouse is installed in /opt/pagehouse. Add Taskhouse (run in the Taskhouse folder):
scripts/install.sh --share-with /opt/pagehouse
```

The added product starts no database of its own. It joins the first product's compose network and uses its database, and the installer copies that install's database password and `SECRET_KEY` into the new `.env`. The first product keeps running and nothing in it is changed: accounts, passwords, groups, people who are signed in and all content stay as they are.

Then:
1. Set `PUBLIC_URL` in the `.env` of both and apply it with `docker compose up -d` in each folder. This puts the link to the other product in each menu.
2. Open the added product and sign in with an account you already have. There is no setup step and no setup token. Nobody is its administrator yet: the first administrator of the other product who opens it becomes one, and can then name others.

Running the two:
- The added product needs the first one running, because its database is there.
- Each product's backups (automatic and `scripts/backup.sh`) hold the whole shared database, so both products, plus that product's own attachments. Restoring one takes the accounts and both products back to that moment. Before `scripts/restore.sh`, stop the other product (`docker compose stop app` in its folder) and start it again afterwards. A backup from before the second product was added is refused, because restoring it would delete the other product's data.
- To remove the added product again: `docker compose down -v` in its folder, then drop its tables and its menu link from the shared database. For an added Pagehouse, in the Taskhouse folder: `docker compose exec db psql -U taskhouse -c "DROP SCHEMA pagehouse CASCADE" -c "DELETE FROM accounts.settings WHERE key = 'url:pagehouse'"`. For an added Taskhouse, in the Pagehouse folder: `docker compose exec db psql -U pagehouse -c "DROP SCHEMA taskhouse CASCADE" -c "DELETE FROM accounts.settings WHERE key = 'url:taskhouse'"`. The accounts stay.

The settings involved (the installer takes care of `SECRET_KEY`; on other setups set them yourself):

| Setting | Why |
|---|---|
| `SECRET_KEY`, the same value | The SSO client secret is stored once and both must be able to read it |
| `PUBLIC_URL` | Each product shows a link to the other in its menu |
| `COOKIE_DOMAIN` | Only when the two run on different subdomains: the parent domain (`example.com` for `wiki.example.com` and `tasks.example.com`), so one sign-in covers both. On the same host name (different ports or paths) leave it empty. The sign-in cookie then goes to every site under that domain, so use it only when all of them are yours |

With SSO, register both callback addresses (`<PUBLIC_URL>/api/auth/oidc/callback` of each product) on the one client at your provider. A changed SSO setting reaches the other product within 30 seconds. The administrator group, if you set one, decides who is an administrator in both products at each SSO sign-in.

Good to know:
- An account created in one product is an ordinary member of the other. Disabling an account closes both.
- Deleting a group in Pagehouse also removes the project roles Taskhouse gave that group.
- Two installs that **both already have accounts** can't be joined by pointing them at one database: the second one refuses to start and changes nothing. Merging existing accounts is not supported yet.
- On separate servers, on Kubernetes or with your own PostgreSQL there is no installer option: give both products the same `DATABASE_URL` (see [external PostgreSQL](#using-an-external-postgresql-compose)) and the same `SECRET_KEY`, and back that database up yourself. One dump holds both products.
- To keep the two apart, give each its own database, as a default install does. Nothing is shared then.

## Where data lives

| Data | Location |
|---|---|
| Pages, history, comments, accounts | Compose volume `db` (PostgreSQL) |
| Attachments | Compose volume `files` (`/data/files` in the app) |
| Backups | `./backups` in the install folder |
| Settings | `.env` (permissions 600; contains the database password) |

## Troubleshooting

| Symptom | What to check |
|---|---|
| Page does not load | `docker compose ps` shows the containers `healthy`; `docker compose logs app` |
| `POSTGRES_PASSWORD` error | Run compose from the install folder, where `.env` is |
| Installer stops: "a database volume from an earlier install … still exists" | A previous install in a folder of the same name left its data behind, and its `.env` is gone. Put the old `.env` back to keep that data, or delete the volumes the message names to start over |
| Port already in use | Change `PORT` in `.env` |
| Signed in, then sent back to sign-in | HTTPS without `X-Forwarded-Proto` from the proxy, or the site opened under two host names |
| Large uploads fail | Raise the proxy body limit (nginx `client_max_body_size`) |
| No new backups | `docker compose logs backup`; free disk space |
| Which version is running? | `curl localhost:3000/healthz` |
| Suddenly a blank screen | A tab left open across an upgrade: reload once. If it persists, the page says "This screen couldn't be shown" and the cause is in the browser console |
| Copy buttons do nothing | Current versions copy on plain HTTP too; reload an old tab |
| `/healthz` answers 503 (`relay: down`) | With several instances, the database notification link has been down over a minute. Fix the database; the app reconnects |
| Forgotten password | With `SMTP_URL`, the sign-in page sends a reset email; otherwise an admin issues a reset link or temporary password in **Admin → People** |

## Uninstall

```sh
docker compose down        # stops everything; data and backups stay
```

`docker compose down -v` also deletes the database and attachments volumes. The `backups` folder stays, but make sure you have a recent backup before doing this.
