// Link previews: title, description, image and site name of a URL, for link cards in pages.
// The server fetches on the user's behalf, so it refuses private and loopback addresses (no probing the internal
// network) unless the host is listed in LINK_PREVIEW_ALLOW (e.g. "jira.corp.local,.gitlab.corp.local").
// The address check happens at connect time, so a DNS answer can't change between check and fetch.
import type { Hono, Context } from 'hono'
import { lookup } from 'node:dns'
import { isIP } from 'node:net'
import http from 'node:http'
import https from 'node:https'

export type Preview = { url: string; title: string; description: string; image: string; site: string }
const MAX_BYTES = 512 * 1024
const cache = new Map<string, { at: number; p: Preview | null }>()

export function privateAddress(ip: string): boolean {
  if (ip.startsWith('::ffff:')) ip = ip.slice(7)
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number)
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) || a >= 224
  }
  const v = ip.toLowerCase()
  return v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('ff')
}

const allowed = (host: string) =>
  (process.env.LINK_PREVIEW_ALLOW ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    .some((a) => (a.startsWith('.') ? host.endsWith(a) || host === a.slice(1) : host === a))

function get(url: URL, redirects = 3): Promise<{ html: string; url: URL }> {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http
    const trusted = allowed(url.hostname.toLowerCase())
    // IP literals skip the DNS lookup below, so check them here.
    const literal = url.hostname.replace(/^\[|\]$/g, '')
    if (isIP(literal) && !trusted && privateAddress(literal)) return reject(new Error('private address'))
    const req = lib.get(url, {
      timeout: 5000,
      headers: { 'user-agent': 'Pagehouse link preview', accept: 'text/html,application/xhtml+xml' },
      // Node asks for every address (opts.all) to race IPv4/IPv6; each one is checked.
      lookup: ((host: string, opts: any, cb: any) =>
        lookup(host, opts, (err, addr: any, family?: number) => {
          if (err) return cb(err)
          const list: { address: string }[] = Array.isArray(addr) ? addr : [{ address: addr }]
          if (!trusted && list.some((a) => privateAddress(a.address))) return cb(new Error('private address'))
          opts.all ? cb(null, addr) : cb(null, addr, family)
        })) as any,
    }, (res) => {
      const loc = res.headers.location
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && loc) {
        res.resume()
        if (!redirects) return reject(new Error('too many redirects'))
        const next = new URL(loc, url)
        if (!/^https?:$/.test(next.protocol)) return reject(new Error('bad redirect'))
        return get(next, redirects - 1).then(resolve, reject)
      }
      if (res.statusCode !== 200 || !/html/i.test(String(res.headers['content-type']))) return res.resume(), reject(new Error(`status ${res.statusCode}`))
      let size = 0
      const chunks: Buffer[] = []
      res.on('data', (ch: Buffer) => {
        size += ch.length
        chunks.push(ch)
        // The <head> is all we need; stop reading big pages.
        if (size > MAX_BYTES) res.destroy()
      })
      res.on('close', () => resolve({ html: Buffer.concat(chunks).toString('utf8'), url }))
      res.on('error', reject)
    })
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', reject)
  })
}

const decodeEntities = (s: string) =>
  s.replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos|#39);/gi, (_, e: string) =>
    e[0] === '#' ? String.fromCodePoint(parseInt(e.slice(e[1] === 'x' || e[1] === 'X' ? 2 : 1), e[1] === 'x' || e[1] === 'X' ? 16 : 10))
      : ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[e.toLowerCase()] ?? '')

export function parsePreview(html: string, url: URL): Preview {
  const head = html.slice(0, MAX_BYTES)
  const meta = (key: string) => {
    for (const m of head.matchAll(/<meta\b[^>]*>/gi)) {
      const tag = m[0]
      const name = tag.match(/\b(?:property|name)\s*=\s*["']([^"']+)["']/i)?.[1]?.toLowerCase()
      if (name === key) return decodeEntities(tag.match(/\bcontent\s*=\s*"([^"]*)"|\bcontent\s*=\s*'([^']*)'/i)?.slice(1).find((x) => x !== undefined) ?? '').trim()
    }
    return ''
  }
  const title = meta('og:title') || meta('twitter:title') || decodeEntities(head.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').replace(/\s+/g, ' ').trim()
  let image = meta('og:image') || meta('twitter:image')
  try {
    // Only https images: the page's own security policy blocks anything else anyway.
    image = image ? new URL(image, url).toString() : ''
    if (!image.startsWith('https://')) image = ''
  } catch {
    image = ''
  }
  return {
    url: url.toString(), title: title.slice(0, 300), description: (meta('og:description') || meta('description')).slice(0, 500),
    image, site: (meta('og:site_name') || url.hostname).slice(0, 100),
  }
}

export function registerPreview(app: Hono<any>, fail: (c: Context, status: 400 | 404, code: string) => Response) {
  app.get('/api/link-preview', async (c) => {
    if (process.env.LINK_PREVIEW === '0') return fail(c, 404, 'preview_unavailable')
    let url: URL
    try {
      url = new URL(c.req.query('url') ?? '')
      if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw 0
    } catch {
      return fail(c, 400, 'bad_request')
    }
    const key = url.toString()
    const hit = cache.get(key)
    if (hit && Date.now() - hit.at < 3600_000) return hit.p ? c.json(hit.p) : fail(c, 404, 'preview_unavailable')
    let p: Preview | null = null
    try {
      const r = await get(url)
      p = parsePreview(r.html, r.url)
      if (!p.title) p = null
    } catch {}
    if (cache.size > 1000) cache.clear()
    cache.set(key, { at: Date.now(), p })
    return p ? c.json(p) : fail(c, 404, 'preview_unavailable')
  })
}
