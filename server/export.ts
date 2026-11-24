// ZIP export of a page with its subpages, or a whole space: Markdown files in folders that mirror the page tree,
// the attachments next to them, and pagehouse.json with the lossless original for re-import.
import type { Hono, Context } from 'hono'
import { existsSync, readFileSync } from 'node:fs'
import { join, posix } from 'node:path'
import { zipSync, type Zippable } from 'fflate'
import type { Db } from './db.ts'
import { toMarkdown } from './markdown.ts'

type Deps = {
  db: Db
  filesDir: string
  fail: (c: Context, status: 400 | 401 | 403 | 404 | 409, code: string) => Response
  guard: (c: Context<any>, pageId: number, need: 'view' | 'edit') => Promise<Response | null>
  visibleFor: (c: Context<any>) => { sql: (alias: string, first: number) => string; params: unknown[] }
}

// File and folder names that work on Windows, macOS and Linux.
const safeName = (s: string) =>
  (s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '').trim() || 'Untitled').slice(0, 120)

type Row = { id: number; parent_id: number | null; title: string; doc: any; space_id: number; updated_at: Date; position: number }

export function registerExport(app: Hono<any>, { db, filesDir, fail, guard, visibleFor }: Deps) {
  async function build(c: Context<any>, rows: Row[], rootIds: number[], rootName: string, space: { name: string; key: string }) {
    const children = new Map<number | null, Row[]>()
    for (const r of rows) children.set(r.parent_id, [...(children.get(r.parent_id) ?? []), r])
    for (const list of children.values()) list.sort((a, b) => a.position - b.position || a.id - b.id)

    // Give every page a unique path: Folder/Title.md, its children in Folder/Title/.
    const paths = new Map<number, string>()
    const assign = (list: Row[], dir: string) => {
      const used = new Set<string>()
      for (const r of list) {
        let base = safeName(r.title)
        for (let i = 2; used.has(base.toLowerCase()); i++) base = `${safeName(r.title)} (${i})`
        used.add(base.toLowerCase())
        paths.set(r.id, posix.join(dir, `${base}.md`))
        assign(children.get(r.id) ?? [], posix.join(dir, base))
      }
    }
    assign(rows.filter((r) => rootIds.includes(r.id)), rootName)

    const ids = [...paths.keys()]
    const atts = ids.length
      ? (await db.query(`SELECT id, page_id, name, mime, sha256, size FROM attachments WHERE page_id = ANY($1::bigint[])`, [ids])).rows
      : []
    const attPath = new Map<number, string>(atts.map((a) => [Number(a.id), posix.join(rootName, '_attachments', `${a.id}-${safeName(a.name)}`)]))

    const zip: Zippable = {}
    for (const r of rows) {
      const path = paths.get(r.id)
      if (!path) continue
      const rel = (target: string) => posix.relative(posix.dirname(path), target)
      // Attachment and page links become relative paths inside the archive; everything else is kept.
      const url = (u: string) => {
        const f = u.match(/^\/api\/files\/(\d+)$/)
        if (f && attPath.has(Number(f[1]))) return encodeURI(rel(attPath.get(Number(f[1]))!))
        const pg = u.match(/^(?:.*)#\/p\/(\d+)$/)
        if (pg && paths.has(Number(pg[1]))) return encodeURI(rel(paths.get(Number(pg[1]))!))
        return u
      }
      zip[path] = [new TextEncoder().encode(toMarkdown(r.title, r.doc, url)), { level: 6 }]
    }
    let missing = 0
    for (const a of atts) {
      const file = join(filesDir, a.sha256)
      // shortcut: files are read into memory; fine for team wikis, stream the ZIP if exports reach several GB.
      if (existsSync(file)) zip[attPath.get(Number(a.id))!] = [readFileSync(file), { level: /^(image|video|audio)\/|zip|pdf/.test(a.mime) ? 0 : 6 }]
      else missing++
    }
    const manifest = {
      format: 'pagehouse-export',
      version: 1,
      exportedAt: new Date().toISOString(),
      exportedBy: c.get('user').email,
      space,
      pages: rows.filter((r) => paths.has(r.id)).map((r) => ({
        id: r.id, parentId: paths.has(r.parent_id as number) ? r.parent_id : null, title: r.title, path: paths.get(r.id), doc: r.doc, updatedAt: r.updated_at,
      })),
      attachments: atts.map((a) => ({ id: Number(a.id), pageId: Number(a.page_id), name: a.name, mime: a.mime, size: Number(a.size), path: attPath.get(Number(a.id)) })),
      missingFiles: missing,
    }
    zip[posix.join(rootName, 'pagehouse.json')] = [new TextEncoder().encode(JSON.stringify(manifest, null, 1)), { level: 6 }]
    const data = zipSync(zip)
    return new Response(data, {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(rootName)}.zip`,
        'Content-Length': String(data.byteLength),
        'Cache-Control': 'no-store',
      },
    })
  }

  // Every live page under (and including) the root, minus the ones this user can't see.
  async function subtree(c: Context<any>, where: string, params: unknown[]) {
    const v = visibleFor(c)
    const { rows } = await db.query(
      `WITH RECURSIVE t AS (
         SELECT p.* FROM pages p WHERE ${where} AND p.deleted_at IS NULL
         UNION ALL SELECT p.* FROM pages p JOIN t ON p.parent_id = t.id WHERE p.deleted_at IS NULL)
       SELECT t.id, t.parent_id, t.title, t.doc, t.space_id, t.updated_at, t.position FROM t WHERE ${v.sql('t', params.length + 1)}`,
      [...params, ...v.params],
    )
    return rows.map((r) => ({ ...r, id: Number(r.id), parent_id: r.parent_id === null ? null : Number(r.parent_id) })) as Row[]
  }

  app.get('/api/pages/:id/export', async (c) => {
    const pid = Number(c.req.param('id'))
    const denied = Number.isInteger(pid) ? await guard(c, pid, 'view') : fail(c, 404, 'page_not_found')
    if (denied) return denied
    const rows = await subtree(c, 'p.id = $1', [pid])
    const root = rows.find((r) => r.id === pid)
    if (!root) return fail(c, 404, 'page_not_found')
    const space = (await db.query('SELECT name, key FROM spaces WHERE id = $1', [root.space_id])).rows[0]
    return build(c, rows, [pid], safeName(root.title), space)
  })

  app.get('/api/spaces/:id/export', async (c) => {
    const sid = Number(c.req.param('id'))
    const space = Number.isInteger(sid) ? (await db.query('SELECT name, key FROM spaces WHERE id = $1', [sid])).rows[0] : null
    if (!space) return fail(c, 404, 'space_not_found')
    const rows = await subtree(c, 'p.space_id = $1 AND p.parent_id IS NULL', [sid])
    return build(c, rows, rows.filter((r) => r.parent_id === null).map((r) => r.id), safeName(space.name), space)
  })
}
