// Spaces and their members, the home dashboard, @mentions and notifications.
import type { Hono, Context } from 'hono'
import { tx, type Db } from './db.ts'

type User = { id: number; email: string; name: string; role: string }
type Deps = {
  db: Db
  fail: (c: Context, status: 400 | 401 | 403 | 404 | 409 | 413 | 429, code: string) => Response
  /** SQL "this page is visible" filter: (alias, first free $n) => sql; params to append. */
  visibleFor: (c: Context<any>) => { sql: (alias: string, first: number) => string; params: unknown[] }
}

const ACCESS = ['edit', 'view', 'none'] as const
const ROLES = ['admin', 'edit', 'view'] as const

/** User ids mentioned in a page doc (Tiptap mention nodes). */
export function mentionedInDoc(node: any, out = new Set<number>()): Set<number> {
  if (!node || typeof node !== 'object') return out
  if (node.type === 'mention' && /^\d+$/.test(String(node.attrs?.id ?? ''))) out.add(Number(node.attrs.id))
  for (const c of node.content ?? []) mentionedInDoc(c, out)
  return out
}
/** Comments store mentions as <@123>. */
export const mentionedInText = (s: string) => new Set([...s.matchAll(/<@(\d+)>/g)].map((m) => Number(m[1])))

export function registerPeople(app: Hono<any>, { db, fail, visibleFor }: Deps) {
  const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0]
  const all = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows
  const me = (c: Context<any>) => c.get('user') as User
  const sid = (c: Context) => (/^\d+$/.test(c.req.param('id') ?? '') ? Number(c.req.param('id')) : 0)

  /** 'admin' | 'edit' | 'view' | null for the signed-in user in a space. Site admins manage every space. */
  async function spaceRole(c: Context<any>, spaceId: number): Promise<string | null> {
    if (me(c).role === 'admin') return (await one('SELECT 1 FROM spaces WHERE id = $1', [spaceId])) ? 'admin' : null
    return (await one('SELECT space_access($1, $2) AS r', [spaceId, me(c).id]))?.r ?? null
  }

  // ---------- spaces ----------
  app.get('/api/spaces', async (c) =>
    c.json(
      await all(
        `SELECT s.id, s.key, s.name, s.default_access AS "defaultAccess",
           CASE WHEN $1 THEN 'admin' ELSE space_access(s.id, $2) END AS role
         FROM spaces s WHERE $1 OR space_access(s.id, $2) IS NOT NULL ORDER BY s.name`,
        [me(c).role === 'admin', me(c).id],
      ),
    ),
  )

  app.post('/api/spaces', async (c) => {
    const b = await c.req.json().catch(() => ({}))
    const name = typeof b.name === 'string' ? b.name.trim().slice(0, 100) : ''
    const key = typeof b.key === 'string' ? b.key.trim().toUpperCase().slice(0, 20) : ''
    const access = ACCESS.includes(b.defaultAccess) ? b.defaultAccess : 'edit'
    if (!name || !/^[A-Z0-9]+$/.test(key)) return fail(c, 400, 'bad_space')
    const row = await one(
      `INSERT INTO spaces (key, name, default_access, created_by) VALUES ($1, $2, $3, $4) ON CONFLICT (key) DO NOTHING
       RETURNING id, key, name, default_access AS "defaultAccess"`,
      [key, name, access, me(c).id],
    )
    if (!row) return fail(c, 409, 'space_key_taken')
    // The creator manages the space, so a private space is never created locked.
    await db.query(`INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, 'admin')`, [row.id, me(c).id])
    return c.json({ ...row, role: 'admin' })
  })

  app.get('/api/spaces/:id/settings', async (c) => {
    const role = await spaceRole(c, sid(c))
    if (!role) return fail(c, 404, 'space_not_found')
    const s = await one(`SELECT id, key, name, default_access AS "defaultAccess" FROM spaces WHERE id = $1`, [sid(c)])
    const members = await all(
      `SELECT m.user_id AS "userId", m.group_id AS "groupId", m.role, coalesce(u.name, g.name) AS name, u.email
       FROM space_members m LEFT JOIN users u ON u.id = m.user_id LEFT JOIN groups g ON g.id = m.group_id
       WHERE m.space_id = $1 ORDER BY CASE m.role WHEN 'admin' THEN 0 WHEN 'edit' THEN 1 ELSE 2 END, m.group_id IS NULL, coalesce(u.name, g.name)`,
      [sid(c)],
    )
    return c.json({ ...s, members, canManage: role === 'admin' })
  })

  app.put('/api/spaces/:id/settings', async (c) => {
    if ((await spaceRole(c, sid(c))) !== 'admin') return fail(c, 403, 'space_admin_only')
    const b = await c.req.json().catch(() => ({}))
    const name = typeof b.name === 'string' ? b.name.trim().slice(0, 100) : ''
    if (!name || !ACCESS.includes(b.defaultAccess) || !Array.isArray(b.members) || b.members.length > 5000) return fail(c, 400, 'bad_request')
    const members = new Map<number, string>()
    const groups = new Map<number, string>()
    for (const m of b.members) {
      if (!ROLES.includes(m?.role) || Number.isInteger(m?.userId) === Number.isInteger(m?.groupId)) return fail(c, 400, 'bad_request')
      if (m.groupId) groups.set(m.groupId, m.role)
      else members.set(m.userId, m.role)
    }
    // Whoever saves keeps managing the space (site admins can always reach it anyway).
    if (me(c).role !== 'admin') members.set(me(c).id, 'admin')
    const ids = [...members.keys()]
    const gids = [...groups.keys()]
    if (ids.length && (await all('SELECT id FROM users WHERE id = ANY($1::bigint[])', [ids])).length !== ids.length) return fail(c, 400, 'user_not_found')
    if (gids.length && (await all('SELECT id FROM groups WHERE id = ANY($1::bigint[])', [gids])).length !== gids.length) return fail(c, 400, 'group_not_found')
    await tx(db, async (q) => {
      await q.query('UPDATE spaces SET name = $1, default_access = $2 WHERE id = $3', [name, b.defaultAccess, sid(c)])
      await q.query('DELETE FROM space_members WHERE space_id = $1', [sid(c)])
      await q.query(
        `INSERT INTO space_members (space_id, user_id, group_id, role)
         SELECT $1::bigint, u, NULL::bigint, r FROM unnest($2::bigint[], $3::text[]) AS x(u, r)
         UNION ALL SELECT $1::bigint, NULL::bigint, g, r FROM unnest($4::bigint[], $5::text[]) AS y(g, r)`,
        [sid(c), ids, ids.map((i) => members.get(i)), gids, gids.map((i) => groups.get(i))],
      )
    })
    return c.json({ ok: true })
  })

  // ---------- templates ----------
  app.get('/api/templates', async (c) => {
    const space = Number(c.req.query('space')) || 0
    const role = space ? await spaceRole(c, space) : null
    return c.json(await all(
      `SELECT t.id, t.space_id AS "spaceId", t.name, t.icon, t.title, t.doc, t.created_by AS "createdBy"
       FROM templates t WHERE t.deleted_at IS NULL AND (t.space_id IS NULL OR ($1 AND t.space_id = $2)) ORDER BY t.space_id NULLS FIRST, t.name`,
      [!!role, space]))
  })
  app.post('/api/templates', async (c) => {
    const b = await c.req.json().catch(() => ({}))
    const name = typeof b.name === 'string' ? b.name.trim().slice(0, 100) : ''
    const icon = typeof b.icon === 'string' && b.icon.trim() ? [...b.icon.trim()].slice(0, 2).join('') : '📄'
    if (!name || !Number.isInteger(b.pageId)) return fail(c, 400, 'bad_request')
    // The page must be one the caller can open; its current content becomes the template.
    const v = visibleFor(c)
    const page = await one(`SELECT p.space_id, p.title, p.doc FROM pages p WHERE p.id = $1 AND p.deleted_at IS NULL AND ${v.sql('p', 2)}`, [b.pageId, ...v.params])
    if (!page) return fail(c, 404, 'page_not_found')
    const global = b.global === true
    if (global ? me(c).role !== 'admin' : !['admin', 'edit'].includes((await spaceRole(c, page.space_id)) ?? '')) return fail(c, 403, 'no_edit_permission')
    const row = await one(
      `INSERT INTO templates (space_id, name, icon, title, doc, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [global ? null : page.space_id, name, icon, page.title, page.doc, me(c).id])
    return c.json({ id: row.id })
  })
  app.delete('/api/templates/:id', async (c) => {
    const tpl = await one('SELECT space_id, created_by FROM templates WHERE id = $1 AND deleted_at IS NULL', [sid(c)])
    if (!tpl) return fail(c, 404, 'bad_request')
    const ok = me(c).role === 'admin' || tpl.created_by === me(c).id || (tpl.space_id && (await spaceRole(c, tpl.space_id)) === 'admin')
    if (!ok) return fail(c, 403, 'space_admin_only')
    // Kept, only hidden, like everything else that gets deleted.
    await db.query('UPDATE templates SET deleted_at = now() WHERE id = $1', [sid(c)])
    return c.json({ ok: true })
  })

  // ---------- groups ----------
  // Everyone can list groups (to pick them in space and page settings); only admins change them.
  app.get('/api/groups', async (c) =>
    c.json(await all(`SELECT g.id, g.name, (SELECT count(*)::int FROM group_members m WHERE m.group_id = g.id) AS size FROM groups g ORDER BY g.name`)),
  )
  app.get('/api/admin/groups/:id', async (c) => {
    const g = await one('SELECT id, name FROM groups WHERE id = $1', [sid(c)])
    if (!g) return fail(c, 404, 'group_not_found')
    const members = await all(
      'SELECT u.id, u.name, u.email FROM group_members m JOIN users u ON u.id = m.user_id WHERE m.group_id = $1 ORDER BY u.name', [g.id])
    return c.json({ ...g, members })
  })
  const saveGroup = async (c: Context<any>, groupId: number | null) => {
    const b = await c.req.json().catch(() => ({}))
    const name = typeof b.name === 'string' ? b.name.trim().slice(0, 100) : ''
    const members: number[] = Array.isArray(b.members) ? [...new Set<number>(b.members)] : []
    if (!name || !members.every(Number.isInteger)) return fail(c, 400, 'bad_group')
    const r = await tx(db, async (q) => {
      const row = groupId
        ? (await q.query('UPDATE groups SET name = $1 WHERE id = $2 AND NOT EXISTS (SELECT 1 FROM groups WHERE name = $1 AND id <> $2) RETURNING id', [name, groupId])).rows[0]
        : (await q.query('INSERT INTO groups (name) VALUES ($1) ON CONFLICT (name) DO NOTHING RETURNING id', [name])).rows[0]
      if (!row) return null
      await q.query('DELETE FROM group_members WHERE group_id = $1', [row.id])
      await q.query('INSERT INTO group_members (group_id, user_id) SELECT $1, u FROM unnest($2::bigint[]) u WHERE u IN (SELECT id FROM users)', [row.id, members])
      return row
    })
    if (!r) return groupId && !(await one('SELECT 1 FROM groups WHERE id = $1', [groupId])) ? fail(c, 404, 'group_not_found') : fail(c, 409, 'bad_group')
    return c.json({ id: r.id, name })
  }
  app.post('/api/admin/groups', (c) => saveGroup(c, null))
  app.put('/api/admin/groups/:id', (c) => saveGroup(c, sid(c)))
  app.delete('/api/admin/groups/:id', async (c) => {
    // Refused while in use: removing a group's grants could open restricted pages or change space roles.
    const used = await one(
      `SELECT EXISTS (SELECT 1 FROM page_restrictions WHERE group_id = $1) OR EXISTS (SELECT 1 FROM space_members WHERE group_id = $1) AS used`, [sid(c)])
    if (used.used) return fail(c, 409, 'group_in_use')
    const r = await db.query('DELETE FROM groups WHERE id = $1', [sid(c)])
    return r.rowCount ? c.json({ ok: true }) : fail(c, 404, 'group_not_found')
  })

  // ---------- favorites and recently viewed (sidebar) ----------
  app.get('/api/me/quick', async (c) => {
    const v = visibleFor(c)
    const u = me(c).id
    const [starred, recent] = await Promise.all([
      all(
        `SELECT p.id, p.title, p.kind FROM page_stars st JOIN pages p ON p.id = st.page_id
         WHERE st.user_id = $1 AND p.deleted_at IS NULL AND ${v.sql('p', 2)} ORDER BY st.created_at DESC LIMIT 50`,
        [u, ...v.params],
      ),
      all(
        `SELECT p.id, p.title, p.kind FROM page_views pv JOIN pages p ON p.id = pv.page_id
         WHERE pv.user_id = $1 AND p.deleted_at IS NULL AND ${v.sql('p', 2)} ORDER BY pv.viewed_at DESC LIMIT 8`,
        [u, ...v.params],
      ),
    ])
    return c.json({ starred, recent })
  })

  // ---------- home ----------
  app.get('/api/home', async (c) => {
    const v = visibleFor(c)
    const u = me(c).id
    const [viewed, created, forYou] = await Promise.all([
      all(
        `SELECT p.id, p.title, s.name AS space, v.viewed_at AS "viewedAt", p.updated_at AS "updatedAt", ub.name AS "updatedBy"
         FROM page_views v JOIN pages p ON p.id = v.page_id JOIN spaces s ON s.id = p.space_id JOIN users ub ON ub.id = p.updated_by
         WHERE v.user_id = $1 AND p.deleted_at IS NULL AND ${v.sql('p', 2)} ORDER BY v.viewed_at DESC LIMIT 12`,
        [u, ...v.params],
      ),
      all(
        `SELECT p.id, p.title, s.name AS space, p.created_at AS "createdAt", cb.name AS "createdBy"
         FROM pages p JOIN spaces s ON s.id = p.space_id JOIN users cb ON cb.id = p.created_by
         WHERE p.deleted_at IS NULL AND p.kind = 'page' AND ${v.sql('p', 1)} ORDER BY p.created_at DESC LIMIT 12`,
        v.params,
      ),
      notifications(c, 12),
    ])
    return c.json({ viewed, created, forYou: forYou.items })
  })

  // ---------- notifications ----------
  async function notifications(c: Context<any>, limit: number) {
    const v = visibleFor(c)
    const items = await all(
      `SELECT n.id, n.kind, n.created_at AS "createdAt", n.read_at AS "readAt", n.page_id AS "pageId", p.title AS page,
         n.comment_id AS "commentId", left(cm.body, 200) AS excerpt, a.name AS actor
       FROM notifications n JOIN pages p ON p.id = n.page_id LEFT JOIN users a ON a.id = n.actor_id
       LEFT JOIN comments cm ON cm.id = n.comment_id
       WHERE n.user_id = $1 AND p.deleted_at IS NULL AND (cm.id IS NULL OR cm.deleted_at IS NULL) AND ${v.sql('p', 2)}
       ORDER BY n.id DESC LIMIT ${limit}`,
      [me(c).id, ...v.params],
    )
    const unread = (await one('SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL', [me(c).id])).n
    return { unread, items }
  }
  app.get('/api/notifications', async (c) => c.json(await notifications(c, 40)))
  app.get('/api/notifications/count', async (c) =>
    c.json(await one('SELECT count(*)::int AS unread FROM notifications WHERE user_id = $1 AND read_at IS NULL', [me(c).id])),
  )
  app.post('/api/notifications/read', async (c) => {
    const b = await c.req.json().catch(() => ({}))
    if (Array.isArray(b.ids) && b.ids.every(Number.isInteger))
      await db.query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND id = ANY($2::bigint[]) AND read_at IS NULL', [me(c).id, b.ids])
    else await db.query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [me(c).id])
    return c.json({ ok: true })
  })
}

/**
 * Records notifications. Recipients only hear about pages they can open, never about their own actions,
 * and each person gets one notification per event even if several reasons apply.
 */
export async function notify(db: Db, actorId: number, pageId: number, commentId: number | null, recipients: [number, string][]) {
  const seen = new Set<number>([actorId])
  const targets = recipients.filter(([uid]) => !seen.has(uid) && seen.add(uid))
  if (!targets.length) return
  const ids = targets.map(([u]) => u)
  const ok = new Set(
    (await db.query(
      `SELECT u.id FROM users u JOIN pages p ON p.id = $2
       WHERE u.id = ANY($1::bigint[]) AND u.disabled_at IS NULL
         AND (u.role = 'admin' OR p.id NOT IN (SELECT id FROM hidden_pages(u.id)))`,
      [ids, pageId],
    )).rows.map((r) => Number(r.id)),
  )
  const rows = targets.filter(([u]) => ok.has(u))
  if (!rows.length) return
  await db.query(
    `INSERT INTO notifications (user_id, kind, actor_id, page_id, comment_id)
     SELECT u, k, $3, $4, $5 FROM unnest($1::bigint[], $2::text[]) AS x(u, k)`,
    [rows.map(([u]) => u), rows.map(([, k]) => k), actorId, pageId, commentId],
  )
}
