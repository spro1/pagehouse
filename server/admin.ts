// Admin monitoring: storage, backups, content and activity. Plus the storage limit that uploads respect.
import type { Hono, Context } from 'hono'
import { existsSync, readdirSync, rmSync, statSync, statfsSync } from 'node:fs'
import { join } from 'node:path'
import type { Db } from './db.ts'
import { processStats, recentStats, prometheus, counter } from './metrics.ts'

type Deps = {
  db: Db
  filesDir: string
  fail: (c: Context, status: 400 | 401 | 403 | 404 | 409, code: string) => Response
}

const GB = 1024 ** 3

/** Bytes used by everything the limit counts: the database plus attachments as stored (deduplicated). */
export async function usedBytes(db: Db) {
  const { rows } = await db.query(
    `SELECT pg_database_size(current_database())::bigint AS db,
       (SELECT coalesce(sum(size), 0) FROM (SELECT DISTINCT ON (sha256) size FROM attachments) f)::bigint AS files`,
  )
  return { db: Number(rows[0].db), files: Number(rows[0].files) }
}

export async function storageLimit(db: Db): Promise<number | null> {
  const r = (await db.query(`SELECT value FROM settings WHERE key = 'storage_limit_bytes'`)).rows[0]
  return r ? Number(r.value) : null
}

/** Name and logo set in Admin → Branding. The name falls back to Pagehouse everywhere (tab, mail, link previews). */
type Branding = { name: string | null; logo: string | null }
// Read on every page load, so kept for a short while. Other app instances see a change within BRAND_TTL.
const BRAND_TTL = 30_000
let brandCache: { at: number; value: Branding } | null = null
export async function branding(db: Db): Promise<Branding> {
  if (brandCache && Date.now() - brandCache.at < BRAND_TTL) return brandCache.value
  const v = (await db.query(`SELECT value FROM settings WHERE key = 'branding'`)).rows[0]?.value ?? {}
  brandCache = { at: Date.now(), value: { name: v.name || null, logo: v.logo || null } }
  return brandCache.value
}
export async function saveBranding(db: Db, patch: Partial<Branding>) {
  await db.query(
    `INSERT INTO settings (key, value) VALUES ('branding', $1) ON CONFLICT (key) DO UPDATE SET value = settings.value || EXCLUDED.value, updated_at = now()`,
    [JSON.stringify(patch)],
  )
  brandCache = null
}

// Stored files are named by their content hash and written by three things: attachments, profile photos and the
// logo. Attachments are never deleted, but a replaced photo or logo leaves its file behind.
const FRESH_MS = 10 * 60_000
/** Remove files nothing points to. A file touched in the last few minutes is kept: an upload writes (or, for
 *  bytes already stored, touches) its file just before it saves the row that points to it. */
export async function pruneFiles(db: Db, filesDir: string, only?: (string | null | undefined)[]) {
  const names = (only ?? (existsSync(filesDir) ? readdirSync(filesDir) : [])).map((n) => n?.split(':')[0]).filter((n): n is string => !!n && /^[0-9a-f]{64}$/.test(n))
  if (!names.length) return 0
  const used = new Set((await db.query(
    `SELECT sha256 AS h FROM attachments WHERE sha256 = ANY($1)
     UNION SELECT split_part(avatar, ':', 1) FROM users WHERE split_part(avatar, ':', 1) = ANY($1)
     UNION SELECT split_part(value->>'logo', ':', 1) FROM settings WHERE key = 'branding' AND value->>'logo' IS NOT NULL`,
    [names],
  )).rows.map((r) => r.h))
  let removed = 0
  for (const h of names) {
    if (used.has(h)) continue
    const path = join(filesDir, h)
    try {
      if (Date.now() - statSync(path).mtimeMs < FRESH_MS) continue
      rmSync(path, { force: true })
      removed++
    } catch {} // already gone
  }
  return removed
}

/** Hourly, so files left by earlier versions (or skipped as too fresh) go too. */
export function startFileSweep(db: Db, filesDir: string) {
  const run = () => pruneFiles(db, filesDir).then((n) => n && console.log(`removed ${n} unused files`), (e) => console.error('file sweep:', e.message))
  const first = setTimeout(run, 60_000)
  const timer = setInterval(run, 3_600_000)
  first.unref()
  timer.unref()
}
export const brandName = async (db: Db) => (await branding(db)).name ?? 'Pagehouse'

