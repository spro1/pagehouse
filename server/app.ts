import { Hono, type Context } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { bodyLimit } from 'hono/body-limit'
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import { compress } from 'hono/compress'
import { secureHeaders } from 'hono/secure-headers'
import { join } from 'node:path'
import { tx, type Db } from './db.ts'
import { registerAdmin, uploadAllowed } from './admin.ts'
import { registerExport } from './export.ts'
import { oidcConfig, registerSso } from './sso.ts'
import { createCollab } from './collab.ts'
import { createNodeWebSocket } from '@hono/node-ws'
import { mentionedInDoc, mentionedInText, notify, registerPeople } from './people.ts'

type User = { id: number; email: string; name: string; role: string; locale: string | null; theme: string | null }
const LOCALES = ['en', 'ko']
type Env = { Variables: { user: User } }
const SESSION_DAYS = 30
const INLINE_MIME = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
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
  use_sso: 'Sign in with single sign-on.',
} as const
type ErrorCode = keyof typeof ERRORS
const fail = (c: Context, status: 400 | 401 | 403 | 404 | 409 | 413 | 429, code: string) =>
  c.json({ error: ERRORS[code as ErrorCode] ?? code, code }, status)

const sha256 = (v: string | Buffer) => createHash('sha256').update(v).digest('hex')

