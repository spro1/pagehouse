import { Hono, type Context } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { bodyLimit } from 'hono/body-limit'
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import { compress } from 'hono/compress'
import { secureHeaders } from 'hono/secure-headers'
import { join } from 'node:path'
import { tx, type Db } from './db.ts'
import { branding as readBranding, brandName, metricsText, pruneFiles, registerAdmin, saveBranding, uploadAllowed } from './admin.ts'
import { registerExport } from './export.ts'
import { isColor } from './html.ts'
import { registerSso, registerSsoAdmin, ssoLogoutUrl, ssoSource } from './sso.ts'
import { createCollab } from './collab.ts'
import { relayDownSince } from './cluster.ts'
import { auditMiddleware, registerAudit } from './audit.ts'
import { createWebhooks, httpUrl } from './webhooks.ts'
import { metricsMiddleware, onServerError } from './metrics.ts'
import { mailEnabled, sendMail } from './mail.ts'
import { registerMcp } from './mcp.ts'
import { registerPreview } from './preview.ts'
import { createNodeWebSocket } from '@hono/node-ws'
import { mentionedInDoc, mentionedInText, notify, registerPeople } from './people.ts'

type User = { id: number; email: string; name: string; role: string; locale: string | null; theme: string | null }
const LOCALES = ['en', 'ko']
type Env = { Variables: { user: User } }
// How long a sign-in lasts (SESSION_HOURS, the name Taskhouse uses); one day by default.
const SESSION_HOURS = Number(process.env.SESSION_HOURS) || 24
// An account that signed in by SSO but hasn't for this long is probably gone at the provider: its API tokens stop.
const TOKEN_SSO_GRACE_DAYS = Number(process.env.TOKEN_SSO_GRACE_DAYS ?? 30)
const INLINE_MIME = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
export const normLabel = (s: unknown) =>
  String(s ?? '').trim().toLowerCase().replace(/^#/, '').replace(/[\s_]+/g, '-').replace(/[^\p{L}\p{N}-]/gu, '').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 50)
const EMPTY_DOC = { type: 'doc', content: [{ type: 'paragraph' }] }

// API errors carry a stable `code` (clients translate it) and an English `error` for humans and agents.
const ERRORS = {
  invalid_signup: 'Email, name and a password of at least 8 characters are required.',
  invite_invalid: 'This invite link has expired or was already used.',
  signup_closed: 'Sign-up is closed. Ask an administrator for an invite link.',
  email_taken: 'That email already has an account.',
  bad_credentials: 'Wrong email or password.',
  account_disabled: 'This account is disabled.',
  password_short: 'Passwords need at least 8 characters.',
  reset_invalid: 'This reset link has expired or was already used.',
  login_required: 'Sign in required.',
  admin_only: 'Administrators only.',
  wrong_password: 'The current password is wrong.',
  cannot_change_self: 'You cannot change your own role or status.',
  user_not_found: 'User not found.',
  bad_space: 'A name and a key of letters and digits are required.',
  space_key_taken: 'That space key is already used.',
  space_not_found: 'Space not found.',
  parent_not_found: 'Parent page not found.',
  page_not_found: 'Page not found.',
  no_edit_permission: 'You do not have permission to edit this page.',
  move_into_self: 'A page cannot be moved inside itself.',
  move_drops_restrictions: 'Moving it there would lift the restrictions it inherits. Ask an administrator to move it.',
  not_in_trash: 'That page is not in the trash.',
  empty_comment: 'Comment body is empty.',
  comment_not_found: 'Comment not found.',
  not_comment_author: 'Only the author can delete this comment.',
  delete_blocked: 'It contains pages you cannot edit.',
  version_not_found: 'Version not found.',
  file_required: 'A file is required.',
  file_not_found: 'File not found.',
  bad_request: 'Invalid request.',
  conflict: 'The page changed since you loaded it.',
  space_admin_only: 'Only space admins can change this.',
  storage_full: 'The storage limit set by the administrator is reached. Text edits still save; new files cannot be added.',
  file_too_large: 'Files can be up to 50 MB.',
  too_many_attempts: 'Too many attempts. Try again in a few minutes.',
  bad_origin: 'Request from another site was refused.',
  group_not_found: 'Group not found.',
  group_in_use: 'This group still grants access to spaces or pages. Remove it there first.',
  bad_group: 'A group needs a unique name.',
  preview_unavailable: 'No preview for this link.',
  use_sso: 'Sign in with single sign-on.',
  bad_setup_token: 'Wrong setup token. It is in the server log (or SETUP_TOKEN in .env).',
} as const
type ErrorCode = keyof typeof ERRORS
const fail = (c: Context, status: 400 | 401 | 403 | 404 | 409 | 413 | 429, code: string) =>
  c.json({ error: ERRORS[code as ErrorCode] ?? code, code }, status)

const sha256 = (v: string | Buffer) => createHash('sha256').update(v).digest('hex')

/** The token that creating the first account needs: SETUP_TOKEN, else one made on first start (kept in settings so every
 *  instance prints the same). Stored as is: it only lives until the admin exists, and whoever can read the database
 *  already controls the install. Null once there are users. */
export async function setupToken(q: Pick<Db, 'query'>): Promise<string | null> {
  if ((await q.query('SELECT 1 FROM users LIMIT 1')).rowCount) return null
  if (process.env.SETUP_TOKEN) return process.env.SETUP_TOKEN
  await q.query(`INSERT INTO settings (key, value) VALUES ('setup_token', $1) ON CONFLICT (key) DO NOTHING`, [JSON.stringify(randomBytes(18).toString('base64url'))])
  return (await q.query(`SELECT value FROM settings WHERE key = 'setup_token'`)).rows[0].value
}

function hashPassword(password: string, salt = randomBytes(16).toString('hex')) {
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`
}
// No account (or an SSO-only one) takes as long to refuse as a wrong password, so timing doesn't tell who has one.
function checkPassword(password: string, stored = '') {
  const [salt, hash] = stored.split(':')
  if (!hash) return (scryptSync(password, 'no-account-padding', 64), false)
  return timingSafeEqual(scryptSync(password, salt, 64), Buffer.from(hash, 'hex'))
}

// Korean words carry particles ("배포를", "배포는"); searching by the stem finds every form.
// Only stripped when at least two syllables remain, so short words stay exact.
const PARTICLES = ['으로부터', '에서는', '에게서', '으로는', '이라는', '에서', '에게', '으로', '이랑', '까지', '부터', '처럼', '보다', '라는', '하고', '을', '를', '이', '가', '은', '는', '에', '의', '로', '와', '과', '도', '만', '랑']
export function koreanStem(term: string) {
  if (!/[가-힣]$/.test(term)) return term
  for (const p of PARTICLES) if (term.endsWith(p) && [...term.slice(0, -p.length)].length >= 2) return term.slice(0, -p.length)
  return term
}

/** Adjacent Hangul syllable pairs, as the database's hangul_bigrams() makes them (migration 024). */
export function hangulBigrams(t: string) {
  const out = new Set<string>()
  for (let i = 0; i + 1 < t.length; i++) if (/^[가-힣]{2}$/.test(t.slice(i, i + 2))) out.add(t.slice(i, i + 2))
  return [...out]
}

// ~120 characters around the first match, starting and ending on word boundaries.
export function snippet(text: string, q: string) {
  const flat = text.replace(/\s+/g, ' ').trim()
  const i = Math.max(0, flat.toLowerCase().indexOf(q.toLowerCase()))
  let start = Math.max(0, i - 40)
  let end = Math.min(flat.length, i + q.length + 80)
  if (start > 0) start = flat.indexOf(' ', start) + 1 || start
  if (end < flat.length) end = flat.lastIndexOf(' ', end) > i ? flat.lastIndexOf(' ', end) : end
  return (start > 0 ? '…' : '') + flat.slice(start, end) + (end < flat.length ? '…' : '')
}

// True when going from `before` to `after` removes a noticeable amount of content
// (a select-all delete, a dropped table). Such saves always start a new history entry.
export function losesContent(before: unknown, after: unknown) {
  const textLoss = docText(before).length - docText(after).length
  const a = JSON.stringify(before).length
  const b = JSON.stringify(after).length
  return textLoss > 200 || textLoss > docText(before).length * 0.3 || (b < a * 0.8 && a - b > 500)
}

// Plain text of a ProseMirror doc, for search.
export function docText(node: any): string {
  if (!node || typeof node !== 'object') return ''
  if (typeof node.text === 'string') return node.text
  if (node.type === 'mention') return `@${node.attrs?.label ?? ''}`
  if (node.type === 'linkCard') return `${node.attrs?.title ?? ''} ${node.attrs?.href ?? ''}`
  // Inline pieces (text split by marks, mentions) join directly; blocks are separated by a space.
  return Array.isArray(node.content) ? node.content.map(docText).join(node.content.some((c: any) => c?.type === 'text') ? '' : ' ') : ''
}

export function createApp(db: Db, dataDir: string) {
  const filesDir = join(dataDir, 'files')
  mkdirSync(filesDir, { recursive: true })
  const app = new Hono<Env>()
  const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0]
  const all = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows
  const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : null)
  const id = (c: Context) => (/^\d+$/.test(c.req.param('id') ?? '') ? Number(c.req.param('id')) : 0)

  // Browser hardening for the app shell and API. Images from other sites are allowed (imported docs link them);
  // scripts, frames and plugins are not. Inline styles are needed by the editor.
  const hardening = secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
      referrerPolicy: 'strict-origin-when-cross-origin',
      crossOriginEmbedderPolicy: false,
      strictTransportSecurity: false, // set by the TLS-terminating proxy, which knows whether HTTPS is in use
    })
  // Attachments send their own, stricter policy (sandbox); don't overwrite it.
  app.use('*', (c, next) => (c.req.path.startsWith('/api/files/') ? next() : hardening(c, next)))

  app.use('*', metricsMiddleware)
  app.onError(onServerError)

  // Prometheus scrape endpoint, off unless METRICS_TOKEN is set; scrapers send it as a bearer token.
  app.get('/metrics', async (c) => {
    const want = process.env.METRICS_TOKEN
    if (!want) return c.text('Not found', 404)
    const got = c.req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? ''
    if (sha256(got) !== sha256(want)) return c.text('Unauthorized', 401, { 'WWW-Authenticate': 'Bearer' })
    return c.text(await metricsText(db, collab), 200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' })
  })

  app.get('/healthz', async (c) => {
    try {
      await db.query('SELECT 1')
      // Cut off from the other instances for over a minute: let the orchestrator restart this one.
      if (relayDownSince && Date.now() - relayDownSince > 60_000) return c.json({ ok: false, relay: 'down' }, 503)
      return c.json({ ok: true, version: process.env.APP_VERSION ?? 'dev' })
    } catch {
      return c.json({ ok: false }, 503)
    }
  })

  app.use('/api/*', bodyLimit({ maxSize: 50 * 1024 * 1024, onError: (c) => fail(c, 413, 'file_too_large') }))
  // JSON compresses ~10x (a 3000-page tree is ~240 KB raw). Files are skipped: images are already compressed.
  // Write requests must come from this site's own pages. SameSite cookies already stop most cross-site posts;
  // this also covers browsers and proxies that don't honor them.
  app.use('/api/*', async (c, next) => {
    if (c.req.method === 'GET' || c.req.method === 'HEAD') return next()
    const origin = c.req.header('origin')
    if (origin && origin !== 'null') {
      const host = c.req.header('x-forwarded-host') ?? c.req.header('host')
      let ok = false
      try {
        ok = new URL(origin).host === host
      } catch {}
      if (!ok) return fail(c, 403, 'bad_origin')
    }
    return next()
  })

  const gzip = compress()
  app.use('/api/*', (c, next) => (c.req.path.startsWith('/api/files/') ? next() : gzip(c, next)))

  // Sign-in throttling: 10 failures per account per address, 50 per address, or 30 per account from anywhere, in 15 minutes.
  // shortcut: kept in memory, so it resets on restart and is per process; move it to Postgres for several replicas.
  const failures = new Map<string, number[]>()
  const WINDOW = 15 * 60 * 1000
  // The caller's address. X-Forwarded-For is anyone's to write, so it only counts behind proxies we were told about
  // (TRUST_PROXY = how many), and then only the hop our own proxy added, counting from the right.
  const clientIp = (c: Context) => {
    const socket = (c.env as any)?.incoming?.socket?.remoteAddress as string | undefined
    const proxies = Math.max(0, Math.floor(Number(process.env.TRUST_PROXY) || 0))
    if (proxies) {
      const hops = (c.req.header('x-forwarded-for') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
      const ip = hops[hops.length - proxies]
      if (ip) return ip
    }
    return socket || 'local'
  }
  app.use('/api/*', auditMiddleware(db, clientIp))
  const recent = (key: string) => (failures.get(key) ?? []).filter((t) => Date.now() - t < WINDOW)
  const throttled = (c: Context, account: string) => {
    const ip = clientIp(c)
    return recent(`${ip}|${account}`).length >= 10 || recent(ip).length >= 50 || recent(`account|${account}`).length >= 30
  }
  const failed = (c: Context, account: string) => {
    const ip = clientIp(c)
    for (const k of [`${ip}|${account}`, ip, `account|${account}`]) failures.set(k, [...recent(k), Date.now()])
    if (failures.size > 10_000) for (const [k] of failures) if (!recent(k).length) failures.delete(k)
  }
  const tooMany = (c: Context) => (c.header('Retry-After', '900'), fail(c, 429, 'too_many_attempts'))

  async function startSession(c: Context, userId: number) {
    const token = randomBytes(32).toString('hex')
    await db.query(`INSERT INTO sessions VALUES ($1, $2, now() + make_interval(hours => $3))`, [sha256(token), userId, SESSION_HOURS])
    setCookie(c, 'sid', token, {
      httpOnly: true, sameSite: 'Lax', path: '/', maxAge: SESSION_HOURS * 3600,
      // Many internal installs run on plain http; a Secure cookie would never come back there.
      secure: new URL(c.req.url).protocol === 'https:' || c.req.header('x-forwarded-proto') === 'https',
    })
  }

  // SSO can be switched on or changed by an admin at any time, so every use reads the current config.
  const sso = ssoSource(db)
  const hooks = createWebhooks(db)
  registerSso(app, db, sso, startSession)

  const liveInvite = (token: unknown) =>
    typeof token === 'string' && token
      ? one('SELECT purpose FROM invites WHERE token_hash = $1 AND used_by IS NULL AND expires_at > now()', [sha256(token)])
      : Promise.resolve(undefined)

  app.get('/api/auth/status', async (c) =>
    c.json({
      needsSetup: !(await one('SELECT 1 FROM users LIMIT 1')),
      signupOpen: process.env.ALLOW_SIGNUP === '1',
      sso: (await sso.current())?.label ?? null,
      passwordLogin: (await sso.current())?.passwordLogin ?? true,
      mail: mailEnabled(),
      link: (await liveInvite(c.req.query('token')))?.purpose ?? null,
    }),
  )

  app.post('/api/auth/register', async (c) => {
    const b = await c.req.json().catch(() => ({}))
    const email = str(b.email, 200)?.toLowerCase()
    const name = str(b.name, 100)
    if (!email || !/^\S+@\S+\.\S+$/.test(email) || !name || typeof b.password !== 'string' || b.password.length < 8)
      return fail(c, 400, 'invalid_signup')
    // Guessing the setup token counts like guessing a password.
    if (!(await one('SELECT 1 FROM users LIMIT 1')) && throttled(c, 'setup')) return tooMany(c)
    const hash = hashPassword(b.password)
    const r = await tx(db, async (q) => {
      // Serialize registrations so two simultaneous first signups can't both become admin.
      await q.query('SELECT pg_advisory_xact_lock(727002)')
      const first = !(await q.query('SELECT 1 FROM users LIMIT 1')).rowCount
      // FOR UPDATE: an invite link is single use even if two people open it at once.
      const invite = typeof b.invite === 'string' && b.invite
        ? (await q.query(`SELECT * FROM invites WHERE token_hash = $1 AND purpose = 'invite' AND used_by IS NULL AND expires_at > now() FOR UPDATE`,
            [sha256(b.invite)])).rows[0]
        : undefined
      if (b.invite && !invite) return { status: 403 as const, error: 'invite_invalid' }
      // The first account becomes admin, so it needs the token from the server log: whoever runs the server claims it.
      if (first) {
        const want = await setupToken(q)
        if (!want || typeof b.setupToken !== 'string' || sha256(b.setupToken.trim()) !== sha256(want)) return { status: 403 as const, error: 'bad_setup_token' }
        await q.query(`DELETE FROM settings WHERE key = 'setup_token'`)
      }
      if (!first && !invite && process.env.ALLOW_SIGNUP !== '1') return { status: 403 as const, error: 'signup_closed' }
      if ((await q.query('SELECT 1 FROM users WHERE email = $1', [email])).rowCount)
        return { status: 409 as const, error: 'email_taken' }
      const role = first ? 'admin' : invite?.role ?? 'member'
      const { id } = (await q.query('INSERT INTO users (email, name, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id',
        [email, name, hash, role])).rows[0]
      if (invite) await q.query('UPDATE invites SET used_by = $1 WHERE token_hash = $2', [id, invite.token_hash])
      if (first) await q.query(`INSERT INTO spaces (key, name) VALUES ('GENERAL', 'General')`)
      return { id }
    })
    if ('error' in r && r.error === 'bad_setup_token') failed(c, 'setup')
    if ('error' in r) return fail(c, r.status!, r.error!)
    await startSession(c, r.id)
    return c.json(await one('SELECT id, email, name, role, locale FROM users WHERE id = $1', [r.id]))
  })

  app.post('/api/auth/login', async (c) => {
    const b = await c.req.json().catch(() => ({}))
    const email = String(b.email ?? '').toLowerCase()
    if (throttled(c, email)) return tooMany(c)
    // With SSO and PASSWORD_LOGIN=0 only admins may still use a password (a way back in if the provider is down).
    const row = await one('SELECT * FROM users WHERE email = $1', [email])
    if (typeof b.password !== 'string' || !checkPassword(b.password, row?.password_hash) || !row) {
      failed(c, email)
      return fail(c, 401, 'bad_credentials')
    }
    if (row.disabled_at) return fail(c, 403, 'account_disabled')
    if ((await sso.current())?.passwordLogin === false && row.role !== 'admin') return fail(c, 403, 'use_sso')
    await startSession(c, row.id)
    return c.json({ id: row.id, email: row.email, name: row.name, role: row.role, locale: row.locale, theme: row.theme, avatar: !!row.avatar, mustChangePassword: row.must_change_password })
  })

  app.post('/api/auth/reset', async (c) => {
    const b = await c.req.json().catch(() => ({}))
    if (typeof b.password !== 'string' || b.password.length < 8) return fail(c, 400, 'password_short')
    if (throttled(c, 'reset')) return tooMany(c)
    const hash = hashPassword(b.password)
    const userId = await tx(db, async (q) => {
      const inv = typeof b.token === 'string'
        ? (await q.query(`SELECT * FROM invites WHERE token_hash = $1 AND purpose = 'reset' AND used_by IS NULL AND expires_at > now() FOR UPDATE`,
            [sha256(b.token)])).rows[0]
        : undefined
      if (!inv) return null
      // A disabled account keeps its password: the link stays unused and nothing changes.
      if ((await q.query('SELECT disabled_at FROM users WHERE id = $1', [inv.user_id])).rows[0]?.disabled_at) return 'disabled' as const
      await q.query('UPDATE users SET password_hash = $1, must_change_password = false WHERE id = $2', [hash, inv.user_id])
      await q.query('UPDATE invites SET used_by = $1 WHERE token_hash = $2', [inv.user_id, inv.token_hash])
      await q.query('DELETE FROM sessions WHERE user_id = $1', [inv.user_id])
      return inv.user_id as number
    })
    if (!userId) return failed(c, 'reset'), fail(c, 403, 'reset_invalid')
    if (userId === 'disabled') return fail(c, 403, 'account_disabled')
    const u = await one('SELECT id, email, name, role, locale FROM users WHERE id = $1', [userId])
    await startSession(c, userId)
    return c.json({ id: u.id, email: u.email, name: u.name, role: u.role, locale: u.locale })
  })

  // Forgot password: with mail set up, a one-hour reset link goes to the address. The answer is the same whether
  // or not the address has an account, so this can't be used to find out who does.
  app.post('/api/auth/forgot', async (c) => {
    if (!mailEnabled()) return fail(c, 404, 'mail_off')
    const b = await c.req.json().catch(() => ({}))
    const email = String(b.email ?? '').trim().toLowerCase()
    if (throttled(c, `forgot:${email}`)) return tooMany(c)
    failed(c, `forgot:${email}`) // every request counts toward the limit, so nobody gets flooded with mail
    const u = email && (await one('SELECT id, locale FROM users WHERE email = $1 AND disabled_at IS NULL', [email]))
    if (u) {
      const token = randomBytes(24).toString('hex')
      await db.query(`INSERT INTO invites (token_hash, purpose, user_id, created_by, expires_at) VALUES ($1, 'reset', $2, $2, now() + interval '1 hour')`, [sha256(token), u.id])
      const base = process.env.PUBLIC_URL?.replace(/\/$/, '') || new URL(c.req.url).origin
      const ko = u.locale === 'ko'
      const brand = await brandName(db)
      await sendMail(email, ko ? `[${brand}] 비밀번호 재설정` : `[${brand}] Reset your password`,
        (ko ? '아래 링크에서 새 비밀번호를 정하세요. 링크는 1시간 동안 한 번만 쓸 수 있습니다.\n\n' : 'Choose a new password at the link below. It works once, for one hour.\n\n') +
        `${base}/#/reset/${token}\n\n` + (ko ? '요청하지 않았다면 이 메일은 무시하세요.' : 'If you didn’t ask for this, ignore this email.'),
        brand,
      ).catch((e) => console.error('forgot-password mail failed:', e.message))
    }
    return c.json({ ok: true })
  })

  app.post('/api/auth/logout', async (c) => {
    const token = getCookie(c, 'sid')
    if (token) await db.query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)])
    deleteCookie(c, 'sid', { path: '/' })
    return c.json({ ok: true, redirect: await ssoLogoutUrl(c, sso) })
  })

  // Everything below requires a session.
  app.use('/api/*', async (c, next) => {
    if (c.req.path.startsWith('/api/auth/')) return next()
    const token = getCookie(c, 'sid')
    // API clients and agents send a personal token instead of the session cookie.
    const bearer = c.req.header('authorization')?.match(/^Bearer\s+(ph_[A-Za-z0-9_-]+)$/)?.[1]
    const user = token
      ? await one(
          `SELECT u.id, u.email, u.name, u.role, u.locale, u.theme, u.avatar IS NOT NULL AS avatar, u.must_change_password AS "mustChangePassword" FROM sessions s JOIN users u ON u.id = s.user_id
           WHERE s.token_hash = $1 AND s.expires_at > now() AND u.disabled_at IS NULL`,
          [sha256(token)],
        )
      : bearer
        ? await one(
            `UPDATE api_tokens t SET last_used_at = now() FROM users u
             WHERE t.token_hash = $1 AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > now())
               AND u.id = t.user_id AND u.disabled_at IS NULL
               AND (u.last_sso_at IS NULL OR u.last_sso_at > now() - make_interval(days => $2))
             RETURNING u.id, u.email, u.name, u.role, u.locale, u.theme, u.avatar IS NOT NULL AS avatar, u.must_change_password AS "mustChangePassword"`,
            [sha256(bearer), TOKEN_SSO_GRACE_DAYS],
          )
        : undefined
    if (!user) return fail(c, 401, 'login_required')
    c.set('user', user)
    if (c.req.path.startsWith('/api/admin/') && user.role !== 'admin') return fail(c, 403, 'admin_only')
    return next()
  })

  app.get('/api/me', async (c) =>
    c.json({ ...c.get('user'), mail: mailEnabled(), ...(await one('SELECT email_notify AS "emailNotify", webhook_url AS "webhookUrl" FROM users WHERE id = $1', [c.get('user').id])) }))

  // Content-addressed: the same bytes are stored once. Touching an existing file marks it in use for pruneFiles.
  const storeFile = (buf: Buffer) => {
    const hash = sha256(buf)
    const path = join(filesDir, hash)
    if (existsSync(path)) utimesSync(path, new Date(), new Date())
    else writeFileSync(path, buf)
    return hash
  }
  const dropIfUnused = (ref: string | null | undefined) => pruneFiles(db, filesDir, [ref])
  const avatarOf = async (userId: number) => (await one('SELECT avatar FROM users WHERE id = $1', [userId]))?.avatar as string | null

  // Profile photo: the browser sends a small square image (it resizes before uploading).
  app.put('/api/me/avatar', async (c) => {
    const file = (await c.req.parseBody()).file
    if (!(file instanceof File) || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) return fail(c, 400, 'bad_request')
    if (file.size > 1024 * 1024) return fail(c, 413, 'file_too_large')
    const buf = Buffer.from(await file.arrayBuffer())
    const hash = storeFile(buf)
    const old = await avatarOf(c.get('user').id)
    await db.query('UPDATE users SET avatar = $1 WHERE id = $2', [`${hash}:${file.type}`, c.get('user').id])
    await dropIfUnused(old)
    return c.json({ avatar: true })
  })
  app.delete('/api/me/avatar', async (c) => {
    const old = await avatarOf(c.get('user').id)
    await db.query('UPDATE users SET avatar = NULL WHERE id = $1', [c.get('user').id])
    await dropIfUnused(old)
    return c.json({ avatar: false })
  })
  app.get('/api/users/:id/avatar', async (c) => {
    const a = (await one('SELECT avatar FROM users WHERE id = $1', [id(c)]))?.avatar as string | undefined
    // Cached briefly either way, so lists of people don't ask again on every render.
    if (!a) return c.body(null, 404, { 'Cache-Control': 'private, max-age=300' })
    const [hash, mime] = a.split(':')
    const path = join(filesDir, hash)
    if (!existsSync(path)) return c.body(null, 404)
    const etag = `"${hash}"`
    if (c.req.header('if-none-match') === etag) return c.body(null, 304)
    return c.body(readFileSync(path), 200, { 'Content-Type': mime, ETag: etag, 'Cache-Control': 'private, max-age=300' })
  })

  // Branding: the name (browser tab title) and logo (also the favicon) an admin sets after installing.
  // Read under /api/auth/ so the sign-in screen shows it too.
  const branding = () => readBranding(db)
  const setBranding = (patch: object) => saveBranding(db, patch)
  app.get('/api/auth/branding', async (c) => {
    const b = await branding()
    return c.json({ name: b.name, logo: b.logo?.split(':')[0] ?? null, accent: b.accent })
  })
  app.get('/api/auth/branding/logo', async (c) => {
    const logo = (await branding()).logo
    if (!logo) return c.body(null, 404)
    const [hash, mime] = logo.split(':')
    const path = join(filesDir, hash)
    if (!existsSync(path)) return c.body(null, 404)
    // The client asks with ?v=<hash>, so a new logo is a new URL.
    return c.body(readFileSync(path), 200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=31536000, immutable' })
  })
  app.put('/api/admin/branding', async (c) => {
    const b = await c.req.json().catch(() => ({}))
    // Each field is optional; null brings back the default.
    const patch: { name?: string | null; accent?: string | null } = {}
    if ('name' in b) {
      if (b.name !== null && typeof b.name !== 'string') return fail(c, 400, 'bad_request')
      patch.name = b.name?.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 60) || null
    }
    if ('accent' in b) {
      // Goes into a <style> on every page: nothing but #rrggbb.
      if (b.accent !== null && !isColor(b.accent)) return fail(c, 400, 'bad_request')
      patch.accent = b.accent?.toLowerCase() ?? null
    }
    if (!Object.keys(patch).length) return fail(c, 400, 'bad_request')
    await setBranding(patch)
    return c.json(patch)
  })
  app.put('/api/admin/branding/logo', async (c) => {
    const file = (await c.req.parseBody()).file
    // No SVG: served from this origin it could run script.
    if (!(file instanceof File) || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) return fail(c, 400, 'bad_request')
    if (file.size > 512 * 1024) return fail(c, 413, 'file_too_large')
    const buf = Buffer.from(await file.arrayBuffer())
    const hash = storeFile(buf)
    const old = (await branding()).logo
    await setBranding({ logo: `${hash}:${file.type}` })
    await dropIfUnused(old)
    return c.json({ logo: hash })
  })
  app.delete('/api/admin/branding/logo', async (c) => {
    const old = (await branding()).logo
    await setBranding({ logo: null })
    await dropIfUnused(old)
    return c.json({ logo: null })
  })

  app.patch('/api/me', async (c) => {
    const b = await c.req.json().catch(() => ({}))
    const locale = b.locale === undefined ? undefined : LOCALES.includes(b.locale) ? b.locale : null
    const theme = b.theme === undefined ? undefined : ['system', 'light', 'dark'].includes(b.theme) ? b.theme : null
    const emailNotify = typeof b.emailNotify === 'boolean' ? b.emailNotify : null
    const name = b.name === undefined ? undefined : str(b.name, 100) ?? null
    // '' clears it.
    const webhookUrl = b.webhookUrl === undefined ? undefined : b.webhookUrl === '' || b.webhookUrl === null ? '' : httpUrl(b.webhookUrl)
    if (webhookUrl === null) return fail(c, 400, 'bad_request')
    if (webhookUrl !== undefined) await db.query('UPDATE users SET webhook_url = $1 WHERE id = $2', [webhookUrl || null, c.get('user').id])
    if (webhookUrl !== undefined && locale === undefined && theme === undefined && emailNotify === null && name === undefined) return c.json({ webhookUrl: webhookUrl || null })
    if (locale === null || theme === null || name === null || (locale === undefined && theme === undefined && emailNotify === null && name === undefined)) return fail(c, 400, 'bad_request')
    await db.query('UPDATE users SET locale = coalesce($1, locale), theme = coalesce($2, theme), email_notify = coalesce($3, email_notify), name = coalesce($5, name) WHERE id = $4',
      [locale ?? null, theme ?? null, emailNotify, c.get('user').id, name ?? null])
    return c.json({ ...c.get('user'), ...(locale && { locale }), ...(theme && { theme }), ...(emailNotify !== null && { emailNotify }), ...(name && { name }) })
  })

  app.get('/api/me/tokens', async (c) =>
    c.json(await all(`SELECT id, name, created_at AS "createdAt", expires_at AS "expiresAt", last_used_at AS "lastUsedAt" FROM api_tokens
      WHERE user_id = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()) ORDER BY id DESC`, [c.get('user').id])))
  app.post('/api/me/tokens', async (c) => {
    // A token can't mint more tokens: only a signed-in browser session can.
    if (!getCookie(c, 'sid')) return fail(c, 403, 'login_required')
    const b = await c.req.json().catch(() => ({}))
    const name = str(b.name, 100)
    const days = Number(b.days ?? 90)
    if (!name || !Number.isInteger(days) || days < 1 || days > 365) return fail(c, 400, 'bad_request')
    const token = `ph_${randomBytes(24).toString('base64url')}`
    const row = await one(`INSERT INTO api_tokens (user_id, name, token_hash, expires_at) VALUES ($1, $2, $3, now() + make_interval(days => $4))
      RETURNING id, expires_at AS "expiresAt"`, [c.get('user').id, name, sha256(token), days])
    return c.json({ id: row.id, name, expiresAt: row.expiresAt, token })
  })
  app.delete('/api/me/tokens/:id', async (c) => {
    const r = await db.query('UPDATE api_tokens SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL', [id(c), c.get('user').id])
    return r.rowCount ? c.json({ ok: true }) : fail(c, 404, 'bad_request')
  })

  app.post('/api/me/password', async (c) => {
    const b = await c.req.json().catch(() => ({}))
    const user = c.get('user')
    const row = await one('SELECT password_hash FROM users WHERE id = $1', [user.id])
    if (throttled(c, user.email)) return tooMany(c)
    if (typeof b.current !== 'string' || !checkPassword(b.current, row.password_hash)) {
      failed(c, user.email)
      return fail(c, 400, 'wrong_password')
    }
    if (typeof b.next !== 'string' || b.next.length < 8) return fail(c, 400, 'password_short')
    await db.query('UPDATE users SET password_hash = $1, must_change_password = false WHERE id = $2', [hashPassword(b.next), user.id])
    // Sign out every other device.
    await db.query('DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2', [user.id, sha256(getCookie(c, 'sid')!)])
    return c.json({ ok: true })
  })

  app.get('/api/admin/users', async (c) =>
    c.json(await all(`SELECT id, email, name, role, disabled_at AS "disabledAt", created_at AS "createdAt" FROM users ORDER BY id`)),
  )

  app.patch('/api/admin/users/:id', async (c) => {
    const b = await c.req.json().catch(() => ({}))
    if (id(c) === c.get('user').id) return fail(c, 400, 'cannot_change_self')
    if (b.role !== undefined && !['admin', 'member'].includes(b.role)) return fail(c, 400, 'bad_request')
    const r = await db.query(
      `UPDATE users SET role = COALESCE($1, role),
         disabled_at = CASE WHEN $2::boolean IS NULL THEN disabled_at WHEN $2 THEN COALESCE(disabled_at, now()) ELSE NULL END
       WHERE id = $3`,
      [b.role ?? null, typeof b.disabled === 'boolean' ? b.disabled : null, id(c)],
    )
    if (!r.rowCount) return fail(c, 404, 'user_not_found')
    if (b.disabled === true) await db.query('DELETE FROM sessions WHERE user_id = $1', [id(c)])
    return c.json({ ok: true })
  })

  // Password reset without a mail server: the admin hands the user a one-time link.
  // A temporary password the admin passes on; the person must pick their own right after signing in with it.
  app.post('/api/admin/users/:id/temp-password', async (c) => {
    if (id(c) === c.get('user').id) return fail(c, 400, 'cannot_change_self')
    // Easy to read out loud: no 0/O, 1/l/I.
    const abc = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    const password = [...randomBytes(12)].map((b) => abc[b % abc.length]).join('')
    const r = await db.query('UPDATE users SET password_hash = $1, must_change_password = true WHERE id = $2', [hashPassword(password), id(c)])
    if (!r.rowCount) return fail(c, 404, 'user_not_found')
    await db.query('DELETE FROM sessions WHERE user_id = $1', [id(c)])
    return c.json({ password })
  })

  app.post('/api/admin/users/:id/reset-link', async (c) => {
    if (!(await one('SELECT 1 FROM users WHERE id = $1', [id(c)]))) return fail(c, 404, 'user_not_found')
    const token = randomBytes(24).toString('hex')
    await db.query(`INSERT INTO invites (token_hash, purpose, user_id, created_by, expires_at) VALUES ($1, 'reset', $2, $3, now() + interval '1 day')`,
      [sha256(token), id(c), c.get('user').id])
    return c.json({ token })
  })

  app.post('/api/admin/invites', async (c) => {
    const b = await c.req.json().catch(() => ({}))
    const role = b.role === 'admin' ? 'admin' : 'member'
    const token = randomBytes(24).toString('hex')
    await db.query(`INSERT INTO invites (token_hash, role, created_by, expires_at) VALUES ($1, $2, $3, now() + interval '7 days')`,
      [sha256(token), role, c.get('user').id])
    return c.json({ token, role })
  })

  app.get('/api/recent', async (c) =>
    c.json(
      await all(
        `SELECT p.id, p.title, p.updated_at AS "updatedAt", u.name AS "updatedBy", s.name AS space, s.id AS "spaceId"
         FROM pages p JOIN users u ON u.id = p.updated_by JOIN spaces s ON s.id = p.space_id
         WHERE p.deleted_at IS NULL AND p.kind = 'page' AND ${visible('p', 1, 2)} ORDER BY p.updated_at DESC LIMIT 20`,
        who(c),
      ),
    ),
  )

  app.get('/api/spaces/:id/pages', async (c) =>
    c.json(
      await all(
        `SELECT p.id, p.parent_id AS "parentId", p.kind, p.title, p.icon,
           EXISTS (SELECT 1 FROM page_restrictions r WHERE r.page_id = p.id) AS locked
         FROM pages p WHERE p.space_id = $1 AND p.deleted_at IS NULL AND ${visible('p', 2, 3)} ORDER BY p.position, p.id`,
        [id(c), ...who(c)],
      ),
    ),
  )

  const livePage = (pageId: number) => one('SELECT * FROM pages WHERE id = $1 AND deleted_at IS NULL', [pageId])

  // Access to one page: 'edit' | 'view' | null. Admins always get 'edit' so a lockout can be fixed.
  // `trashed` picks pages in the trash instead of live ones.
  async function access(pageId: number, user: User, trashed = false): Promise<'edit' | 'view' | null> {
    const r = await one(
      'SELECT page_access(id, $2) AS a, space_access(space_id, $2) AS s FROM pages WHERE id = $1 AND (deleted_at IS NOT NULL) = $3',
      [pageId, user.id, trashed],
    )
    if (!r) return null
    if (user.role === 'admin') return 'edit'
    // A page can be no more open than its space: view-only spaces cap every page at view.
    if (!r.a || !r.s) return null
    return r.s === 'view' ? 'view' : r.a
  }
  // Pages you can't see answer 404, same as missing ones, so their existence doesn't leak.
  async function guard(c: Context<Env>, pageId: number, need: 'view' | 'edit', trashed = false) {
    const a = await access(pageId, c.get('user'), trashed)
    if (!a) return fail(c, 404, 'page_not_found')
    if (need === 'edit' && a !== 'edit') return fail(c, 403, 'no_edit_permission')
    return null
  }
  // SQL filter for lists; `admin` and `uid` are the query's parameter numbers for the caller.
  // hidden_pages() runs once per query (Postgres hashes the uncorrelated subquery), not once per row.
  const visible = (alias: string, admin: number, uid: number) => `($${admin} OR ${alias}.id NOT IN (SELECT id FROM hidden_pages($${uid})))`
  const who = (c: Context<Env>) => [c.get('user').role === 'admin', c.get('user').id]

  app.post('/api/pages', async (c) => {
    const b = await c.req.json().catch(() => ({}))
    const title = str(b.title, 500) ?? 'Untitled'
    const kind = b.kind === 'folder' ? 'folder' : 'page'
    const spaceId = Number(b.spaceId)
    const parentId = b.parentId == null ? null : Number(b.parentId)
    if (!Number.isInteger(spaceId) || !(await one('SELECT 1 FROM spaces WHERE id = $1', [spaceId])))
      return fail(c, 400, 'space_not_found')
    if (parentId !== null) {
      const parent = Number.isInteger(parentId) && (await livePage(parentId))
      if (!parent || parent.space_id !== spaceId) return fail(c, 400, 'parent_not_found')
      const denied = await guard(c, parentId, 'edit')
      if (denied) return denied
    }
    if (parentId === null && c.get('user').role !== 'admin') {
      const role = (await one('SELECT space_access($1, $2) AS r', [spaceId, c.get('user').id]))?.r
      if (!role) return fail(c, 404, 'space_not_found')
      if (role === 'view') return fail(c, 403, 'no_edit_permission')
    }
    // Templates send a starting doc.
    const doc = b.doc?.type === 'doc' ? b.doc : EMPTY_DOC
    const user = c.get('user')
    const row = await one(
      `INSERT INTO pages (space_id, parent_id, kind, title, doc, text, position, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6,
         (SELECT COALESCE(MAX(position), 0) + 1 FROM pages WHERE space_id = $1 AND parent_id IS NOT DISTINCT FROM $2),
         $7, $7)
       RETURNING id`,
      [spaceId, parentId, kind, title, doc, docText(doc), user.id],
    )
    await db.query('INSERT INTO page_versions (page_id, version, title, doc, author_id) VALUES ($1, 1, $2, $3, $4)', [row.id, title, doc, user.id])
    await db.query('INSERT INTO page_watches (user_id, page_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [user.id, row.id])
    hooks.emit('page.created', row.id, user.id)
    return c.json({ id: row.id, parentId, kind, title })
  })

  // A copy of one page (not its children) next to it. It keeps the original's restrictions, so copying never widens access.
  app.post('/api/pages/:id/copy', async (c) => {
    const pageId = id(c)
    const denied = await guard(c, pageId, 'view')
    if (denied) return denied
    await collab.flush(pageId)
    const src = await livePage(pageId)
    if (!src) return fail(c, 404, 'page_not_found')
    const b = await c.req.json().catch(() => ({}))
    const title = str(b.title, 500) ?? `${src.title} (copy)`
    const [admin, uid] = who(c)
    // With children: every live descendant the caller can see, parents first. Hidden ones (and so their subtrees) stay out.
    const rows: any[] = b.children
      ? (await db.query(
          `WITH RECURSIVE t AS (SELECT id, 0 AS depth FROM pages WHERE id = $1
             UNION ALL SELECT p.id, t.depth + 1 FROM pages p JOIN t ON p.parent_id = t.id WHERE p.deleted_at IS NULL)
           SELECT p.* FROM t JOIN pages p ON p.id = t.id WHERE t.depth = 0 OR $2 OR p.id NOT IN (SELECT id FROM hidden_pages($3))
           ORDER BY t.depth, p.position`,
          [pageId, admin, uid],
        )).rows
      : [src]
    for (const r of rows) await collab.flush(Number(r.id))
    // Creating next to the original needs the same rights as creating a page there.
    if (src.parent_id !== null) {
      const d = await guard(c, Number(src.parent_id), 'edit')
      if (d) return d
    } else if (!admin) {
      const role = (await one('SELECT space_access($1, $2) AS r', [src.space_id, uid]))?.r
      if (!role) return fail(c, 404, 'space_not_found')
      if (role === 'view') return fail(c, 403, 'no_edit_permission')
    }
    // All or nothing: a half-made copy could exist for a moment without the restrictions it should carry.
    const newId = new Map<number, number>()
    await tx(db, async (q) => {
      const one1 = async (sql: string, params: unknown[]) => (await q.query(sql, params)).rows[0]
      // Old file id -> its copy, across the tree, so a subpage showing its parent's image points at the copied parent's file.
      const files = new Map<string, string>()
      for (const [i, r0] of rows.entries()) {
        const r = await one1('SELECT * FROM pages WHERE id = $1 AND deleted_at IS NULL', [r0.id]) // latest, after the flush
        if (!r || (i > 0 && !newId.has(Number(r.parent_id)))) continue
        const parent = i === 0 ? r.parent_id : newId.get(Number(r.parent_id))
        const position = i === 0
          ? (await one1('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM pages WHERE space_id = $1 AND parent_id IS NOT DISTINCT FROM $2', [r.space_id, parent])).p
          : r.position
        const t = i === 0 ? title : r.title
        const to = Number((await one1(
          `INSERT INTO pages (space_id, parent_id, kind, title, doc, text, position, icon, created_by, updated_by)
           VALUES ($1, $2, $3, $4, $5, '', $6, $7, $8, $8) RETURNING id`,
          [r.space_id, parent, r.kind, t, EMPTY_DOC, position, r.icon, uid],
        )).id)
        newId.set(Number(r.id), to)
        await q.query('INSERT INTO page_restrictions (page_id, user_id, group_id, level) SELECT $1, user_id, group_id, level FROM page_restrictions WHERE page_id = $2', [to, r.id])
        await q.query('INSERT INTO page_labels (page_id, label) SELECT $1, label FROM page_labels WHERE page_id = $2', [to, r.id])
        // Attachments are content-addressed, so a copy is just a new row pointing at the same bytes.
        for (const a of (await q.query('SELECT * FROM attachments WHERE page_id = $1', [r.id])).rows)
          files.set(String(a.id), String((await one1(
            'INSERT INTO attachments (page_id, name, mime, size, sha256, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
            [to, a.name, a.mime, a.size, a.sha256, uid],
          )).id))
        const doc = JSON.parse(JSON.stringify(r.doc).replace(/\/api\/files\/(\d+)/g, (m, f) => (files.has(f) ? `/api/files/${files.get(f)}` : m)))
        await q.query('UPDATE pages SET doc = $2, text = $3 WHERE id = $1', [to, doc, docText(doc)])
        await q.query('INSERT INTO page_versions (page_id, version, title, doc, author_id) VALUES ($1, 1, $2, $3, $4)', [to, t, doc, uid])
        if (i === 0) await q.query('INSERT INTO page_watches (user_id, page_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [uid, to])
      }
    })
    const top = newId.get(pageId)!
    return c.json({ id: top, parentId: src.parent_id, kind: src.kind, title, count: newId.size })
  })

  app.get('/api/pages/:id', async (c) => {
    const p = await one(
      `SELECT p.*, u.name AS updated_by_name, cu.name AS created_by_name, s.name AS space_name, s.key AS space_key
       FROM pages p JOIN users u ON u.id = p.updated_by JOIN users cu ON cu.id = p.created_by JOIN spaces s ON s.id = p.space_id
       WHERE p.id = $1 AND p.deleted_at IS NULL`,
      [id(c)],
    )
    const a = p && (await access(p.id, c.get('user')))
    if (!p || !a) return fail(c, 404, 'page_not_found')
    await db.query(
      `INSERT INTO page_views (user_id, page_id) VALUES ($1, $2) ON CONFLICT (user_id, page_id) DO UPDATE SET viewed_at = now()`,
      [c.get('user').id, p.id],
    )
    const ancestors = await all(
      `WITH RECURSIVE a(id, parent_id, title, depth) AS (
         SELECT id, parent_id, title, 0 FROM pages WHERE id = $1
         UNION ALL SELECT p.id, p.parent_id, p.title, a.depth + 1 FROM pages p JOIN a ON p.id = a.parent_id)
       SELECT id, title FROM a WHERE depth > 0 ORDER BY depth DESC`,
      [p.id],
    )
    return c.json({
      id: p.id, spaceId: p.space_id, parentId: p.parent_id, kind: p.kind, title: p.title,
      doc: p.doc, version: p.version, updatedAt: p.updated_at, updatedBy: p.updated_by_name,
      createdAt: p.created_at, createdBy: p.created_by_name,
      space: { id: p.space_id, name: p.space_name, key: p.space_key }, ancestors,
      access: a,
      icon: p.icon,
      labels: (await all('SELECT label FROM page_labels WHERE page_id = $1 ORDER BY label', [p.id])).map((r) => r.label),
      starred: !!(await one('SELECT 1 FROM page_stars WHERE page_id = $1 AND user_id = $2', [p.id, c.get('user').id])),
      watching: !!(await one('SELECT 1 FROM page_watches WHERE page_id = $1 AND user_id = $2', [p.id, c.get('user').id])),
      restricted: !!(await one(
        `WITH RECURSIVE path(id, parent_id) AS (SELECT id, parent_id FROM pages WHERE id = $1
           UNION ALL SELECT x.id, x.parent_id FROM pages x JOIN path ON x.id = path.parent_id)
         SELECT 1 FROM page_restrictions r JOIN path ON r.page_id = path.id LIMIT 1`,
        [p.id],
      )),
    })
  })

  // Labels: lowercase words joined by dashes, so "Meeting Notes" and "meeting-notes" are one label.
  app.put('/api/pages/:id/labels', async (c) => {
    const denied = await guard(c, id(c), 'edit')
    if (denied) return denied
    const b = await c.req.json().catch(() => ({}))
    if (!Array.isArray(b.labels)) return fail(c, 400, 'bad_request')
    const labels = [...new Set(b.labels.map(normLabel).filter(Boolean))].slice(0, 30)
    await tx(db, async (q) => {
      await q.query('DELETE FROM page_labels WHERE page_id = $1', [id(c)])
      if (labels.length) await q.query('INSERT INTO page_labels (page_id, label) SELECT $1, unnest($2::text[])', [id(c), labels])
    })
    return c.json({ labels: labels.sort() })
  })

  // Labels in use on pages the caller can see, most used first; `q` narrows by prefix for suggestions.
  app.get('/api/labels', async (c) => {
    const q = normLabel(c.req.query('q') ?? '')
    return c.json(await all(
      `SELECT l.label, count(*)::int AS pages FROM page_labels l JOIN pages p ON p.id = l.page_id
       WHERE p.deleted_at IS NULL AND ${visible('p', 1, 2)} AND l.label LIKE $3
       GROUP BY l.label ORDER BY count(*) DESC, l.label LIMIT 100`,
      [...who(c), `${q.replace(/[\\%_]/g, '\\$&')}%`],
    ))
  })

  // One emoji (any sequence: flags, skin tones, ZWJ families), or null to remove it.
  app.put('/api/pages/:id/icon', async (c) => {
    const denied = await guard(c, id(c), 'edit')
    if (denied) return denied
    const b = await c.req.json().catch(() => ({}))
    const icon = b.icon === null || b.icon === '' ? null : typeof b.icon === 'string' ? b.icon.trim() : undefined
    if (icon === undefined || (icon !== null && (icon.length > 16 || !/^[\p{Extended_Pictographic}\p{Regional_Indicator}\u200d\ufe0f\u20e3\p{Emoji_Modifier}\p{Emoji_Component}]+$/u.test(icon) || !/[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u.test(icon))))
      return fail(c, 400, 'bad_request')
    await db.query('UPDATE pages SET icon = $2 WHERE id = $1', [id(c), icon])
    return c.json({ icon })
  })

  app.put('/api/pages/:id/star', async (c) => {
    const denied = await guard(c, id(c), 'view')
    if (denied) return denied
    const b = await c.req.json().catch(() => ({}))
    await db.query(b.starred
      ? 'INSERT INTO page_stars (user_id, page_id) VALUES ($1, $2) ON CONFLICT DO NOTHING'
      : 'DELETE FROM page_stars WHERE user_id = $1 AND page_id = $2', [c.get('user').id, id(c)])
    return c.json({ starred: !!b.starred })
  })

  app.put('/api/pages/:id/watch', async (c) => {
    const denied = await guard(c, id(c), 'view')
    if (denied) return denied
    const b = await c.req.json().catch(() => ({}))
    if (b.watching) await db.query('INSERT INTO page_watches (user_id, page_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [c.get('user').id, id(c)])
    else await db.query('DELETE FROM page_watches WHERE user_id = $1 AND page_id = $2', [c.get('user').id, id(c)])
    return c.json({ watching: !!b.watching })
  })

  app.post('/api/pages/:id/move', async (c) => {
    const b = await c.req.json().catch(() => ({}))
    const parentId = b.parentId == null ? null : Number(b.parentId)
    const index = Number.isInteger(b.index) && b.index >= 0 ? b.index : Number.MAX_SAFE_INTEGER
    const denied = (await guard(c, id(c), 'edit')) ?? (parentId !== null && Number.isInteger(parentId) ? await guard(c, parentId, 'edit') : null)
    if (denied) return denied
    const r = await tx(db, async (q) => {
      const p = (await q.query('SELECT * FROM pages WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [id(c)])).rows[0]
      if (!p) return { status: 404 as const, error: 'page_not_found' }
      if (parentId !== null) {
        const parent = (await q.query('SELECT space_id FROM pages WHERE id = $1 AND deleted_at IS NULL', [parentId])).rows[0]
        if (!parent || parent.space_id !== p.space_id) return { status: 400 as const, error: 'parent_not_found' }
        // Refuse to move a page under itself or its own descendant.
        const cycle = await q.query(
          `WITH RECURSIVE a(id, parent_id) AS (SELECT id, parent_id FROM pages WHERE id = $1
             UNION ALL SELECT x.id, x.parent_id FROM pages x JOIN a ON x.id = a.parent_id)
           SELECT 1 FROM a WHERE id = $2`,
          [parentId, p.id],
        )
        if (cycle.rowCount) return { status: 400 as const, error: 'move_into_self' }
      }
      // Restrictions are inherited from ancestors, so a move can lift them. Only an admin may move a page out from
      // under a restricted page; anyone else would be widening access they don't control.
      if (c.get('user').role !== 'admin') {
        const restrictedAbove = async (start: number | null) => start === null ? new Set<number>() : new Set<number>((await q.query(
          `WITH RECURSIVE a(id, parent_id) AS (SELECT id, parent_id FROM pages WHERE id = $1
             UNION ALL SELECT x.id, x.parent_id FROM pages x JOIN a ON x.id = a.parent_id)
           SELECT DISTINCT a.id FROM a JOIN page_restrictions r ON r.page_id = a.id`, [start])).rows.map((r) => Number(r.id)))
        const before = await restrictedAbove(p.parent_id === null ? null : Number(p.parent_id))
        const after = await restrictedAbove(parentId)
        if ([...before].some((x) => !after.has(x))) return { status: 403 as const, error: 'move_drops_restrictions' }
      }
      const siblings: number[] = (await q.query(
        `SELECT id FROM pages WHERE space_id = $1 AND parent_id IS NOT DISTINCT FROM $2 AND deleted_at IS NULL AND id <> $3
         ORDER BY position, id`,
        [p.space_id, parentId, p.id],
      )).rows.map((r) => r.id)
      siblings.splice(Math.min(index, siblings.length), 0, p.id)
      await q.query('UPDATE pages SET parent_id = $1 WHERE id = $2', [parentId, p.id])
      await q.query('UPDATE pages SET position = x.ord FROM unnest($1::bigint[]) WITH ORDINALITY AS x(id, ord) WHERE pages.id = x.id',
        [siblings])
      return { ok: true }
    })
    return 'error' in r ? fail(c, r.status!, r.error!) : c.json(r)
  })

  // Each deletion shows up once in the trash: the page that was deleted, not its subtree.
  app.get('/api/spaces/:id/trash', async (c) =>
    c.json(
      await all(
        `SELECT p.id, p.title, p.deleted_at AS "deletedAt" FROM pages p LEFT JOIN pages pp ON pp.id = p.parent_id
         WHERE p.space_id = $1 AND p.deleted_at IS NOT NULL AND (pp.id IS NULL OR pp.deleted_at IS DISTINCT FROM p.deleted_at)
           AND ${visible('p', 2, 3)}
         ORDER BY p.deleted_at DESC LIMIT 200`,
        [id(c), ...who(c)],
      ),
    ),
  )

  app.post('/api/pages/:id/restore', async (c) => {
    const denied = await guard(c, id(c), 'edit', true)
    if (denied) return denied
    const r = await tx(db, async (q) => {
      const p = (await q.query('SELECT p.*, pp.deleted_at AS parent_deleted FROM pages p LEFT JOIN pages pp ON pp.id = p.parent_id WHERE p.id = $1 AND p.deleted_at IS NOT NULL', [id(c)])).rows[0]
      if (!p) return false
      // Restore what was deleted together with it; if its parent is still in the trash, put it at the top level.
      await q.query(
        // Compare timestamps inside SQL: JS Dates drop the microseconds Postgres keeps.
        `WITH RECURSIVE t(id) AS (SELECT $1::bigint UNION ALL SELECT x.id FROM pages x JOIN t ON x.parent_id = t.id
           WHERE x.deleted_at = (SELECT deleted_at FROM pages WHERE id = $1))
         UPDATE pages SET deleted_at = NULL WHERE id IN (SELECT id FROM t)`,
        [p.id],
      )
      if (p.parent_deleted) await q.query('UPDATE pages SET parent_id = NULL WHERE id = $1', [p.id])
      return true
    })
    return r ? c.json({ ok: true }) : fail(c, 404, 'not_in_trash')
  })

  app.get('/api/pages/:id/comments', async (c) =>
    (await guard(c, id(c), 'view')) ??
    c.json(
      await all(
        `SELECT cm.id, cm.parent_id AS "parentId", cm.body, cm.quote, cm.resolved_at AS "resolvedAt", cm.created_at AS "createdAt",
           cm.author_id AS "authorId", u.name AS author
         FROM comments cm JOIN users u ON u.id = cm.author_id
         LEFT JOIN comments parent ON parent.id = cm.parent_id
         WHERE cm.page_id = $1 AND cm.deleted_at IS NULL AND parent.deleted_at IS NULL ORDER BY cm.id`,
        [id(c)],
      ),
    ),
  )

  app.post('/api/pages/:id/comments', async (c) => {
    const b = await c.req.json().catch(() => ({}))
    const body = str(b.body, 10000)
    if (!body) return fail(c, 400, 'empty_comment')
    const denied = await guard(c, id(c), 'view')
    if (denied) return denied
    const parentId = b.parentId == null ? null : Number(b.parentId)
    if (parentId !== null && !(await one('SELECT 1 FROM comments WHERE id = $1 AND page_id = $2 AND parent_id IS NULL AND deleted_at IS NULL', [parentId, id(c)])))
      return fail(c, 400, 'comment_not_found')
    const user = c.get('user')
    const row = await one(
      `INSERT INTO comments (page_id, parent_id, author_id, body, quote) VALUES ($1, $2, $3, $4, $5)
       RETURNING id, parent_id AS "parentId", body, quote, resolved_at AS "resolvedAt", created_at AS "createdAt", author_id AS "authorId"`,
      [id(c), parentId, user.id, body, parentId ? null : str(b.quote, 2000)],
    )
    const parentAuthor = parentId ? (await one('SELECT author_id FROM comments WHERE id = $1', [parentId]))?.author_id : null
    const pageCreator = (await one('SELECT created_by FROM pages WHERE id = $1', [id(c)]))?.created_by
    await notify(db, user.id, id(c), row.id, [
      ...[...mentionedInText(body)].map((u): [number, string] => [u, 'comment_mention']),
      ...(parentAuthor ? [[Number(parentAuthor), 'reply'] as [number, string]] : []),
      ...(pageCreator ? [[Number(pageCreator), 'comment'] as [number, string]] : []),
    ])
    hooks.emit('comment.created', id(c), user.id, { comment: { id: Number(row.id), parentId: row.parentId == null ? null : Number(row.parentId), body: row.body } })
    return c.json({ ...row, author: user.name })
  })

  app.patch('/api/comments/:id', async (c) => {
    const b = await c.req.json().catch(() => ({}))
    if (typeof b.resolved !== 'boolean') return fail(c, 400, 'bad_request')
    const cm = await one('SELECT page_id, author_id FROM comments WHERE id = $1 AND deleted_at IS NULL', [id(c)])
    // Whoever started the thread, or anyone who may edit the page, can close it; readers only read.
    const denied = !cm ? fail(c, 404, 'comment_not_found')
      : await guard(c, cm.page_id, Number(cm.author_id) === c.get('user').id ? 'view' : 'edit')
    if (denied) return denied
    const r = await db.query(
      `UPDATE comments SET resolved_at = CASE WHEN $1 THEN now() ELSE NULL END WHERE id = $2 AND parent_id IS NULL`,
      [b.resolved, id(c)],
    )
    return r.rowCount ? c.json({ ok: true }) : fail(c, 404, 'comment_not_found')
  })

  app.delete('/api/comments/:id', async (c) => {
    const user = c.get('user')
    const cm = await one('SELECT page_id FROM comments WHERE id = $1', [id(c)])
    const denied = cm ? await guard(c, cm.page_id, 'view') : fail(c, 404, 'comment_not_found')
    if (denied) return denied
    // Hidden, not erased: replies disappear with it and come back with it.
    const r = await db.query('UPDATE comments SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL AND (author_id = $2 OR $3)',
      [id(c), user.id, user.role === 'admin'])
    return r.rowCount ? c.json({ ok: true }) : fail(c, 403, 'not_comment_author')
  })

  app.post('/api/comments/:id/restore', async (c) => {
    const user = c.get('user')
    const cm = await one('SELECT page_id FROM comments WHERE id = $1', [id(c)])
    const denied = cm ? await guard(c, cm.page_id, 'view') : fail(c, 404, 'comment_not_found')
    if (denied) return denied
    const r = await db.query('UPDATE comments SET deleted_at = NULL WHERE id = $1 AND (author_id = $2 OR $3)', [id(c), user.id, user.role === 'admin'])
    return r.rowCount ? c.json({ ok: true }) : fail(c, 403, 'not_comment_author')
  })

  // Saves a page and its history. `version` is the optimistic lock (null for the live editing room, which
  // merges everyone's edits itself). Returns null when the version no longer matches.
  async function savePage(pageId: number, userId: number, title: string, doc: unknown, o: { version: number | null; checkpoint?: boolean }) {
    let newlyMentioned: number[] = []
    const r = await tx(db, async (q) => {
      // The version check and bump happen in one UPDATE, so two writers holding the same version can't both succeed.
      const up = await q.query(
        `UPDATE pages SET title = $1, doc = $2, text = $3, version = version + 1, updated_by = $4, updated_at = now()
         WHERE id = $5 AND deleted_at IS NULL AND ($6::int IS NULL OR version = $6) RETURNING version, updated_at`,
        [title, doc, docText(doc), userId, pageId, o.version],
      )
      if (!up.rowCount) return null
      const { version, updated_at } = up.rows[0]
      // The latest history row always equals the page as it was before this save.
      // Autosave fires often, so the same author's saves within 10 minutes update that row in place,
      // except when doing so could lose something: then the old row is kept and a new one starts.
      const last = (await q.query(
        `SELECT id, author_id, doc, created_at > now() - interval '10 minutes' AS recent
         FROM page_versions WHERE page_id = $1 ORDER BY id DESC LIMIT 1 FOR UPDATE`,
        [pageId],
      )).rows[0]
      const before = mentionedInDoc(last?.doc)
      newlyMentioned = [...mentionedInDoc(doc)].filter((u) => !before.has(u))
      const merge = last && !o.checkpoint && last.author_id === userId && last.recent && !losesContent(last.doc, doc)
      if (merge)
        await q.query('UPDATE page_versions SET version = $1, title = $2, doc = $3 WHERE id = $4', [version, title, doc, last.id])
      else
        await q.query('INSERT INTO page_versions (page_id, version, title, doc, author_id) VALUES ($1, $2, $3, $4, $5)',
          [pageId, version, title, doc, userId])
      return { version: version as number, updatedAt: updated_at as Date }
    })
    if (r) {
      await notify(db, userId, pageId, null, newlyMentioned.map((u) => [u, 'mention']))
      // Watchers hear about edits once until they look: no new notice while an unread one for this page waits.
      const watchers = (await db.query(
        `SELECT w.user_id FROM page_watches w WHERE w.page_id = $1 AND w.user_id <> $2 AND NOT EXISTS (
           SELECT 1 FROM notifications n WHERE n.user_id = w.user_id AND n.page_id = $1 AND n.kind = 'update' AND n.read_at IS NULL)`,
        [pageId, userId])).rows
      await notify(db, userId, pageId, null, watchers.map((w) => [w.user_id, 'update']))
      hooks.emit('page.updated', pageId, userId, { version: r.version })
    }
    return r
  }

  // One-time rebuild of search text after docText changed (formatting no longer splits words). Runs in the background.
  void (async () => {
    // Marked done only after it finished, so a crash halfway means it runs again (rebuilding twice is harmless).
    if ((await db.query(`SELECT 1 FROM settings WHERE key = 'search_text_v2'`)).rowCount) return
    for (let after = 0; ; ) {
      const rows = (await db.query('SELECT id, doc FROM pages WHERE id > $1 ORDER BY id LIMIT 200', [after])).rows
      if (!rows.length) break
      for (const r of rows) await db.query('UPDATE pages SET text = $1 WHERE id = $2', [docText(r.doc), r.id])
      after = rows[rows.length - 1].id
    }
    await db.query(`INSERT INTO settings (key, value) VALUES ('search_text_v2', 'true') ON CONFLICT DO NOTHING`)
  })().catch((e) => console.error('search text rebuild failed', e))

  const collab = createCollab({
    load: async (pageId) => (await one('SELECT title, doc, version, ydoc FROM pages WHERE id = $1 AND deleted_at IS NULL', [pageId])) ?? null,
    storeState: async (pageId, state, claim) => {
      const r = await db.query(`UPDATE pages SET ydoc = $1 WHERE id = $2${claim ? ' AND ydoc IS NULL' : ''}`, [state && Buffer.from(state), pageId])
      // A new document identity: updates relayed for the old one must never merge into it.
      if (claim && r.rowCount) await db.query('DELETE FROM collab_updates WHERE page_id = $1', [pageId])
      return !!r.rowCount
    },
    save: async (pageId, userId, title, doc, checkpoint) => {
      // Someone who lost edit rights while the room was open no longer gets their edits saved.
      const u = await one('SELECT id, role, name FROM users WHERE id = $1 AND disabled_at IS NULL', [userId])
      if (!u || (await access(pageId, u)) !== 'edit') return null
      const r = await savePage(pageId, userId, title.slice(0, 500), doc, { version: null, checkpoint })
      return r && { ...r, updatedBy: u.name }
    },
  })
  const ws = createNodeWebSocket({ app })
  app.get('/api/collab/:id', async (c, next) => {
    // Browsers send Origin on WebSocket upgrades but no CORS check applies, so refuse other sites here.
    const origin = c.req.header('origin')
    const host = c.req.header('x-forwarded-host') ?? c.req.header('host')
    try {
      if (!origin || new URL(origin).host !== host) return fail(c, 403, 'bad_origin')
    } catch {
      return fail(c, 403, 'bad_origin')
    }
    const a = await access(id(c), c.get('user'))
    if (!a) return fail(c, 404, 'page_not_found')
    return ws.upgradeWebSocket(() => collab.connect(id(c), c.get('user').id, a === 'edit', c.req.query('epoch') || undefined))(c, next)
  })

  app.put('/api/pages/:id', async (c) => {
    const b = await c.req.json().catch(() => ({}))
    const title = str(b.title, 500)
    if (!title || b.doc?.type !== 'doc' || !Number.isInteger(b.version)) return fail(c, 400, 'bad_request')
    const denied = await guard(c, id(c), 'edit')
    if (denied) return denied
    // Unsaved live edits go in first, so this save is checked against them (and gets a conflict instead of erasing them).
    await collab.flush(id(c))
    // Someone typed in the live room since the flush: replacing the content now would drop those keystrokes.
    // shortcut: a few milliseconds remain between this check and the replace below; a room-level lock would close it.
    if (collab.hasUnsaved(id(c))) {
      const cur = await livePage(id(c))
      return c.json({ error: ERRORS.conflict, code: 'conflict', version: cur?.version }, 409)
    }
    const r = await savePage(id(c), c.get('user').id, title, b.doc, { version: b.version, checkpoint: !!b.checkpoint })
    if (r) {
      await collab.replace(id(c), b.doc, title)
      return c.json(r)
    }
    const cur = await livePage(id(c))
    return cur ? c.json({ error: ERRORS.conflict, code: 'conflict', version: cur.version }, 409) : fail(c, 404, 'page_not_found')
  })

  app.delete('/api/pages/:id', async (c) => {
    const denied = await guard(c, id(c), 'edit')
    if (denied) return denied
    const user = c.get('user')
    // Check and delete together, with the page locked, so a move or a restriction change can't slip in between.
    const r = await tx(db, async (q) => {
      if (!(await q.query('SELECT 1 FROM pages WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [id(c)])).rowCount) return { rowCount: 0, blocked: false }
      if (user.role !== 'admin') {
        const blocked = await q.query(
          `WITH RECURSIVE t(id) AS (SELECT $1::bigint UNION ALL SELECT p.id FROM pages p JOIN t ON p.parent_id = t.id WHERE p.deleted_at IS NULL)
           SELECT 1 FROM t WHERE page_access(t.id, $2) IS DISTINCT FROM 'edit' LIMIT 1`,
          [id(c), user.id],
        )
        if (blocked.rowCount) return { rowCount: 0, blocked: true }
      }
      // Soft delete the whole subtree so nothing is orphaned and it stays recoverable.
      const u = await q.query(
        `WITH RECURSIVE t(id) AS (
           SELECT id FROM pages WHERE id = $1 AND deleted_at IS NULL
           UNION ALL SELECT p.id FROM pages p JOIN t ON p.parent_id = t.id WHERE p.deleted_at IS NULL)
         UPDATE pages SET deleted_at = now() WHERE id IN (SELECT id FROM t)`,
        [id(c)],
      )
      return { rowCount: u.rowCount ?? 0, blocked: false }
    })
    if (r.blocked) return fail(c, 403, 'delete_blocked')
    if (r.rowCount) hooks.emit('page.deleted', id(c), user.id, { pagesDeleted: r.rowCount })
    return r.rowCount ? c.json({ ok: true }) : fail(c, 404, 'page_not_found')
  })

  app.get('/api/pages/:id/versions', async (c) =>
    (await guard(c, id(c), 'view')) ??
    c.json(
      await all(
        `SELECT v.id, v.version, v.title, v.created_at AS "createdAt", u.name AS author
         FROM page_versions v JOIN users u ON u.id = v.author_id WHERE v.page_id = $1 ORDER BY v.id DESC LIMIT 100`,
        [id(c)],
      ),
    ),
  )

  app.get('/api/versions/:id', async (c) => {
    const v = await one('SELECT page_id, title, doc FROM page_versions WHERE id = $1', [id(c)])
    if (!v) return fail(c, 404, 'version_not_found')
    return (await guard(c, v.page_id, 'view')) ?? c.json({ title: v.title, doc: v.doc })
  })

  app.post('/api/pages/:id/attachments', async (c) => {
    const p = await livePage(id(c))
    if (!p) return fail(c, 404, 'page_not_found')
    const denied = await guard(c, p.id, 'edit')
    if (denied) return denied
    const file = (await c.req.parseBody()).file
    if (!(file instanceof File)) return fail(c, 400, 'file_required')
    if (!(await uploadAllowed(db, file.size))) return fail(c, 413, 'storage_full')
    const buf = Buffer.from(await file.arrayBuffer())
    const hash = storeFile(buf)
    const name = file.name.slice(0, 255) || 'file'
    const mime = file.type || 'application/octet-stream'
    const row = await one(
      'INSERT INTO attachments (page_id, name, mime, size, sha256, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
      [p.id, name, mime, buf.length, hash, c.get('user').id],
    )
    return c.json({ id: row.id, name, mime, url: `/api/files/${row.id}` })
  })

  app.get('/api/files/:id', async (c) => {
    const user = c.get('user')
    // Files follow their page's restrictions, including pages in the trash.
    const a = await one(
      'SELECT a.* FROM attachments a WHERE a.id = $1 AND ($2 OR a.page_id NOT IN (SELECT id FROM hidden_pages($3)))',
      [id(c), user.role === 'admin', user.id],
    )
    if (!a) return fail(c, 404, 'file_not_found')
    // Only raster images render in the browser; everything else (html, svg, ...) downloads,
    // so an uploaded file can never run script on this origin.
    const inline = INLINE_MIME.includes(a.mime)
    // Content never changes for a given hash, so the hash is a perfect ETag.
    const etag = `"${a.sha256}"`
    if (c.req.header('if-none-match') === etag) return c.body(null, 304)
    const path = join(filesDir, a.sha256)
    if (!existsSync(path)) return fail(c, 404, 'file_not_found')
    // Streamed, so a 50 MB download doesn't sit in memory.
    return new Response(Readable.toWeb(createReadStream(path)) as ReadableStream, {
      headers: {
        ETag: etag,
        'Content-Length': String(a.size),
        // Opened directly, a file is inert: no scripts, no plugins, no framing, no network.
        'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
        'Cross-Origin-Resource-Policy': 'same-origin',
        'Content-Type': inline ? a.mime : 'application/octet-stream',
        'Content-Disposition': inline ? 'inline' : `attachment; filename*=UTF-8''${encodeURIComponent(a.name)}`,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, max-age=31536000, immutable',
      },
    })
  })

  // Everyone signed in can pick teammates for restrictions and mentions.
  app.get('/api/users', async (c) =>
    c.json(await all('SELECT id, name, email FROM users WHERE disabled_at IS NULL ORDER BY name')),
  )

  app.get('/api/pages/:id/restrictions', async (c) => {
    const denied = await guard(c, id(c), 'view')
    if (denied) return denied
    const entries = await all(
      `SELECT r.user_id AS "userId", r.group_id AS "groupId", r.level, coalesce(u.name, g.name) AS name, u.email
       FROM page_restrictions r LEFT JOIN users u ON u.id = r.user_id LEFT JOIN groups g ON g.id = r.group_id
       WHERE r.page_id = $1 ORDER BY r.group_id IS NULL, coalesce(u.name, g.name)`,
      [id(c)],
    )
    // Restricted pages above this one, which also limit who gets here.
    const inherited = await all(
      `WITH RECURSIVE a(id, parent_id, title, depth) AS (
         SELECT id, parent_id, title, 0 FROM pages WHERE id = $1
         UNION ALL SELECT p.id, p.parent_id, p.title, a.depth + 1 FROM pages p JOIN a ON p.id = a.parent_id)
       SELECT a.id, a.title FROM a WHERE a.depth > 0 AND EXISTS (SELECT 1 FROM page_restrictions r WHERE r.page_id = a.id)
       ORDER BY a.depth DESC`,
      [id(c)],
    )
    return c.json({ entries, inherited })
  })

  app.put('/api/pages/:id/restrictions', async (c) => {
    const denied = await guard(c, id(c), 'edit')
    if (denied) return denied
    const b = await c.req.json().catch(() => ({}))
    if (!Array.isArray(b.entries) || b.entries.length > 1000) return fail(c, 400, 'bad_request')
    const user = c.get('user')
    const map = new Map<number, 'view' | 'edit'>()
    const groups = new Map<number, 'view' | 'edit'>()
    for (const e of b.entries) {
      if (!['view', 'edit'].includes(e?.level) || Number.isInteger(e?.userId) === Number.isInteger(e?.groupId)) return fail(c, 400, 'bad_request')
      if (e.groupId) groups.set(e.groupId, e.level)
      else map.set(e.userId, e.level)
    }
    // Whoever restricts a page keeps edit on it, so nobody locks themselves out by accident.
    if ((map.size || groups.size) && user.role !== 'admin') map.set(user.id, 'edit')
    const ids = [...map.keys()]
    const gids = [...groups.keys()]
    if (ids.length && (await all('SELECT id FROM users WHERE id = ANY($1::bigint[])', [ids])).length !== ids.length) return fail(c, 400, 'user_not_found')
    if (gids.length && (await all('SELECT id FROM groups WHERE id = ANY($1::bigint[])', [gids])).length !== gids.length) return fail(c, 400, 'group_not_found')
    await tx(db, async (q) => {
      await q.query('DELETE FROM page_restrictions WHERE page_id = $1', [id(c)])
      await q.query(
        `INSERT INTO page_restrictions (page_id, user_id, group_id, level)
         SELECT $1::bigint, u, NULL::bigint, l FROM unnest($2::bigint[], $3::text[]) AS x(u, l)
         UNION ALL SELECT $1::bigint, NULL::bigint, g, l FROM unnest($4::bigint[], $5::text[]) AS y(g, l)`,
        [id(c), ids, ids.map((i) => map.get(i)), gids, gids.map((i) => groups.get(i))],
      )
    })
    return c.json({ ok: true, restricted: ids.length + gids.length > 0 })
  })

  // Search: every word must appear (in the title, or anywhere with scope=all).
  // Filters: space, author (last editor), updated within N days. Sort: relevance (title hits first) or recent.
  app.get('/api/search', async (c) => {
    const qp = (k: string) => c.req.query(k)?.trim() ?? ''
    const q = qp('q').slice(0, 200)
    const terms = [...new Set(q.split(/\s+/).filter(Boolean))].slice(0, 8)
    const label = normLabel(qp('label'))
    if (!terms.length && !label) return c.json({ total: 0, results: [] })
    const limit = Math.min(Math.max(Number(qp('limit')) || 20, 1), 50)
    const offset = Math.min(Math.max(Number(qp('offset')) || 0, 0), 10_000)
    const titleOnly = qp('scope') === 'title'
    const params: unknown[] = [...who(c)]
    const add = (v: unknown) => (params.push(v), `$${params.length}`)
    const where = [`p.deleted_at IS NULL`, `p.kind = 'page'`, visible('p', 1, 2)]
    for (const term of terms) {
      const stem = koreanStem(term)
      const like = add(`%${stem.replace(/[\\%_]/g, '\\$&')}%`)
      // Hangul pairs narrow through their index first: pg_trgm's can't serve a two-syllable word like "배포".
      const grams = hangulBigrams(stem)
      const has = (alias: string) => (grams.length ? `${alias}.grams @> ${add(grams)}::text[] AND ` : '')
      // Body searches also look in comments and attachment names.
      where.push(titleOnly ? `(${has('p')}p.title ILIKE ${like})` : `p.id IN (
        SELECT x.id FROM pages x WHERE ${has('x')}(x.title ILIKE ${like} OR x.text ILIKE ${like})
        UNION SELECT cm.page_id FROM comments cm WHERE ${has('cm')}cm.deleted_at IS NULL AND cm.body ILIKE ${like}
        UNION SELECT at.page_id FROM attachments at WHERE at.name ILIKE ${like})`)
    }
    if (/^\d+$/.test(qp('space'))) where.push(`p.space_id = ${add(Number(qp('space')))}`)
    if (/^\d+$/.test(qp('author'))) where.push(`p.updated_by = ${add(Number(qp('author')))}`)
    if (/^\d+$/.test(qp('days'))) where.push(`p.updated_at > now() - make_interval(days => ${add(Number(qp('days')))})`)
    if (label) where.push(`EXISTS (SELECT 1 FROM page_labels l WHERE l.page_id = p.id AND l.label = ${add(label)})`)
    const filter = where.join(' AND ')
    const filterParams = [...params]
    // Relevance: the whole query in the title, then every word in the title, then title similarity, then recency.
    // A label alone lists its pages, newest first.
    const order = qp('sort') === 'recent' || !terms.length
      ? 'p.updated_at DESC'
      : `(p.title ILIKE ${add(`%${q.replace(/[\\%_]/g, '\\$&')}%`)}) DESC, (${terms.map((term) => `p.title ILIKE ${add(`%${term.replace(/[\\%_]/g, '\\$&')}%`)}`).join(' AND ')}) DESC, similarity(p.title, ${add(q)}) DESC, p.updated_at DESC`
    const [{ total }] = await all(`SELECT count(*)::int AS total FROM pages p WHERE ${filter}`, filterParams)
    const rows = await all(
      `SELECT p.id, p.title, p.text, p.updated_at AS "updatedAt", u.name AS "updatedBy", s.name AS space, p.space_id AS "spaceId", p.parent_id
       FROM pages p JOIN users u ON u.id = p.updated_by JOIN spaces s ON s.id = p.space_id
       WHERE ${filter} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`,
      params,
    )
    // Breadcrumb for every result in one query.
    const paths = new Map<number, string[]>()
    if (rows.length) {
      const anc = await all(
        `WITH RECURSIVE a(root, id, parent_id, title, depth) AS (
           SELECT p.id, p.id, p.parent_id, p.title, 0 FROM pages p WHERE p.id = ANY($1::bigint[])
           UNION ALL SELECT a.root, x.id, x.parent_id, x.title, a.depth + 1 FROM pages x JOIN a ON x.id = a.parent_id)
         SELECT root, title FROM a WHERE depth > 0 ORDER BY root, depth DESC`,
        [rows.map((r) => r.id)],
      )
      for (const r of anc) paths.set(r.root, [...(paths.get(r.root) ?? []), r.title])
    }
    return c.json({
      total,
      results: rows.map((r) => ({
        id: r.id, title: r.title, snippet: terms.length ? snippet(r.text, terms.map(koreanStem).find((term) => r.text.toLowerCase().includes(term.toLowerCase())) ?? koreanStem(terms[0])) : r.text.slice(0, 160),
        updatedAt: r.updatedAt, updatedBy: r.updatedBy, space: r.space, spaceId: r.spaceId, path: paths.get(r.id) ?? [],
      })),
    })
  })

  registerMcp(app)
  registerPreview(app, fail)
  registerAdmin(app, { db, filesDir, fail, collab })
  registerAudit(app, db)
  registerSsoAdmin(app, sso)
  hooks.register(app, fail)
  registerPeople(app, { db, fail, visibleFor: (c) => ({ sql: (alias, first) => visible(alias, first, first + 1), params: who(c) }) })
  registerExport(app, {
    db, filesDir, fail, guard,
    visibleFor: (c) => ({ sql: (alias, first) => visible(alias, first, first + 1), params: who(c) }),
  })

  return Object.assign(app, { injectWebSocket: ws.injectWebSocket, collab, webhooks: hooks })
}
