// Import Markdown, HTML and text files, or ZIP archives of them, as pages. Runs in the browser so every document
// goes through the same editor schema as typing it would. Never touches existing pages: it only creates new ones.
//
// Recognized ZIP layouts:
//   - Pagehouse export (pagehouse.json inside): lossless, keeps the tree, attachments and page links
//   - Notion "Markdown & CSV" export: "Page 1a2b….md" next to a "Page 1a2b…/" folder of subpages
//   - Confluence "HTML" space export: page tree rebuilt from each page's breadcrumbs, attachments/ folder
//   - any folder of .md / .html / .txt files: folders become parent pages
import { Editor } from '@tiptap/core'
import { Markdown } from '@tiptap/markdown'
import { unzipSync } from 'fflate'
import { api } from './api.ts'
import { extensions } from './editor/extensions.tsx'
import { ALERT_TO_CALLOUT } from '../server/markdown.ts'

type Json = { type: string; attrs?: Record<string, any>; content?: Json[]; text?: string; marks?: { type: string; attrs?: Record<string, any> }[] }
type Item = { path: string; data: Uint8Array }
type Doc = { key: string; path: string; title: string; parent: string | null; doc: Json; dir: string }
export type Plan = {
  kind: 'pagehouse' | 'notion' | 'confluence' | 'files'
  docs: Doc[]
  files: Map<string, Uint8Array>
  manifest?: any
  skipped: string[]
}
export type Progress = { done: number; total: number; current: string }
export type Result = { created: { id: number; title: string }[]; warnings: string[] }

const DOC_EXT = /\.(md|markdown|html?|txt)$/i
// A 2,000-page Confluence space with its attachments is ~11,000 files; leave plenty of room.
const MAX_FILES = 50_000

let converter: Editor | null = null
function editor() {
  converter ??= new Editor({ extensions: [...extensions(), Markdown], content: '' })
  return converter
}

