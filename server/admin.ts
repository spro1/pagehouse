// Admin monitoring: storage, backups, content and activity. Plus the storage limit that uploads respect.
import type { Hono, Context } from 'hono'
import { existsSync, readdirSync, statSync, statfsSync } from 'node:fs'
import { join } from 'node:path'
import type { Db } from './db.ts'

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

export function registerAdmin(app: Hono<any>, { db, filesDir, fail }: Deps) {
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
    return c.json({
      storage: {
        dbBytes: used.db,
        fileBytes: used.files,
        fileBytesBeforeDedup: Number(logical.bytes),
        usedBytes: used.db + used.files,
        limitBytes: limit,
        disk: disk(filesDir),
      },
      backups: backups(process.env.BACKUP_DIR),
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