function disk(path: string) {
  try {
    const s = statfsSync(path)
    return { total: s.blocks * s.bsize, free: s.bavail * s.bsize }
  } catch {
    return null
  }
}

/** Backup archives under BACKUP_DIR (mounted read-only into the app by docker-compose). */
function backups(dir: string | undefined) {
  if (!dir || !existsSync(dir)) return null
  const files: { name: string; size: number; at: number }[] = []
  const walk = (d: string, prefix = '') => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name), `${prefix}${e.name}/`)
      else if (e.name.endsWith('.tar.gz')) {
        const st = statSync(join(d, e.name))
        files.push({ name: prefix + e.name, size: st.size, at: st.mtimeMs })
      }
    }
  }
  try {
    walk(dir)
  } catch {
    return null
  }
  files.sort((a, b) => b.at - a.at)
  const auto = files.filter((f) => f.name.startsWith('pagehouse-auto-'))
  return {
    count: files.length,
    bytes: files.reduce((s, f) => s + f.size, 0),
    latest: files[0] ? { name: files[0].name, at: new Date(files[0].at).toISOString(), size: files[0].size } : null,
    latestAuto: auto[0] ? new Date(auto[0].at).toISOString() : null,
  }
}

const started = Date.now()

type Rooms = { rooms: Map<number, { conns: Map<unknown, unknown> }> }

/** What an operator wants to know at a glance; shared by Admin → Overview and /metrics. */
export async function health(db: Db, collab: Rooms) {
  const t = performance.now()
  await db.query('SELECT 1')
  const dbLatencyMs = Math.round((performance.now() - t) * 10) / 10
  const pool = db as unknown as { totalCount?: number; idleCount?: number; waitingCount?: number }
  const q = (await db.query(
    `SELECT (SELECT count(*) FROM notifications WHERE emailed_at IS NULL AND read_at IS NULL AND created_at < now() - interval '15 minutes')::int AS "mailBacklog",
            (SELECT count(*) FROM notifications WHERE hooked_at IS NULL AND created_at < now() - interval '5 minutes')::int AS "hookBacklog",
            (SELECT count(*) FROM webhooks WHERE enabled AND last_error IS NOT NULL)::int AS "webhooksFailing",
            (SELECT count(*) FROM users WHERE disabled_at IS NULL)::int AS users,
            (SELECT count(*) FROM pages WHERE deleted_at IS NULL)::int AS pages`,
  )).rows[0]
  const bk = backups(process.env.BACKUP_DIR)
  const policy = await backupPolicy(db)
  const lastBackupAt = bk?.latestAuto ? new Date(bk.latestAuto).getTime() : null
  return {
    db: { latencyMs: dbLatencyMs, connections: pool.totalCount ?? null, idle: pool.idleCount ?? null, waiting: pool.waitingCount ?? null },
    process: processStats(),
    recent: recentStats(),
    collab: { rooms: collab.rooms.size, connections: [...collab.rooms.values()].reduce((s, r) => s + r.conns.size, 0) },
    backlog: { mail: q.mailBacklog, webhooks: q.hookBacklog },
    webhooksFailing: q.webhooksFailing,
    mailFailed: counter('pagehouse_mail_sent_total{result="failed"}'),
    backup: bk ? { lastAt: bk.latestAuto, overdue: !lastBackupAt || Date.now() - lastBackupAt > policy.intervalHours * 1.5 * 3600_000 } : null,
    counts: { users: q.users, pages: q.pages },
  }
}