const decode = (b: Uint8Array) => new TextDecoder().decode(b)
const norm = (p: string) => {
  const out: string[] = []
  for (const part of p.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return out.join('/')
}
const dirOf = (p: string) => p.split('/').slice(0, -1).join('/')
const baseName = (p: string) => p.split('/').pop() ?? p
const stripExt = (s: string) => s.replace(/\.[^.]+$/, '')
// Notion appends a 32-hex id to every file and folder name.
const stripNotionId = (s: string) => s.replace(/\s+[0-9a-f]{32}$/i, '')

/** Reads the chosen files; ZIPs are expanded in memory. */
export async function readFiles(files: File[]): Promise<Item[]> {
  const items: Item[] = []
  for (const f of files) {
    const data = new Uint8Array(await f.arrayBuffer())
    if (/\.zip$/i.test(f.name)) {
      const entries = unzipSync(data, { filter: (e) => !e.name.endsWith('/') && !/(^|\/)(__MACOSX|\.DS_Store)/.test(e.name) })
      for (const [path, bytes] of Object.entries(entries)) items.push({ path: norm(path), data: bytes })
    } else items.push({ path: norm(f.name), data })
    if (items.length > MAX_FILES) throw new Error(`more than ${MAX_FILES} files`)
  }
  return items
}

// ---------- converting one document ----------

function fromMarkdown(md: string): Json {
  const json = editor().markdown!.parse(md) as Json
  return alertsToCallouts(json)
}

/** "> [!WARNING]\n> text" (GitHub alerts, our own export) becomes a warning panel. */
function alertsToCallouts(node: Json): Json {
  const content = node.content?.map((c) => {
    if (c.type === 'blockquote') {
      const first = c.content?.[0]
      const lead = first?.type === 'paragraph' ? first.content?.[0] : undefined
      const m = lead?.type === 'text' ? lead.text?.match(/^\[!(NOTE|IMPORTANT|WARNING|TIP|CAUTION)\]\s*/i) : null
      if (m && first) {
        const rest = { ...lead!, text: lead!.text!.slice(m[0].length) }
        const firstPara = { ...first, content: [rest, ...(first.content ?? []).slice(1)].filter((x) => x.type !== 'text' || x.text) }
        const body = [firstPara, ...(c.content ?? []).slice(1)].filter((b) => b.type !== 'paragraph' || b.content?.length)
        return { type: 'callout', attrs: { variant: ALERT_TO_CALLOUT[m[1].toUpperCase()] }, content: body.length ? body : [{ type: 'paragraph' }] }
      }
    }
    return alertsToCallouts(c)
  })
  return content ? { ...node, content } : node
}

function fromHtml(html: string): { doc: Json; title: string | null; crumbs: string[] } {
  const dom = new DOMParser().parseFromString(html, 'text/html')
  const title = dom.querySelector('#title-text, h1#title-heading')?.textContent?.trim()
    ?? dom.title.replace(/^.*?\s:\s/, '').trim() ?? null
  // Confluence: page body lives in #main-content; breadcrumbs give the parent page.
  const crumbs = [...dom.querySelectorAll('#breadcrumbs li a')].map((a) => a.getAttribute('href') ?? '')
  const root = dom.querySelector('#main-content') ?? dom.body
  // Confluence info/note/warning/tip panels become our panels.
  for (const el of root.querySelectorAll('.confluence-information-macro')) {
    const cls = el.className
    const variant = /warning/.test(cls) ? 'danger' : /note/.test(cls) ? 'warning' : /tip/.test(cls) ? 'success' : 'info'
    const body = el.querySelector('.confluence-information-macro-body') ?? el
    const div = dom.createElement('div')
    div.setAttribute('data-callout', variant)
    div.innerHTML = body.innerHTML
    el.replaceWith(div)
  }
  // Code macros: keep the language.
  for (const pre of root.querySelectorAll('pre[data-syntaxhighlighter-params]')) {
    const lang = pre.getAttribute('data-syntaxhighlighter-params')?.match(/brush:\s*([\w+-]+)/)?.[1]
    const code = dom.createElement('code')
    if (lang) code.className = `language-${lang}`
    code.textContent = pre.textContent
    pre.replaceChildren(code)
  }
  root.querySelectorAll('script, style, .pageSection.group, #footer, .page-metadata').forEach((e) => e.remove())
  editor().commands.setContent(root.innerHTML, { emitUpdate: false })
  return { doc: editor().getJSON() as Json, title: title || null, crumbs }
}

function fromText(text: string): Json {
  const paras = text.replace(/\r\n/g, '\n').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
  return {
    type: 'doc',
    content: paras.length
      ? paras.map((p) => ({ type: 'paragraph', content: p.split('\n').flatMap((line, i) => (i ? [{ type: 'hardBreak' }, { type: 'text', text: line }] : line ? [{ type: 'text', text: line }] : [])) }))
      : [{ type: 'paragraph' }],
  }
}

/** Our export (and many others) repeat the title as the first heading; drop it so it isn't shown twice. */
function dropTitleHeading(doc: Json, title: string, headingIsTitle: boolean): { doc: Json; title: string } {
  const first = doc.content?.[0]
  if (first?.type === 'heading' && first.attrs?.level === 1) {
    const text = (first.content ?? []).map((c) => c.text ?? '').join('').trim()
    // Markdown's leading H1 is the document title; for HTML only when it repeats the <title>.
    if (text && (headingIsTitle || text === title || stripNotionId(text) === title))
      return { doc: { ...doc, content: doc.content!.length > 1 ? doc.content!.slice(1) : [{ type: 'paragraph' }] }, title: text }
  }
  return { doc, title }
}

// ---------- planning ----------

export function plan(items: Item[]): Plan {
  const files = new Map(items.map((i) => [i.path, i.data]))
  const manifestItem = items.find((i) => baseName(i.path) === 'pagehouse.json')
  if (manifestItem) {
    try {
      const manifest = JSON.parse(decode(manifestItem.data))
      if (manifest.format === 'pagehouse-export') return { kind: 'pagehouse', docs: [], files, manifest, skipped: [] }
    } catch {}
  }

  let docItems = items.filter((i) => DOC_EXT.test(i.path))
  const skipped = items.filter((i) => !DOC_EXT.test(i.path) && !/\.(png|jpe?g|gif|webp|svg|pdf|zip|csv|docx?|xlsx?|pptx?|txt|json)$/i.test(i.path)).map((i) => i.path)
  const htmlCount = docItems.filter((i) => /\.html?$/i.test(i.path)).length
  const confluence = htmlCount > 0 && docItems.some((i) => /\.html?$/i.test(i.path) && /id="breadcrumbs"|confluence/i.test(decode(i.data).slice(0, 20000)))
  // Confluence's index.html is the space overview listing, not a page.
  if (confluence && htmlCount > 1) docItems = docItems.filter((i) => baseName(i.path).toLowerCase() !== 'index.html')
  const notion = docItems.some((i) => /\s[0-9a-f]{32}\.md$/i.test(i.path))

  // A single folder wrapping everything (most ZIPs) is not a page of its own.
  const tops = new Set(docItems.map((i) => i.path.split('/')[0]))
  const strip = tops.size === 1 && docItems.every((i) => i.path.includes('/')) ? [...tops][0] + '/' : ''
  const rel = (p: string) => (strip && p.startsWith(strip) ? p.slice(strip.length) : p)

  const docs: Doc[] = []
  for (const it of docItems) {
    const name = stripNotionId(stripExt(baseName(it.path)))
    const text = decode(it.data)
    let doc: Json
    let title = name
    let parent: string | null = null
    if (/\.html?$/i.test(it.path)) {
      const h = fromHtml(text)
      doc = h.doc
      title = h.title || name.replace(/_\d+$/, '').replace(/[-_]+/g, ' ')
      const last = h.crumbs.filter((c) => c && !/index\.html?$/i.test(c)).pop()
      if (confluence && last) parent = norm(`${dirOf(it.path)}/${last}`)
    } else if (/\.txt$/i.test(it.path)) doc = fromText(text)
    else doc = fromMarkdown(text.replace(/^---\n[\s\S]*?\n---\n/, ''))
    ;({ doc, title } = dropTitleHeading(doc, title, /\.(md|markdown)$/i.test(it.path)))
    docs.push({ key: it.path, path: rel(it.path), title: title.slice(0, 500) || 'Untitled', parent, doc, dir: dirOf(it.path) })
  }

  // Folder hierarchy: "A/B.md" goes under "A.md" if it exists (Notion), otherwise under a page made for folder "A".
  if (!confluence) {
    const byPath = new Map(docs.map((d) => [stripExt(d.path), d]))
    const folders = new Map<string, Doc>()
    const folderPage = (dir: string): string | null => {
      if (!dir) return null
      const same = byPath.get(dir)
      if (same) return same.key
      if (!folders.has(dir)) {
        const f: Doc = { key: `folder:${dir}`, path: dir, title: stripNotionId(baseName(dir)), parent: null, doc: { type: 'doc', content: [{ type: 'paragraph' }] }, dir: '' }
        folders.set(dir, f)
        f.parent = folderPage(dirOf(dir))
      }
      return folders.get(dir)!.key
    }
    for (const d of docs) d.parent = folderPage(dirOf(d.path))
    docs.push(...folders.values())
  }
  // Parents first, so every page can be created under an existing one.
  const keys = new Set(docs.map((d) => d.key))
  for (const d of docs) if (d.parent && !keys.has(d.parent)) d.parent = null
  const ordered: Doc[] = []
  const seen = new Set<string>()
  const visit = (d: Doc, depth = 0) => {
    if (seen.has(d.key) || depth > 50) return
    const p = d.parent ? docs.find((x) => x.key === d.parent) : undefined
    if (p) visit(p, depth + 1)
    seen.add(d.key)
    ordered.push(d)
  }
  docs.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true })).forEach((d) => visit(d))
  return { kind: confluence ? 'confluence' : notion ? 'notion' : 'files', docs: ordered, files, skipped }
}

