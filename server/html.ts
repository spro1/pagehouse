// ProseMirror JSON → a standalone HTML page, for the HTML export: open index.html from the unzipped folder in any
// browser, no server needed. Same shape as markdown.ts: unknown nodes fall back to their children, no text is dropped.
import type { UrlMap } from './markdown.ts'

type Node = { type: string; attrs?: Record<string, any>; content?: Node[]; text?: string; marks?: { type: string; attrs?: Record<string, any> }[] }

export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
// Only web, mail and relative links survive; javascript: and friends never reach the exported page.
// Colors come from the editor (or pasted HTML), so only plain color values reach a style attribute.
const safeColor = (c: unknown) =>
  typeof c === 'string' && /^(#[0-9a-f]{3,8}|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*(0|1|0?\.\d+)\s*)?\))$/i.test(c.trim()) ? c.trim() : null
const align = (n: Node) => (['center', 'right', 'justify'].includes(n.attrs?.textAlign) ? ` style="text-align:${n.attrs!.textAlign}"` : '')
const safeUrl = (u: string) => (/^(https?:|mailto:|#|\.{0,2}\/|[^:]*$)/i.test(u) ? u : '#')

function inline(nodes: Node[] = [], url: UrlMap): string {
  return nodes
    .map((n) => {
      if (n.type === 'hardBreak') return '<br>'
      if (n.type === 'image') return `<img src="${escapeHtml(safeUrl(url(n.attrs?.src ?? '')))}" alt="${escapeHtml(n.attrs?.alt ?? '')}">`
      if (n.type === 'mention') return `<span class="mention">@${escapeHtml(n.attrs?.label ?? '')}</span>`
      if (n.type !== 'text') return inline(n.content, url)
      let t = escapeHtml(n.text ?? '')
      for (const m of n.marks ?? []) {
        if (m.type === 'bold') t = `<strong>${t}</strong>`
        else if (m.type === 'italic') t = `<em>${t}</em>`
        else if (m.type === 'strike') t = `<s>${t}</s>`
        else if (m.type === 'code') t = `<code>${t}</code>`
        else if (m.type === 'highlight') t = safeColor(m.attrs?.color) ? `<mark style="background:${safeColor(m.attrs?.color)}">${t}</mark>` : `<mark>${t}</mark>`
        else if (m.type === 'textStyle' && safeColor(m.attrs?.color)) t = `<span style="color:${safeColor(m.attrs?.color)}">${t}</span>`
        else if (m.type === 'underline') t = `<u>${t}</u>`
        else if (m.type === 'link') t = `<a href="${escapeHtml(safeUrl(url(m.attrs?.href ?? '')))}">${t}</a>`
      }
      return t
    })
    .join('')
}

const CALLOUT_ICON: Record<string, string> = { info: 'ℹ️', warning: '⚠️', success: '✅', danger: '⛔' }

function block(n: Node, url: UrlMap): string {
  const kids = () => (n.content ?? []).map((c) => block(c, url)).join('\n')
  const span = (c: Node) => `${(c.attrs?.colspan ?? 1) > 1 ? ` colspan="${c.attrs!.colspan}"` : ''}${(c.attrs?.rowspan ?? 1) > 1 ? ` rowspan="${c.attrs!.rowspan}"` : ''}${safeColor(c.attrs?.background) ? ` style="background:${safeColor(c.attrs?.background)}"` : ''}`
  switch (n.type) {
    case 'doc': return kids()
    case 'paragraph': return `<p${align(n)}>${inline(n.content, url)}</p>`
    case 'heading': {
      const l = Math.min(6, Math.max(1, n.attrs?.level ?? 1))
      return `<h${l}${align(n)}>${inline(n.content, url)}</h${l}>`
    }
    case 'blockquote': return `<blockquote>${kids()}</blockquote>`
    case 'callout': {
      const v = String(n.attrs?.variant ?? 'info')
      return `<div class="callout ${escapeHtml(v)}"><span class="callout-icon">${CALLOUT_ICON[v] ?? 'ℹ️'}</span><div>${kids()}</div></div>`
    }
    case 'codeBlock': {
      const lang = String(n.attrs?.language ?? '')
      const body = (n.content ?? []).map((c) => c.text ?? '').join('')
      return `<pre${lang ? ` data-language="${escapeHtml(lang)}"` : ''}><code>${escapeHtml(body)}</code></pre>`
    }
    case 'horizontalRule': return '<hr>'
    case 'linkCard': {
      const href = escapeHtml(safeUrl(url(n.attrs?.href ?? '')))
      return `<p class="link-card"><a href="${href}">${escapeHtml(n.attrs?.title || n.attrs?.href || '')}</a>${n.attrs?.description ? `<br><small>${escapeHtml(n.attrs.description)}</small>` : ''}</p>`
    }
    case 'image': {
      const w = Number(n.attrs?.width) > 0 ? ` style="width:${Math.round(Number(n.attrs!.width))}px"` : ''
      const img = `<img src="${escapeHtml(safeUrl(url(n.attrs?.src ?? '')))}" alt="${escapeHtml(n.attrs?.alt || n.attrs?.caption || '')}"${w}>`
      return n.attrs?.caption ? `<figure>${img}<figcaption>${escapeHtml(n.attrs.caption)}</figcaption></figure>` : `<p>${img}</p>`
    }
    case 'bulletList': return `<ul>${kids()}</ul>`
    case 'orderedList': return `<ol${(n.attrs?.start ?? 1) !== 1 ? ` start="${Number(n.attrs!.start)}"` : ''}>${kids()}</ol>`
    case 'listItem': return `<li>${kids()}</li>`
    case 'taskList': return `<ul class="tasks">${kids()}</ul>`
    case 'taskItem': return `<li><input type="checkbox" disabled${n.attrs?.checked ? ' checked' : ''}> <div>${kids()}</div></li>`
    case 'table': return `<div class="table"><table>${kids()}</table></div>`
    case 'tableRow': return `<tr>${kids()}</tr>`
    case 'tableHeader': return `<th${span(n)}>${kids()}</th>`
    case 'tableCell': return `<td${span(n)}>${kids()}</td>`
    default: return n.content ? kids() : inline([n], url)
  }
}

export type NavItem = { title: string; href: string; current?: boolean; children: NavItem[] }

const navHtml = (items: NavItem[]): string =>
  items.length
    ? `<ul>${items.map((i) => `<li><a href="${escapeHtml(i.href)}"${i.current ? ' class="current" aria-current="page"' : ''}>${escapeHtml(i.title)}</a>${navHtml(i.children)}</li>`).join('')}</ul>`
    : ''

/** A full page: the space's page tree on the left (links relative to this file), the page on the right. */
export function toHtmlPage(o: { title: string; doc: unknown; url: UrlMap; space: string; crumbs: { title: string; href: string }[]; nav: NavItem[]; home: string; updated?: Date; css: string }) {
  const crumbs = o.crumbs.map((c) => `<a href="${escapeHtml(c.href)}">${escapeHtml(c.title)}</a>`).join(' / ')
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(o.title)} · ${escapeHtml(o.space)}</title><link rel="stylesheet" href="${escapeHtml(o.css)}"></head>
<body><nav class="side"><a class="space" href="${escapeHtml(o.home)}">${escapeHtml(o.space)}</a>${navHtml(o.nav)}</nav>
<main><div class="crumbs">${crumbs}</div><h1 class="title">${escapeHtml(o.title)}</h1>
${o.updated ? `<p class="meta">${escapeHtml(o.updated.toISOString().slice(0, 10))}</p>` : ''}
<article>${block(o.doc as Node, o.url)}</article></main></body></html>
`
}

export const EXPORT_CSS = `*{box-sizing:border-box}body{margin:0;display:flex;font:15px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI","Apple SD Gothic Neo","Malgun Gothic",sans-serif;color:#1f2328;background:#fff}
.side{width:280px;flex:none;height:100vh;position:sticky;top:0;overflow:auto;padding:16px 12px;border-right:1px solid #e5e7eb;background:#f8f9fa;font-size:13.5px}
.side .space{display:block;font-weight:700;font-size:15px;margin:0 6px 10px;color:#1f2328;text-decoration:none}
.side ul{list-style:none;margin:0;padding-left:12px}.side>ul{padding-left:0}.side li a{display:block;padding:3px 6px;border-radius:5px;color:#444;text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.side li a:hover{background:#eceef1}.side li a.current{background:#e3e8f5;color:#1f2328;font-weight:600}
main{flex:1;min-width:0;max-width:900px;padding:32px 48px 80px}.crumbs{font-size:13px;color:#6b7280}.crumbs a{color:#6b7280}
h1.title{font-size:30px;line-height:1.3;margin:8px 0 4px}.meta{color:#6b7280;font-size:13px;margin:0 0 24px}
a{color:#2f6feb}img{max-width:100%;height:auto;border-radius:6px}
pre{background:#f6f8fa;border:1px solid #e5e7eb;border-radius:8px;padding:12px 14px;overflow:auto;font-size:13px;line-height:1.5}
code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.9em}p code{background:#f2f3f5;padding:1px 5px;border-radius:4px}
blockquote{margin:0;padding:2px 16px;border-left:3px solid #d0d7de;color:#57606a}
.callout{display:flex;gap:10px;padding:10px 14px;border-radius:8px;margin:12px 0;border:1px solid}.callout>div>:first-child{margin-top:0}.callout>div>:last-child{margin-bottom:0}
.callout.info{background:#eef4ff;border-color:#c9dafc}.callout.warning{background:#fff8e6;border-color:#f3dc9b}.callout.success{background:#ecf9f0;border-color:#b9e6c6}.callout.danger{background:#fdeeee;border-color:#f3c2c2}
.table{overflow:auto}table{border-collapse:collapse;margin:12px 0;font-size:14px}th,td{border:1px solid #d0d7de;padding:6px 10px;vertical-align:top}th{background:#f6f8fa}td>p:first-child,th>p:first-child{margin-top:0}td>p:last-child,th>p:last-child{margin-bottom:0}
ul.tasks{list-style:none;padding-left:4px}ul.tasks li{display:flex;gap:6px}ul.tasks li>div>p{margin:0}
figure{margin:12px 0}figure img{max-width:100%}figcaption{color:#57606a;font-size:13px;text-align:center;margin-top:4px}mark{background:#fff3a3}.mention{color:#2f6feb}.link-card{border:1px solid #e5e7eb;border-radius:8px;padding:10px 14px}
hr{border:0;border-top:1px solid #e5e7eb;margin:24px 0}
@media (max-width:800px){body{display:block}.side{position:static;width:auto;height:auto;border-right:0;border-bottom:1px solid #e5e7eb}main{padding:20px 16px}}
@media print{.side{display:none}main{max-width:none;padding:0}}`
