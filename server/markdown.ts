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
    case 'image': return `![${n.attrs?.alt ?? ''}](${url(n.attrs?.src ?? '')})`
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