/** Prometheus text for /metrics: the request metrics plus gauges read now. */
export async function metricsText(db: Db, collab: Rooms) {
  const h = await health(db, collab)
  const used = await usedBytes(db)
  const limit = await storageLimit(db)
  const g: [string, string, number, Record<string, string>?][] = [
    ['pagehouse_info', 'Running version.', 1, { version: process.env.APP_VERSION ?? 'dev' }],
    ['pagehouse_db_latency_seconds', 'Time for a trivial database query.', h.db.latencyMs / 1000],
    ['pagehouse_db_pool_connections', 'Database connections held by this instance.', h.db.connections ?? 0],
    ['pagehouse_db_pool_waiting', 'Queries waiting for a database connection.', h.db.waiting ?? 0],
    ['pagehouse_collab_rooms', 'Pages open for live editing on this instance.', h.collab.rooms],
    ['pagehouse_collab_connections', 'Live editing connections on this instance.', h.collab.connections],
    ['pagehouse_storage_bytes', 'Storage used.', used.db, { kind: 'database' }],
    ['pagehouse_storage_bytes', 'Storage used.', used.files, { kind: 'files' }],
    ['pagehouse_storage_limit_bytes', 'Storage limit set by an admin (0 = none).', limit ?? 0],
    ['pagehouse_backup_last_success_timestamp_seconds', 'When the last automatic backup was written (0 = never or not visible).', h.backup?.lastAt ? Math.round(new Date(h.backup.lastAt).getTime() / 1000) : 0],
    ['pagehouse_notification_backlog', 'Notifications waiting longer than expected to be sent.', h.backlog.mail, { channel: 'mail' }],
    ['pagehouse_notification_backlog', 'Notifications waiting longer than expected to be sent.', h.backlog.webhooks, { channel: 'webhook' }],
    ['pagehouse_webhooks_failing', 'Enabled admin webhooks whose last delivery failed.', h.webhooksFailing],
    ['pagehouse_users', 'Active accounts.', h.counts.users],
    ['pagehouse_pages', 'Pages not in the trash.', h.counts.pages],
  ]
  return prometheus(g)
}

/** How long backups are kept. Saved by an admin; read by the backup container on every run. Env gives the defaults. */
export type BackupPolicy = { intervalHours: number; keep: number; maxAgeDays: number; manualMaxAgeDays: number }
export async function backupPolicy(db: Db): Promise<BackupPolicy> {
  const s = (await db.query(`SELECT value FROM settings WHERE key = 'backup'`)).rows[0]?.value ?? {}
  return {
    intervalHours: s.intervalHours ?? (Number(process.env.BACKUP_INTERVAL_HOURS) || 24),
    keep: s.keep ?? (Number(process.env.BACKUP_KEEP) || 14),
    maxAgeDays: s.maxAgeDays ?? 0,
    manualMaxAgeDays: s.manualMaxAgeDays ?? 0,
  }
}