function hashPassword(password: string, salt = randomBytes(16).toString('hex')) {
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`
}
function checkPassword(password: string, stored: string) {
  const [salt, hash] = stored.split(':')
  if (!hash) return false // SSO-only account
  return timingSafeEqual(scryptSync(password, salt, 64), Buffer.from(hash, 'hex'))
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

  app.get('/healthz', async (c) => {
    try {
      await db.query('SELECT 1')
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

  // Sign-in throttling: 10 failures per account per address, or 50 per address, in 15 minutes.
  // shortcut: kept in memory, so it resets on restart and is per process; enough for a single-instance wiki.
  const failures = new Map<string, number[]>()
  const WINDOW = 15 * 60 * 1000
  const clientIp = (c: Context) =>
    c.req.header('x-forwarded-for')?.split(',')[0].trim() || (c.env as any)?.incoming?.socket?.remoteAddress || 'local'
  const recent = (key: string) => (failures.get(key) ?? []).filter((t) => Date.now() - t < WINDOW)
  const throttled = (c: Context, account: string) => {
    const ip = clientIp(c)
    return recent(`${ip}|${account}`).length >= 10 || recent(ip).length >= 50
  }
  const failed = (c: Context, account: string) => {
    const ip = clientIp(c)
    for (const k of [`${ip}|${account}`, ip]) failures.set(k, [...recent(k), Date.now()])
    if (failures.size > 10_000) for (const [k] of failures) if (!recent(k).length) failures.delete(k)
  }
  const tooMany = (c: Context) => (c.header('Retry-After', '900'), fail(c, 429, 'too_many_attempts'))

  async function startSession(c: Context, userId: number) {
    const token = randomBytes(32).toString('hex')
    await db.query(`INSERT INTO sessions VALUES ($1, $2, now() + interval '${SESSION_DAYS} days')`, [sha256(token), userId])
    setCookie(c, 'sid', token, {
      httpOnly: true, sameSite: 'Lax', path: '/', maxAge: SESSION_DAYS * 86400,
      // Many internal installs run on plain http; a Secure cookie would never come back there.
      secure: new URL(c.req.url).protocol === 'https:' || c.req.header('x-forwarded-proto') === 'https',
    })
  }

  const sso = oidcConfig()
  if (sso) registerSso(app, db, sso, startSession)

  const liveInvite = (token: unknown) =>
    typeof token === 'string' && token
      ? one('SELECT purpose FROM invites WHERE token_hash = $1 AND used_by IS NULL AND expires_at > now()', [sha256(token)])
      : Promise.resolve(undefined)

  app.get('/api/auth/status', async (c) =>
    c.json({
      needsSetup: !(await one('SELECT 1 FROM users LIMIT 1')),
      signupOpen: process.env.ALLOW_SIGNUP === '1',
      sso: sso?.label ?? null,
      passwordLogin: !sso || process.env.PASSWORD_LOGIN !== '0',
      link: (await liveInvite(c.req.query('token')))?.purpose ?? null,
    }),
  )

  app.post('/api/auth/register', async (c) => {
    const b = await c.req.json().catch(() => ({}))
    const email = str(b.email, 200)?.toLowerCase()
    const name = str(b.name, 100)
    if (!email || !/^\S+@\S+\.\S+$/.test(email) || !name || typeof b.password !== 'string' || b.password.length < 8)
      return fail(c, 400, 'invalid_signup')
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
    if (!row || typeof b.password !== 'string' || !checkPassword(b.password, row.password_hash)) {
      failed(c, email)
      return fail(c, 401, 'bad_credentials')
    }
    if (row.disabled_at) return fail(c, 403, 'account_disabled')
    if (sso && process.env.PASSWORD_LOGIN === '0' && row.role !== 'admin') return fail(c, 403, 'use_sso')
    await startSession(c, row.id)
    return c.json({ id: row.id, email: row.email, name: row.name, role: row.role, locale: row.locale, theme: row.theme })
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
      await q.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, inv.user_id])
      await q.query('UPDATE invites SET used_by = $1 WHERE token_hash = $2', [inv.user_id, inv.token_hash])
      await q.query('DELETE FROM sessions WHERE user_id = $1', [inv.user_id])
      return inv.user_id as number
    })
    if (!userId) return failed(c, 'reset'), fail(c, 403, 'reset_invalid')
    const u = await one('SELECT id, email, name, role, locale, disabled_at FROM users WHERE id = $1', [userId])
    if (u.disabled_at) return fail(c, 403, 'account_disabled')
    await startSession(c, userId)
    return c.json({ id: u.id, email: u.email, name: u.name, role: u.role, locale: u.locale })
  })

  app.post('/api/auth/logout', async (c) => {
    const token = getCookie(c, 'sid')
    if (token) await db.query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)])
    deleteCookie(c, 'sid', { path: '/' })
    return c.json({ ok: true })
  })

  // Everything below requires a session.
  app.use('/api/*', async (c, next) => {
    if (c.req.path.startsWith('/api/auth/')) return next()
    const token = getCookie(c, 'sid')
    const user = token
      ? await one(
          `SELECT u.id, u.email, u.name, u.role, u.locale, u.theme FROM sessions s JOIN users u ON u.id = s.user_id
           WHERE s.token_hash = $1 AND s.expires_at > now() AND u.disabled_at IS NULL`,
          [sha256(token)],
        )
      : undefined
    if (!user) return fail(c, 401, 'login_required')
    c.set('user', user)
    if (c.req.path.startsWith('/api/admin/') && user.role !== 'admin') return fail(c, 403, 'admin_only')
    return next()
  })

  app.get('/api/me', (c) => c.json(c.get('user')))

  app.patch('/api/me', async (c) => {
    const b = await c.req.json().catch(() => ({}))
    const locale = b.locale === undefined ? undefined : LOCALES.includes(b.locale) ? b.locale : null
    const theme = b.theme === undefined ? undefined : ['system', 'light', 'dark'].includes(b.theme) ? b.theme : null
    if (locale === null || theme === null || (locale === undefined && theme === undefined)) return fail(c, 400, 'bad_request')
    await db.query('UPDATE users SET locale = coalesce($1, locale), theme = coalesce($2, theme) WHERE id = $3', [locale ?? null, theme ?? null, c.get('user').id])
    return c.json({ ...c.get('user'), ...(locale && { locale }), ...(theme && { theme }) })
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
    await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hashPassword(b.next), user.id])
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
        `SELECT p.id, p.parent_id AS "parentId", p.kind, p.title,
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
    return c.json({ id: row.id, parentId, kind, title })
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
      restricted: !!(await one(
        `WITH RECURSIVE path(id, parent_id) AS (SELECT id, parent_id FROM pages WHERE id = $1
           UNION ALL SELECT x.id, x.parent_id FROM pages x JOIN path ON x.id = path.parent_id)
         SELECT 1 FROM page_restrictions r JOIN path ON r.page_id = path.id LIMIT 1`,
        [p.id],
      )),
    })
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
    return c.json({ ...row, author: user.name })
  })

  app.patch('/api/comments/:id', async (c) => {
    const b = await c.req.json().catch(() => ({}))
    if (typeof b.resolved !== 'boolean') return fail(c, 400, 'bad_request')
    const cm = await one('SELECT page_id FROM comments WHERE id = $1 AND deleted_at IS NULL', [id(c)])
    const denied = cm ? await guard(c, cm.page_id, 'view') : fail(c, 404, 'comment_not_found')
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
    if (r) await notify(db, userId, pageId, null, newlyMentioned.map((u) => [u, 'mention']))
    return r
  }

  // One-time rebuild of search text after docText changed (formatting no longer splits words). Runs in the background.
  void (async () => {
    const claimed = await db.query(`INSERT INTO settings (key, value) VALUES ('search_text_v2', 'true') ON CONFLICT DO NOTHING`)
    if (!claimed.rowCount) return
    for (let after = 0; ; ) {
      const rows = (await db.query('SELECT id, doc FROM pages WHERE id > $1 ORDER BY id LIMIT 200', [after])).rows
      if (!rows.length) break
      for (const r of rows) await db.query('UPDATE pages SET text = $1 WHERE id = $2', [docText(r.doc), r.id])
      after = rows[rows.length - 1].id
    }
  })().catch((e) => console.error('search text rebuild failed', e))

  const collab = createCollab({
    load: async (pageId) => (await one('SELECT title, doc FROM pages WHERE id = $1 AND deleted_at IS NULL', [pageId])) ?? null,
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
    return ws.upgradeWebSocket(() => collab.connect(id(c), c.get('user').id, a === 'edit'))(c, next)
  })

  app.put('/api/pages/:id', async (c) => {
    const b = await c.req.json().catch(() => ({}))
    const title = str(b.title, 500)
    if (!title || b.doc?.type !== 'doc' || !Number.isInteger(b.version)) return fail(c, 400, 'bad_request')
    const denied = await guard(c, id(c), 'edit')
    if (denied) return denied
    // Unsaved live edits go in first, so this save is checked against them (and gets a conflict instead of erasing them).
    await collab.flush(id(c))
    const r = await savePage(id(c), c.get('user').id, title, b.doc, { version: b.version, checkpoint: !!b.checkpoint })
    if (r) {
      collab.replace(id(c), b.doc, title)
      return c.json(r)
    }
    const cur = await livePage(id(c))
    return cur ? c.json({ error: ERRORS.conflict, code: 'conflict', version: cur.version }, 409) : fail(c, 404, 'page_not_found')
  })

  app.delete('/api/pages/:id', async (c) => {
    const denied = await guard(c, id(c), 'edit')
    if (denied) return denied
    const user = c.get('user')
    if (user.role !== 'admin') {
      const blocked = await one(
        `WITH RECURSIVE t(id) AS (SELECT $1::bigint UNION ALL SELECT p.id FROM pages p JOIN t ON p.parent_id = t.id WHERE p.deleted_at IS NULL)
         SELECT 1 FROM t WHERE page_access(t.id, $2) IS DISTINCT FROM 'edit' LIMIT 1`,
        [id(c), user.id],
      )
      if (blocked) return fail(c, 403, 'delete_blocked')
    }
    // Soft delete the whole subtree so nothing is orphaned and it stays recoverable.
    const r = await db.query(
      `WITH RECURSIVE t(id) AS (
         SELECT id FROM pages WHERE id = $1 AND deleted_at IS NULL
         UNION ALL SELECT p.id FROM pages p JOIN t ON p.parent_id = t.id WHERE p.deleted_at IS NULL)
       UPDATE pages SET deleted_at = now() WHERE id IN (SELECT id FROM t)`,
      [id(c)],
    )
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
    const hash = sha256(buf)
    const path = join(filesDir, hash)
    if (!existsSync(path)) writeFileSync(path, buf)
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
    if (!terms.length) return c.json({ total: 0, results: [] })
    const limit = Math.min(Math.max(Number(qp('limit')) || 20, 1), 50)
    const offset = Math.min(Math.max(Number(qp('offset')) || 0, 0), 10_000)
    const titleOnly = qp('scope') === 'title'
    const params: unknown[] = [...who(c)]
    const add = (v: unknown) => (params.push(v), `$${params.length}`)
    const where = [`p.deleted_at IS NULL`, `p.kind = 'page'`, visible('p', 1, 2)]
    for (const term of terms) {
      const like = add(`%${term.replace(/[\\%_]/g, '\\$&')}%`)
      where.push(titleOnly ? `p.title ILIKE ${like}` : `(p.title ILIKE ${like} OR p.text ILIKE ${like})`)
    }
    if (/^\d+$/.test(qp('space'))) where.push(`p.space_id = ${add(Number(qp('space')))}`)
    if (/^\d+$/.test(qp('author'))) where.push(`p.updated_by = ${add(Number(qp('author')))}`)
    if (/^\d+$/.test(qp('days'))) where.push(`p.updated_at > now() - make_interval(days => ${add(Number(qp('days')))})`)
    const filter = where.join(' AND ')
    const filterParams = [...params]
    // Relevance: the whole query in the title, then every word in the title, then title similarity, then recency.
    const whole = add(`%${q.replace(/[\\%_]/g, '\\$&')}%`)
    const titleTerms = terms.map((term) => `p.title ILIKE ${add(`%${term.replace(/[\\%_]/g, '\\$&')}%`)}`).join(' AND ')
    const qRaw = add(q)
    const order = qp('sort') === 'recent'
      ? 'p.updated_at DESC'
      : `(p.title ILIKE ${whole}) DESC, (${titleTerms}) DESC, similarity(p.title, ${qRaw}) DESC, p.updated_at DESC`
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
        id: r.id, title: r.title, snippet: snippet(r.text, terms.find((term) => r.text.toLowerCase().includes(term.toLowerCase())) ?? terms[0]),
        updatedAt: r.updatedAt, updatedBy: r.updatedBy, space: r.space, spaceId: r.spaceId, path: paths.get(r.id) ?? [],
      })),
    })
  })

  registerAdmin(app, { db, filesDir, fail })
  registerPeople(app, { db, fail, visibleFor: (c) => ({ sql: (alias, first) => visible(alias, first, first + 1), params: who(c) }) })
  registerExport(app, {
    db, filesDir, fail, guard,
    visibleFor: (c) => ({ sql: (alias, first) => visible(alias, first, first + 1), params: who(c) }),
  })

  return Object.assign(app, { injectWebSocket: ws.injectWebSocket, collab })
}
