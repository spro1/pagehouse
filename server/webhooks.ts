// Webhooks, two kinds:
// - Admin → Webhooks: page and comment events sent as signed JSON to another system (a callback).
// - Settings → Notifications: a person's own notifications posted to a chat webhook (Slack, Mattermost, Teams, ...).
// Pages with restrictions (or under a restricted page) are never sent anywhere.
import type { Context, Hono } from 'hono'
import http from 'node:http'
import https from 'node:https'
import { isIP } from 'node:net'
import { createHmac, randomBytes } from 'node:crypto'
import type { Db } from './db.ts'
import { guardedLookup, privateAddress } from './preview.ts'
import { openSecret, sealSecret } from './sso.ts'
import { TEXT } from './mail.ts'
import { inc } from './metrics.ts'

const MAX_ATTEMPTS = 5

export const EVENTS = ['page.created', 'page.updated', 'page.deleted', 'comment.created'] as const
type Event = (typeof EVENTS)[number]

const base = () => process.env.PUBLIC_URL?.replace(/\/$/, '') ?? ''
const pageUrl = (id: number) => (base() ? `${base()}/#/p/${id}` : `/#/p/${id}`)

// Hosts on the private network that personal webhooks may reach (e.g. "chat.corp.local,.corp.local").
const allowed = (host: string) =>
  (process.env.WEBHOOK_ALLOW ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    .some((a) => (a.startsWith('.') ? host.endsWith(a) || host === a.slice(1) : host === a))

export function httpUrl(v: unknown): string | null {
  try {
    const u = new URL(String(v))
    return /^https?:$/.test(u.protocol) && !u.username && !u.password && String(v).length <= 2000 ? u.toString() : null
  } catch {
    return null
  }
}

/** POSTs JSON and resolves with the status code. Redirects are not followed. With `guard`, private addresses are
 *  refused unless WEBHOOK_ALLOW lists the host (any user can set a personal webhook; only admins set the others). */
export function postJson(url: string, body: string, headers: Record<string, string>, guard: boolean): Promise<number> {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const trusted = !guard || allowed(u.hostname.toLowerCase())
    const literal = u.hostname.replace(/^\[|\]$/g, '')
    if (isIP(literal) && !trusted && privateAddress(literal)) return reject(new Error('private address'))
    const req = (u.protocol === 'https:' ? https : http).request(u, {
      method: 'POST',
      timeout: 10_000,
      lookup: guardedLookup(trusted),
      headers: { 'content-type': 'application/json', 'user-agent': 'Pagehouse webhook', 'content-length': String(Buffer.byteLength(body)), ...headers },
    }, (res) => (res.resume(), resolve(res.statusCode ?? 0)))
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', reject)
    req.end(body)
  })
}

/** A chat message: `text` for Slack, Mattermost, Teams, Google Chat, Rocket.Chat; `content` for Discord. */
const chat = (text: string, extra: object) => JSON.stringify({ text, content: text, ...extra })

/** Posts each new notification to its owner's webhook, if they set one. Runs on every instance; rows are claimed. */
export function startPersonalHooks(db: Db) {
  let running = false
  const tick = async () => {
    if (running) return
    running = true
    try {
      // Until the backlog is empty, 200 at a time.
      for (let more = true; more; ) {
      const rows = (await db.query(
        `UPDATE notifications n SET hooked_at = now() FROM users u
         WHERE n.id IN (SELECT id FROM notifications WHERE hooked_at IS NULL ORDER BY id LIMIT 200 FOR UPDATE SKIP LOCKED) AND u.id = n.user_id
         RETURNING n.kind, n.page_id, u.id AS user_id, u.webhook_url, u.locale,
           (SELECT title FROM pages WHERE id = n.page_id) AS page, (SELECT name FROM users WHERE id = n.actor_id) AS actor`,
      )).rows
      more = rows.length === 200
      for (const r of rows) {
        if (!r.webhook_url) continue
        const L = TEXT[r.locale === 'ko' ? 'ko' : 'en']
        const line = (L[r.kind as 'mention'] ?? r.kind).replace('{actor}', r.actor ?? '?').replace('{page}', `“${r.page}”`)
        const url = pageUrl(Number(r.page_id))
        await postJson(r.webhook_url, chat(`${line}\n${url}`, { kind: r.kind, page: { id: Number(r.page_id), title: r.page, url }, actor: r.actor }), {}, true)
          .then((s) => {
            inc('pagehouse_webhook_deliveries_total', { kind: 'personal', result: s >= 200 && s < 300 ? 'ok' : 'failed' })
            if (s >= 300) console.error(`webhook for user ${r.user_id} answered ${s}`)
          })
          .catch((e) => (inc('pagehouse_webhook_deliveries_total', { kind: 'personal', result: 'failed' }), console.error(`webhook for user ${r.user_id} failed:`, e.message)))
      }
      }
    } catch (e) {
      console.error('personal webhooks:', (e as Error).message)
    } finally {
      running = false
    }
  }
  const timer = setInterval(tick, 10_000)
  timer.unref()
  return { stop: () => clearInterval(timer), tick }
}