export function registerAdmin(app: Hono<any>, { db, filesDir, fail, collab }: Deps & { collab: Rooms }) {
  app.get('/api/admin/health', async (c) => c.json(await health(db, collab)))
  const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0]
  const all = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows

  app.get('/api/admin/stats', async (c) => {
    const [used, limit, counts, logical, spaces, largest, activity, pgVersion] = await Promise.all([
      usedBytes(db),
      storageLimit(db),
      one(`SELECT
        (SELECT count(*) FROM users WHERE disabled_at IS NULL)::int AS "activeUsers",
        (SELECT count(*) FROM users WHERE disabled_at IS NOT NULL)::int AS "disabledUsers",
        (SELECT count(*) FROM users WHERE role = 'admin' AND disabled_at IS NULL)::int AS admins,
        (SELECT count(*) FROM spaces)::int AS spaces,
        (SELECT count(*) FROM pages WHERE deleted_at IS NULL)::int AS pages,
        (SELECT count(*) FROM pages WHERE deleted_at IS NOT NULL)::int AS trashed,
        (SELECT count(*) FROM page_versions)::int AS versions,
        (SELECT count(*) FROM comments WHERE deleted_at IS NULL)::int AS comments,
        (SELECT count(*) FROM attachments)::int AS attachments,
        (SELECT count(DISTINCT sha256) FROM attachments)::int AS "uniqueFiles",
        (SELECT count(*) FROM page_restrictions)::int AS restrictions`),
      one(`SELECT coalesce(sum(size), 0)::bigint AS bytes FROM attachments`),
      all(`SELECT s.id, s.name, s.key,
             count(p.id) FILTER (WHERE p.deleted_at IS NULL)::int AS pages,
             coalesce((SELECT sum(a.size) FROM attachments a JOIN pages ap ON ap.id = a.page_id WHERE ap.space_id = s.id), 0)::bigint AS "fileBytes",
             max(p.updated_at) AS "lastEdit"
           FROM spaces s LEFT JOIN pages p ON p.space_id = s.id GROUP BY s.id ORDER BY "fileBytes" DESC, pages DESC`),
      all(`SELECT a.id, a.name, a.size, a.mime, a.page_id AS "pageId", p.title AS page, p.deleted_at IS NOT NULL AS trashed, a.created_at AS "createdAt"
           FROM attachments a JOIN pages p ON p.id = a.page_id ORDER BY a.size DESC LIMIT 10`),
      all(`SELECT to_char(d, 'YYYY-MM-DD') AS day, coalesce(v.edits, 0)::int AS edits, coalesce(v.editors, 0)::int AS editors
           FROM generate_series(current_date - 13, current_date, interval '1 day') d
           LEFT JOIN (SELECT created_at::date AS day, count(*) AS edits, count(DISTINCT author_id) AS editors
                      FROM page_versions WHERE created_at > current_date - 13 GROUP BY 1) v ON v.day = d::date
           ORDER BY d`),
      one(`SELECT current_setting('server_version') AS v`),
    ])
    const activeEditors = await one(`SELECT count(DISTINCT author_id)::int AS n FROM page_versions WHERE created_at > now() - interval '30 days'`)
    const bk = backups(process.env.BACKUP_DIR)
    return c.json({
      storage: {
        dbBytes: used.db,
        fileBytes: used.files,
        fileBytesBeforeDedup: Number(logical.bytes),
        usedBytes: used.db + used.files,
        limitBytes: limit,
        disk: disk(filesDir),
      },
      backups: bk && { ...bk, policy: await backupPolicy(db) },
      counts: { ...counts, activeEditors30d: activeEditors.n },
      spaces: spaces.map((s) => ({ ...s, fileBytes: Number(s.fileBytes) })),
      largestFiles: largest.map((f) => ({ ...f, size: Number(f.size) })),
      activity,
      system: {
        version: process.env.APP_VERSION ?? 'dev',
        node: process.version,
        postgres: pgVersion.v,
        uptimeSeconds: Math.round((Date.now() - started) / 1000),
      },
    })
  })

  app.put('/api/admin/backup-policy', async (c) => {
    const b = await c.req.json().catch(() => ({}))
    const int = (v: unknown, min: number, max: number) => (Number.isInteger(v) && (v as number) >= min && (v as number) <= max ? (v as number) : null)
    const p = { intervalHours: int(b.intervalHours, 1, 168), keep: int(b.keep, 1, 365), maxAgeDays: int(b.maxAgeDays, 0, 3650), manualMaxAgeDays: int(b.manualMaxAgeDays, 0, 3650) }
    if (Object.values(p).some((v) => v === null)) return fail(c, 400, 'bad_request')
    await db.query(
      `INSERT INTO settings (key, value) VALUES ('backup', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [JSON.stringify(p)],
    )
    return c.json(p)
  })

  app.put('/api/admin/settings', async (c) => {
    const b = await c.req.json().catch(() => ({}))
    if (!('storageLimitGb' in b)) return fail(c, 400, 'bad_request')
    const gb = b.storageLimitGb
    if (gb === null || gb === '') {
      await db.query(`DELETE FROM settings WHERE key = 'storage_limit_bytes'`)
      return c.json({ limitBytes: null })
    }
    if (typeof gb !== 'number' || !Number.isFinite(gb) || gb <= 0 || gb > 1_000_000) return fail(c, 400, 'bad_request')
    const bytes = Math.round(gb * GB)
    await db.query(
      `INSERT INTO settings (key, value) VALUES ('storage_limit_bytes', $1::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [JSON.stringify(bytes)],
    )
    return c.json({ limitBytes: bytes })
  })
}

/** Uploads are refused once the limit would be passed. Text edits are never blocked by the limit. */
export async function uploadAllowed(db: Db, incoming: number) {
  const limit = await storageLimit(db)
  if (limit === null) return true
  const u = await usedBytes(db)
  return u.db + u.files + incoming <= limit
}
