# Connecting SSO

[한국어](sso.ko.md)

Pagehouse signs people in through an OpenID Connect provider. **It has been tested with Keycloak only**, so this guide uses Keycloak. Other OpenID Connect providers (Entra ID, Okta, Authentik, …) follow the same standard and should work with the same settings, but haven't been tested.

## How it works

1. The sign-in page shows an SSO button. It sends the browser to the provider's sign-in page.
2. After signing in there, the provider sends the browser back to the wiki's **redirect URI** with a one-time code.
3. The wiki server swaps the code for the user's details directly with the provider, then signs the person in.
4. Accounts are found by the provider's user id (`sub`), so a changed email at the provider still reaches the same account. The first time, an existing account is linked **by verified email**; without one, a member account is created (unless you turn that off).
5. Signing out of the wiki also signs out of the provider and comes back to the wiki.

The wiki server must reach the provider, and so must people's browsers (step 3 is server to provider, steps 1–2 are browser to provider).

## What you need

- The address people use to reach the wiki, e.g. `https://wiki.example.com`. If the wiki is behind a proxy or reached at a different address than the server sees, set `PUBLIC_URL` in `.env`.
- An administrator account in the wiki and permission to register an application at the provider.

## 1. Register the wiki at the provider

Open **Admin → SSO** in the wiki and copy the **redirect URI** shown there (`https://wiki.example.com/api/auth/oidc/callback`). Then create an application ("client") at the provider:

| Setting | Value |
|---|---|
| Type | Web application, confidential (with a client secret), authorization code flow |
| Redirect URI | the redirect URI you copied |
| Post-logout redirect URI | the wiki address ending in `/` (`https://wiki.example.com/`) |
| Scopes | `openid email profile` |

Note the **issuer URL**, **client ID** and **client secret**.

### Keycloak

1. In your realm: **Clients → Create client**. Client type *OpenID Connect*, a client ID such as `pagehouse`.
2. **Client authentication** on, **Standard flow** on (others off).
3. **Valid redirect URIs**: the redirect URI. **Valid post logout redirect URIs**: the wiki address with `/`. **Web origins**: `+`.
4. Secret: **Credentials** tab.
5. Issuer: `https://<keycloak-host>/realms/<realm>`.
6. Users need an email, and **Email verified** on (or use a realm that verifies emails).

## 2. Turn it on in the wiki

In **Admin → SSO**:

1. Enter the **issuer URL** and click **Test connection**. It should say *Connected*.
2. Enter the **client ID** and **client secret**, and optionally the **button text** (e.g. *Sign in with Company SSO*).
3. Choose the options:
   - **Create accounts on first sign-in**: off lets in only people who already have an account with that email.
   - **Allow password sign-in**: off makes everyone but administrators use SSO. Administrators keep their password so they can get in when the provider is down.
   - **Trust emails the provider doesn't mark verified**: only for providers that never send `email_verified`. It applies when linking an existing account by email and when creating a new one.
4. Click **Turn on SSO**. It applies at once, without a restart.

Then sign out and try the button on the sign-in page, ideally in a private window.

The client secret stays on the server, encrypted with `SECRET_KEY` from `.env` (so database backups don't reveal it): the screen never shows it again, and leaving the field empty keeps the saved one. Changes are recorded in the audit log (without the secret).

### Groups and administrators

At each sign-in the wiki reads the person's groups from the **groups claim** (`groups` unless you change it on the SSO screen) and makes them their wiki groups, creating groups that don't exist yet. A Keycloak path like `/Engineering` becomes `Engineering`.
- Memberships added this way are replaced at the next sign-in. Memberships an admin added in **Admin → Groups** are never touched.
- If the provider doesn't send the claim at all, nothing changes. Keycloak needs a *Group Membership* mapper (turn off *Full group path* or not, both work); Entra ID sends group IDs unless configured to send names.
- **Administrator group** (optional): its members become administrators, and stop being one when they leave it. Administrators with a wiki password keep their role, so there is always a way in.

### Passwords and SSO accounts

The wiki's **reset link** and **temporary password** set a password *in the wiki* only. They don't touch the password at the provider, which people change there. Used on an account created by SSO, they add a wiki password, so with *Allow password sign-in* on, that person can then sign in either way; with it off, the password works for administrators only.

### Setting it in `.env` instead

For automated installs, the same settings can come from environment variables (`OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_LABEL`, `OIDC_AUTO_CREATE`, `PASSWORD_LOGIN`, `OIDC_TRUST_EMAIL`, `OIDC_GROUPS_CLAIM`, `OIDC_ADMIN_GROUP`; see the [install guide](install.md#configuration-env)). When they're set, they win and the screen is read-only. Restart after changing them.

## Troubleshooting

Failed sign-ins appear in **Admin → Audit log** as *SSO sign-in* with the reason.

| What you see | Cause and fix |
|---|---|
| The provider says the redirect URI is invalid | The redirect URI registered at the provider doesn't match the one on the SSO screen exactly (http vs https, host, port). If the screen shows the wrong address, set `PUBLIC_URL`. |
| "The sign-on provider did not share a verified email" | The user has no email at the provider, or it isn't marked verified. Verify it there, or (only when appropriate) turn on *Trust emails…*. |
| "An account with this email already exists but could not be linked" | That account is already linked to another person at the provider (for example after the provider was replaced). An administrator can unlink it by clearing `oidc_sub` for that user in the database. |
| "There is no account for you yet" | *Create accounts on first sign-in* is off. Invite the person first. |
| "Single sign-on failed" right after the provider's page | The wiki server can't reach the provider's token endpoint, or the client secret is wrong. Check from the server: `curl <issuer>/.well-known/openid-configuration`. |
| Test connection works but sign-in fails, with the wiki in a container and the provider on the same machine | Inside a container, `localhost` is the container itself. Use an address both the container and browsers can reach. For a local Keycloak, start it with `--hostname=<browser address> --hostname-backchannel-dynamic=true` and use `http://host.containers.internal:8080/realms/<realm>` (Podman) or `host.docker.internal` (Docker) as the issuer. |
| Signing out doesn't sign out of the provider | The wiki address isn't allowed as a post-logout redirect at the provider, or the person signed in before this was set up (they need to sign in once more). |
| Locked out after turning off password sign-in | Administrators can always sign in with a password. Or remove the `sso` row: `podman compose exec db psql -U pagehouse -c "DELETE FROM accounts.settings WHERE key='sso'"`. |
