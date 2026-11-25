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

/** The eight 16-bit groups of an IPv6 address (handles "::" and a dotted IPv4 tail). */
function groups6(ip: string): number[] | null {
  let v = ip.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0]
  const tail = v.match(/(\d+\.\d+\.\d+\.\d+)$/)
  if (tail) {
    const [a, b, c, d] = tail[1].split('.').map(Number)
    v = v.slice(0, -tail[1].length) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const [head, rest] = v.split('::')
  const h = head ? head.split(':') : []
  const r = rest !== undefined && rest ? rest.split(':') : []
  const fill = rest !== undefined ? 8 - h.length - r.length : 0
  const all = [...h, ...Array(Math.max(fill, 0)).fill('0'), ...r].map((x) => parseInt(x, 16))
  return all.length === 8 && all.every((n) => n >= 0 && n <= 0xffff) ? all : null
}

function private4(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number)
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19)) || a >= 224
}

export function privateAddress(ip: string): boolean {
  if (isIP(ip) === 4) return private4(ip)
  const g = groups6(ip)
  if (!g) return true // can't tell what it is: refuse
  // IPv4 inside IPv6 — mapped (::ffff:a.b.c.d, in any spelling), compatible (::a.b.c.d), NAT64 (64:ff9b::/96):
  // judge the IPv4 address it reaches.
  const v4 = () => `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) return g[5] === 0 && g[6] === 0 ? true : private4(v4())
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return private4(v4())
  return (g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xff00) === 0xff00 || g.every((x) => x === 0) ||
    (g[0] === 0x2002) /* 6to4 can wrap any IPv4 */
}

const allowed = (host: string) =>
  (process.env.LINK_PREVIEW_ALLOW ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    .some((a) => (a.startsWith('.') ? host.endsWith(a) || host === a.slice(1) : host === a))

/** A DNS lookup for http(s).request that refuses private addresses (unless `trusted`), checking every address returned. */
export const guardedLookup = (trusted: boolean) =>
  ((host: string, opts: any, cb: any) =>
    lookup(host, opts, (err, addr: any, family?: number) => {
      if (err) return cb(err)
      const list: { address: string }[] = Array.isArray(addr) ? addr : [{ address: addr }]
      if (!trusted && list.some((a) => privateAddress(a.address))) return cb(new Error('private address'))
      opts.all ? cb(null, addr) : cb(null, addr, family)
    })) as any

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
      lookup: guardedLookup(trusted),
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
