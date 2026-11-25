// Import Markdown, HTML and text files, or ZIP archives of them, as pages. Runs in the browser so every document
// goes through the same editor schema as typing it would. Never touches existing pages: it only creates new ones.
//
// Recognized ZIP layouts:
//   - Pagehouse export (pagehouse.json inside): lossless, keeps the tree, attachments and page links
//   - Notion "Markdown & CSV" export: "Page 1a2b….md" next to a "Page 1a2b…/" folder of subpages
//   - Confluence "HTML" space export: page tree rebuilt from each page's breadcrumbs, attachments/ folder
//   - Confluence Cloud "CSV" space export (content.csv, bodycontent.csv, attachments/): see confluenceCsv.ts
//   - any folder of .md / .html / .txt files: folders become parent pages
import { Editor } from '@tiptap/core'
import { Markdown } from '@tiptap/markdown'
import { gunzipSync, unzipSync } from 'fflate'
import { parseCsv, planCsv } from './confluenceCsv.ts'
import { api } from './api.ts'
import { extensions } from './editor/extensions.tsx'
import { ALERT_TO_CALLOUT } from '../server/markdown.ts'
import { t } from './i18n.ts'

const ATTACHMENTS_HEADING = () => t('import.attachments')

type Json = { type: string; attrs?: Record<string, any>; content?: Json[]; text?: string; marks?: { type: string; attrs?: Record<string, any> }[] }
// Documents are read up front; other files (attachments, often most of the size) only when uploaded.
type Item = { path: string; data?: Uint8Array; load: () => Promise<Uint8Array> }
type Doc = {
  key: string; path: string; title: string; parent: string | null; doc: Json; dir: string
  kind?: 'page' | 'folder'
  /** upload path → the file's real name (Confluence stores attachments under numeric names) */
  names?: Map<string, string>
  labels?: string[]
}
export type Plan = {
  kind: 'pagehouse' | 'notion' | 'confluence' | 'confluence-csv' | 'files'
  docs: Doc[]
  files: Map<string, () => Promise<Uint8Array>>
  manifest?: any
  skipped: string[]
  /** things the import can't carry over, shown before starting */
  notes?: string[]
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

const utf8 = new TextDecoder('utf-8', { fatal: true })
const cp949 = new TextDecoder('euc-kr')
/** UTF-8, or Korean Windows' CP949 (EUC-KR) when the bytes aren't valid UTF-8 (Notepad, older Office exports). */
const decode = (b: Uint8Array) => {
  try {
    return utf8.decode(b).replace(/^\uFEFF/, '')
  } catch {
    return cp949.decode(b)
  }
}
/** ZIPs made by Windows' built-in compression store Korean names in CP949 without the UTF-8 flag; fflate then reads
 *  them as Latin-1. Recover the bytes and decode them properly. */
const fixName = (name: string) => {
  if (!/[\u0080-\u00ff]/.test(name) || /[^\u0000-\u00ff]/.test(name)) return name
  return decode(Uint8Array.from(name, (c) => c.charCodeAt(0)))
}
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

// Read up front: the documents and the tables/manifests that describe them.
const EAGER = /\.(md|markdown|html?|txt|csv|csv\.gz|json)$/i
const junk = (p: string) => /(^|\/)(__MACOSX|\.DS_Store)/.test(p)

/** Reads the chosen files (or a chosen folder). ZIPs are opened in memory, but attachments inside are only
 *  decompressed when they're uploaded, so a large export (hundreds of MB of attachments) stays workable. */
export async function readFiles(files: File[]): Promise<Item[]> {
  const items: Item[] = []
  for (const f of files) {
    const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name
    if (junk(rel)) continue
    if (/\.zip$/i.test(f.name)) {
      const zip = new Uint8Array(await f.arrayBuffer())
      const lazy: string[] = []
      const eager = unzipSync(zip, {
        filter: (e) => {
          if (e.name.endsWith('/') || junk(e.name)) return false
          if (EAGER.test(e.name)) return true
          lazy.push(e.name)
          return false
        },
      })
      for (const [name, bytes] of Object.entries(eager)) items.push({ path: norm(fixName(name)), data: bytes, load: async () => bytes })
      for (const name of lazy) items.push({ path: norm(fixName(name)), load: async () => unzipSync(zip, { filter: (e) => e.name === name })[name] })
    } else {
      const data = EAGER.test(rel) ? new Uint8Array(await f.arrayBuffer()) : undefined
      items.push({ path: norm(rel), data, load: async () => data ?? new Uint8Array(await f.arrayBuffer()) })
    }
    if (items.length > MAX_FILES) throw new Error(`more than ${MAX_FILES} files`)
  }
  return items
}

// ---------- converting one document ----------

/** Pairs the ** markers on a line in order; spaces just inside a pair move outside it ("**a: **b" → "**a:** b"). */
function tightenBold(line: string) {
  const parts = line.split('**')
  if (parts.length < 3) return line
  let out = parts[0]
  for (let i = 1; i < parts.length; i++) {
    if (i % 2 === 1 && i + 1 < parts.length) {
      const inner = parts[i]
      const core = inner.trim()
      out += core ? `${inner.match(/^\s*/)![0]}**${core}**${inner.match(/\s*$/)![0]}` : `**${inner}**`
      out += parts[++i]
    } else out += '**' + parts[i]
  }
  return out
}

function fromMarkdown(md: string): Json {
  md = md
    // "**label: **" (Confluence, Google Docs): spaces just inside the markers stop Markdown seeing bold; move them out.
    .split(/(^```[\s\S]*?^```)/m)
    .map((part, i) => (i % 2 ? part : part.split('\n').map(tightenBold).join('\n')))
    .join('')
    // Obsidian / wiki style: ![[image.png]], [[Page]], [[Page|label]], [[Page#Heading]]
    .replace(/!\[\[([^\]|]+?)(?:\|[^\]]*)?\]\]/g, (_, f) => `![](<${f.trim()}>)`)
    .replace(/\[\[([^\]|#]+?)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g, (_, page, label) => `[${(label ?? page).trim()}](<#wiki:${encodeURIComponent(page.trim())}>)`)
    // <details><summary>Title</summary>body</details> → the title in bold, then the body (no fold in the editor).
    .replace(/<details[^>]*>\s*<summary[^>]*>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/gi, (_, s, b) => `\n**${s.trim()}**\n\n${b.trim()}\n`)
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
  // The export writes "Space name : Page title"; the space name is also the first breadcrumb.
  const space = dom.querySelector('#breadcrumbs li:first-child a')?.textContent?.trim()
  const raw = (dom.querySelector('#title-text, h1#title-heading')?.textContent ?? dom.title).replace(/\s+/g, ' ').trim()
  const title = (space && raw.startsWith(`${space} : `) ? raw.slice(space.length + 3) : raw).trim() || null
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
  confluenceMacros(dom, root)
  // Files attached to the page but not shown in it are listed under "Attachments" outside #main-content.
  const shown = new Set([...root.querySelectorAll('img[src], a[href]')].map((e) => e.getAttribute('src') ?? e.getAttribute('href')))
  const attached = [...dom.querySelectorAll('.pageSection.group .greybox a[href^="attachments/"]')]
    .filter((a) => !shown.has(a.getAttribute('href')))
  if (attached.length) {
    const ul = dom.createElement('ul')
    for (const a of attached) {
      const li = dom.createElement('li')
      const link = dom.createElement('a')
      link.setAttribute('href', a.getAttribute('href')!)
      link.textContent = a.textContent?.trim() || a.getAttribute('href')!
      li.append(link)
      ul.append(li)
    }
    const h = dom.createElement('h3')
    h.textContent = ATTACHMENTS_HEADING()
    root.append(h, ul)
  }
  root.querySelectorAll('script, style, .pageSection.group, #footer, .page-metadata').forEach((e) => e.remove())
  editor().commands.setContent(root.innerHTML, { emitUpdate: false })
  return { doc: editor().getJSON() as Json, title: title || null, crumbs }
}

/** Confluence macros that have an equivalent here become it; the rest keep their text. */
function confluenceMacros(dom: Document, root: Element) {
  const el = (tag: string, html = '', attrs: Record<string, string> = {}) => {
    const e = dom.createElement(tag)
    e.innerHTML = html
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v)
    return e
  }
  // Generated or interactive bits with nothing to keep.
  root.querySelectorAll('.toc-macro, .client-side-toc-macro, .plugin_pagetree, .recently-updated, .children-display').forEach((e) => e.remove())
  // Panels → info panel, with their title as a bold first line.
  for (const p of root.querySelectorAll('.panel:not(.code)')) {
    const title = p.querySelector('.panelHeader')?.textContent?.trim()
    const body = p.querySelector('.panelContent')?.innerHTML ?? p.innerHTML
    p.replaceWith(el('div', (title ? `<p><strong>${escapeHtml(title)}</strong></p>` : '') + body, { 'data-callout': 'info' }))
  }
  // Expand: the content is shown, under its title in bold.
  for (const x of root.querySelectorAll('.expand-container')) {
    const title = x.querySelector('.expand-control-text')?.textContent?.trim()
    const body = x.querySelector('.expand-content')?.innerHTML ?? ''
    x.replaceWith(el('div', (title ? `<p><strong>${escapeHtml(title)}</strong></p>` : '') + body))
  }
  // Status lozenges → highlighted text.
  for (const st of root.querySelectorAll('.status-macro')) st.replaceWith(el('mark', escapeHtml(st.textContent?.trim() ?? '')))
  // @mentions of Confluence users → plain "@Name" (accounts don't carry over).
  for (const u of root.querySelectorAll('a.confluence-userlink, a.user-mention')) u.replaceWith(dom.createTextNode(`@${u.textContent?.trim() ?? ''}`))
  // Emoticons → their text.
  for (const img of root.querySelectorAll('img.emoticon')) img.replaceWith(dom.createTextNode(img.getAttribute('data-emoji-fallback') ?? img.getAttribute('alt') ?? ''))
  // Task lists → our checklists.
  for (const ul of root.querySelectorAll('ul.inline-task-list')) {
    ul.setAttribute('data-type', 'taskList')
    for (const li of ul.querySelectorAll(':scope > li')) {
      li.setAttribute('data-type', 'taskItem')
      li.setAttribute('data-checked', String(li.classList.contains('checked')))
      if (!li.querySelector(':scope > p')) li.innerHTML = `<p>${li.innerHTML}</p>`
    }
  }
  // Jira issue macros → a link to the issue.
  for (const j of root.querySelectorAll('.jira-issue')) {
    const a = j.querySelector('a[href]')
    if (a) j.replaceWith(el('a', escapeHtml(j.textContent?.replace(/\s+/g, ' ').trim() ?? ''), { href: a.getAttribute('href')! }))
  }
}
const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

/** Confluence's index.html lists every page as a nested tree: the true parent and sibling order. */
function confluenceTree(html: string, dir: string): Map<string, { parent: string | null; order: number }> {
  const dom = new DOMParser().parseFromString(html, 'text/html')
  const out = new Map<string, { parent: string | null; order: number }>()
  let order = 0
  const walk = (ul: Element, parent: string | null) => {
    for (const li of ul.querySelectorAll(':scope > li')) {
      const href = li.querySelector(':scope > a[href]')?.getAttribute('href')
      const key = href ? norm(`${dir}/${href}`) : null
      if (key) out.set(key, { parent, order: order++ })
      for (const sub of li.querySelectorAll(':scope > ul')) walk(sub, key ?? parent)
    }
  }
  const top = dom.querySelector('#content ul, .pageSection ul, body ul')
  if (top) walk(top, null)
  return out
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
  const files = new Map(items.map((i) => [i.path, i.load]))
  const manifestItem = items.find((i) => baseName(i.path) === 'pagehouse.json')
  if (manifestItem?.data) {
    try {
      const manifest = JSON.parse(decode(manifestItem.data))
      if (manifest.format === 'pagehouse-export') return { kind: 'pagehouse', docs: [], files, manifest, skipped: [] }
    } catch {}
  }

  const csv = csvPlan(items, files)
  if (csv) return csv

  let docItems = items.filter((i) => DOC_EXT.test(i.path) && i.data) as (Item & { data: Uint8Array })[]
  const skipped = items.filter((i) => !DOC_EXT.test(i.path) && !/\.(png|jpe?g|gif|webp|svg|pdf|zip|csv|docx?|xlsx?|pptx?|txt|json)$/i.test(i.path)).map((i) => i.path)
  const htmlCount = docItems.filter((i) => /\.html?$/i.test(i.path)).length
  const confluence = htmlCount > 0 && docItems.some((i) => /\.html?$/i.test(i.path) && /id="breadcrumbs"|confluence/i.test(decode(i.data).slice(0, 20000)))
  // Confluence's index.html is the space overview listing, not a page; its tree gives parents and order.
  const indexItem = confluence ? docItems.find((i) => baseName(i.path).toLowerCase() === 'index.html') : undefined
  const tree = indexItem ? confluenceTree(decode(indexItem.data), dirOf(indexItem.path)) : new Map()
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
      if (confluence) parent = tree.get(it.path)?.parent ?? (last ? norm(`${dirOf(it.path)}/${last}`) : null)
    } else if (/\.txt$/i.test(it.path)) doc = fromText(text)
    else {
      const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/)
      const fmTitle = fm?.[1].match(/^title:\s*["']?(.+?)["']?\s*$/m)?.[1]
      if (fmTitle) title = fmTitle
      doc = fromMarkdown(fm ? text.slice(fm[0].length) : text)
    }
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
  // Confluence keeps its own page order; everything else sorts by name.
  const rank = (d: Doc) => tree.get(d.key)?.order ?? Number.MAX_SAFE_INTEGER
  docs.sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path, undefined, { numeric: true })).forEach((d) => visit(d))
  return { kind: confluence ? 'confluence' : notion ? 'notion' : 'files', docs: ordered, files, skipped }
}

