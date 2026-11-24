// Model Context Protocol endpoint (Streamable HTTP, JSON responses) at /api/mcp, so AI agents can search, read and
// write the wiki with a personal API token. Every tool calls the regular REST API as that user, so agents get exactly
// the user's permissions, restrictions and history — nothing here bypasses them.
import type { Context, Hono } from 'hono'
import { fromMarkdown, toMarkdown } from './markdown.ts'

const VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']
const str = { type: 'string' } as const
const int = { type: 'integer' } as const
const TOOLS = [
  { name: 'list_spaces', description: 'List the spaces you can open.', inputSchema: { type: 'object', properties: {} } },
  { name: 'search', description: 'Full-text search over page titles, bodies, comments and attachment names. Every word must match.',
    inputSchema: { type: 'object', properties: { query: str, spaceId: int, limit: { ...int, description: '1-50, default 10' } }, required: ['query'] } },
  { name: 'list_pages', description: 'The page tree of a space, one "id: title" per line, indented by depth.',
    inputSchema: { type: 'object', properties: { spaceId: int }, required: ['spaceId'] } },
  { name: 'get_page', description: 'A page as Markdown, with its id, space, breadcrumb and last update.',
    inputSchema: { type: 'object', properties: { id: int }, required: ['id'] } },
  { name: 'create_page', description: 'Create a page from Markdown, at the top of a space or under a parent page.',
    inputSchema: { type: 'object', properties: { spaceId: int, parentId: int, title: str, markdown: str }, required: ['spaceId', 'title'] } },
  { name: 'update_page', description: 'Replace a page body with Markdown and/or rename it. The previous version stays in the page history.',
    inputSchema: { type: 'object', properties: { id: int, title: str, markdown: str }, required: ['id'] } },
  { name: 'get_comments', description: 'Comments on a page, oldest first.', inputSchema: { type: 'object', properties: { pageId: int }, required: ['pageId'] } },
  { name: 'add_comment', description: 'Add a comment to a page.', inputSchema: { type: 'object', properties: { pageId: int, body: str }, required: ['pageId', 'body'] } },
]

export function registerMcp(app: Hono<any>) {
  app.get('/api/mcp', (c) => c.body(null, 405, { Allow: 'POST' }))
  app.delete('/api/mcp', (c) => c.body(null, 405, { Allow: 'POST' }))

  app.post('/api/mcp', async (c) => {
    const msg = await c.req.json().catch(() => null)
    if (Array.isArray(msg)) return c.json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Batches are not supported' } }, 400)
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return c.json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } }, 400)
    // Notifications (no id) need no answer.
    if (msg.id === undefined) return c.body(null, 202)
    const reply = (result: unknown) => c.json({ jsonrpc: '2.0', id: msg.id, result })
    const error = (code: number, message: string) => c.json({ jsonrpc: '2.0', id: msg.id, error: { code, message } })
    switch (msg.method) {
      case 'initialize':
        return reply({
          protocolVersion: VERSIONS.includes(msg.params?.protocolVersion) ? msg.params.protocolVersion : VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: { name: 'pagehouse', version: process.env.APP_VERSION ?? 'dev' },
          instructions: 'Pagehouse team wiki. Search or list pages, read them as Markdown, and create or update pages and comments. Page ids are integers.',
        })
      case 'ping':
        return reply({})
      case 'tools/list':
        return reply({ tools: TOOLS })
      case 'tools/call': {
        const name = msg.params?.name
        if (!TOOLS.some((t) => t.name === name)) return error(-32602, `Unknown tool: ${name}`)
        try {
          return reply({ content: [{ type: 'text', text: await runTool(app, c, name, msg.params?.arguments ?? {}) }] })
        } catch (e) {
          // Tool failures (no access, not found, conflict) go back to the model as a result it can read.
          return reply({ content: [{ type: 'text', text: (e as Error).message }], isError: true })
        }
      }
      default:
        return error(-32601, `Method not found: ${msg.method}`)
    }
  })
}