export function createWebhooks(db: Db) {
  // shortcut: page.updated is sent at most every 10 minutes per page and webhook, remembered in memory per instance; a
  // shared table would make that exact across instances.
  const lastUpdate = new Map<string, number>()

  /** One attempt; records the outcome on the webhook. */
  async function deliver(hook: { id: number; url: string; secret: string }, event: string, body: string) {
    let status = 0
    let error: string | null = null
    try {
      // Inside the try: a secret that can't be decrypted (SECRET_KEY missing or changed) is a failed attempt like any other.
      const sig = `sha256=${createHmac('sha256', openSecret(hook.secret)).update(body).digest('hex')}`
      // x-event / x-signature carry the same values under the names Taskhouse uses, so one receiver handles both.
      const headers = { 'x-pagehouse-event': event, 'x-pagehouse-signature': sig, 'x-event': event, 'x-signature': sig }
      status = await postJson(hook.url, body, headers, false)
      error = status >= 200 && status < 300 ? null : `HTTP ${status}`
    } catch (e) {
      error = (e as Error).message
    }
    await db.query('UPDATE webhooks SET last_at = now(), last_status = $1, last_error = $2 WHERE id = $3', [status || null, error, hook.id])
    return { status, error }
  }

  /** Sends due deliveries from webhook_jobs. Failures wait 1, 4, 16, 64 minutes, then give up. Returns how many ran. */
  async function runJobs() {
    const jobs = (await db.query(
      `UPDATE webhook_jobs j SET run_at = now() + interval '5 minutes', attempts = attempts + 1 FROM webhooks h
       WHERE j.id IN (SELECT id FROM webhook_jobs WHERE done_at IS NULL AND run_at <= now() ORDER BY run_at LIMIT 20 FOR UPDATE SKIP LOCKED)
         AND h.id = j.hook_id
       RETURNING j.id, j.event, j.body, j.attempts, h.id AS hook_id, h.url, h.secret`,
    )).rows
    await Promise.all(jobs.map(async (j) => {
      const { error } = await deliver({ id: j.hook_id, url: j.url, secret: j.secret }, j.event, j.body)
      const last = !error || j.attempts >= MAX_ATTEMPTS
      if (last) inc('pagehouse_webhook_deliveries_total', { kind: 'admin', result: error ? 'failed' : 'ok' })
      await db.query(
        `UPDATE webhook_jobs SET last_error = $2, done_at = CASE WHEN $3 THEN now() END, run_at = now() + make_interval(mins => $4) WHERE id = $1`,
        [j.id, error, last, 4 ** (j.attempts - 1)],
      )
    }))
    return jobs.length
  }

  /** Sends an event about a page to every matching webhook. Call without awaiting; failures are only recorded. */
  async function emit(event: Event, pageId: number, actorId: number, extra: Record<string, unknown> = {}) {
    const page = (await db.query(
      `SELECT p.id, p.title, s.id AS space_id, s.key, s.name AS space,
         EXISTS (WITH RECURSIVE up(id, parent_id) AS (SELECT id, parent_id FROM pages WHERE id = $1
                   UNION ALL SELECT q.id, q.parent_id FROM pages q JOIN up ON q.id = up.parent_id)
                 SELECT 1 FROM page_restrictions r JOIN up ON r.page_id = up.id) AS restricted
       FROM pages p JOIN spaces s ON s.id = p.space_id WHERE p.id = $1`,
      [pageId],
    )).rows[0]
    if (!page || page.restricted) return
    let hooks = (await db.query(
      'SELECT id, url, secret FROM webhooks WHERE enabled AND $1 = ANY(events) AND (space_id IS NULL OR space_id = $2)',
      [event, page.space_id],
    )).rows
    if (event === 'page.updated') {
      hooks = hooks.filter((h) => {
        const k = `${h.id}:${pageId}`
        if (Date.now() - (lastUpdate.get(k) ?? 0) < 600_000) return false
        lastUpdate.set(k, Date.now())
        return true
      })
      if (lastUpdate.size > 10_000) lastUpdate.clear()
    }
    if (!hooks.length) return
    const actor = (await db.query('SELECT id, name FROM users WHERE id = $1', [actorId])).rows[0]
    const body = JSON.stringify({
      event,
      at: new Date().toISOString(),
      page: { id: Number(page.id), title: page.title, url: pageUrl(Number(page.id)) },
      space: { id: Number(page.space_id), key: page.key, name: page.space },
      actor: actor ? { id: Number(actor.id), name: actor.name } : null,
      ...extra,
    })
    await db.query('INSERT INTO webhook_jobs (hook_id, event, body) SELECT unnest($1::bigint[]), $2, $3', [hooks.map((h) => h.id), event, body])
    void tick()
  }
  const fire = (...a: Parameters<typeof emit>) => void emit(...a).catch((e) => console.error('webhook:', e.message))

  let busy = false
  const tick = async () => {
    if (busy) return
    busy = true
    try {
      while ((await runJobs()) === 20);
    } catch (e) {
      console.error('webhook jobs:', (e as Error).message)
    } finally {
      busy = false
    }
  }
  /** Retries due deliveries every few seconds on every instance (jobs are claimed), and forgets old ones daily. */
  function start() {
    setInterval(tick, 5_000).unref()
    const prune = () => db.query(`DELETE FROM webhook_jobs WHERE done_at < now() - interval '30 days'`).catch((e) => console.error('webhook jobs:', e.message))
    setInterval(prune, 86400_000).unref()
  }

  /** Admin → Webhooks. Registered behind the session check, so only admins reach it. */
  function register(app: Hono<any>, fail: (c: Context, status: 400 | 404, code: string) => Response) {
    const cols = `id, name, url, events, space_id AS "spaceId", enabled, created_at AS "createdAt",
      last_at AS "lastAt", last_status AS "lastStatus", last_error AS "lastError"`
    const parse = async (c: Context) => {
      const b = await c.req.json().catch(() => ({}))
      const url = httpUrl(b.url)
      const events = Array.isArray(b.events) ? EVENTS.filter((e) => b.events.includes(e)) : []
      const name = String(b.name ?? '').trim().slice(0, 100)
      const spaceId = b.spaceId == null ? null : Number(b.spaceId)
      if (!url || !events.length || !name || (spaceId !== null && !Number.isInteger(spaceId))) return null
      return { url, events, name, spaceId, enabled: b.enabled !== false }
    }
    const newSecret = () => `whsec_${randomBytes(24).toString('base64url')}`
    const hookId = (c: Context) => Number(c.req.param('id'))

    app.get('/api/admin/webhooks', async (c) => c.json({ events: EVENTS, hooks: (await db.query(`SELECT ${cols} FROM webhooks ORDER BY id`)).rows }))
    app.post('/api/admin/webhooks', async (c) => {
      const p = await parse(c)
      if (!p) return fail(c, 400, 'bad_request')
      const secret = newSecret()
      const row = (await db.query(
        `INSERT INTO webhooks (name, url, secret, events, space_id, enabled, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${cols}`,
        [p.name, p.url, sealSecret(secret), p.events, p.spaceId, p.enabled, c.get('user').id],
      )).rows[0]
      // The secret is shown once, so the receiving side can check signatures.
      return c.json({ ...row, secret })
    })
    app.put('/api/admin/webhooks/:id', async (c) => {
      const p = await parse(c)
      if (!p) return fail(c, 400, 'bad_request')
      const row = (await db.query(
        `UPDATE webhooks SET name = $1, url = $2, events = $3, space_id = $4, enabled = $5 WHERE id = $6 RETURNING ${cols}`,
        [p.name, p.url, p.events, p.spaceId, p.enabled, hookId(c)],
      )).rows[0]
      return row ? c.json(row) : fail(c, 404, 'not_found')
    })
    app.post('/api/admin/webhooks/:id/secret', async (c) => {
      const secret = newSecret()
      const r = await db.query('UPDATE webhooks SET secret = $1 WHERE id = $2', [sealSecret(secret), hookId(c)])
      return r.rowCount ? c.json({ secret }) : fail(c, 404, 'not_found')
    })
    app.delete('/api/admin/webhooks/:id', async (c) => {
      const r = await db.query('DELETE FROM webhooks WHERE id = $1', [hookId(c)])
      return r.rowCount ? c.json({ ok: true }) : fail(c, 404, 'not_found')
    })
    app.post('/api/admin/webhooks/:id/test', async (c) => {
      const hook = (await db.query('SELECT id, url, secret FROM webhooks WHERE id = $1', [hookId(c)])).rows[0]
      if (!hook) return fail(c, 404, 'not_found')
      const body = JSON.stringify({ event: 'ping', at: new Date().toISOString(), actor: { id: c.get('user').id, name: c.get('user').name } })
      return c.json(await deliver(hook, 'ping', body))
    })

    // A person's own notification webhook: test it before relying on it.
    app.post('/api/me/webhook/test', async (c) => {
      const url = httpUrl((await c.req.json().catch(() => ({}))).url)
      if (!url) return fail(c, 400, 'bad_request')
      const ko = c.get('user').locale === 'ko'
      try {
        const status = await postJson(url, chat(ko ? 'Pagehouse 알림 웹훅이 연결되었습니다.' : 'Pagehouse notifications are connected.', { kind: 'test' }), {}, true)
        return c.json({ status, error: status >= 200 && status < 300 ? null : `HTTP ${status}` })
      } catch (e) {
        return c.json({ status: 0, error: (e as Error).message })
      }
    })
  }

  return { emit: fire, register, start, runJobs }
}
