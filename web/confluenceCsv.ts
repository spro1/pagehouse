// Confluence Cloud "CSV" space export: the space's database tables (content.csv, bodycontent.csv, …) plus
// attachments/{page id}/{attachment id}/{version}. Page bodies are Confluence's own storage format (XHTML with
// ac:/ri: macro tags), so this converts them straight to the editor's HTML — more faithful than the HTML export.
// Only the current version of each page, folder and attachment is used; history, comments and authors stay behind.

export type CsvTable = Record<string, string>[]

/** RFC 4180 CSV: quoted fields may hold commas, doubled quotes and line breaks. */
export function parseCsv(text: string): CsvTable {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') (field += '"'), i++
        else quoted = false
      } else field += c
    } else if (c === '"') quoted = true
    else if (c === ',') (row.push(field), (field = ''))
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      ;(row = []), (field = '')
    } else field += c
  }
  if (field || row.length) (row.push(field), rows.push(row))
  const [head, ...body] = rows
  return body.filter((r) => r.length > 1 || r[0]).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])))
}

export type CsvPage = {
  id: string; parent: string | null; kind: 'page' | 'folder'; title: string; position: number; html: string
  /** attachment file name → path of its bytes in the upload */
  files: Map<string, string>
  /** attached files the body doesn't show or link */
  unused: string[]
  labels: string[]
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

/** Turns the tables into pages, parents before children isn't guaranteed: the caller orders them. */
export function planCsv(t: { content: CsvTable; bodies: CsvTable; labels?: CsvTable; contentLabels?: CsvTable }, unknown: Map<string, number>, user?: string): CsvPage[] {
  const live = (r: Record<string, string>) => r.content_status === 'current' && !r.prevver
  const pages = t.content.filter((r) => live(r) && (r.contenttype === 'PAGE' || r.contenttype === 'FOLDER' || r.contenttype === 'BLOGPOST'))
  const ids = new Set(pages.map((p) => p.contentid))
  const body = new Map(t.bodies.filter((b) => b.bodytypeid === '2').map((b) => [b.contentid, b.body]))
  // Attachments: the newest version of each, by page.
  const files = new Map<string, Map<string, string>>()
  for (const a of t.content.filter((r) => r.contenttype === 'ATTACHMENT' && live(r) && ids.has(r.pageid))) {
    if (a.title.startsWith('~drawio~')) continue // drawio's autosave scratch files
    if (!files.has(a.pageid)) files.set(a.pageid, new Map())
    files.get(a.pageid)!.set(a.title, `attachments/${a.pageid}/${a.contentid}/${a.version}`)
  }
  const labelName = new Map((t.labels ?? []).filter((l) => l.namespace === 'global').map((l) => [l.labelid, l.name]))
  const labels = new Map<string, string[]>()
  for (const cl of t.contentLabels ?? []) {
    const name = labelName.get(cl.labelid)
    if (name && ids.has(cl.contentid)) labels.set(cl.contentid, [...(labels.get(cl.contentid) ?? []), name])
  }
  // The Jira site, for issue macros: Confluence Cloud lives at <site>/wiki, Jira at <site>.
  let jira: string | undefined
  for (const b of body.values()) {
    const m = b.match(/https:\/\/[\w.-]+\.atlassian\.net(?=\/wiki)/)
    if (m) (jira = m[0])
    if (jira) break
  }
  return pages.map((p) => {
    const own = files.get(p.contentid) ?? new Map<string, string>()
    const used = new Set<string>()
    const html = p.contenttype === 'FOLDER' ? '' : storageToHtml(body.get(p.contentid) ?? '', { jira, files: own, used, unknown, user })
    return {
      id: p.contentid,
      parent: p.parentid && ids.has(p.parentid) ? p.parentid : null,
      kind: p.contenttype === 'FOLDER' ? 'folder' : 'page',
      title: p.title || 'Untitled',
      position: p.child_position === '' ? Number.MAX_SAFE_INTEGER : Number(p.child_position),
      html,
      files: own,
      unused: [...own.keys()].filter((n) => !used.has(n) && !(n.endsWith('.drawio') && own.has(`${n}.png`))),
      labels: labels.get(p.contentid) ?? [],
    }
  })
}

type Ctx = { jira?: string; files: Map<string, string>; used: Set<string>; unknown: Map<string, number>; user?: string }

/** Confluence storage format → HTML the editor understands. */
export function storageToHtml(src: string, ctx: Ctx): string {
  // CDATA (code bodies) means nothing to the HTML parser, and neither do self-closing custom tags: fix both first.
  src = src
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, s: string) => esc(s))
    .replace(/<((?:ac|ri):[\w-]+)((?:\s[^>]*?)?)\s*\/>/g, '<$1$2></$1>')
  const dom = new DOMParser().parseFromString(`<body>${src}</body>`, 'text/html')
  const root = dom.body
  const all = (el: Element | Document, tag: string) => [...el.getElementsByTagName(tag)]
  const kids = (el: Element, tag: string) => [...el.children].filter((c) => c.tagName.toLowerCase() === tag)
  const param = (m: Element, name: string) => kids(m, 'ac:parameter').find((p) => p.getAttribute('ac:name') === name)
  const make = (tag: string, html = '', attrs: Record<string, string> = {}) => {
    const e = dom.createElement(tag)
    e.innerHTML = html
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v)
    return e
  }
  const file = (name: string | null | undefined) => {
    if (!name) return undefined
    const path = ctx.files.get(name)
    if (path) ctx.used.add(name)
    return path
  }
  const rich = (m: Element) => kids(m, 'ac:rich-text-body')[0]?.innerHTML ?? ''
  const titled = (title: string | undefined, html: string) => (title ? `<p><strong>${esc(title)}</strong></p>` : '') + html

  // Innermost macros first, so a panel's body is already converted when the panel is.
  for (const m of all(root, 'ac:structured-macro').reverse()) {
    const name = m.getAttribute('ac:name') ?? ''
    const text = (p: string) => param(m, p)?.textContent?.trim() ?? ''
    let out: Node | null = null
    switch (name) {
      case 'code':
      case 'noformat': {
        const code = make('code')
        const lang = text('language')
        if (lang) code.className = `language-${lang}`
        code.textContent = kids(m, 'ac:plain-text-body')[0]?.textContent ?? ''
        const pre = make('pre')
        pre.append(code)
        out = pre
        break
      }
      case 'info': case 'note': case 'warning': case 'tip': case 'panel': {
        const variant = { info: 'info', panel: 'info', note: 'warning', warning: 'danger', tip: 'success' }[name]!
        out = make('div', titled(text('title'), rich(m) || '<p></p>'), { 'data-callout': variant })
        break
      }
      case 'expand':
        out = make('div', titled(text('title') || undefined, rich(m)))
        break
      case 'jira': {
        const key = text('key')
        const jql = text('jqlQuery')
        if (key) out = ctx.jira ? make('a', esc(key), { href: `${ctx.jira}/browse/${encodeURIComponent(key)}` }) : dom.createTextNode(key)
        else if (jql && ctx.jira) out = make('a', esc(`Jira: ${jql}`), { href: `${ctx.jira}/issues/?jql=${encodeURIComponent(jql)}` })
        break
      }
      case 'view-file': case 'viewpdf': case 'view-file-macro': {
        const att = all(m, 'ri:attachment')[0]
        const fname = att?.getAttribute('ri:filename') ?? text('name')
        const path = file(fname)
        out = path ? make('p', `<a href="${esc(path)}">📎 ${esc(fname)}</a>`) : dom.createTextNode(fname ?? '')
        break
      }
      case 'drawio': case 'inc-drawio': {
        const n = text('diagramName')
        const path = file(`${n}.png`) ?? file(n)
        if (path) file(n)
        out = path ? make('p', `<img src="${esc(path)}" alt="${esc(n)}">`) : dom.createTextNode(n)
        break
      }
      case 'status':
        out = make('mark', esc(text('title')))
        break
      case 'anchor': case 'toc': case 'children': case 'pagetree': case 'recently-updated': case 'contributors':
      case 'livesearch': case 'page-properties-report': case 'content-report-table': case 'create-from-template':
        break
      default: {
        // Layout-ish wrappers (toc-zone, section, column, excerpt, details, …) keep their content.
        const body = rich(m)
        if (body) out = make('div', body)
        else if (kids(m, 'ac:plain-text-body')[0]) {
          const pre = make('pre')
          pre.textContent = kids(m, 'ac:plain-text-body')[0].textContent ?? ''
          out = pre
        } else ctx.unknown.set(name, (ctx.unknown.get(name) ?? 0) + 1)
      }
    }
    out ? m.replaceWith(out) : m.remove()
  }

  for (const img of all(root, 'ac:image')) {
    const att = all(img, 'ri:attachment')[0]
    const url = all(img, 'ri:url')[0]?.getAttribute('ri:value')
    const src = att ? file(att.getAttribute('ri:filename')) : url
    img.replaceWith(src ? make('img', '', { src, alt: att?.getAttribute('ri:filename') ?? '' }) : dom.createTextNode(''))
  }

  for (const l of all(root, 'ac:link')) {
    const body = (kids(l, 'ac:link-body')[0]?.innerHTML || esc(kids(l, 'ac:plain-text-link-body')[0]?.textContent ?? '')).trim()
    const page = all(l, 'ri:page')[0] ?? all(l, 'ri:blog-post')[0]
    const att = all(l, 'ri:attachment')[0]
    const user = all(l, 'ri:user')[0]
    let out: Node
    if (user) out = dom.createTextNode(`@${l.textContent?.trim() || ctx.user || 'user'}`)
    else if (page) {
      const title = page.getAttribute('ri:content-title') ?? ''
      // Resolved to the imported page after every page exists (see run()).
      out = make('a', body || esc(title), { href: `#wiki:${encodeURIComponent(title)}` })
    } else if (att) {
      const n = att.getAttribute('ri:filename') ?? ''
      const path = file(n)
      out = path ? make('a', body || esc(n), { href: path }) : dom.createTextNode(n)
    } else out = make('span', body || esc(l.getAttribute('ac:anchor') ?? ''))
    l.replaceWith(out)
  }

  for (const e of all(root, 'ac:emoticon')) e.replaceWith(dom.createTextNode(e.getAttribute('ac:emoji-fallback') ?? ''))
  for (const list of all(root, 'ac:task-list')) {
    const ul = make('ul', '', { 'data-type': 'taskList' })
    for (const task of kids(list, 'ac:task')) {
      const done = kids(task, 'ac:task-status')[0]?.textContent?.trim() === 'complete'
      ul.append(make('li', `<p>${kids(task, 'ac:task-body')[0]?.innerHTML ?? ''}</p>`, { 'data-type': 'taskItem', 'data-checked': String(done) }))
    }
    list.replaceWith(ul)
  }
  for (const x of all(root, 'ac:adf-extension')) x.replaceWith(make('div', all(x, 'ac:adf-fallback')[0]?.innerHTML ?? ''))
  for (const t of all(root, 'time')) t.replaceWith(dom.createTextNode(t.getAttribute('datetime') ?? t.textContent ?? ''))
  // Whatever Confluence-specific tags are left: keep their content, drop the tag (placeholders and refs go entirely).
  for (const e of [...root.querySelectorAll('*')].reverse()) {
    const tag = e.tagName.toLowerCase()
    if (tag === 'ac:placeholder' || tag.startsWith('ri:') || tag === 'ac:parameter' || tag === 'ac:caption') e.remove()
    else if (tag.startsWith('ac:')) e.replaceWith(...e.childNodes)
  }
  return root.innerHTML
}
