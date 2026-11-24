import pg from 'pg'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// BIGINT ids come back as strings by default; ours stay far below 2^53.
pg.types.setTypeParser(20, Number)

export type Db = pg.Pool
const MIGRATIONS = join(import.meta.dirname, 'migrations')

export async function openDb(url: string) {
  const pool = new pg.Pool({ connectionString: url })
  // Postgres' default assumes spinning disks and then skips the trigram indexes for search
  // (40 ms instead of 0.3 ms at 3,000 pages). 1.1 is the usual value for SSD and cloud storage.
  pool.on('connect', (client) => void client.query('SET random_page_cost = 1.1').catch(() => {}))
  await migrate(pool)
  return pool
}

// Applies migrations/NNN_*.sql in order, each once. The advisory lock keeps two
// app instances starting at the same time from applying the same file twice.
async function migrate(pool: pg.Pool) {
  const client = await pool.connect()
  try {
    await client.query('SELECT pg_advisory_lock(727001)')
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())')
    const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name))
    for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
      if (done.has(file)) continue
      await client.query('BEGIN')
      try {
        await client.query(readFileSync(join(MIGRATIONS, file), 'utf8'))
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file])
        await client.query('COMMIT')
      } catch (e) {
        await client.query('ROLLBACK')
        throw new Error(`migration ${file} failed: ${(e as Error).message}`)
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(727001)').catch(() => {})
    client.release()
  }
}

export async function tx<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>) {
  const c = await pool.connect()
  try {
    await c.query('BEGIN')
    const r = await fn(c)
    await c.query('COMMIT')
    return r
  } catch (e) {
    await c.query('ROLLBACK')
    throw e
  } finally {
    c.release()
  }
}
