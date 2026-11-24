// Single sign-on with any OpenID Connect provider (Keycloak, Azure AD / Entra ID, Google Workspace, Okta, Authentik...).
// Configured by environment variables; see docs/install.md. Accounts are matched by email.
import type { Context, Hono } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { createHash, randomBytes } from 'node:crypto'
import type { Db } from './db.ts'

export type OidcConfig = { issuer: string; clientId: string; clientSecret: string; label: string; autoCreate: boolean; publicUrl?: string }

export function oidcConfig(env = process.env): OidcConfig | null {
  if (!env.OIDC_ISSUER || !env.OIDC_CLIENT_ID) return null
  return {
    issuer: env.OIDC_ISSUER.replace(/\/$/, ''),
    clientId: env.OIDC_CLIENT_ID,
    clientSecret: env.OIDC_CLIENT_SECRET ?? '',
    label: env.OIDC_LABEL || 'SSO',
    autoCreate: env.OIDC_AUTO_CREATE !== '0',
    publicUrl: env.PUBLIC_URL?.replace(/\/$/, ''),
  }
}

const b64url = (b: Buffer) => b.toString('base64url')

export function registerSso(app: Hono<any>, db: Db, cfg: OidcConfig, startSession: (c: Context, userId: number) => Promise<void>) {
  let discovery: { authorization_endpoint: string; token_endpoint: string; userinfo_endpoint: string } | undefined
  const discover = async () =>
    (discovery ??= await fetch(`${cfg.issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10_000) }).then((r) => {
      if (!r.ok) throw new Error(`OIDC discovery failed: ${r.status}`)
      return r.json()
    }))
  const origin = (c: Context) => {
    if (cfg.publicUrl) return cfg.publicUrl
    const u = new URL(c.req.url)
    return `${c.req.header('x-forwarded-proto') ?? u.protocol.replace(':', '')}://${c.req.header('x-forwarded-host') ?? u.host}`
  }
  const back = (c: Context, error?: string) => c.redirect(error ? `/?sso_error=${error}` : '/')

  app.get('/api/auth/oidc/start', async (c) => {
    const d = await discover().catch(() => null)
    if (!d) return back(c, 'unavailable')
    const state = b64url(randomBytes(24))
    const verifier = b64url(randomBytes(32))
    // Lax so the cookie comes back on the provider's top-level redirect to the callback.
    setCookie(c, 'oidc', `${state}.${verifier}`, { httpOnly: true, sameSite: 'Lax', path: '/api/auth/oidc', maxAge: 600 })
    const q = new URLSearchParams({
      response_type: 'code', client_id: cfg.clientId, redirect_uri: `${origin(c)}/api/auth/oidc/callback`,
      scope: 'openid email profile', state,
      code_challenge: b64url(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256',
    })
    return c.redirect(`${d.authorization_endpoint}?${q}`)
  })

  app.get('/api/auth/oidc/callback', async (c) => {
    const [state, verifier] = (getCookie(c, 'oidc') ?? '').split('.')
    deleteCookie(c, 'oidc', { path: '/api/auth/oidc' })
    const code = c.req.query('code')
    if (!state || !verifier || c.req.query('state') !== state || !code) return back(c, 'failed')
    try {
      const d = await discover()
      // The code goes straight to the provider over TLS, so the tokens that come back need no further signature check.
      const tok = await fetch(d.token_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code', code, redirect_uri: `${origin(c)}/api/auth/oidc/callback`,
          client_id: cfg.clientId, client_secret: cfg.clientSecret, code_verifier: verifier,
        }),
        signal: AbortSignal.timeout(10_000),
      }).then((r) => (r.ok ? r.json() : null))
      if (!tok?.access_token) return back(c, 'failed')
      const info = await fetch(d.userinfo_endpoint, { headers: { authorization: `Bearer ${tok.access_token}` }, signal: AbortSignal.timeout(10_000) })
        .then((r) => (r.ok ? r.json() : null))
      const email = typeof info?.email === 'string' ? info.email.toLowerCase() : ''
      if (!email || info.email_verified === false) return back(c, 'no_email')
      let user = (await db.query('SELECT id, disabled_at FROM users WHERE email = $1', [email])).rows[0]
      if (!user) {
        if (!cfg.autoCreate) return back(c, 'no_account')
        const name = String(info.name || info.preferred_username || email.split('@')[0]).slice(0, 100)
        // No password: this account signs in through the provider only (an admin can still send a reset link).
        user = (await db.query(`INSERT INTO users (email, name, password_hash) VALUES ($1, $2, '') ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email RETURNING id, disabled_at`,
          [email, name])).rows[0]
      }
      if (user.disabled_at) return back(c, 'account_disabled')
      await startSession(c, user.id)
      return back(c)
    } catch {
      return back(c, 'failed')
    }
  })
}
