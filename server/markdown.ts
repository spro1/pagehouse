// ProseMirror JSON (as stored by the editor) → Markdown. Shared by the server (ZIP export) and the browser (single-page export).
// No DOM, no dependencies. Unknown nodes fall back to their children so no text is ever dropped.

type Node = { type: string; attrs?: Record<string, any>; content?: Node[]; text?: string; marks?: { type: string; attrs?: Record<string, any> }[] }

/** Rewrites URLs (attachments, page links) while serializing; return the input unchanged to keep it. */
export type UrlMap = (url: string) => string

// GitHub-style alerts round-trip through most Markdown tools and back into our panels on import.
const ALERT: Record<string, string> = { info: 'NOTE', warning: 'WARNING', success: 'TIP', danger: 'CAUTION' }
export const ALERT_TO_CALLOUT: Record<string, string> = { NOTE: 'info', IMPORTANT: 'info', WARNING: 'warning', TIP: 'success', CAUTION: 'danger' }

const escapeText = (s: string) => s.replace(/([\\`*_[\]<>|])/g, '\\$1').replace(/^(\s*)([#>+-]|\d+\.)(?=\s)/, '$1\\$2')

function inline(nodes: Node[] = [], url: UrlMap): string {
  return nodes
    .map((n) => {
      if (n.type === 'hardBreak') return '  \n'
      if (n.type === 'image') return `![${n.attrs?.alt ?? ''}](${url(n.attrs?.src ?? '')})`
      if (n.type === 'mention') return `@${n.attrs?.label ?? ''}`
      if (n.type !== 'text') return inline(n.content, url)
      const code = n.marks?.some((m) => m.type === 'code')
      let t = code ? '`' + (n.text ?? '').replace(/`/g, 'ˋ') + '`' : escapeText(n.text ?? '')
      for (const m of n.marks ?? []) {
        if (m.type === 'bold') t = `**${t}**`
        else if (m.type === 'italic') t = `*${t}*`
        else if (m.type === 'strike') t = `~~${t}~~`
        else if (m.type === 'highlight') t = `==${t}==`
        else if (m.type === 'link') t = `[${t}](${url(m.attrs?.href ?? '')})`
      }
      return t
    })
    .join('')
}

const prefix = (text: string, first: string, rest = ' '.repeat(first.length)) =>
  text.split('\n').map((l, i) => (i === 0 ? first : l ? rest : rest.trimEnd()) + l).join('\n')

function block(n: Node, url: UrlMap): string {
  const kids = (sep = '\n\n') => (n.content ?? []).map((c) => block(c, url)).filter((s) => s !== '').join(sep)
  switch (n.type) {
    case 'doc': return kids()
    case 'paragraph': return inline(n.content, url)
    case 'heading': return `${'#'.repeat(Math.min(6, n.attrs?.level ?? 1))} ${inline(n.content, url)}`
    case 'blockquote': return prefix(kids(), '> ', '> ')
    case 'callout': return prefix(`[!${ALERT[n.attrs?.variant] ?? 'NOTE'}]\n${kids()}`, '> ', '> ')
    case 'codeBlock': {
      const body = (n.content ?? []).map((c) => c.text ?? '').join('')
      const fence = body.includes('```') ? '~~~~' : '```'
      return `${fence}${n.attrs?.language ?? ''}\n${body}\n${fence}`
    }
    case 'horizontalRule': return '---'
    case 'linkCard': return `[${escapeText(n.attrs?.title || n.attrs?.href || '')}](${url(n.attrs?.href ?? '')})`
    // A caption becomes the image title: ![alt](src "caption").
    case 'image': return `![${n.attrs?.alt ?? ''}](${url(n.attrs?.src ?? '')}${n.attrs?.caption ? ` "${String(n.attrs.caption).replace(/"/g, '\\"')}"` : ''})`
    case 'bulletList':
    case 'orderedList':
    case 'taskList':
      return (n.content ?? [])
        .map((li, i) => {
          const mark = n.type === 'orderedList' ? `${(n.attrs?.start ?? 1) + i}. ` : n.type === 'taskList' ? `- [${li.attrs?.checked ? 'x' : ' '}] ` : '- '
          const body = (li.content ?? []).map((c) => block(c, url)).join('\n')
          return prefix(body, mark)
        })
        .join('\n')
    case 'table': {
      const rows = (n.content ?? []).map((r) =>
        (r.content ?? []).map((c) => (c.content ?? []).map((p) => inline(p.content, url)).join('<br>').replace(/\n/g, ' ') || ' '),
      )
      if (!rows.length) return ''
      const width = Math.max(...rows.map((r) => r.length))
      const line = (r: string[]) => `| ${[...r, ...Array(width - r.length).fill(' ')].join(' | ')} |`
      return [line(rows[0]), line(Array(width).fill('---')), ...rows.slice(1).map(line)].join('\n')
    }
    default: return n.content ? kids() : inline([n], url)
  }
}

export function toMarkdown(title: string, doc: unknown, url: UrlMap = (u) => u) {
  const body = block(doc as Node, url).trim()
  return `# ${title}\n\n${body}\n`
}

// ---------- Markdown → ProseMirror JSON (for the API and agents; the browser editor has its own parser) ----------
// Covers what agents write: headings, paragraphs, lists (nested by indent), task lists, code fences, quotes and
// GitHub alerts, tables, rules, images; inline bold, italic, strike, highlight, code and links.

const md = (s: string) => s.replace(/\\([\\`*_[\]<>|#>+\-.!~=])/g, '$1')
function inlineFrom(src: string): Node[] {
  const out: Node[] = []
  const push = (text: string, marks: Node['marks'] = []) => {
    if (!text) return
    const last = out[out.length - 1]
    if (last && JSON.stringify(last.marks ?? []) === JSON.stringify(marks)) last.text += text
    else out.push({ type: 'text', text, ...(marks.length ? { marks } : {}) })
  }
  const re = /(`+)([\s\S]*?)\1|!\[([^\]]*)\]\(([^)\s]+)\)|\[([^\]]+)\]\(([^)\s]+)\)|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|~~([\s\S]+?)~~|==([\s\S]+?)==|\*([^*\s][^*]*?)\*|_([^_\s][^_]*?)_|( {2,}|\\)\n/g
  const walk = (s: string, marks: NonNullable<Node['marks']>) => {
    let i = 0
    for (const m of s.matchAll(re)) {
      push(md(s.slice(i, m.index)), marks)
      i = m.index! + m[0].length
      if (m[1]) push(m[2], [...marks, { type: 'code' }])
      else if (m[4]) out.push({ type: 'image', attrs: { src: m[4], alt: m[3] } })
      else if (m[6]) walk(m[5], [...marks, { type: 'link', attrs: { href: m[6] } }])
      else if (m[7] ?? m[8]) walk(m[7] ?? m[8], [...marks, { type: 'bold' }])
      else if (m[9]) walk(m[9], [...marks, { type: 'strike' }])
      else if (m[10]) walk(m[10], [...marks, { type: 'highlight' }])
      else if (m[11] ?? m[12]) walk(m[11] ?? m[12], [...marks, { type: 'italic' }])
      else if (m[13]) out.push({ type: 'hardBreak' })
    }
    push(md(s.slice(i)), marks)
  }
  walk(src, [])
  return out
}
const para = (text: string): Node => {
  const content = inlineFrom(text.replace(/\n(?! )/g, ' ').trim())
  return { type: 'paragraph', ...(content.length ? { content } : {}) }
}
const LIST = /^(\s*)([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?(.*)$/
const CALLOUT: Record<string, string> = ALERT_TO_CALLOUT

function blocksFrom(lines: string[]): Node[] {
  const out: Node[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) { i++; continue }
    const fence = line.match(/^\s*(`{3,}|~{3,})\s*([\w+-]*)/)
    if (fence) {
      const body: string[] = []
      for (i++; i < lines.length && !lines[i].trim().startsWith(fence[1]); i++) body.push(lines[i])
      i++
      out.push({ type: 'codeBlock', attrs: { language: fence[2] || null }, ...(body.length ? { content: [{ type: 'text', text: body.join('\n') }] } : {}) })
      continue
    }
    const h = line.match(/^(#{1,6})\s+(.*?)\s*#*$/)
    if (h) { out.push({ type: 'heading', attrs: { level: Math.min(h[1].length, 3) }, content: inlineFrom(h[2]) }); i++; continue }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push({ type: 'horizontalRule' }); i++; continue }
    if (/^\s*>/.test(line)) {
      const body: string[] = []
      for (; i < lines.length && /^\s*>/.test(lines[i]); i++) body.push(lines[i].replace(/^\s*> ?/, ''))
      const alert = body[0]?.match(/^\[!(\w+)\]\s*$/)
      const inner = blocksFrom(alert ? body.slice(1) : body)
      out.push(alert && CALLOUT[alert[1].toUpperCase()]
        ? { type: 'callout', attrs: { variant: CALLOUT[alert[1].toUpperCase()] }, content: inner.length ? inner : [{ type: 'paragraph' }] }
        : { type: 'blockquote', content: inner.length ? inner : [{ type: 'paragraph' }] })
      continue
    }
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? '')) {
      const cells = (l: string) => l.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim())
      const rows = [cells(line)]
      for (i += 2; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]); i++) rows.push(cells(lines[i]))
      out.push({ type: 'table', content: rows.map((r, ri) => ({ type: 'tableRow', content: r.map((c) => ({
        type: ri === 0 ? 'tableHeader' : 'tableCell', content: c.split(/<br\s*\/?>/i).map(para) })) })) })
      continue
    }
    const li = line.match(LIST)
    if (li) {
      const indent = li[1].length
      const ordered = /\d/.test(li[2])
      const task = !!li[3]
      const items: Node[] = []
      while (i < lines.length) {
        const m = lines[i].match(LIST)
        if (!m || m[1].length !== indent || /\d/.test(m[2]) !== ordered || !!m[3] !== task) break
        // The item's own text, then anything indented deeper (nested lists, continuation lines).
        const body = [m[4]]
        for (i++; i < lines.length && (lines[i].match(/^(\s*)/)![1].length > indent || (!lines[i].trim() && (lines[i + 1] ?? '').match(/^(\s*)/)![1].length > indent)); i++)
          body.push(lines[i].slice(Math.min(indent + 2, lines[i].match(/^(\s*)/)![1].length)))
        const inner = blocksFrom(body)
        items.push(task
          ? { type: 'taskItem', attrs: { checked: /x/i.test(m[3]) }, content: inner.length ? inner : [{ type: 'paragraph' }] }
          : { type: 'listItem', content: inner.length ? inner : [{ type: 'paragraph' }] })
      }
      out.push({ type: task ? 'taskList' : ordered ? 'orderedList' : 'bulletList', ...(ordered ? { attrs: { start: Number(li[2].replace(/\D/g, '')) || 1 } } : {}), content: items })
      continue
    }
    const text: string[] = []
    for (; i < lines.length && lines[i].trim() && !/^\s*(#{1,6}\s|>|```|~~~|\|)/.test(lines[i]) && !LIST.test(lines[i]); i++) text.push(lines[i])
    if (!text.length) { text.push(lines[i]); i++ }
    const p = para(text.join('\n'))
    // A paragraph that is only an image becomes an image block.
    out.push(p.content?.length === 1 && p.content[0].type === 'image' ? p.content[0] : p)
  }
  return out
}

export function fromMarkdown(src: string): Node {
  const content = blocksFrom(src.replace(/\r\n?/g, '\n').split('\n'))
  return { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] }
}
