import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { compress } from 'hono/compress'
import type { Context } from 'hono'
import { createApp } from './app.ts'
import { openDb } from './db.ts'
import { branding, startFileSweep } from './admin.ts'
import { join } from 'node:path'
import { brandHtml } from './html.ts'
import { existsSync, readFileSync } from 'node:fs'
import { startMailer } from './mail.ts'
import { startPersonalHooks } from './webhooks.ts'
import { startRelay } from './cluster.ts'

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required, e.g. postgres://user:pass@localhost:5432/pagehouse')
  process.exit(1)
}
const db = await openDb(process.env.DATABASE_URL)
const dataDir = process.env.DATA_DIR ?? './data'
const app = createApp(db, dataDir)
startFileSweep(db, join(dataDir, 'files'))
startMailer(db)
startPersonalHooks(db)
await startRelay(db, process.env.DATABASE_URL, app.collab)

app.use('/assets/*', compress())
// Build output under /assets has content hashes in its names: cache it for a year.
app.use('/assets/*', async (c, next) => {
  await next()
  if (c.res.ok) c.header('Cache-Control', 'public, max-age=31536000, immutable')
})
// The HTML shell (at / or any client route) must be revalidated so a new release is picked up at once.
app.use('*', async (c, next) => {
  await next()
  if (c.res.headers.get('content-type')?.startsWith('text/html')) c.header('Cache-Control', 'no-cache')
})
const shellHtml = existsSync('./dist/index.html') ? readFileSync('./dist/index.html', 'utf8') : ''
const shell = async (c: Context) => {
  if (!shellHtml) return c.text('Not found', 404)
  return c.html(brandHtml(shellHtml, await branding(db)))
}
app.get('/', shell)
app.get('/index.html', shell)
app.use('*', serveStatic({ root: './dist' }))
// A build file that isn't there (an old tab asking for the previous release's code) must fail as such, not get the HTML page.
app.get('/assets/*', (c) => c.text('Not found', 404))
app.get('*', shell)

const port = Number(process.env.PORT ?? 3000)
const server = serve({ fetch: app.fetch, port }, () => console.log(`pagehouse listening on http://localhost:${port}`))
app.injectWebSocket(server)

// On stop or upgrade, let in-flight requests (saves) finish before exiting.
for (const sig of ['SIGTERM', 'SIGINT'] as const)
  process.on(sig, () => {
    // Live editing rooms save what they hold before the process goes.
    void app.collab.flushAll().finally(() => server.close(() => process.exit(0)))
    setTimeout(() => process.exit(0), 10_000).unref()
  })