/** Confluence Cloud CSV export: content.csv and bodycontent.csv side by side (".csv.gz" names, gzipped or not). */
function csvPlan(items: Item[], files: Plan['files']): Plan | null {
  const table = (name: string) => {
    const it = items.find((i) => i.data && new RegExp(`(^|/)${name}\\.csv(\\.gz)?$`, 'i').test(i.path))
    if (!it?.data) return undefined
    const bytes = it.data[0] === 0x1f && it.data[1] === 0x8b ? gunzipSync(it.data) : it.data
    return parseCsv(decode(bytes))
  }
  const content = table('content')
  const bodies = table('bodycontent')
  if (!content || !bodies) return null
  // Paths in the upload are relative to the folder holding content.csv.
  const base = dirOf(items.find((i) => /(^|\/)content\.csv(\.gz)?$/i.test(i.path))!.path)
  const at = (p: string) => (base ? `${base}/${p}` : p)
  const unknown = new Map<string, number>()
  const pages = planCsv({ content, bodies, labels: table('label'), contentLabels: table('content_label') }, unknown, t('import.csv.user'))
  const docs: Doc[] = pages.map((p) => {
    let html = p.html
    if (p.unused.length)
      html += `<h3>${escapeHtml(ATTACHMENTS_HEADING())}</h3><ul>${p.unused.map((n) => `<li><a href="${escapeHtml(at(p.files.get(n)!))}">${escapeHtml(n)}</a></li>`).join('')}</ul>`
    // Attachment paths in the body are relative to the export root; make them relative to the upload.
    html = html.replace(/(src|href)="attachments\//g, `$1="${at('attachments/')}`)
    editor().commands.setContent(html || '<p></p>', { emitUpdate: false })
    const names = new Map([...p.files].map(([n, path]) => [norm(at(path)), n]))
    return { key: `csv:${p.id}`, path: p.title, title: p.title.slice(0, 500), parent: p.parent && `csv:${p.parent}`, doc: editor().getJSON() as Json, dir: '', kind: p.kind, names, labels: p.labels }
  })
  // Parents first; siblings in Confluence's order.
  const kids = new Map<string | null, Doc[]>()
  const pos = new Map(pages.map((p) => [`csv:${p.id}`, p.position]))
  for (const d of docs) kids.set(d.parent, [...(kids.get(d.parent) ?? []), d])
  const ordered: Doc[] = []
  const walk = (parent: string | null) =>
    (kids.get(parent) ?? []).sort((a, b) => pos.get(a.key)! - pos.get(b.key)! || a.title.localeCompare(b.title)).forEach((d) => (ordered.push(d), walk(d.key)))
  walk(null)
  return { kind: 'confluence-csv', docs: ordered, files, skipped: [], notes: [...unknown].map(([n, c]) => `${n} ×${c}`) }
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

async function createPage(spaceId: number, parentId: number | null, title: string, kind: 'page' | 'folder' = 'page') {
  return api<{ id: number }>('/api/pages', { json: { spaceId, parentId, title, kind } })
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
            const load = att && findFile(att.path)
            if (!load) return (warnings.push(`${pg.title}: missing file ${att?.name ?? old}`), u)
            fileUrl.set(old, (await uploadFile(newId, att.name, await load())).url)
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
      const page = await createPage(spaceId, d.parent ? ids.get(d.parent) ?? parentId : parentId, d.title, d.kind)
      ids.set(d.key, page.id)
      created.push({ id: page.id, title: d.title })
      const uploaded = new Map<string, string>()
      const doc = await rewrite(d.doc, async (u) => {
        // Any URL scheme (https:, ftp:, mailto:, smb:, …) points outside the upload.
        if (/^([a-z][a-z0-9+.-]*:|#|\/api\/)/i.test(u) && !u.startsWith('data:')) return u
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
        const load = p.files.get(path)
        if (!load) return DOC_EXT.test(path) ? u : (warnings.push(`${d.title}: “${u}” not found in the upload`), u)
        if (DOC_EXT.test(path)) return u
        const name = d.names?.get(path) ?? baseName(path)
        try {
          const url = (await uploadFile(page.id, name, await load())).url
          uploaded.set(path, url)
          return url
        } catch (e: any) {
          // One file that can't be uploaded (too big, storage full) mustn't cost the page its text.
          warnings.push(`${d.title}: ${name} — ${e.message}`)
          uploaded.set(path, u)
          return u
        }
      })
      if (d.kind !== 'folder') await setDoc(page.id, d.title, doc)
      if (d.labels?.length) await api(`/api/pages/${page.id}/labels`, { method: 'PUT', json: { labels: d.labels } })
    } catch (e: any) {
      warnings.push(`${d.title}: ${e.message}`)
    }
  }
  // Links between imported pages (to .md/.html files, or [[wiki links]] by name) now point at the new pages.
  const byName = new Map<string, number>()
  for (const d of p.docs) {
    const id = ids.get(d.key)
    if (!id) continue
    for (const n of [d.title, stripNotionId(stripExt(baseName(d.path)))]) if (!byName.has(n.toLowerCase())) byName.set(n.toLowerCase(), id)
  }
  // "#wiki:Title" is a link by page name (the editor only keeps links with known schemes, so it rides on "#").
  const internal = /"href":"(?!https?:|mailto:|#(?!wiki:)|\/api\/|data:)/
  for (const d of p.docs) {
    const id = ids.get(d.key)
    // Only pages that link to other files need a second look; the rest are done.
    if (!id || !internal.test(JSON.stringify(d.doc))) continue
    try {
      const cur = await api<{ doc: Json; title: string }>(`/api/pages/${id}`)
      const linked = await rewrite(cur.doc, async (u) => {
        if (u.startsWith('#wiki:')) {
          const name = decodeURIComponent(u.slice(6))
          const target = byName.get(name.toLowerCase())
          // A page that wasn't in the upload: search for it instead of a dead link.
          return target ? `#/p/${target}` : `#/search?q=${encodeURIComponent(name)}`
        }
        if (/^([a-z][a-z0-9+.-]*:|#|\/api\/)/i.test(u)) return u
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
