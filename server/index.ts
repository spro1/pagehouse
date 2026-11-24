import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { compress } from 'hono/compress'
import { createApp } from './app.ts'
import { openDb } from './db.ts'
import { startMailer } from './mail.ts'

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required, e.g. postgres://user:pass@localhost:5432/pagehouse')
  process.exit(1)
}
const db = await openDb(process.env.DATABASE_URL)
const app = createApp(db, process.env.DATA_DIR ?? './data')
startMailer(db)

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
app.use('*', serveStatic({ root: './dist' }))
app.get('*', serveStatic({ path: './dist/index.html' }))

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
