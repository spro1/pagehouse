// Single sign-on with any OpenID Connect provider (Keycloak, Azure AD / Entra ID, Google Workspace, Okta, Authentik...).
// Configured by an admin in Admin → SSO (stored in settings), or by environment variables, which then take over and
// make the screen read-only. Accounts are matched by email.
import type { Context, Hono } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import type { Db } from './db.ts'

export type OidcConfig = {
  issuer: string; clientId: string; clientSecret: string; label: string
  autoCreate: boolean; trustEmail: boolean; passwordLogin: boolean; publicUrl?: string
}
/** What the admin screen edits. The secret is never sent back, only whether there is one. */
export type SsoSettings = Omit<OidcConfig, 'publicUrl'> & { enabled: boolean }

/** SSO from environment variables, if set there (they win over the admin screen). */
export function oidcConfig(env = process.env): OidcConfig | null {
  if (!env.OIDC_ISSUER || !env.OIDC_CLIENT_ID) return null
  return {
    issuer: env.OIDC_ISSUER.replace(/\/$/, ''),
    clientId: env.OIDC_CLIENT_ID,
    clientSecret: env.OIDC_CLIENT_SECRET ?? '',
    label: env.OIDC_LABEL || 'SSO',
    autoCreate: env.OIDC_AUTO_CREATE !== '0',
    trustEmail: env.OIDC_TRUST_EMAIL === '1',
    passwordLogin: env.PASSWORD_LOGIN !== '0',
    publicUrl: env.PUBLIC_URL?.replace(/\/$/, ''),
  }
}

const b64url = (b: Buffer) => b.toString('base64url')
const KEY = 'sso'

// The client secret is encrypted with SECRET_KEY from .env, which is not in the database or the backups, so a leaked
// dump or backup doesn't leak the secret. Without SECRET_KEY it is stored as before (plain) and the screen says so.
const ENC = 'enc:v1:'
const secretKey = () => (process.env.SECRET_KEY ? createHash('sha256').update(process.env.SECRET_KEY).digest() : null)
export function sealSecret(plain: string): string {
  const key = secretKey()
  if (!plain || !key) return plain
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()])
  return ENC + [iv, c.getAuthTag(), ct].map(b64url).join('.')
}
export function openSecret(stored: string): string {
  if (!stored.startsWith(ENC)) return stored
  const key = secretKey()
  if (!key) throw new Error('The SSO client secret is encrypted but SECRET_KEY is not set.')
  const [iv, tag, ct] = stored.slice(ENC.length).split('.').map((s) => Buffer.from(s, 'base64url'))
  const d = createDecipheriv('aes-256-gcm', key, iv)
  d.setAuthTag(tag)
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8')
}

/** The SSO config in force: environment first, else what an admin saved. Cached briefly; saving clears it here. */
export function ssoSource(db: Db) {
  let cache: { at: number; cfg: OidcConfig | null } | null = null
  const raw = async (): Promise<SsoSettings | null> => (await db.query('SELECT value FROM settings WHERE key = $1', [KEY])).rows[0]?.value ?? null
  const write = (s: SsoSettings) => db.query(
    `INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [KEY, JSON.stringify({ ...s, clientSecret: sealSecret(s.clientSecret) })],
  )
  const fromDb = async (): Promise<SsoSettings | null> => {
    const s = await raw()
    if (!s) return null
    // Saved before SECRET_KEY was set (or before this version): encrypt it now.
    if (s.clientSecret && !s.clientSecret.startsWith(ENC) && secretKey()) await write(s)
    try {
      return { ...s, clientSecret: openSecret(s.clientSecret ?? '') }
    } catch (e) {
      // Wrong or missing SECRET_KEY: carry on without the secret (sign-in fails) so an admin can enter it again.
      console.error('sso:', (e as Error).message)
      return { ...s, clientSecret: '' }
    }
  }
  return {
    env: () => oidcConfig(),
    stored: fromDb,
    async current(): Promise<OidcConfig | null> {
      const env = oidcConfig()
      if (env) return env
      // shortcut: other instances notice a change within 30 seconds; fine for a setting changed once in a while.
      if (cache && Date.now() - cache.at < 30_000) return cache.cfg
      const s = await fromDb()
      const cfg = s?.enabled && s.issuer && s.clientId
        ? { ...s, issuer: s.issuer.replace(/\/$/, ''), label: s.label || 'SSO', publicUrl: process.env.PUBLIC_URL?.replace(/\/$/, '') }
        : null
      cache = { at: Date.now(), cfg }
      return cfg
    },
    async save(s: SsoSettings) {
      await write(s)
      cache = null
    },
  }
}
export type SsoSource = ReturnType<typeof ssoSource>

type Discovery = { issuer?: string; authorization_endpoint: string; token_endpoint: string; userinfo_endpoint: string; end_session_endpoint?: string }
const discoveries = new Map<string, { at: number; d: Discovery }>()
/** The provider's endpoints from /.well-known/openid-configuration, cached for an hour per issuer. */
export async function discover(issuer: string): Promise<Discovery> {
  const hit = discoveries.get(issuer)
  if (hit && Date.now() - hit.at < 3600_000) return hit.d
  const r = await fetch(`${issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10_000) })
  if (!r.ok) throw new Error(`discovery answered ${r.status}`)
  const d = (await r.json()) as Discovery
  if (!d.authorization_endpoint || !d.token_endpoint || !d.userinfo_endpoint) throw new Error('discovery document is missing endpoints')
  discoveries.set(issuer, { at: Date.now(), d })
  return d
}