async function runTool(app: Hono<any>, c: Context, name: string, a: Record<string, any>): Promise<string> {
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, {
      method,
      headers: { authorization: c.req.header('authorization') ?? '', cookie: c.req.header('cookie') ?? '', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
    return data
  }
  const num = (v: unknown, field: string) => {
    if (!Number.isInteger(v)) throw new Error(`${field} must be an integer`)
    return v as number
  }
  const base = process.env.PUBLIC_URL?.replace(/\/$/, '')
  switch (name) {
    case 'list_spaces': {
      const spaces = await call('GET', '/api/spaces')
      return spaces.map((s: any) => `${s.id}: ${s.name} (key ${s.key}, your role: ${s.role})`).join('\n') || 'No spaces.'
    }
    case 'search': {
      const q = new URLSearchParams({ q: String(a.query ?? ''), limit: String(Math.min(Math.max(Number(a.limit) || 10, 1), 50)) })
      if (Number.isInteger(a.spaceId)) q.set('space', String(a.spaceId))
      const r = await call('GET', `/api/search?${q}`)
      if (!r.results.length) return 'No pages found.'
      return `${r.total} result(s):\n` + r.results.map((x: any) => `- ${x.id}: ${[x.space, ...x.path, x.title].join(' / ')}\n  ${x.snippet}`).join('\n')
    }
    case 'list_pages': {
      const pages: { id: number; parentId: number | null; title: string; kind: string }[] = await call('GET', `/api/spaces/${num(a.spaceId, 'spaceId')}/pages`)
      const kids = new Map<number | null, typeof pages>()
      for (const p of pages) kids.set(p.parentId, [...(kids.get(p.parentId) ?? []), p])
      const lines: string[] = []
      const walk = (parent: number | null, depth: number) => {
        for (const p of kids.get(parent) ?? []) (lines.push(`${'  '.repeat(depth)}${p.id}: ${p.title}${p.kind === 'folder' ? ' (folder)' : ''}`), walk(p.id, depth + 1))
      }
      walk(null, 0)
      return lines.join('\n') || 'This space has no pages.'
    }
    case 'get_page': {
      const p = await call('GET', `/api/pages/${num(a.id, 'id')}`)
      const head = [
        `id: ${p.id}`, `space: ${p.space.name} (id ${p.space.id})`,
        `path: ${[...p.ancestors.map((x: any) => x.title), p.title].join(' / ')}`,
        `updated: ${p.updatedAt} by ${p.updatedBy}`, `access: ${p.access}`, ...(base ? [`url: ${base}/#/p/${p.id}`] : []),
      ]
      return `${head.join('\n')}\n\n${toMarkdown(p.title, p.doc)}`
    }
    case 'create_page': {
      const doc = fromMarkdown(String(a.markdown ?? ''))
      const p = await call('POST', '/api/pages', { spaceId: num(a.spaceId, 'spaceId'), parentId: a.parentId ?? null, title: String(a.title ?? ''), doc })
      return `Created page ${p.id}: ${p.title}${base ? ` (${base}/#/p/${p.id})` : ''}`
    }
    case 'update_page': {
      const id = num(a.id, 'id')
      const cur = await call('GET', `/api/pages/${id}`)
      const title = typeof a.title === 'string' && a.title.trim() ? a.title : cur.title
      const doc = typeof a.markdown === 'string' ? fromMarkdown(a.markdown) : cur.doc
      const r = await call('PUT', `/api/pages/${id}`, { title, doc, version: cur.version, checkpoint: true })
      return `Updated page ${id} (version ${r.version}). The previous version is in the page history.`
    }
    case 'get_comments': {
      const list = await call('GET', `/api/pages/${num(a.pageId, 'pageId')}/comments`)
      return list.map((x: any) => `- #${x.id}${x.parentId ? ` (reply to #${x.parentId})` : ''} ${x.author}, ${x.createdAt}${x.resolvedAt ? ' [resolved]' : ''}${x.quote ? `\n  on: "${x.quote}"` : ''}\n  ${x.body}`).join('\n') || 'No comments.'
    }
    case 'add_comment': {
      const r = await call('POST', `/api/pages/${num(a.pageId, 'pageId')}/comments`, { body: String(a.body ?? '') })
      return `Added comment #${r.id}.`
    }
  }
  throw new Error(`Unknown tool: ${name}`)
}
