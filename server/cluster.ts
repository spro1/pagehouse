// Co-editing across several app instances. Each room's Yjs updates go into collab_updates and a NOTIFY tells the
// other instances, which apply them to their copy of the room; cursors (awareness) ride in the NOTIFY itself.
// Postgres is the only moving part, so there's nothing extra to run.
import pg from 'pg'
import { randomUUID } from 'node:crypto'
import type { Db } from './db.ts'
import type { Relay } from './collab.ts'

const CHANNEL = 'pagehouse_collab'
const MAX_NOTIFY = 7000 // Postgres caps a payload at 8000 bytes

/** When the relay lost its Postgres connection (0 while it's fine). /healthz fails after a minute of that. */
export let relayDownSince = 0

export async function startRelay(db: Db, url: string, collab: { setRelay: (r: Relay | null) => void; receive: (pageId: number, kind: 'u' | 'a', data: Uint8Array) => void; rooms: Map<number, unknown> }) {
  const me = randomUUID().slice(0, 8)
  let listener: pg.Client
  let closed = false
  let lastId = 0 // newest relayed update seen, to catch up after a reconnect
  let started = false
  const onNotify = async (n: pg.Notification) => {
    // payload: "<instance> <kind> <page> <row id | base64 awareness>"
    const [from, kind, page, rest] = (n.payload ?? '').split(' ')
    if (kind === 'u') lastId = Math.max(lastId, Number(rest))
    if (from === me) return
    try {
      if (kind === 'a') return collab.receive(Number(page), 'a', Buffer.from(rest, 'base64'))
      const row = (await db.query('SELECT data FROM collab_updates WHERE id = $1', [rest])).rows[0]
      if (row) collab.receive(Number(page), 'u', new Uint8Array(row.data))
    } catch (e) {
      console.error('collab relay:', (e as Error).message)
    }
  }
  // A dropped connection means this instance stops hearing the others: reconnect (backing off), then replay what
  // was missed for the rooms open here. Without that, two instances would keep saving diverging copies.
  const connect = async (attempt = 0): Promise<void> => {
    if (closed) return
    listener = new pg.Client({ connectionString: url })
    listener.on('notification', onNotify)
    listener.on('error', (e) => {
      if (closed) return
      console.error('collab relay connection lost:', e.message)
      relayDownSince ||= Date.now()
      listener.removeAllListeners('error')
      listener.on('error', () => {})
      void listener.end().catch(() => {})
      setTimeout(() => void connect(), 1000)
    })
    try {
      await listener.connect()
      await listener.query(`LISTEN ${CHANNEL}`)
      if (relayDownSince && collab.rooms.size) {
        const missed = await db.query('SELECT id, page_id, data FROM collab_updates WHERE id > $1 AND page_id = ANY($2::bigint[]) ORDER BY id', [lastId, [...collab.rooms.keys()]])
        for (const r of missed.rows) (collab.receive(Number(r.page_id), 'u', new Uint8Array(r.data)), (lastId = Math.max(lastId, Number(r.id))))
      }
      relayDownSince = 0
      started = true
    } catch (e) {
      relayDownSince ||= Date.now()
      if (!started) throw e // the very first connect failing is a startup error
      console.error('collab relay reconnect failed:', (e as Error).message)
      setTimeout(() => void connect(attempt + 1), Math.min(30_000, 1000 * 2 ** attempt))
    }
  }
  await connect()
  const notify = (payload: string) => db.query('SELECT pg_notify($1, $2)', [CHANNEL, payload])
  collab.setRelay({
    publish(pageId, kind, data) {
      const p = kind === 'a'
        ? (() => { const b = Buffer.from(data).toString('base64'); return b.length < MAX_NOTIFY ? notify(`${me} a ${pageId} ${b}`) : undefined })()
        : db.query('INSERT INTO collab_updates (page_id, data) VALUES ($1, $2) RETURNING id', [pageId, Buffer.from(data)])
            .then((r) => notify(`${me} u ${pageId} ${r.rows[0].id}`))
      p?.catch((e) => console.error('collab relay:', e.message))
    },
    backlog: async (pageId) => (await db.query('SELECT data FROM collab_updates WHERE page_id = $1 ORDER BY id', [pageId])).rows.map((r) => new Uint8Array(r.data)),
  })
  // Relayed updates are only needed until every room has them saved; an hour is far past the 10-second save.
  // shortcut: a room whose saves keep failing for over an hour would lose that history for newly opened copies.
  const timer = setInterval(() => void db.query("DELETE FROM collab_updates WHERE created_at < now() - interval '1 hour'").catch(() => {}), 60_000)
  timer.unref()
  return async () => {
    closed = true
    clearInterval(timer)
    collab.setRelay(null)
    await listener.end().catch(() => {})
  }
}