export const redirectUri = (c: Context, cfg: { publicUrl?: string }) => {
  if (cfg.publicUrl) return `${cfg.publicUrl}/api/auth/oidc/callback`
  const u = new URL(c.req.url)
  return `${c.req.header('x-forwarded-proto') ?? u.protocol.replace(':', '')}://${c.req.header('x-forwarded-host') ?? u.host}/api/auth/oidc/callback`
}

export function registerSso(app: Hono<any>, db: Db, source: SsoSource, startSession: (c: Context, userId: number) => Promise<void>) {
  const back = (c: Context, error?: string) => c.redirect(error ? `/?sso_error=${error}` : '/')

  app.get('/api/auth/oidc/start', async (c) => {
    const cfg = await source.current()
    if (!cfg) return back(c, 'unavailable')
    const d = await discover(cfg.issuer).catch(() => null)
    if (!d) return back(c, 'unavailable')
    const state = b64url(randomBytes(24))
    const verifier = b64url(randomBytes(32))
    // Lax so the cookie comes back on the provider's top-level redirect to the callback.
    setCookie(c, 'oidc', `${state}.${verifier}`, { httpOnly: true, sameSite: 'Lax', path: '/api/auth/oidc', maxAge: 600 })
    const q = new URLSearchParams({
      response_type: 'code', client_id: cfg.clientId, redirect_uri: redirectUri(c, cfg),
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
    const cfg = await source.current()
    if (!cfg) return back(c, 'unavailable')
    try {
      const d = await discover(cfg.issuer)
      // The code goes straight to the provider over TLS, so the tokens that come back need no further signature check.
      const tok = await fetch(d.token_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code', code, redirect_uri: redirectUri(c, cfg),
          client_id: cfg.clientId, client_secret: cfg.clientSecret, code_verifier: verifier,
        }),
        signal: AbortSignal.timeout(10_000),
      }).then((r) => (r.ok ? r.json() : null))
      if (!tok?.access_token) return back(c, 'failed')
      const info = await fetch(d.userinfo_endpoint, { headers: { authorization: `Bearer ${tok.access_token}` }, signal: AbortSignal.timeout(10_000) })
        .then((r) => (r.ok ? r.json() : null))
      const email = typeof info?.email === 'string' ? info.email.toLowerCase() : ''
      // Accounts are matched by email, so the provider must vouch for it: otherwise anyone able to set an email at the
      // provider could sign in as that person here. Providers that never send the claim (some Entra ID setups)
      // can be trusted explicitly.
      const verified = info?.email_verified === true || info?.email_verified === 'true' || (cfg.trustEmail && info?.email_verified !== false)
      if (!email || !verified) return back(c, 'no_email')
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
      // Kept so signing out here can also end the session at the provider (else the next SSO click signs straight back in).
      if (typeof tok.id_token === 'string') setCookie(c, 'oidc_idt', tok.id_token, { httpOnly: true, sameSite: 'Lax', path: '/api/auth', maxAge: 30 * 86400 })
      return back(c)
    } catch {
      return back(c, 'failed')
    }
  })
}

