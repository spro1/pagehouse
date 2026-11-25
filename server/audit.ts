// Audit log: sign-ins, account and permission changes, deletions and exports. One middleware records them by route,
// so handlers stay as they are. Request bodies are kept for admin and permission changes (never for sign-in or
// password routes), so an admin can see what was changed, not only that something was.
import type { Context, Hono, MiddlewareHandler } from 'hono'
import { createHash } from 'node:crypto'
import type { Db } from './db.ts'

// [method, path, action, keep the request body]. A number in the path is the target.
const RULES: [string, RegExp, string, boolean][] = [
  ['POST', /^\/api\/auth\/login$/, 'auth.login', false],
  ['GET', /^\/api\/auth\/oidc\/callback$/, 'auth.sso', false],
  ['POST', /^\/api\/auth\/register$/, 'auth.register', false],
  ['POST', /^\/api\/auth\/reset$/, 'auth.reset', false],
  ['POST', /^\/api\/me\/password$/, 'user.password', false],
  ['POST', /^\/api\/me\/tokens$/, 'token.create', false],
  ['DELETE', /^\/api\/me\/tokens\/(\d+)$/, 'token.revoke', false],
  ['PATCH', /^\/api\/admin\/users\/(\d+)$/, 'user.update', true],
  ['POST', /^\/api\/admin\/users\/(\d+)\/reset-link$/, 'user.reset_link', false],
  ['POST', /^\/api\/admin\/users\/(\d+)\/temp-password$/, 'user.temp_password', false],
  ['POST', /^\/api\/auth\/forgot$/, 'auth.forgot', false],
  ['POST', /^\/api\/admin\/invites$/, 'user.invite', true],
  ['PUT', /^\/api\/admin\/settings$/, 'settings.update', true],
  // The body holds the client secret: record that SSO changed, not the values.
  ['PUT', /^\/api\/admin\/sso$/, 'settings.sso', false],
  ['POST', /^\/api\/admin\/groups$/, 'group.create', true],
  ['PUT', /^\/api\/admin\/groups\/(\d+)$/, 'group.update', true],
  ['DELETE', /^\/api\/admin\/groups\/(\d+)$/, 'group.delete', false],
  ['POST', /^\/api\/spaces$/, 'space.create', true],
  ['PUT', /^\/api\/spaces\/(\d+)\/settings$/, 'space.settings', true],
  ['GET', /^\/api\/spaces\/(\d+)\/export$/, 'space.export', false],
  ['PUT', /^\/api\/pages\/(\d+)\/restrictions$/, 'page.restrictions', true],
  ['DELETE', /^\/api\/pages\/(\d+)$/, 'page.delete', false],
  ['POST', /^\/api\/pages\/(\d+)\/restore$/, 'page.restore', false],
  ['POST', /^\/api\/pages\/(\d+)\/move$/, 'page.move', true],
  ['GET', /^\/api\/pages\/(\d+)\/export$/, 'page.export', false],
]
export const AUDIT_ACTIONS = RULES.map((r) => r[2])

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

export function auditMiddleware(db: Db, clientIp: (c: Context) => string): MiddlewareHandler {
  return async (c, next) => {
    const rule = RULES.find(([m, re]) => m === c.req.method && re.test(c.req.path))
    if (!rule) return next()
    const [, re, action, keepBody] = rule
    const json = keepBody || action === 'auth.login' ? await c.req.raw.clone().json().catch(() => null) : null
    await next()
    // SSO answers with a redirect either way; a refusal carries ?sso_error=… in it.
    const ssoError = action === 'auth.sso' ? c.res.headers.get('location')?.match(/sso_error=(\w+)/)?.[1] : undefined
    const ok = c.res.status < 400 && !ssoError
    // Before sign-in there's no user yet; the session cookie the response sets tells who signed in.
    let actor: number | null = (c.get('user') as { id: number } | undefined)?.id ?? null
    const sid = c.res.headers.getSetCookie().find((h) => h.startsWith('sid='))?.slice(4).split(';')[0]
    if (!actor && sid) actor = (await db.query('SELECT user_id FROM sessions WHERE token_hash = $1', [sha256(sid)])).rows[0]?.user_id ?? null
    const detail: Record<string, unknown> = {}
    if (keepBody && json) detail.body = json
    if (action === 'auth.login' && json) detail.email = String(json.email ?? '').slice(0, 200)
    if (!ok) detail.status = c.res.status
    if (ssoError) detail.error = ssoError
    const text = JSON.stringify(detail)
    await db.query('INSERT INTO audit_log (actor_id, action, target_id, ok, ip, detail) VALUES ($1, $2, $3, $4, $5, $6)', [
      actor, action, Number(c.req.path.match(re)?.[1]) || null, ok, clientIp(c),
      text === '{}' ? null : text.length > 8000 ? { truncated: true, status: detail.status } : detail,
    ]).catch((e) => console.error('audit:', e.message))
  }
}

export function registerAudit(app: Hono<any>, db: Db) {
  // Newest first, 100 at a time; `before` pages back.
  app.get('/api/admin/audit', async (c) => {
    const q = c.req.query()
    const params: unknown[] = []
    const where: string[] = []
    if (/^\d+$/.test(q.before ?? '')) (params.push(Number(q.before)), where.push(`a.id < $${params.length}`))
    if (AUDIT_ACTIONS.includes(q.action ?? '')) (params.push(q.action), where.push(`a.action = $${params.length}`))
    if (/^\d+$/.test(q.actor ?? '')) (params.push(Number(q.actor)), where.push(`a.actor_id = $${params.length}`))
    const rows = (await db.query(
      `SELECT a.*, u.name AS actor_name,
         CASE split_part(a.action, '.', 1)
           WHEN 'page' THEN (SELECT title FROM pages WHERE id = a.target_id)
           WHEN 'space' THEN (SELECT name FROM spaces WHERE id = a.target_id)
           WHEN 'group' THEN (SELECT name FROM groups WHERE id = a.target_id)
           WHEN 'user' THEN (SELECT name FROM users WHERE id = a.target_id) END AS target_name
       FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY a.id DESC LIMIT 100`,
      params,
    )).rows
    return c.json(rows.map((r) => ({
      id: r.id, at: r.at, action: r.action, ok: r.ok, ip: r.ip, detail: r.detail,
      actor: r.actor_id ? { id: r.actor_id, name: r.actor_name } : null,
      target: r.target_id ? { id: r.target_id, name: r.target_name } : null,
    })))
  })
}