// ---------- running ----------

const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv', json: 'application/json', zip: 'application/zip',
}

async function uploadFile(pageId: number, name: string, data: Uint8Array) {
  const type = MIME[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream'
  const form = new FormData()
  form.append('file', new File([data as BlobPart], name, { type }))
  return api<{ url: string }>(`/api/pages/${pageId}/attachments`, { body: form })
}

/** Walks a doc and rewrites image sources and link targets with `map` (async, may upload). */
async function rewrite(node: Json, map: (url: string) => Promise<string>): Promise<Json> {
  const attrs = node.attrs ? { ...node.attrs } : undefined
  if (node.type === 'image' && attrs?.src) attrs.src = await map(attrs.src)
  const marks = node.marks ? await Promise.all(node.marks.map(async (m) => (m.type === 'link' && m.attrs?.href ? { ...m, attrs: { ...m.attrs, href: await map(m.attrs.href) } } : m))) : undefined
  const content = node.content ? await Promise.all(node.content.map((c) => rewrite(c, map))) : undefined
  return { ...node, ...(attrs && { attrs }), ...(marks && { marks }), ...(content && { content }) }
}

async function createPage(spaceId: number, parentId: number | null, title: string) {
  return api<{ id: number }>('/api/pages', { json: { spaceId, parentId, title } })
}
async function setDoc(id: number, title: string, doc: Json) {
  const page = await api<{ version: number }>(`/api/pages/${id}`)
  await api(`/api/pages/${id}`, { method: 'PUT', json: { title, doc, version: page.version } })
}

export async function run(p: Plan, spaceId: number, parentId: number | null, onProgress: (p: Progress) => void): Promise<Result> {
  const created: Result['created'] = []
  const warnings: string[] = []
  const ids = new Map<string, number>()

  if (p.kind === 'pagehouse') {
    const m = p.manifest
    const root = (m.pages[0]?.path ?? '').split('/')[0] + '/'
    const findFile = (path: string) => p.files.get(path) ?? p.files.get(path.startsWith(root) ? path : root + path)
    const pages: any[] = [...m.pages]
    const byOld = new Map<number, number>()
    // parents before children
    const ordered: any[] = []
    const add = (pg: any) => {
      if (ordered.includes(pg)) return
      const parent = pages.find((x) => x.id === pg.parentId)
      if (parent) add(parent)
      ordered.push(pg)
    }
    pages.forEach(add)
    const total = ordered.length
    for (const [i, pg] of ordered.entries()) {
      onProgress({ done: i, total, current: pg.title })
      const page = await createPage(spaceId, pg.parentId ? byOld.get(pg.parentId) ?? parentId : parentId, pg.title)
      byOld.set(pg.id, page.id)
      created.push({ id: page.id, title: pg.title })
    }
    const fileUrl = new Map<number, string>()
    for (const [i, pg] of ordered.entries()) {
      onProgress({ done: i, total, current: pg.title })
      const newId = byOld.get(pg.id)!
      const doc = await rewrite(pg.doc, async (u) => {
        const f = u.match(/^\/api\/files\/(\d+)$/)
        if (f) {
          const old = Number(f[1])
          if (!fileUrl.has(old)) {
            const att = m.attachments.find((a: any) => a.id === old)
            const data = att && findFile(att.path)
            if (!data) return (warnings.push(`${pg.title}: missing file ${att?.name ?? old}`), u)
            fileUrl.set(old, (await uploadFile(newId, att.name, data)).url)
          }
          return fileUrl.get(old)!
        }
        const link = u.match(/#\/p\/(\d+)$/)
        if (link && byOld.has(Number(link[1]))) return `#/p/${byOld.get(Number(link[1]))}`
        return u
      })
      await setDoc(newId, pg.title, doc)
    }
    onProgress({ done: total, total, current: '' })
    return { created, warnings }
  }

  const total = p.docs.length
  for (const [i, d] of p.docs.entries()) {
    onProgress({ done: i, total, current: d.title })
    try {
      const page = await createPage(spaceId, d.parent ? ids.get(d.parent) ?? parentId : parentId, d.title)
      ids.set(d.key, page.id)
      created.push({ id: page.id, title: d.title })
      const uploaded = new Map<string, string>()
      const doc = await rewrite(d.doc, async (u) => {
        if (/^(https?:|mailto:|#|\/api\/)/i.test(u)) return u
        if (u.startsWith('data:image/')) {
          const [, type, b64] = u.match(/^data:image\/(\w+);base64,(.*)$/) ?? []
          if (!b64) return u
          const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0))
          return (await uploadFile(page.id, `image.${type}`, bytes)).url
        }
        // Relative path to a file inside the archive: upload it to this page.
        let path: string
        try {
          path = norm(`${d.dir}/${decodeURIComponent(u.split(/[?#]/)[0])}`)
        } catch {
          return u
        }
        if (uploaded.has(path)) return uploaded.get(path)!
        const data = p.files.get(path)
        if (!data) return DOC_EXT.test(path) ? u : (warnings.push(`${d.title}: “${u}” not found in the upload`), u)
        if (DOC_EXT.test(path)) return u
        const url = (await uploadFile(page.id, baseName(path), data)).url
        uploaded.set(path, url)
        return url
      })
      await setDoc(page.id, d.title, doc)
    } catch (e: any) {
      warnings.push(`${d.title}: ${e.message}`)
    }
  }
  // Links between imported pages (to .md/.html files) now point at the new pages.
  for (const d of p.docs) {
    const id = ids.get(d.key)
    if (!id) continue
    try {
      const cur = await api<{ doc: Json; title: string }>(`/api/pages/${id}`)
      const linked = await rewrite(cur.doc, async (u) => {
        if (/^(https?:|mailto:|#|\/api\/|data:)/i.test(u)) return u
        try {
          const target = ids.get(norm(`${d.dir}/${decodeURIComponent(u.split(/[?#]/)[0])}`))
          return target ? `#/p/${target}` : u
        } catch {
          return u
        }
      })
      if (JSON.stringify(linked) !== JSON.stringify(cur.doc)) await setDoc(id, cur.title, linked)
    } catch (e: any) {
      warnings.push(`${d.title}: ${e.message}`)
    }
  }
  onProgress({ done: total, total, current: '' })
  return { created, warnings }
}