/** Where to send the browser after signing out here so the provider's session ends too, or null if not an SSO sign-in. */
export async function ssoLogoutUrl(c: Context, source: SsoSource): Promise<string | null> {
  const idToken = getCookie(c, 'oidc_idt')
  if (!idToken) return null
  deleteCookie(c, 'oidc_idt', { path: '/api/auth' })
  const cfg = await source.current()
  const d = cfg && (await discover(cfg.issuer).catch(() => null))
  if (!cfg || !d?.end_session_endpoint) return null
  // The provider must allow this address as a post-logout redirect (Keycloak: "Valid post logout redirect URIs").
  const home = redirectUri(c, cfg).replace(/\/api\/auth\/oidc\/callback$/, '/')
  return `${d.end_session_endpoint}?${new URLSearchParams({ id_token_hint: idToken, client_id: cfg.clientId, post_logout_redirect_uri: home })}`
}

/** Admin → SSO. Registered behind the session check, so only admins reach it. */
export function registerSsoAdmin(app: Hono<any>, source: SsoSource) {
  const view = async (c: Context) => {
    const env = source.env()
    const s = env ? { ...env, enabled: true } : await source.stored()
    return {
      source: env ? 'env' : 'admin',
      enabled: !!s?.enabled,
      issuer: s?.issuer ?? '', clientId: s?.clientId ?? '', hasSecret: !!s?.clientSecret,
      label: s?.label ?? '', autoCreate: s?.autoCreate ?? true, trustEmail: s?.trustEmail ?? false, passwordLogin: s?.passwordLogin ?? true,
      redirectUri: redirectUri(c, { publicUrl: process.env.PUBLIC_URL?.replace(/\/$/, '') }),
      encrypted: !!process.env.SECRET_KEY,
    }
  }
  const httpUrl = (v: unknown) => {
    try {
      const u = new URL(String(v))
      return /^https?:$/.test(u.protocol) && !u.username && !u.password ? u.toString().replace(/\/$/, '') : null
    } catch {
      return null
    }
  }
  app.get('/api/admin/sso', async (c) => c.json(await view(c)))
  app.put('/api/admin/sso', async (c) => {
    if (source.env()) return c.json({ error: 'SSO is set by environment variables.', code: 'sso_env' }, 409)
    const b = await c.req.json().catch(() => ({}))
    const old = await source.stored()
    const issuer = b.issuer ? httpUrl(b.issuer) : ''
    if (issuer === null) return c.json({ error: 'The issuer must be an http(s) URL.', code: 'sso_issuer' }, 400)
    const s: SsoSettings = {
      enabled: b.enabled === true,
      issuer: issuer ?? '',
      clientId: String(b.clientId ?? '').trim().slice(0, 300),
      // Left empty, the stored secret stays: the screen never receives it to send back.
      clientSecret: typeof b.clientSecret === 'string' && b.clientSecret ? b.clientSecret.slice(0, 1000) : old?.clientSecret ?? '',
      label: String(b.label ?? '').trim().slice(0, 60),
      autoCreate: b.autoCreate !== false,
      trustEmail: b.trustEmail === true,
      passwordLogin: b.passwordLogin !== false,
    }
    if (s.enabled && (!s.issuer || !s.clientId)) return c.json({ error: 'Turning SSO on needs an issuer and a client ID.', code: 'sso_incomplete' }, 400)
    if (s.enabled) {
      // Refuse to switch on something that can't work, rather than leaving everyone with a broken sign-in button.
      const ok = await discover(s.issuer).then(() => true, () => false)
      if (!ok) return c.json({ error: 'The issuer did not answer with an OpenID configuration.', code: 'sso_discovery' }, 400)
    }
    await source.save(s)
    return c.json(await view(c))
  })
  // Checks an issuer before saving: admins only, and only http(s) URLs.
  app.post('/api/admin/sso/test', async (c) => {
    const b = await c.req.json().catch(() => ({}))
    const issuer = httpUrl(b.issuer)
    if (!issuer) return c.json({ ok: false, error: 'The issuer must be an http(s) URL.' })
    discoveries.delete(issuer)
    try {
      const d = await discover(issuer)
      return c.json({ ok: true, issuer: d.issuer ?? issuer, authorization: d.authorization_endpoint })
    } catch (e) {
      return c.json({ ok: false, error: (e as Error).message })
    }
  })
}
