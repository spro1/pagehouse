# Connecting SSO

[한국어](sso.ko.md)

Pagehouse signs people in with any OpenID Connect provider: Keycloak, Microsoft Entra ID, Google Workspace, Okta, Authentik and others. This guide covers the setup on both sides and the usual problems.

## How it works

1. The sign-in page shows an SSO button. It sends the browser to the provider's sign-in page.
2. After signing in there, the provider sends the browser back to the wiki's **redirect URI** with a one-time code.
3. The wiki server swaps the code for the user's details directly with the provider, then signs the person in.
4. Accounts are matched **by email**. Without an account for that email, one is created as a member (unless you turn that off).
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

### Microsoft Entra ID

1. **App registrations → New registration**. Redirect URI: platform *Web*, the redirect URI.
2. **Certificates & secrets → New client secret**: the secret (copy the *Value*).
3. **Authentication → Web → Redirect URIs**: also add the wiki address ending in `/`, so signing out can come back to the wiki.
4. Client ID: *Application (client) ID*. Issuer: `https://login.microsoftonline.com/<tenant-id>/v2.0`.
5. Entra ID often doesn't send `email_verified`. If sign-in says the provider didn't give a verified email, tick **Trust emails the provider doesn't mark verified**, but only if users can't change their own email in your directory.

### Google Workspace

1. Google Cloud console → **APIs & Services → Credentials → Create credentials → OAuth client ID**, type *Web application*.
2. **Authorized redirect URIs**: the redirect URI.
3. Issuer: `https://accounts.google.com`.
4. To keep out personal Google accounts, set the OAuth consent screen to *Internal*.

Google has no sign-out endpoint, so signing out of the wiki doesn't sign out of Google.

### Okta

1. **Applications → Create App Integration**: *OIDC*, *Web Application*.
2. **Sign-in redirect URIs**: the redirect URI. **Sign-out redirect URIs**: the wiki address with `/`.
3. Assign the people or groups who may use it.
4. Issuer: `https://<your-org>.okta.com` (or your custom authorization server, e.g. `https://<your-org>.okta.com/oauth2/default`).

## 2. Turn it on in the wiki

In **Admin → SSO**:

1. Enter the **issuer URL** and click **Test connection**. It should say *Connected*.
2. Enter the **client ID** and **client secret**, and optionally the **button text** (e.g. *Sign in with Company SSO*).
3. Choose the options:
   - **Create accounts on first sign-in**: off lets in only people who already have an account with that email.
   - **Allow password sign-in**: off makes everyone but administrators use SSO. Administrators keep their password so they can get in when the provider is down.
   - **Trust emails the provider doesn't mark verified**: only for providers that never send `email_verified`.
4. Click **Turn on SSO**. It applies at once, without a restart.

Then sign out and try the button on the sign-in page, ideally in a private window.

The client secret stays on the server: the screen never shows it again, and leaving the field empty keeps the saved one. Changes are recorded in the audit log (without the secret).

### Passwords and SSO accounts

The wiki's **reset link** and **temporary password** set a password *in the wiki* only. They don't touch the password at the provider, which people change there. Used on an account created by SSO, they add a wiki password, so with *Allow password sign-in* on, that person can then sign in either way; with it off, the password works for administrators only.

### Setting it in `.env` instead

For automated installs, the same settings can come from environment variables (`OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_LABEL`, `OIDC_AUTO_CREATE`, `PASSWORD_LOGIN`, `OIDC_TRUST_EMAIL`; see the [install guide](install.md#configuration-env)). When they're set, they win and the screen is read-only. Restart after changing them.

## Troubleshooting

Failed sign-ins appear in **Admin → Audit log** as *SSO sign-in* with the reason.

| What you see | Cause and fix |
|---|---|
| The provider says the redirect URI is invalid | The redirect URI registered at the provider doesn't match the one on the SSO screen exactly (http vs https, host, port). If the screen shows the wrong address, set `PUBLIC_URL`. |
| "The sign-on provider did not share a verified email" | The user has no email at the provider, or it isn't marked verified. Verify it there, or (only when appropriate) turn on *Trust emails…*. |
| "There is no account for you yet" | *Create accounts on first sign-in* is off. Invite the person first. |
| "Single sign-on failed" right after the provider's page | The wiki server can't reach the provider's token endpoint, or the client secret is wrong. Check from the server: `curl <issuer>/.well-known/openid-configuration`. |
| Test connection works but sign-in fails, with the wiki in a container and the provider on the same machine | Inside a container, `localhost` is the container itself. Use an address both the container and browsers can reach. For a local Keycloak, start it with `--hostname=<browser address> --hostname-backchannel-dynamic=true` and use `http://host.containers.internal:8080/realms/<realm>` (Podman) or `host.docker.internal` (Docker) as the issuer. |
| Signing out doesn't sign out of the provider | The wiki address isn't allowed as a post-logout redirect at the provider, or the person signed in before this was set up (they need to sign in once more). |
| Locked out after turning off password sign-in | Administrators can always sign in with a password. Or remove the `sso` row: `podman compose exec db psql -U pagehouse -c "DELETE FROM settings WHERE key='sso'"`. |
