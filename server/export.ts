// ZIP export of a page with its subpages, or a whole space: Markdown files in folders that mirror the page tree,
// the attachments next to them, and pagehouse.json with the lossless original for re-import.
import type { Hono, Context } from 'hono'
import { createReadStream, existsSync } from 'node:fs'
import { join, posix } from 'node:path'
import { Zip, ZipDeflate, ZipPassThrough, type Zippable } from 'fflate'
import type { Db } from './db.ts'
import { toMarkdown } from './markdown.ts'
import { EXPORT_CSS, toHtmlPage, type NavItem } from './html.ts'

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
  async function build(c: Context<any>, rows: Row[], rootIds: number[], rootName: string, space: { name: string; key: string }, format: 'md' | 'html') {
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
        paths.set(r.id, posix.join(dir, `${base}.${format}`))
        assign(children.get(r.id) ?? [], posix.join(dir, base))
      }
    }
    assign(rows.filter((r) => rootIds.includes(r.id)), rootName)

    const byId = new Map(rows.map((r) => [r.id, r]))
    const ancestors = (r: Row) => {
      const out: Row[] = []
      for (let p = byId.get(r.parent_id as number); p && paths.has(p.id); p = byId.get(p.parent_id as number)) out.unshift(p)
      return out
    }
    const rootRows = rows.filter((r) => rootIds.includes(r.id)).sort((a, b) => a.position - b.position || a.id - b.id)
    const navFor = (list: Row[], current: number, rel: (p: string) => string): NavItem[] =>
      list.map((r) => ({ title: r.title, href: encodeURI(rel(paths.get(r.id)!)), current: r.id === current, children: navFor(children.get(r.id) ?? [], current, rel) }))
    const cssPath = posix.join(rootName, 'style.css')
    const indexPath = posix.join(rootName, 'index.html')

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
      const text = format === 'md' ? toMarkdown(r.title, r.doc, url) : toHtmlPage({
        title: r.title, doc: r.doc, url, space: space.name, updated: r.updated_at, css: rel(cssPath), home: rel(indexPath),
        crumbs: ancestors(r).map((a) => ({ title: a.title, href: encodeURI(rel(paths.get(a.id)!)) })),
        nav: navFor(rootRows, r.id, rel),
      })
      zip[path] = [new TextEncoder().encode(text), { level: 6 }]
    }
    if (format === 'html') {
      // Opening the folder in a browser starts at index.html: the space's page tree.
      zip[cssPath] = [new TextEncoder().encode(EXPORT_CSS), { level: 6 }]
      zip[indexPath] = [new TextEncoder().encode(toHtmlPage({
        title: space.name, doc: { type: 'doc', content: [] }, url: (u) => u, space: space.name, css: 'style.css', home: 'index.html', crumbs: [],
        nav: navFor(rootRows, -1, (p) => posix.relative(rootName, p)),
      })), { level: 6 }]
    }
    // Attachments are streamed into the archive below, not read into memory: a space can hold gigabytes.
    const present = atts.filter((a) => existsSync(join(filesDir, a.sha256)))
    const missing = atts.length - present.length
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
    const body = new ReadableStream<Uint8Array>({
      async start(out) {
        const z = new Zip((err, chunk, final) => (err ? out.error(err) : (out.enqueue(chunk), final && out.close())))
        // Wait while the reader is behind, so a slow download doesn't pile the whole archive up in memory.
        const drain = async () => { while ((out.desiredSize ?? 1) <= 0) await new Promise((r) => setTimeout(r, 20)) }
        const entry = (name: string, level: number) => {
          const f = level ? new ZipDeflate(name, { level: level as 6 }) : new ZipPassThrough(name)
          z.add(f)
          return f
        }
        try {
          for (const [name, v] of Object.entries(zip)) {
            const [data, opts] = v as [Uint8Array, { level: number }]
            entry(name, opts.level).push(data, true)
            await drain()
          }
          for (const a of present) {
            // Already-compressed media go in as they are.
            const f = entry(attPath.get(Number(a.id))!, /^(image|video|audio)\/|zip|pdf/.test(a.mime) ? 0 : 6)
            for await (const chunk of createReadStream(join(filesDir, a.sha256))) (f.push(chunk as Uint8Array), await drain())
            f.push(new Uint8Array(0), true)
          }
          z.end()
        } catch (e) {
          out.error(e)
        }
      },
    }, { highWaterMark: 16 })
    return new Response(body, {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(format === 'html' ? `${rootName}-html` : rootName)}.zip`,
        'Cache-Control': 'no-store',
      },
    })
  }

  const fmt = (c: Context<any>) => (c.req.query('format') === 'html' ? 'html' : 'md')

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
    return build(c, rows, [pid], safeName(root.title), space, fmt(c))
  })

  app.get('/api/spaces/:id/export', async (c) => {
    const sid = Number(c.req.param('id'))
    const space = Number.isInteger(sid) ? (await db.query('SELECT name, key FROM spaces WHERE id = $1', [sid])).rows[0] : null
    if (!space) return fail(c, 404, 'space_not_found')
    const rows = await subtree(c, 'p.space_id = $1 AND p.parent_id IS NULL', [sid])
    return build(c, rows, rows.filter((r) => r.parent_id === null).map((r) => r.id), safeName(space.name), space, fmt(c))
  })
}
