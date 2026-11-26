import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, utimesSync } from 'node:fs'
import { createServer } from 'node:http'
import { createHmac } from 'node:crypto'
import { startPersonalHooks } from './webhooks.ts'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp, hangulBigrams, setupToken } from './app.ts'
import { pruneFiles } from './admin.ts'
import { brandCss, brandHtml, contrastOnWhite, safeHref } from './html.ts'
import { toMarkdown } from './markdown.ts'
import { openDb } from './db.ts'

// The tests stand behind one pretend proxy, so X-Forwarded-For names the caller.
process.env.TRUST_PROXY = '1'
const url = process.env.TEST_DATABASE_URL ?? 'postgres://pagehouse:pagehouse@localhost:55432/pagehouse_test'

// The test wipes the database, so refuse anything not named *_test.
assert.match(new URL(url).pathname, /_test$/)
const reset = await openDb(url)
await reset.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
await reset.end()
const db = await openDb(url)
after(() => db.end())
const dataDir = mkdtempSync(join(tmpdir(), 'pagehouse-'))
const app = createApp(db, dataDir)

// A tiny client that keeps its own session cookie.
function client() {
  const c = { cookie: '', async call(method: string, path: string, body?: unknown) {
    const res = await app.request(path, {
      method,
      headers: { cookie: c.cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    })
    const set = res.headers.get('set-cookie')
    if (set) c.cookie = set.split(';')[0]
    return res
  }, async json(method: string, path: string, body?: unknown) { return (await c.call(method, path, body)).json() } }
  return c
}

test('register, edit with conflict detection, search, attachments', async () => {
  const a = client()
  const call = a.call
  assert.equal((await call('GET', '/api/spaces')).status, 401)
  assert.equal((await call('POST', '/api/auth/register', { email: 'a@b.co', name: 'A', password: 'short' })).status, 400)
  // The first account (the admin) needs the setup token printed in the server log.
  const setup = (await setupToken(db))!
  assert.match(setup, /^[\w-]{20,}$/)
  assert.equal(await setupToken(db), setup, 'every instance prints the same token')
  assert.equal((await call('POST', '/api/auth/register', { email: 'a@b.co', name: 'A', password: 'password1' })).status, 403)
  assert.equal((await call('POST', '/api/auth/register', { email: 'a@b.co', name: 'A', password: 'password1', setupToken: 'guess' })).status, 403)
  // Guessing it is throttled like a password: after 10 wrong tries from one address, even the right token waits.
  const fromGuesser = (setupToken: string) => app.request('/api/auth/register', { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.9.9.9' }, body: JSON.stringify({ email: 'g@b.co', name: 'G', password: 'password1', setupToken }) })
  for (let i = 0; i < 10; i++) assert.equal((await fromGuesser(`guess-${i}`)).status, 403)
  assert.equal((await fromGuesser(setup)).status, 429)
  assert.equal((await call('POST', '/api/auth/register', { email: 'a@b.co', name: 'A', password: 'password1', setupToken: setup })).status, 200)
  assert.equal(await setupToken(db), null, 'gone once there is an admin')
  assert.equal((await db.query(`SELECT 1 FROM settings WHERE key = 'setup_token'`)).rowCount, 0)

  const [space] = await (await call('GET', '/api/spaces')).json()
  const page = await (await call('POST', '/api/pages', { spaceId: space.id, title: '주간보고' })).json()
  const child = await (await call('POST', '/api/pages', { spaceId: space.id, parentId: page.id, title: '하위' })).json()

  const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '클러스터 배포 완료' }] }] }
  const saved = await call('PUT', `/api/pages/${page.id}`, { title: '주간보고', doc, version: 1 })
  assert.equal((await saved.json()).version, 2)
  // A second writer still holding version 1 must be rejected, not silently overwrite.
  assert.equal((await call('PUT', `/api/pages/${page.id}`, { title: 'x', doc, version: 1 })).status, 409)
  assert.equal((await (await call('GET', `/api/pages/${page.id}/versions`)).json()).length, 1)

  // Two-character Korean query, and LIKE wildcards are treated literally.
  assert.equal((await (await call('GET', `/api/search?q=${encodeURIComponent('배포')}`)).json()).results[0].id, page.id)
  assert.equal((await (await call('GET', '/api/search?q=%25')).json()).total, 0)
  // A particle on the query word ("배포를") still finds "배포 완료".
  assert.equal((await (await call('GET', `/api/search?q=${encodeURIComponent('배포를')}`)).json()).results[0]?.id, page.id)

  const form = new FormData()
  form.append('file', new File(['<script>alert(1)</script>'], 'x.html', { type: 'text/html' }))
  const up = await (await app.request(`/api/pages/${page.id}/attachments`, { method: 'POST', headers: { cookie: a.cookie }, body: form })).json()
  // Attachment names are searchable.
  assert.equal((await (await call('GET', '/api/search?q=x.html')).json()).results[0]?.id, page.id)
  const file = await call('GET', up.url)
  assert.equal(file.headers.get('content-type'), 'application/octet-stream')
  assert.match(file.headers.get('content-disposition')!, /^attachment/)

  // Deleting a parent removes its subtree.
  assert.equal((await call('DELETE', `/api/pages/${page.id}`)).status, 200)
  assert.equal((await call('GET', `/api/pages/${child.id}`)).status, 404)

  // A second concurrent writer at the same version: exactly one wins.
  const v = (await (await call('POST', '/api/pages', { spaceId: space.id, title: 'race' })).json()).id
  const codes = (await Promise.all([1, 2].map(() => call('PUT', `/api/pages/${v}`, { title: 'r', doc, version: 1 })))).map((r) => r.status).sort()
  assert.deepEqual(codes, [200, 409])

  assert.equal((await app.request('/healthz')).status, 200)

  // Signup closes after the first account.
  assert.equal((await client().call('POST', '/api/auth/register', { email: 'c@d.co', name: 'C', password: 'password1' })).status, 403)
})

test('invites, disabling, password reset', async () => {
  const admin = client()
  await admin.call('POST', '/api/auth/login', { email: 'a@b.co', password: 'password1' })
  const { token } = await admin.json('POST', '/api/admin/invites', { role: 'member' })
  assert.equal((await client().json('GET', `/api/auth/status?token=${token}`)).link, 'invite')

  const bob = client()
  const me = await bob.json('POST', '/api/auth/register', { email: 'bob@b.co', name: 'Bob', password: 'password1', invite: token })
  assert.equal(me.role, 'member')
  assert.equal((await client().json('POST', '/api/auth/login', { email: 'a@b.co', password: 'password1' })).role, 'admin')
  assert.equal((await bob.call('GET', '/api/admin/users')).status, 403)
  // The invite is single use.
  assert.equal((await client().call('POST', '/api/auth/register', { email: 'eve@b.co', name: 'E', password: 'password1', invite: token })).status, 403)

  assert.equal((await admin.call('PATCH', `/api/admin/users/${me.id}`, { disabled: true })).status, 200)
  assert.equal((await bob.call('GET', '/api/me')).status, 401)
  assert.equal((await client().call('POST', '/api/auth/login', { email: 'bob@b.co', password: 'password1' })).status, 403)
  await admin.call('PATCH', `/api/admin/users/${me.id}`, { disabled: false })

  const reset = await admin.json('POST', `/api/admin/users/${me.id}/reset-link`)
  assert.equal((await client().call('POST', '/api/auth/reset', { token: reset.token, password: 'newpassword' })).status, 200)
  assert.equal((await client().call('POST', '/api/auth/reset', { token: reset.token, password: 'again12345' })).status, 403)
  assert.equal((await client().call('POST', '/api/auth/login', { email: 'bob@b.co', password: 'newpassword' })).status, 200)
})

test('move, trash and restore, comments', async () => {
  const a = client()
  await a.call('POST', '/api/auth/login', { email: 'a@b.co', password: 'password1' })
  const [space] = await a.json('GET', '/api/spaces')
  const mk = (title: string, parentId: number | null = null) => a.json('POST', '/api/pages', { spaceId: space.id, parentId, title })
  const p1 = await mk('p1'), p2 = await mk('p2'), c1 = await mk('c1', p1.id)

  // Cannot move a page under its own child.
  assert.equal((await a.call('POST', `/api/pages/${p1.id}/move`, { parentId: c1.id })).status, 400)
  await a.call('POST', `/api/pages/${p2.id}/move`, { parentId: p1.id, index: 0 })
  const kids = (await a.json('GET', `/api/spaces/${space.id}/pages`)).filter((p: any) => p.parentId === p1.id)
  assert.deepEqual(kids.map((p: any) => p.title), ['p2', 'c1'])
  const page = await a.json('GET', `/api/pages/${c1.id}`)
  assert.deepEqual(page.ancestors.map((x: any) => x.title), ['p1'])

  await a.call('DELETE', `/api/pages/${p1.id}`)
  const trash = await a.json('GET', `/api/spaces/${space.id}/trash`)
  assert.deepEqual(trash.filter((t: any) => ['p1', 'p2', 'c1'].includes(t.title)).map((t: any) => t.title), ['p1'])
  await a.call('POST', `/api/pages/${p1.id}/restore`)
  assert.equal((await a.call('GET', `/api/pages/${c1.id}`)).status, 200)

  const top = await a.json('POST', `/api/pages/${p1.id}/comments`, { body: '확인 부탁드립니다' })
  await a.json('POST', `/api/pages/${p1.id}/comments`, { body: '확인했습니다', parentId: top.id })
  await a.call('PATCH', `/api/comments/${top.id}`, { resolved: true })
  const list = await a.json('GET', `/api/pages/${p1.id}/comments`)
  assert.equal(list.length, 2)
  assert.ok(list[0].resolvedAt)

  const bob = client()
  await bob.call('POST', '/api/auth/login', { email: 'bob@b.co', password: 'newpassword' })
  assert.equal((await bob.call('DELETE', `/api/comments/${top.id}`)).status, 403)
})

test('page restrictions hide pages everywhere and inherit to children', async () => {
  const admin = client()
  await admin.call('POST', '/api/auth/login', { email: 'a@b.co', password: 'password1' })
  const join = async (email: string) => {
    const { token } = await admin.json('POST', '/api/admin/invites', { role: 'member' })
    const u = client()
    const me = await u.json('POST', '/api/auth/register', { email, name: email, password: 'password1', invite: token })
    return Object.assign(u, { id: me.id as number })
  }
  const bob = Object.assign(client(), { id: 0 })
  bob.id = (await bob.json('POST', '/api/auth/login', { email: 'bob@b.co', password: 'newpassword' })).id
  const carol = await join('carol@b.co')
  const dave = await join('dave@b.co')
  const [space] = await bob.json('GET', '/api/spaces')
  const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '인사평가 기밀' }] }] }

  const secret = await bob.json('POST', '/api/pages', { spaceId: space.id, title: '기밀 문서', doc })
  const child = await bob.json('POST', '/api/pages', { spaceId: space.id, parentId: secret.id, title: '기밀 하위', doc })
  const form = new FormData()
  form.append('file', new File(['secret-bytes'], 's.png', { type: 'image/png' }))
  const file = await (await app.request(`/api/pages/${secret.id}/attachments`, { method: 'POST', headers: { cookie: bob.cookie }, body: form })).json()

  // Bob restricts to Carol (view). Bob keeps edit automatically.
  assert.equal((await bob.call('PUT', `/api/pages/${secret.id}/restrictions`, { entries: [{ userId: carol.id, level: 'view' }] })).status, 200)
  const r = await bob.json('GET', `/api/pages/${secret.id}/restrictions`)
  assert.deepEqual(r.entries.map((e: any) => [e.userId, e.level]).sort(), [[bob.id, 'edit'], [carol.id, 'view']].sort())

  // A copy has the same body and keeps the restrictions; someone who can't see the page can't copy it.
  const copy = await bob.json('POST', `/api/pages/${secret.id}/copy`, {})
  assert.equal(copy.title, '기밀 문서 (copy)')
  assert.deepEqual((await bob.json('GET', `/api/pages/${copy.id}`)).doc, doc)
  assert.equal((await dave.call('GET', `/api/pages/${copy.id}`)).status, 404)
  assert.equal((await carol.call('GET', `/api/pages/${copy.id}`)).status, 200)
  assert.equal((await dave.call('POST', `/api/pages/${secret.id}/copy`, {})).status, 404)
  await bob.call('DELETE', `/api/pages/${copy.id}`)
  // With subpages: the child comes along, and the copied attachment link points at the copy's own file.
  await bob.call('PUT', `/api/pages/${child.id}`, { title: '기밀 하위', doc: { type: 'doc', content: [{ type: 'image', attrs: { src: file.url } }, ...doc.content] }, version: 1 })
  const copied = await bob.json('POST', `/api/pages/${secret.id}/copy`, { children: true })
  assert.equal(copied.count, 2)
  const kids = (await bob.json('GET', `/api/spaces/${space.id}/pages`)).filter((p: any) => p.parentId === copied.id)
  assert.equal(kids.length, 1)
  const src = (await bob.json('GET', `/api/pages/${kids[0].id}`)).doc.content[0].attrs.src
  assert.notEqual(src, file.url)
  assert.equal((await app.request(src, { headers: { cookie: bob.cookie } })).status, 200)
  assert.equal((await dave.call('GET', `/api/pages/${kids[0].id}`)).status, 404)
  await bob.call('DELETE', `/api/pages/${copied.id}`)

  // Dave: not listed. Every route behaves as if the pages don't exist.
  const status = async (u: any, m: string, path: string, body?: unknown) => (await u.call(m, path, body)).status
  for (const pid of [secret.id, child.id]) {
    assert.equal(await status(dave, 'GET', `/api/pages/${pid}`), 404)
    assert.equal(await status(dave, 'GET', `/api/pages/${pid}/comments`), 404)
    assert.equal(await status(dave, 'GET', `/api/pages/${pid}/versions`), 404)
    assert.equal(await status(dave, 'GET', `/api/pages/${pid}/restrictions`), 404)
    assert.equal(await status(dave, 'PUT', `/api/pages/${pid}`, { title: 'x', doc, version: 1 }), 404)
    assert.equal(await status(dave, 'DELETE', `/api/pages/${pid}`), 404)
    assert.equal(await status(dave, 'POST', `/api/pages/${pid}/comments`, { body: 'hi' }), 404)
    assert.equal(await status(dave, 'POST', '/api/pages', { spaceId: space.id, parentId: pid, title: 'x' }), 404)
  }
  assert.equal(await status(dave, 'GET', file.url), 404)
  const ids = (list: any[]) => list.map((p) => p.id)
  assert.ok(!ids(await dave.json('GET', `/api/spaces/${space.id}/pages`)).includes(secret.id))
  assert.ok(!ids(await dave.json('GET', `/api/spaces/${space.id}/pages`)).includes(child.id))
  assert.equal((await dave.json('GET', `/api/search?q=${encodeURIComponent('인사평가')}`)).total, 0)
  assert.ok(!ids(await dave.json('GET', '/api/recent')).includes(secret.id))

  // Carol: view only, inherited to the child.
  assert.equal((await carol.json('GET', `/api/pages/${child.id}`)).access, 'view')
  assert.equal(await status(carol, 'PUT', `/api/pages/${secret.id}`, { title: 'x', doc, version: 1 }), 403)
  assert.equal(await status(carol, 'POST', `/api/pages/${secret.id}/comments`, { body: '봤습니다' }), 200)
  assert.equal(await status(carol, 'GET', file.url), 200)
  assert.equal((await carol.json('GET', `/api/search?q=${encodeURIComponent('인사평가')}`)).total, 2)
  const tree = await carol.json('GET', `/api/spaces/${space.id}/pages`)
  assert.equal(tree.find((p: any) => p.id === secret.id).locked, true)

  // Admin can always reach it, to fix a lockout.
  assert.equal((await admin.json('GET', `/api/pages/${secret.id}`)).access, 'edit')

  // Dave can't trash a parent that holds a page hidden from him.
  const box = await dave.json('POST', '/api/pages', { spaceId: space.id, title: 'dave box' })
  assert.equal(await status(bob, 'POST', `/api/pages/${secret.id}/move`, { parentId: box.id }), 200)
  assert.equal(await status(dave, 'DELETE', `/api/pages/${box.id}`), 403)
  assert.equal(await status(dave, 'GET', `/api/pages/${secret.id}`), 404)

  // Clearing restrictions opens it again.
  await bob.call('PUT', `/api/pages/${secret.id}/restrictions`, { entries: [] })
  assert.equal((await dave.json('GET', `/api/pages/${child.id}`)).access, 'edit')
  assert.equal(await status(carol, 'PUT', `/api/pages/${secret.id}/restrictions`, { entries: [{ userId: 999999, level: 'edit' }] }), 400)
})

test('search snippets start and end on word boundaries', async () => {
  const { snippet } = await import('./app.ts')
  const text = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega'
  const s = snippet(text, 'omicron')
  assert.match(s, /^…\S/)
  assert.ok(s.includes('omicron'))
  // The excerpt begins with a whole word, not the tail of one.
  assert.ok(text.split(' ').includes(s.slice(1).split(' ')[0]))
  assert.equal(snippet('short text', 'short'), 'short text')
})

test('nothing written is lost: wipes, restores and deleted comments stay recoverable', async () => {
  const a = client()
  await a.call('POST', '/api/auth/login', { email: 'a@b.co', password: 'password1' })
  const [space] = await a.json('GET', '/api/spaces')
  const para = (text: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] }] })
  const long = '중요한 회의 결정 사항입니다. '.repeat(30)
  const pg = await a.json('POST', '/api/pages', { spaceId: space.id, title: 'safety', doc: para('template') })

  // The template content itself is in history from the start.
  let versions = await a.json('GET', `/api/pages/${pg.id}/versions`)
  assert.equal(versions.length, 1)

  // Typing in one session merges into one entry...
  let v = (await a.json('PUT', `/api/pages/${pg.id}`, { title: 'safety', doc: para(long), version: 1 })).version
  v = (await a.json('PUT', `/api/pages/${pg.id}`, { title: 'safety', doc: para(long + ' 추가'), version: v })).version
  versions = await a.json('GET', `/api/pages/${pg.id}/versions`)
  assert.equal(versions.length, 1)

  // ...but an accidental select-all delete never overwrites it.
  v = (await a.json('PUT', `/api/pages/${pg.id}`, { title: 'safety', doc: para(''), version: v })).version
  versions = await a.json('GET', `/api/pages/${pg.id}/versions`)
  assert.equal(versions.length, 2)
  const before = await a.json('GET', `/api/versions/${versions[1].id}`)
  assert.ok(JSON.stringify(before.doc).includes('추가'), 'the content from before the wipe is still in history')

  // A checkpoint save (history restore, draft recovery) always keeps the previous state.
  v = (await a.json('PUT', `/api/pages/${pg.id}`, { title: 'safety', doc: para('x'), version: v, checkpoint: true })).version
  assert.equal((await a.json('GET', `/api/pages/${pg.id}/versions`)).length, 3)

  // Deleting a comment hides it with its replies; restoring brings both back.
  const top = await a.json('POST', `/api/pages/${pg.id}/comments`, { body: 'top' })
  await a.json('POST', `/api/pages/${pg.id}/comments`, { body: 'reply', parentId: top.id })
  await a.call('DELETE', `/api/comments/${top.id}`)
  assert.equal((await a.json('GET', `/api/pages/${pg.id}/comments`)).length, 0)
  assert.equal((await a.call('POST', `/api/comments/${top.id}/restore`)).status, 200)
  assert.equal((await a.json('GET', `/api/pages/${pg.id}/comments`)).length, 2)
})

test('search: all words must match, filters, title-first ranking, paths; locale is per account', async () => {
  const a = client()
  const me = await a.json('POST', '/api/auth/login', { email: 'a@b.co', password: 'password1' })
  const space = await a.json('POST', '/api/spaces', { name: 'Search', key: 'SRCH' })
  const para = (t: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }] })
  const parent = await a.json('POST', '/api/pages', { spaceId: space.id, title: '인프라', doc: para('상위') })
  const inBody = await a.json('POST', '/api/pages', { spaceId: space.id, parentId: parent.id, title: '회의록', doc: para('쿠버네티스 업그레이드 일정 논의') })
  const inTitle = await a.json('POST', '/api/pages', { spaceId: space.id, title: '쿠버네티스 업그레이드 계획', doc: para('일정') })
  await a.json('POST', '/api/pages', { spaceId: space.id, title: '쿠버네티스 모니터링', doc: para('대시보드') })

  const s = (q: string) => a.json('GET', `/api/search?space=${space.id}&${q}`)
  const both = await s(`q=${encodeURIComponent('쿠버네티스 업그레이드')}`)
  assert.equal(both.total, 2, 'only pages containing every word')
  assert.equal(both.results[0].id, inTitle.id, 'title matches rank first')
  assert.deepEqual(both.results.find((r: any) => r.id === inBody.id).path, ['인프라'])
  assert.equal((await s(`q=${encodeURIComponent('업그레이드')}&scope=title`)).total, 1)
  assert.equal((await s(`q=${encodeURIComponent('쿠버네티스')}&limit=1&offset=1`)).results.length, 1)
  assert.equal((await s(`q=${encodeURIComponent('쿠버네티스')}&author=999999`)).total, 0)
  assert.equal((await s(`q=${encodeURIComponent('쿠버네티스')}&days=1`)).total, 3)

  assert.equal(me.locale, null)
  assert.equal((await a.call('PATCH', '/api/me', { locale: 'fr' })).status, 400)
  await a.call('PATCH', '/api/me', { locale: 'ko' })
  assert.equal((await a.json('GET', '/api/me')).locale, 'ko')
  assert.equal((await client().json('POST', '/api/auth/login', { email: 'a@b.co', password: 'password1' })).locale, 'ko')
})

test('markdown: every block the editor makes, with URL rewriting', async () => {
  const { toMarkdown } = await import('./markdown.ts')
  const t = (text: string, marks?: any[]) => ({ type: 'text', text, marks })
  const p = (...c: any[]) => ({ type: 'paragraph', content: c })
  const doc = { type: 'doc', content: [
    { type: 'heading', attrs: { level: 2 }, content: [t('Plan')] },
    p(t('bold', [{ type: 'bold' }]), t(' and '), t('docs', [{ type: 'link', attrs: { href: '/api/files/7' } }])),
    { type: 'bulletList', content: [{ type: 'listItem', content: [p(t('one')), { type: 'bulletList', content: [{ type: 'listItem', content: [p(t('nested'))] }] }] }] },
    { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true }, content: [p(t('done'))] }] },
    { type: 'callout', attrs: { variant: 'warning' }, content: [p(t('careful'))] },
    { type: 'codeBlock', attrs: { language: 'yaml' }, content: [t('a: 1')] },
    { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableHeader', content: [p(t('k'))] }, { type: 'tableHeader', content: [p(t('v|x'))] }] }] },
    { type: 'image', attrs: { src: '/api/files/8', alt: 'pic' } },
  ] }
  const md = toMarkdown('Title', doc, (u) => u.replace('/api/files/', 'files/'))
  for (const want of ['# Title', '## Plan', '**bold**', '[docs](files/7)', '- one\n  - nested', '- [x] done', '> [!WARNING]\n> careful', '```yaml\na: 1\n```', '| k | v\\|x |', '![pic](files/8)'])
    assert.ok(md.includes(want), `missing ${JSON.stringify(want)} in\n${md}`)
})

test('admin stats, storage limit blocks uploads but never text, ZIP export respects access', async () => {
  const { unzipSync, strFromU8 } = await import('fflate')
  const admin = client()
  await admin.call('POST', '/api/auth/login', { email: 'a@b.co', password: 'password1' })
  const stats = await admin.json('GET', '/api/admin/stats')
  assert.ok(stats.storage.dbBytes > 0 && stats.counts.pages > 0 && stats.activity.length === 14)
  const bob = client()
  await bob.call('POST', '/api/auth/login', { email: 'bob@b.co', password: 'newpassword' })
  assert.equal((await bob.call('GET', '/api/admin/stats')).status, 403)

  const space = await admin.json('POST', '/api/spaces', { name: 'Export Test', key: 'EXP' })
  const para = (text: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })
  const root = await admin.json('POST', '/api/pages', { spaceId: space.id, title: 'Handbook', doc: para('root') })
  const child = await admin.json('POST', '/api/pages', { spaceId: space.id, parentId: root.id, title: 'On/boarding', doc: para('child') })
  const secret = await admin.json('POST', '/api/pages', { spaceId: space.id, parentId: root.id, title: 'Secret', doc: para('hidden') })
  await admin.call('PUT', `/api/pages/${secret.id}/restrictions`, { entries: [{ userId: 1, level: 'edit' }] })
  const upload = (cookie: string, pageId: number, bytes: number) => {
    const form = new FormData()
    form.append('file', new File([new Uint8Array(bytes).fill(65)], 'a.txt', { type: 'text/plain' }))
    return app.request(`/api/pages/${pageId}/attachments`, { method: 'POST', headers: { cookie }, body: form })
  }
  const att = await (await upload(admin.cookie, child.id, 10)).json()
  const pg = await admin.json('GET', `/api/pages/${child.id}`)
  await admin.json('PUT', `/api/pages/${child.id}`, { title: 'On/boarding', version: pg.version, doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'see', marks: [{ type: 'link', attrs: { href: att.url } }] }] }] } })

  // Limit just above current use: uploads are refused, saving text still works.
  const used = stats.storage.usedBytes
  await admin.json('PUT', '/api/admin/settings', { storageLimitGb: (used + 1000) / 1024 ** 3 })
  const refused = await upload(admin.cookie, child.id, 1_000_000)
  assert.equal(refused.status, 413)
  assert.equal((await refused.json()).code, 'storage_full')
  const now = await admin.json('GET', `/api/pages/${child.id}`)
  assert.equal((await admin.call('PUT', `/api/pages/${child.id}`, { title: 'On/boarding', version: now.version, doc: para('text still saves') })).status, 200)
  await admin.json('PUT', '/api/admin/settings', { storageLimitGb: null })

  // Backup policy: validated, saved, and what the backup container reads back.
  assert.equal((await admin.call('PUT', '/api/admin/backup-policy', { intervalHours: 0, keep: 14, maxAgeDays: 0, manualMaxAgeDays: 0 })).status, 400)
  assert.equal((await admin.call('PUT', '/api/admin/backup-policy', { intervalHours: 6, keep: 7, maxAgeDays: 30, manualMaxAgeDays: 90 })).status, 200)
  const pol = (await db.query(`SELECT coalesce((v->>'intervalHours')::int, 24) || ' ' || coalesce((v->>'keep')::int, 14) || ' ' || coalesce((v->>'maxAgeDays')::int, 0) || ' ' || coalesce((v->>'manualMaxAgeDays')::int, 0) AS p
    FROM (SELECT (SELECT value FROM settings WHERE key = 'backup') AS v) s`)).rows[0].p
  assert.equal(pol, '6 7 30 90')
  await db.query(`DELETE FROM settings WHERE key = 'backup'`)
  assert.equal((await upload(admin.cookie, child.id, 1000)).status, 200)

  const files = (buf: ArrayBuffer) => unzipSync(new Uint8Array(buf))
  const asAdmin = files(await (await admin.call('GET', `/api/spaces/${space.id}/export`)).arrayBuffer())
  const names = Object.keys(asAdmin)
  assert.ok(names.includes('Export Test/Handbook.md'))
  assert.ok(names.includes('Export Test/Handbook/On_boarding.md'), names.join(', '))
  assert.ok(names.includes('Export Test/Handbook/Secret.md'))
  assert.ok(names.some((n) => n.startsWith('Export Test/_attachments/')))
  const manifest = JSON.parse(strFromU8(asAdmin['Export Test/pagehouse.json']))
  assert.equal(manifest.format, 'pagehouse-export')
  assert.equal(manifest.pages.length, 3)

  // Bob can't see the restricted page, so it is not in his export.
  const asBob = files(await (await bob.call('GET', `/api/pages/${root.id}/export`)).arrayBuffer())
  // Same layout as a space export: <archive folder>/<page>.md, subpages in <archive folder>/<page>/.
  assert.ok(Object.keys(asBob).includes('Handbook/Handbook/On_boarding.md'), Object.keys(asBob).join(', '))
  assert.ok(!Object.keys(asBob).some((n) => n.includes('Secret')))
  assert.equal((await bob.call('GET', `/api/pages/${secret.id}/export`)).status, 404)
})

test('security: sign-in throttling, cross-site writes refused, inert attachments', async () => {
  // Wrong passwords: the 11th attempt in a row is refused even with the right password.
  const ip = { 'x-forwarded-for': '203.0.113.9', 'content-type': 'application/json' }
  const login = (password: string) => app.request('/api/auth/login', { method: 'POST', headers: ip, body: JSON.stringify({ email: 'bob@b.co', password }) })
  for (let i = 0; i < 10; i++) assert.equal((await login('wrong-password')).status, 401)
  const blocked = await login('newpassword')
  assert.equal(blocked.status, 429)
  assert.equal((await blocked.json()).code, 'too_many_attempts')
  // Writing a fresh address in front of X-Forwarded-For doesn't help: only the hop our proxy added counts.
  const forged = await app.request('/api/auth/login', { method: 'POST', headers: { ...ip, 'x-forwarded-for': '192.0.2.77, 203.0.113.9' }, body: JSON.stringify({ email: 'bob@b.co', password: 'newpassword' }) })
  assert.equal(forged.status, 429)
  // Another address is not affected.
  const other = await app.request('/api/auth/login', { method: 'POST', headers: { ...ip, 'x-forwarded-for': '198.51.100.7' }, body: JSON.stringify({ email: 'bob@b.co', password: 'newpassword' }) })
  assert.equal(other.status, 200)

  const a = client()
  await a.call('POST', '/api/auth/login', { email: 'a@b.co', password: 'password1' })
  const [space] = await a.json('GET', '/api/spaces')
  const evil = await app.request('/api/pages', {
    method: 'POST',
    headers: { cookie: a.cookie, 'content-type': 'application/json', origin: 'https://evil.example', host: 'wiki.local' },
    body: JSON.stringify({ spaceId: space.id, title: 'x' }),
  })
  assert.equal(evil.status, 403)
  const same = await app.request('http://wiki.local/api/pages', {
    method: 'POST',
    headers: { cookie: a.cookie, 'content-type': 'application/json', origin: 'http://wiki.local', host: 'wiki.local' },
    body: JSON.stringify({ spaceId: space.id, title: 'ok' }),
  })
  assert.equal(same.status, 200)

  const form = new FormData()
  form.append('file', new File(['<svg onload=alert(1)>'], 'x.svg', { type: 'image/svg+xml' }))
  const up = await (await app.request(`/api/pages/${(await same.json()).id}/attachments`, { method: 'POST', headers: { cookie: a.cookie }, body: form })).json()
  const file = await a.call('GET', up.url)
  assert.match(file.headers.get('content-security-policy')!, /sandbox/)
  assert.equal(file.headers.get('content-type'), 'application/octet-stream')
})

test('spaces: private and view-only spaces, members, and the limits they put on pages', async () => {
  const admin = client()
  await admin.call('POST', '/api/auth/login', { email: 'a@b.co', password: 'password1' })
  const join = async (email: string) => {
    const { token } = await admin.json('POST', '/api/admin/invites', { role: 'member' })
    const u = client()
    const me = await u.json('POST', '/api/auth/register', { email, name: email.split('@')[0], password: 'password1', invite: token })
    return Object.assign(u, { id: me.id as number })
  }
  const owner = await join('owner@sp.co')
  const insider = await join('insider@sp.co')
  const outsider = await join('outsider@sp.co')

  // A member creates a private space; they manage it automatically.
  const priv = await owner.json('POST', '/api/spaces', { name: 'HR', key: 'HR', defaultAccess: 'none' })
  assert.equal(priv.role, 'admin')
  const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '연봉 테이블' }] }] }
  const pg = await owner.json('POST', '/api/pages', { spaceId: priv.id, title: 'Salaries', doc })
  const ids = (l: any[]) => l.map((x) => x.id)
  assert.ok(!ids(await outsider.json('GET', '/api/spaces')).includes(priv.id), 'private space not listed')
  assert.equal((await outsider.call('GET', `/api/pages/${pg.id}`)).status, 404)
  assert.equal((await outsider.json('GET', `/api/search?q=${encodeURIComponent('연봉')}`)).total, 0)
  assert.equal((await outsider.call('POST', '/api/pages', { spaceId: priv.id, title: 'x' })).status, 404)
  assert.equal((await outsider.call('GET', `/api/spaces/${priv.id}/settings`)).status, 404)
  assert.equal((await outsider.call('PUT', `/api/spaces/${priv.id}/settings`, { name: 'x', defaultAccess: 'edit', members: [] })).status, 403)

  // Add the insider as a viewer: they see it, but can't edit or create.
  assert.equal((await owner.call('PUT', `/api/spaces/${priv.id}/settings`, { name: 'HR', defaultAccess: 'none', members: [{ userId: insider.id, role: 'view' }] })).status, 200)
  const settings = await owner.json('GET', `/api/spaces/${priv.id}/settings`)
  assert.deepEqual(settings.members.map((m: any) => m.role).sort(), ['admin', 'view'], 'owner kept as admin')
  assert.equal((await insider.json('GET', `/api/pages/${pg.id}`)).access, 'view')
  assert.equal((await insider.call('PUT', `/api/pages/${pg.id}`, { title: 'x', doc, version: 1 })).status, 403)
  assert.equal((await insider.call('POST', '/api/pages', { spaceId: priv.id, title: 'x' })).status, 403)

  // An open space everyone can read but only members edit.
  const docs = await owner.json('POST', '/api/spaces', { name: 'Policies', key: 'POL', defaultAccess: 'view' })
  const policy = await owner.json('POST', '/api/pages', { spaceId: docs.id, title: 'Leave policy' })
  assert.equal((await outsider.json('GET', `/api/pages/${policy.id}`)).access, 'view')
  assert.equal((await outsider.call('POST', '/api/pages', { spaceId: docs.id, title: 'x' })).status, 403)
  // Site admins can always reach and manage every space.
  assert.equal((await admin.json('GET', `/api/pages/${pg.id}`)).access, 'edit')
  assert.equal((await admin.json('GET', `/api/spaces/${priv.id}/settings`)).canManage, true)
})

test('mentions and replies notify people who can see the page; home lists viewed, created and for-you', async () => {
  const admin = client()
  await admin.call('POST', '/api/auth/login', { email: 'a@b.co', password: 'password1' })
  const insider = client(); const me = await insider.json('POST', '/api/auth/login', { email: 'insider@sp.co', password: 'password1' })
  const outsider = client(); const out = await outsider.json('POST', '/api/auth/login', { email: 'outsider@sp.co', password: 'password1' })
  const owner = client(); await owner.call('POST', '/api/auth/login', { email: 'owner@sp.co', password: 'password1' })
  const [general] = await admin.json('GET', '/api/spaces')
  const mention = (id: number, label: string) => ({ type: 'mention', attrs: { id: String(id), label } })
  const pg = await admin.json('POST', '/api/pages', { spaceId: general.id, title: 'Kickoff' })
  await admin.json('PUT', `/api/pages/${pg.id}`, { title: 'Kickoff', version: 1, doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'cc ' }, mention(me.id, 'insider')] }] } })

  let n = await insider.json('GET', '/api/notifications')
  assert.equal(n.unread, 1)
  assert.equal(n.items[0].kind, 'mention')
  assert.equal(n.items[0].page, 'Kickoff')
  // Saving again doesn't notify twice for the same mention.
  const cur = await admin.json('GET', `/api/pages/${pg.id}`)
  await admin.json('PUT', `/api/pages/${pg.id}`, { title: 'Kickoff!', version: cur.version, doc: cur.doc })
  assert.equal((await insider.json('GET', '/api/notifications')).unread, 1)

  // Comment mention + reply notifications; the page creator hears about comments.
  const top = await insider.json('POST', `/api/pages/${pg.id}/comments`, { body: `Looks good <@${out.id}>` })
  assert.equal((await outsider.json('GET', '/api/notifications')).items[0].kind, 'comment_mention')
  assert.equal((await admin.json('GET', '/api/notifications')).items[0].kind, 'comment')
  await admin.json('POST', `/api/pages/${pg.id}/comments`, { body: 'thanks', parentId: top.id })
  assert.equal((await insider.json('GET', '/api/notifications')).items[0].kind, 'reply')

  // Mentioning someone on a page they can't open sends nothing.
  const hr = (await owner.json('GET', '/api/spaces')).find((s: any) => s.key === 'HR')
  const secret = await owner.json('POST', '/api/pages', { spaceId: hr.id, title: 'Secret' })
  await owner.json('PUT', `/api/pages/${secret.id}`, { title: 'Secret', version: 1, doc: { type: 'doc', content: [{ type: 'paragraph', content: [mention(out.id, 'outsider')] }] } })
  assert.ok(!(await outsider.json('GET', '/api/notifications')).items.some((i: any) => i.pageId === secret.id))

  await insider.call('POST', '/api/notifications/read', {})
  assert.equal((await insider.json('GET', '/api/notifications/count')).unread, 0)

  await insider.call('GET', `/api/pages/${pg.id}`)
  const home = await insider.json('GET', '/api/home')
  assert.equal(home.viewed[0].id, pg.id)
  assert.ok(home.created.some((p: any) => p.id === pg.id))
  assert.ok(home.forYou.some((i: any) => i.kind === 'mention'))
  assert.ok(!(await outsider.json('GET', '/api/home')).created.some((p: any) => p.id === secret.id), 'private pages not in others’ home')
})

test('OIDC single sign-on creates, links and signs in accounts by the provider id', async () => {
  const { createServer } = await import('node:http')
  let verifier = ''
  let nonce = ''
  let groups: string[] | undefined = ['/Engineering', 'wiki-admins']
  let emailVerified: unknown = true
  let sub = 'sso-1'
  let email = 'SSO@Corp.co'
  const jwt = (claims: object) => ['{"alg":"none"}', JSON.stringify(claims), ''].map((p) => Buffer.from(p).toString('base64url')).join('.')
  const idp = createServer(async (req, res) => {
    const u = new URL(req.url!, 'http://x')
    const base = `http://127.0.0.1:${(idp.address() as any).port}`
    let body = ''
    for await (const ch of req) body += ch
    res.setHeader('content-type', 'application/json')
    if (u.pathname === '/.well-known/openid-configuration')
      return res.end(JSON.stringify({ authorization_endpoint: `${base}/auth`, token_endpoint: `${base}/token`, userinfo_endpoint: `${base}/me`, end_session_endpoint: `${base}/logout` }))
    if (u.pathname === '/token') {
      verifier = new URLSearchParams(body).get('code_verifier') ?? ''
      const idt = jwt({ iss: base, aud: 'wiki', sub, nonce, exp: Math.floor(Date.now() / 1000) + 60 })
      return res.end(JSON.stringify(new URLSearchParams(body).get('code') === 'good' && new URLSearchParams(body).get('client_secret') === 's3cret-value' ? { access_token: 'at', id_token: idt } : {}))
    }
    if (u.pathname === '/me') return res.end(JSON.stringify({ sub, email, email_verified: emailVerified, name: 'Sso User', groups }))
    res.statusCode = 404
    res.end()
  })
  await new Promise<void>((r) => idp.listen(0, '127.0.0.1', r))
  const issuer = `http://127.0.0.1:${(idp.address() as any).port}`
  const sapp = createApp(db, mkdtempSync(join(tmpdir(), 'pagehouse-')))
  const admin = client()
  await admin.call('POST', '/api/auth/login', { email: 'a@b.co', password: 'password1' })
  process.env.SECRET_KEY = 'test-secret-key'
  const put = (body: unknown) => sapp.request('/api/admin/sso', { method: 'PUT', headers: { cookie: admin.cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  try {
    // An admin turns it on from the screen; an issuer that doesn't answer is refused instead of saved.
    assert.equal((await (await sapp.request('/api/auth/status')).json()).sso, null)
    assert.equal((await put({ enabled: true, issuer: 'http://127.0.0.1:1', clientId: 'wiki' })).status, 400)
    const saved = await (await put({ enabled: true, issuer, clientId: 'wiki', clientSecret: 's3cret-value', label: 'SSO', adminGroup: 'wiki-admins' })).json()
    assert.equal(saved.enabled, true)
    assert.deepEqual([saved.groupsClaim, saved.adminGroup], ['groups', 'wiki-admins'])
    assert.equal(saved.hasSecret, true)
    assert.ok(!JSON.stringify(saved).includes('s3cret-value'), 'the secret never comes back')
    // Stored encrypted with SECRET_KEY, so a database dump or backup doesn't reveal it.
    const raw = (await db.query(`SELECT value->>'clientSecret' AS s FROM settings WHERE key = 'sso'`)).rows[0].s
    assert.match(raw, /^enc:v1:/)
    assert.ok(!raw.includes('s3cret-value'))
    // Saving again without a secret keeps the stored one.
    assert.equal((await (await put({ ...saved, clientSecret: '' })).json()).hasSecret, true)
    assert.equal((await (await sapp.request('/api/auth/status')).json()).sso, 'SSO')
    const audit = await (await sapp.request('/api/admin/audit?action=settings.sso', { headers: { cookie: admin.cookie } })).json()
    assert.ok(audit.length >= 1 && !JSON.stringify(audit).includes('s3cret-value'))
    const signIn = async (idpNonce?: string) => {
      const start = await sapp.request('/api/auth/oidc/start')
      const loc = new URL(start.headers.get('location')!)
      nonce = idpNonce ?? loc.searchParams.get('nonce')!
      const cookie = start.headers.get('set-cookie')!.split(';')[0]
      return { state: loc.searchParams.get('state')!, cookie, sent: loc.searchParams.get('nonce') }
    }
    const { state, cookie, sent } = await signIn()
    assert.ok(sent && sent.length >= 20, 'a nonce goes with the request')
    // A forged state is refused.
    assert.match((await sapp.request(`/api/auth/oidc/callback?code=good&state=bad`, { headers: { cookie } })).headers.get('location')!, /sso_error=failed/)
    // An ID token minted for another sign-in (its nonce doesn't match this browser's) is refused.
    const replay = await signIn('someone-elses-nonce')
    assert.match((await sapp.request(`/api/auth/oidc/callback?code=good&state=${replay.state}`, { headers: { cookie: replay.cookie } })).headers.get('location')!, /sso_error=failed/)
    nonce = sent
    const cb = await sapp.request(`/api/auth/oidc/callback?code=good&state=${state}`, { headers: { cookie } })
    assert.equal(cb.headers.get('location'), '/')
    assert.ok(verifier.length > 40)
    const sid = cb.headers.getSetCookie().find((h) => h.startsWith('sid='))!.split(';')[0]
    const me = await (await sapp.request('/api/me', { headers: { cookie: sid } })).json()
    assert.equal(me.email, 'sso@corp.co')
    // The provider's groups became Pagehouse groups (Keycloak's leading slash dropped), and the admin group made an admin.
    const groupsOf = async () => (await db.query(`SELECT g.name, gm.source FROM group_members gm JOIN groups g ON g.id = gm.group_id
      WHERE gm.user_id = $1 ORDER BY g.name`, [me.id])).rows.map((r) => `${r.name}:${r.source ?? 'manual'}`)
    assert.deepEqual(await groupsOf(), ['Engineering:oidc', 'wiki-admins:oidc'])
    assert.equal(me.role, 'admin')
    // Next sign-in: left the provider groups. Synced memberships go, one an admin added by hand stays, admin goes.
    const manual = await (await sapp.request('/api/admin/groups', { method: 'POST', headers: { cookie: admin.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Manual', members: [me.id] }) })).json()
    groups = []
    const again = await signIn()
    await sapp.request(`/api/auth/oidc/callback?code=good&state=${again.state}`, { headers: { cookie: again.cookie } })
    assert.deepEqual(await groupsOf(), ['Manual:manual'])
    assert.equal((await db.query('SELECT role FROM users WHERE id = $1', [me.id])).rows[0].role, 'member')
    // A provider that sends no groups claim changes nothing.
    groups = undefined
    const third = await signIn()
    await sapp.request(`/api/auth/oidc/callback?code=good&state=${third.state}`, { headers: { cookie: third.cookie } })
    assert.deepEqual(await groupsOf(), ['Manual:manual'])
    await sapp.request(`/api/admin/groups/${manual.id}`, { method: 'DELETE', headers: { cookie: admin.cookie } })
    // As person `as` at the provider: where the callback sends the browser, and the account it signed in to.
    const as = async (who: string, mail: string, verified: unknown = true) => {
      ;[sub, email, emailVerified] = [who, mail, verified]
      const s = await signIn()
      const res = await sapp.request(`/api/auth/oidc/callback?code=good&state=${s.state}`, { headers: { cookie: s.cookie } })
      const sidc = res.headers.getSetCookie().find((h) => h.startsWith('sid='))?.split(';')[0]
      return { to: res.headers.get('location'), id: sidc ? (await (await sapp.request('/api/me', { headers: { cookie: sidc } })).json()).id : null }
    }
    const subOf = async (id: number) => (await db.query('SELECT email, oidc_sub FROM users WHERE id = $1', [id])).rows[0]
    assert.deepEqual(await subOf(me.id), { email: 'sso@corp.co', oidc_sub: 'sso-1' })
    // An account from before the upgrade (no provider id yet) is linked by verified email at its first SSO sign-in...
    const legacy = (await db.query(`INSERT INTO users (email, name, password_hash) VALUES ('old@corp.co', 'Old', 'x') RETURNING id`)).rows[0].id
    assert.deepEqual(await as('sso-2', 'Old@Corp.co'), { to: '/', id: legacy })
    assert.equal((await subOf(legacy)).oidc_sub, 'sso-2')
    // ...then found by that id: a changed email at the provider is the same account (its email here stays).
    assert.deepEqual(await as('sso-2', 'renamed@corp.co'), { to: '/', id: legacy })
    assert.equal((await subOf(legacy)).email, 'old@corp.co')
    // Someone else at the provider with that email can't take the linked account.
    assert.deepEqual(await as('sso-3', 'old@corp.co'), { to: '/?sso_error=email_taken', id: null })
    // An unverified email neither links an existing account nor creates a new one.
    const legacy2 = (await db.query(`INSERT INTO users (email, name, password_hash) VALUES ('old2@corp.co', 'Old 2', 'x') RETURNING id`)).rows[0].id
    assert.equal((await as('sso-4', 'old2@corp.co', false)).to, '/?sso_error=no_email')
    assert.equal((await as('sso-4', 'old2@corp.co', null)).to, '/?sso_error=no_email')
    assert.equal((await as('sso-5', 'fresh@corp.co', false)).to, '/?sso_error=no_email')
    assert.equal((await db.query(`SELECT 1 FROM users WHERE email = 'fresh@corp.co' OR oidc_sub IN ('sso-4', 'sso-5')`)).rowCount, 0)
    // "Trust emails…" only covers a provider that sends no email_verified; "false", even as a string, is still a refusal.
    await put({ ...saved, clientSecret: '', trustEmail: true })
    assert.equal((await as('sso-4', 'old2@corp.co', 'false')).to, '/?sso_error=no_email')
    assert.equal((await as('sso-5', 'fresh@corp.co', false)).to, '/?sso_error=no_email')
    assert.deepEqual(await as('sso-4', 'old2@corp.co', null), { to: '/', id: legacy2 })
    assert.equal((await as('sso-5', 'fresh@corp.co', null)).to, '/')
    // With account creation off, linked and linkable accounts still get in; nobody else does.
    await put({ ...saved, clientSecret: '', autoCreate: false })
    assert.deepEqual(await as('sso-2', 'renamed@corp.co'), { to: '/', id: legacy })
    assert.equal((await as('sso-3', 'old@corp.co')).to, '/?sso_error=no_account')
    assert.equal((await as('sso-6', 'nobody@corp.co')).to, '/?sso_error=no_account')
    ;[sub, email, emailVerified] = ['sso-1', 'SSO@Corp.co', true]
    await put({ ...saved, clientSecret: '' })
    // The SSO account has no password, so password sign-in can't be used to get in.
    assert.equal((await sapp.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'sso@corp.co', password: '' }) })).status, 401)
    // Environment variables take over, and the screen becomes read-only.
    process.env.OIDC_ISSUER = issuer
    process.env.OIDC_CLIENT_ID = 'from-env'
    // Signing out also ends the provider's session.
    const idt = cb.headers.getSetCookie().find((h) => h.startsWith('oidc_idt='))!.split(';')[0]
    const out = await (await sapp.request('/api/auth/logout', { method: 'POST', headers: { cookie: `${sid}; ${idt}` } })).json()
    assert.match(out.redirect, /\/logout\?id_token_hint=[\w-]+\.[\w-]+\.&client_id=.+&post_logout_redirect_uri=http%3A%2F%2F/)
    assert.equal((await (await sapp.request('/api/auth/logout', { method: 'POST', headers: { cookie: sid } })).json()).redirect, null)
    const env = await (await sapp.request('/api/admin/sso', { headers: { cookie: admin.cookie } })).json()
    assert.deepEqual([env.source, env.clientId], ['env', 'from-env'])
    assert.equal((await put({ enabled: false })).status, 409)
  } finally {
    delete process.env.OIDC_ISSUER
    delete process.env.OIDC_CLIENT_ID
    await put({ enabled: false })
    idp.close()
    delete process.env.SECRET_KEY
  }
})

test('groups grant space roles and page access; a group in use cannot be deleted', async () => {
  const admin = client()
  await admin.call('POST', '/api/auth/login', { email: 'a@b.co', password: 'password1' })
  const join = async (email: string) => {
    const { token } = await admin.json('POST', '/api/admin/invites', { role: 'member' })
    const u = client()
    const me = await u.json('POST', '/api/auth/register', { email, name: email.split('@')[0], password: 'password1', invite: token })
    return Object.assign(u, { id: me.id as number })
  }
  const lead = await join('lead@g.co')
  const dev = await join('dev@g.co')
  const other = await join('other@g.co')
  const devs = await admin.json('POST', '/api/admin/groups', { name: 'Developers', members: [dev.id] })
  assert.equal((await admin.call('POST', '/api/admin/groups', { name: 'Developers', members: [] })).status, 409)
  assert.equal((await dev.call('POST', '/api/admin/groups', { name: 'X', members: [] })).status, 403)

  const space = await lead.json('POST', '/api/spaces', { name: 'Eng', key: 'ENG', defaultAccess: 'none' })
  const page = await lead.json('POST', '/api/pages', { spaceId: space.id, title: 'Runbook' })
  assert.equal((await dev.call('GET', `/api/pages/${page.id}`)).status, 404)
  await lead.call('PUT', `/api/spaces/${space.id}/settings`, { name: 'Eng', defaultAccess: 'none', members: [{ groupId: devs.id, role: 'edit' }] })
  assert.equal((await dev.json('GET', `/api/pages/${page.id}`)).access, 'edit')
  assert.equal((await other.call('GET', `/api/pages/${page.id}`)).status, 404)
  // A personal membership overrides the group role.
  await lead.call('PUT', `/api/spaces/${space.id}/settings`, { name: 'Eng', defaultAccess: 'none', members: [{ groupId: devs.id, role: 'edit' }, { userId: dev.id, role: 'view' }] })
  assert.equal((await dev.json('GET', `/api/pages/${page.id}`)).access, 'view')

  // Page restricted to the group: members see it, others don't, in lists and search too.
  const open = await admin.json('POST', '/api/spaces', { name: 'Open', key: 'OPENG', defaultAccess: 'edit' })
  const secret = await lead.json('POST', '/api/pages', { spaceId: open.id, title: 'Grouponly' })
  assert.equal((await lead.call('PUT', `/api/pages/${secret.id}/restrictions`, { entries: [{ groupId: devs.id, level: 'view' }] })).status, 200)
  assert.equal((await dev.json('GET', `/api/pages/${secret.id}`)).access, 'view')
  assert.equal((await other.call('GET', `/api/pages/${secret.id}`)).status, 404)
  assert.equal((await other.json('GET', '/api/search?q=Grouponly')).total, 0)
  assert.equal((await dev.json('GET', '/api/search?q=Grouponly')).total, 1)
  const r = await lead.json('GET', `/api/pages/${secret.id}/restrictions`)
  assert.deepEqual(r.entries.map((e: any) => e.name), ['Developers', 'lead'])

  // Deleting a group that still grants access would open the page; refused.
  assert.equal((await admin.call('DELETE', `/api/admin/groups/${devs.id}`)).status, 409)
  // Leaving the group removes access.
  await admin.call('PUT', `/api/admin/groups/${devs.id}`, { name: 'Developers', members: [] })
  assert.equal((await dev.call('GET', `/api/pages/${secret.id}`)).status, 404)
})

test('live co-editing: JSON round-trips through Yjs; two editors merge and the room saves', async () => {
  const Y = await import('yjs')
  const { docToY, yToDoc } = await import('./collab.ts')
  const sample = { type: 'doc', content: [
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Plan' }] },
    { type: 'paragraph', content: [
      { type: 'text', text: 'bold ', marks: [{ type: 'bold' }] },
      { type: 'text', text: 'link', marks: [{ type: 'link', attrs: { href: 'https://x.co' } }, { type: 'comment', attrs: { id: '1' } }, { type: 'comment', attrs: { id: '2' } }] },
    ] },
    { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph' }] }] },
  ] }
  const yd = new Y.Doc()
  docToY(yd, sample as any, 'T')
  assert.deepEqual(yToDoc(yd), sample)

  const { serve } = await import('@hono/node-server')
  const { default: WS } = await import('ws')
  const { WebsocketProvider } = await import('y-websocket')
  const dir = mkdtempSync(join(tmpdir(), 'pagehouse-'))
  const live = createApp(db, dir)
  const server = serve({ fetch: live.fetch, port: 0 })
  live.injectWebSocket(server)
  await new Promise((r) => server.once('listening', r))
  const port = (server.address() as any).port
  try {
    const a = client()
    await a.call('POST', '/api/auth/login', { email: 'a@b.co', password: 'password1' })
    const [space] = await a.json('GET', '/api/spaces')
    const page = await a.json('POST', '/api/pages', { spaceId: space.id, title: 'Live' })
    const join = (cookie: string, origin = `http://localhost:${port}`) => {
      const doc = new Y.Doc()
      const Sock = class extends WS { constructor(url: string) { super(url, { headers: { cookie, origin } }) } }
      const p = new WebsocketProvider(`ws://localhost:${port}/api/collab`, String(page.id), doc, { WebSocketPolyfill: Sock as any, disableBc: true })
      return { doc, p, synced: new Promise<void>((r) => p.once('sync', () => r())) }
    }
    const one = join(a.cookie)
    const two = join(a.cookie)
    await Promise.all([one.synced, two.synced])
    // Both start from the stored page.
    assert.equal(two.doc.getText('title').toString(), 'Live')
    // Simultaneous edits in two places both survive.
    const para = (d: any) => d.getXmlFragment('default').get(0) as any
    para(one.doc).insert(0, [new Y.XmlText('first ')])
    para(two.doc).insert(0, [new Y.XmlText('second ')])
    await new Promise((r) => setTimeout(r, 2200))
    const saved = await a.json('GET', `/api/pages/${page.id}`)
    const text = JSON.stringify(saved.doc)
    assert.ok(text.includes('first') && text.includes('second'), text)
    assert.ok(saved.version > 1)
    assert.equal(one.doc.getMap('meta').get('version'), saved.version)
    // Another site can't open a room with the user's cookie.
    const evil = join(a.cookie, 'http://evil.example')
    const closed = await new Promise((r) => evil.p.once('connection-close', () => r(true)))
    evil.p.destroy()
    evil.doc.destroy()
    assert.ok(closed)
    for (const x of [one, two]) x.p.destroy()
    await live.collab.flushAll()

    // Server restart: a fresh process resumes the stored state, so an editor still holding the old copy
    // reconnects and merges without duplicating anything.
    const restarted = createApp(db, dir)
    const server2 = serve({ fetch: restarted.fetch, port: 0 })
    restarted.injectWebSocket(server2)
    await new Promise((r) => server2.once('listening', r))
    const port2 = (server2.address() as any).port
    try {
      const rejoin = (doc: any, epoch: string) => {
        const Sock = class extends WS { constructor(url: string) { super(url, { headers: { cookie: a.cookie, origin: `http://localhost:${port2}` } }) } }
        return new WebsocketProvider(`ws://localhost:${port2}/api/collab`, String(page.id), doc, { WebSocketPolyfill: Sock as any, disableBc: true, params: { epoch } })
      }
      const epoch = String(one.doc.getMap('meta').get('epoch'))
      const back = rejoin(one.doc, epoch)
      await new Promise<void>((r) => back.once('sync', () => r()))
      await new Promise((r) => setTimeout(r, 200))
      assert.equal(one.doc.getText('title').toString(), 'Live', 'title not duplicated')
      assert.equal((JSON.stringify(yToDoc(one.doc)).match(/first/g) ?? []).length, 1, 'body not duplicated')
      back.destroy()
      await restarted.collab.flushAll()
      // Saved outside any room (REST): the change goes into the stored state, so an old copy rejoins and catches up
      // without duplicating anything.
      const cur = await a.json('GET', `/api/pages/${page.id}`)
      const restDoc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'rest edit' }] }] }
      await a.call('PUT', `/api/pages/${page.id}`, { title: 'Live', doc: restDoc, version: cur.version })
      const stale = rejoin(two.doc, epoch)
      await new Promise<void>((r) => stale.once('sync', () => r()))
      await new Promise((r) => setTimeout(r, 200))
      assert.deepEqual(yToDoc(two.doc), restDoc)
      assert.equal(two.doc.getText('title').toString(), 'Live')
      stale.destroy()
      // A document identity the server never had is still refused, not merged.
      const bogusDoc = new Y.Doc()
      const bogus = rejoin(bogusDoc, 'nope')
      const code = await new Promise((r) => bogus.on('connection-close', (e: any) => r(e?.code)))
      bogus.destroy()
      bogusDoc.destroy()
      assert.equal(code, 4409)
      await restarted.collab.flushAll()
    } finally {
      ;(server2 as any).closeAllConnections?.()
      server2.close()
    }
    for (const x of [one, two]) x.doc.destroy()
  } finally {
    ;(server as any).closeAllConnections?.()
    server.close()
  }
})

test('co-editing across two app instances: edits and saves meet through Postgres', async () => {
  const Y = await import('yjs')
  const { serve } = await import('@hono/node-server')
  const { default: WS } = await import('ws')
  const { WebsocketProvider } = await import('y-websocket')
  const { startRelay } = await import('./cluster.ts')
  const { yToDoc } = await import('./collab.ts')
  const dir = mkdtempSync(join(tmpdir(), 'pagehouse-'))
  const nodes = await Promise.all([0, 1].map(async () => {
    const app = createApp(db, dir)
    const server = serve({ fetch: app.fetch, port: 0 })
    app.injectWebSocket(server)
    await new Promise((r) => server.once('listening', r))
    return { app, server, port: (server.address() as any).port as number, stop: await startRelay(db, url, app.collab) }
  }))
  const docs: any[] = []
  const provs: any[] = []
  try {
    const a = client()
    await a.call('POST', '/api/auth/login', { email: 'a@b.co', password: 'password1' })
    const [space] = await a.json('GET', '/api/spaces')
    const page = await a.json('POST', '/api/pages', { spaceId: space.id, title: 'Cluster' })
    // Both instances open the page at the same moment: they must agree on one document identity.
    const [one, two] = nodes.map(({ port }) => {
      const doc = new Y.Doc()
      const Sock = class extends WS { constructor(u: string) { super(u, { headers: { cookie: a.cookie, origin: `http://localhost:${port}` } }) } }
      const p = new WebsocketProvider(`ws://localhost:${port}/api/collab`, String(page.id), doc, { WebSocketPolyfill: Sock as any, disableBc: true })
      docs.push(doc)
      provs.push(p)
      return { doc, synced: new Promise<void>((r) => p.once('sync', () => r())) }
    })
    await Promise.all([one.synced, two.synced])
    assert.equal(one.doc.getMap('meta').get('epoch'), two.doc.getMap('meta').get('epoch'))
    const para = (d: any) => d.getXmlFragment('default').get(0) as any
    para(one.doc).insert(0, [new Y.XmlText('from one ')])
    para(two.doc).insert(0, [new Y.XmlText('from two ')])
    await new Promise((r) => setTimeout(r, 2500))
    for (const d of [one.doc, two.doc]) {
      const t = JSON.stringify(yToDoc(d))
      assert.ok(t.includes('from one') && t.includes('from two'), t)
      assert.equal(d.getText('title').toString(), 'Cluster')
    }
    const saved = JSON.stringify((await a.json('GET', `/api/pages/${page.id}`)).doc)
    assert.ok(saved.includes('from one') && saved.includes('from two'), saved)
    // A REST save handled by an instance reaches editors connected to the other one.
    const cur = await a.json('GET', `/api/pages/${page.id}`)
    const restDoc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'via rest' }] }] }
    assert.equal((await nodes[0].app.request(`/api/pages/${page.id}`, {
      method: 'PUT', headers: { cookie: a.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Cluster', doc: restDoc, version: cur.version }),
    })).status, 200)
    await new Promise((r) => setTimeout(r, 300))
    assert.deepEqual(yToDoc(two.doc), restDoc)
    assert.deepEqual(yToDoc(one.doc), restDoc)
  } finally {
    for (const p of provs) p.destroy()
    for (const n of nodes) await n.app.collab.flushAll()
    for (const d of docs) d.destroy()
    for (const n of nodes) (await n.stop(), (n.server as any).closeAllConnections?.(), n.server.close())
  }
})

test('audit log: sign-ins (failed too), permission changes and deletions, admins only', async () => {
  const x = client()
  assert.equal((await x.call('POST', '/api/auth/login', { email: 'a@b.co', password: 'wrong-password' })).status, 401)
  await x.call('POST', '/api/auth/login', { email: 'a@b.co', password: 'password1' })
  const [space] = await x.json('GET', '/api/spaces')
  const page = await x.json('POST', '/api/pages', { spaceId: space.id, title: 'Audited' })
  await x.call('PUT', `/api/pages/${page.id}/restrictions`, { entries: [] })
  await x.call('DELETE', `/api/pages/${page.id}`)
  const log = await x.json('GET', '/api/admin/audit')
  const [del, restr, ok, bad] = log
  assert.deepEqual([del.action, del.target.name, restr.action, ok.action, ok.ok, bad.action, bad.ok], ['page.delete', 'Audited', 'page.restrictions', 'auth.login', true, 'auth.login', false])
  assert.ok(ok.actor.name)
  assert.equal(bad.actor, null)
  assert.equal(bad.detail.email, 'a@b.co')
  assert.ok(!JSON.stringify(log).includes('password1'))
  const filtered = await x.json('GET', '/api/admin/audit?action=page.delete')
  assert.ok(filtered.every((r: any) => r.action === 'page.delete') && filtered[0].id === del.id)
  const bob = client()
  await bob.call('POST', '/api/auth/login', { email: 'bob@b.co', password: 'newpassword' })
  assert.equal((await bob.call('GET', '/api/admin/audit')).status, 403)
})

test('labels: normalized, searchable on their own, hidden pages stay hidden, copied with the page', async () => {
  const x = client()
  await x.call('POST', '/api/auth/login', { email: 'a@b.co', password: 'password1' })
  const [space] = await x.json('GET', '/api/spaces')
  const page = await x.json('POST', '/api/pages', { spaceId: space.id, title: 'Weekly sync' })
  const r = await x.json('PUT', `/api/pages/${page.id}/labels`, { labels: ['Meeting Notes', '#meeting-notes', '회의록', '  ', 'a/b'] })
  assert.deepEqual(r.labels, ['ab', 'meeting-notes', '회의록'])
  assert.deepEqual((await x.json('GET', `/api/pages/${page.id}`)).labels, ['ab', 'meeting-notes', '회의록'])
  const found = await x.json('GET', '/api/search?label=meeting-notes')
  assert.deepEqual(found.results.map((h: any) => h.id), [page.id])
  assert.equal((await x.json('GET', '/api/search?label=meeting-notes&q=nomatchword')).total, 0)
  assert.ok((await x.json('GET', '/api/labels?q=meet')).some((l: any) => l.label === 'meeting-notes' && l.pages === 1))
  const copy = await x.json('POST', `/api/pages/${page.id}/copy`, {})
  assert.deepEqual((await x.json('GET', `/api/pages/${copy.id}`)).labels, ['ab', 'meeting-notes', '회의록'])
  // Restricted away from Bob: neither the page nor its label shows up for him.
  await x.call('DELETE', `/api/pages/${copy.id}`)
  await x.call('PUT', `/api/pages/${page.id}/restrictions`, { entries: [{ userId: (await x.json('GET', '/api/me')).id, level: 'edit' }] })
  const bob = client()
  await bob.call('POST', '/api/auth/login', { email: 'bob@b.co', password: 'newpassword' })
  assert.equal((await bob.json('GET', '/api/search?label=meeting-notes')).total, 0)
  assert.ok(!(await bob.json('GET', '/api/labels')).some((l: any) => l.label === 'meeting-notes'))
  assert.equal((await bob.call('PUT', `/api/pages/${page.id}/labels`, { labels: ['x'] })).status, 404)
})

test('favorites and recently viewed: per person, only pages they can still see', async () => {
  const x = client()
  await x.call('POST', '/api/auth/login', { email: 'a@b.co', password: 'password1' })
  const [space] = await x.json('GET', '/api/spaces')
  const fav = await x.json('POST', '/api/pages', { spaceId: space.id, title: 'Fav' })
  assert.equal((await x.json('GET', `/api/pages/${fav.id}`)).starred, false)
  assert.deepEqual(await x.json('PUT', `/api/pages/${fav.id}/star`, { starred: true }), { starred: true })
  assert.equal((await x.json('GET', `/api/pages/${fav.id}`)).starred, true)
  const q = await x.json('GET', '/api/me/quick')
  assert.equal(q.starred[0].id, fav.id)
  assert.equal(q.recent[0].id, fav.id)
  const bob = client()
  await bob.call('POST', '/api/auth/login', { email: 'bob@b.co', password: 'newpassword' })
  assert.ok(!(await bob.json('GET', '/api/me/quick')).starred.some((p: any) => p.id === fav.id))
  await x.call('DELETE', `/api/pages/${fav.id}`)
  assert.ok(!(await x.json('GET', '/api/me/quick')).starred.some((p: any) => p.id === fav.id))
})

test('page icon: one emoji, shown in the tree, removable, editors only', async () => {
  const x = client()
  await x.call('POST', '/api/auth/login', { email: 'a@b.co', password: 'password1' })
  const [space] = await x.json('GET', '/api/spaces')
  const page = await x.json('POST', '/api/pages', { spaceId: space.id, title: 'Iconic' })
  for (const icon of ['🚀', '👩‍💻', '🇰🇷', '👍🏽', '❤️']) assert.deepEqual(await x.json('PUT', `/api/pages/${page.id}/icon`, { icon }), { icon }, icon)
  for (const icon of ['abc', '12', '<b>', '🚀'.repeat(9), 5]) assert.equal((await x.call('PUT', `/api/pages/${page.id}/icon`, { icon })).status, 400, String(icon))
  assert.equal((await x.json('GET', `/api/pages/${page.id}`)).icon, '❤️')
  assert.equal((await x.json('GET', `/api/spaces/${space.id}/pages`)).find((p: any) => p.id === page.id).icon, '❤️')
  assert.deepEqual(await x.json('PUT', `/api/pages/${page.id}/icon`, { icon: null }), { icon: null })
  await x.call('PUT', `/api/pages/${page.id}/restrictions`, { entries: [{ userId: (await x.json('GET', '/api/me')).id, level: 'edit' }] })
  const bob = client()
  await bob.call('POST', '/api/auth/login', { email: 'bob@b.co', password: 'newpassword' })
  assert.equal((await bob.call('PUT', `/api/pages/${page.id}/icon`, { icon: '🔥' })).status, 404)
})

test('HTML export: a browsable folder with the page tree, relative links and escaped content', async () => {
  const { unzipSync } = await import('fflate')
  const x = client()
  await x.call('POST', '/api/auth/login', { email: 'a@b.co', password: 'password1' })
  const [space] = await x.json('GET', '/api/spaces')
  const parent = await x.json('POST', '/api/pages', { spaceId: space.id, title: 'HTML 부모' })
  const child = await x.json('POST', '/api/pages', { spaceId: space.id, parentId: parent.id, title: '자식 <script>' })
  const doc = { type: 'doc', content: [
    { type: 'callout', attrs: { variant: 'warning' }, content: [{ type: 'paragraph', content: [{ type: 'text', text: '주의 <b>' }] }] },
    { type: 'paragraph', content: [
      { type: 'text', text: '자식으로', marks: [{ type: 'link', attrs: { href: `#/p/${child.id}` } }] },
      { type: 'text', text: ' 나쁜링크', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] },
    ] },
    { type: 'codeBlock', attrs: { language: 'js' }, content: [{ type: 'text', text: 'a < b && c' }] },
  ] }
  await x.call('PUT', `/api/pages/${parent.id}`, { title: 'HTML 부모', doc, version: 1 })
  const res = await x.call('GET', `/api/pages/${parent.id}/export?format=html`)
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-disposition')!, /-html\.zip/)
  const files = unzipSync(new Uint8Array(await res.arrayBuffer()))
  const names = Object.keys(files).sort()
  // Same layout as the Markdown export: a page's children sit in a folder named after it.
  assert.deepEqual(names.filter((n) => !n.endsWith('pagehouse.json')), ['HTML 부모/HTML 부모.html', 'HTML 부모/HTML 부모/자식 _script_.html', 'HTML 부모/index.html', 'HTML 부모/style.css'].sort())
  const html = new TextDecoder().decode(files['HTML 부모/HTML 부모.html'])
  assert.match(html, /class="callout warning"/)
  assert.match(html, /주의 &lt;b&gt;/)
  assert.match(html, /a &lt; b &amp;&amp; c/)
  assert.match(html, new RegExp(`href="${encodeURI('HTML 부모/자식 _script_.html').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`))
  assert.ok(!html.includes('javascript:'), 'unsafe link dropped')
  // Colors and alignment survive; anything that isn't a plain color never reaches a style attribute.
  const { toHtmlPage } = await import('./html.ts')
  const styled = toHtmlPage({ title: 't', space: 's', css: 'c', home: 'h', crumbs: [], nav: [], url: (u) => u, doc: { type: 'doc', content: [
    { type: 'paragraph', attrs: { textAlign: 'center' }, content: [
      { type: 'text', text: 'red', marks: [{ type: 'textStyle', attrs: { color: '#dc2626' } }] },
      { type: 'text', text: 'hl', marks: [{ type: 'highlight', attrs: { color: 'rgba(250, 204, 21, 0.35)' } }] },
      { type: 'text', text: 'evil', marks: [{ type: 'textStyle', attrs: { color: 'red;background:url(https://x)' } }, { type: 'underline' }] },
    ] },
  ] } })
  assert.match(styled, /<p style="text-align:center">/)
  assert.match(styled, /<span style="color:#dc2626">red<\/span>/)
  assert.match(styled, /<mark style="background:rgba\(250, 204, 21, 0.35\)">hl<\/mark>/)
  assert.ok(!styled.includes('url(https://x)') && styled.includes('<u>evil</u>'))
  // Image width and caption, cell colors; a hostile color never reaches the style attribute.
  const fig = toHtmlPage({ title: 't', space: 's', css: 'c', home: 'h', crumbs: [], nav: [], url: (u) => u, doc: { type: 'doc', content: [
    { type: 'image', attrs: { src: 'a.png', alt: '', width: 240.4, caption: 'cap <b>' } },
    { type: 'table', content: [{ type: 'tableRow', content: [
      { type: 'tableCell', attrs: { background: 'rgba(59, 130, 246, 0.25)' }, content: [{ type: 'paragraph' }] },
      { type: 'tableCell', attrs: { background: 'red;x:url(y)' }, content: [{ type: 'paragraph' }] },
    ] }] },
  ] } })
  assert.match(fig, /<figure><img src="a.png" alt="cap &lt;b&gt;" style="width:240px"><figcaption>cap &lt;b&gt;<\/figcaption><\/figure>/)
  assert.match(fig, /<td style="background:rgba\(59, 130, 246, 0.25\)">/)
  assert.ok(!fig.includes('url(y)'))
  assert.ok(html.includes('자식 &lt;script&gt;'), 'nav titles escaped')
  assert.match(new TextDecoder().decode(files['HTML 부모/index.html']), /href="HTML%20%EB%B6%80%EB%AA%A8\.html"/)
  // Markdown stays the default.
  assert.match((await x.call('GET', `/api/pages/${parent.id}/export`)).headers.get('content-disposition')!, /%EB%B6%80%EB%AA%A8\.zip/)
})

test('profile: name, photo; admin temporary password must be replaced; forgot needs mail', async () => {
  const admin = client()
  await admin.call('POST', '/api/auth/login', { email: 'a@b.co', password: 'password1' })
  const { token } = await admin.json('POST', '/api/admin/invites', { role: 'member' })
  const eve = client()
  const me = await eve.json('POST', '/api/auth/register', { email: 'eve@b.co', name: 'Eve', password: 'password1', invite: token })
  // Name
  assert.equal((await eve.json('PATCH', '/api/me', { name: '  이브  ' })).name, '이브')
  assert.equal((await eve.json('GET', '/api/me')).name, '이브')
  assert.equal((await eve.call('PATCH', '/api/me', { name: '   ' })).status, 400)
  // Photo: images only, served to others, removable
  assert.equal((await eve.call('GET', `/api/users/${me.id}/avatar`)).status, 404)
  const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0))
  const up = (type: string) => { const f = new FormData(); f.append('file', new File([png], 'a', { type })); return app.request('/api/me/avatar', { method: 'PUT', headers: { cookie: eve.cookie }, body: f }) }
  assert.equal((await up('image/svg+xml')).status, 400)
  assert.equal((await up('image/png')).status, 200)
  assert.equal((await eve.json('GET', '/api/me')).avatar, true)
  const got = await admin.call('GET', `/api/users/${me.id}/avatar`)
  assert.equal(got.headers.get('content-type'), 'image/png')
  assert.equal(got.headers.get('x-content-type-options'), 'nosniff')
  await eve.call('DELETE', '/api/me/avatar')
  assert.equal((await admin.call('GET', `/api/users/${me.id}/avatar`)).status, 404)
  // Temporary password: old one stops working, sessions end, and the account must pick a new one.
  const { password } = await admin.json('POST', `/api/admin/users/${me.id}/temp-password`, {})
  assert.match(password, /^[A-Za-z2-9]{12}$/)
  assert.equal((await eve.call('GET', '/api/me')).status, 401)
  assert.equal((await eve.call('POST', '/api/auth/login', { email: 'eve@b.co', password: 'password1' })).status, 401)
  const login = await eve.json('POST', '/api/auth/login', { email: 'eve@b.co', password })
  assert.equal(login.mustChangePassword, true)
  assert.equal((await eve.json('GET', '/api/me')).mustChangePassword, true)
  await eve.call('POST', '/api/me/password', { current: password, next: 'brand-new-pw' })
  assert.equal((await eve.json('GET', '/api/me')).mustChangePassword, false)
  assert.equal((await admin.call('POST', `/api/admin/users/${(await admin.json('GET', '/api/me')).id}/temp-password`, {})).status, 400)
  const bob = client()
  await bob.call('POST', '/api/auth/login', { email: 'bob@b.co', password: 'newpassword' })
  assert.equal((await bob.call('POST', `/api/admin/users/${me.id}/temp-password`, {})).status, 403)
  // Without mail, there's no self-service reset.
  assert.equal((await client().call('POST', '/api/auth/forgot', { email: 'eve@b.co' })).status, 404)
  assert.equal((await client().json('GET', '/api/auth/status')).mail, false)
})

test('security: moving out from under a restricted page and resolving threads need the right to', async () => {
  const admin = client()
  await admin.call('POST', '/api/auth/login', { email: 'a@b.co', password: 'password1' })
  const space = (await admin.json('GET', '/api/spaces')).find((x: any) => x.key === 'GENERAL')
  const bob = client()
  const bobId = (await bob.json('POST', '/api/auth/login', { email: 'bob@b.co', password: 'newpassword' })).id
  const locked = await admin.json('POST', '/api/pages', { spaceId: space.id, title: 'Locked parent' })
  const inner = await admin.json('POST', '/api/pages', { spaceId: space.id, parentId: locked.id, title: 'Inner' })
  await admin.call('PUT', `/api/pages/${locked.id}/restrictions`, { entries: [{ userId: bobId, level: 'edit' }] })
  // Bob may edit Inner, but moving it to the top would make it visible to everyone.
  const r = await bob.call('POST', `/api/pages/${inner.id}/move`, { parentId: null })
  assert.equal(r.status, 403)
  assert.equal((await r.json()).code, 'move_drops_restrictions')
  assert.equal((await admin.call('POST', `/api/pages/${inner.id}/move`, { parentId: null })).status, 200)
  // A reader can't close someone else's thread; its author (or an editor) can.
  const page = await admin.json('POST', '/api/pages', { spaceId: space.id, title: 'Read only for Bob' })
  await admin.call('PUT', `/api/pages/${page.id}/restrictions`, { entries: [{ userId: bobId, level: 'view' }] })
  const cm = await admin.json('POST', `/api/pages/${page.id}/comments`, { body: 'Open question' })
  assert.equal((await bob.call('PATCH', `/api/comments/${cm.id}`, { resolved: true })).status, 403)
  const mine = await bob.json('POST', `/api/pages/${page.id}/comments`, { body: 'Mine' })
  assert.equal((await bob.call('PATCH', `/api/comments/${mine.id}`, { resolved: true })).status, 200)
  assert.equal((await admin.call('PATCH', `/api/comments/${cm.id}`, { resolved: true })).status, 200)
})

test('templates: saved from a page, per space or global, removable', async () => {
  const admin = client()
  await admin.call('POST', '/api/auth/login', { email: 'a@b.co', password: 'password1' })
  const [space] = await admin.json('GET', '/api/spaces')
  const doc = { type: 'doc', content: [{ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Agenda' }] }] }
  const page = await admin.json('POST', '/api/pages', { spaceId: space.id, title: 'Retro', doc })
  const tpl = await admin.json('POST', '/api/templates', { pageId: page.id, name: 'Retro', icon: '🔁' })
  const list = await admin.json('GET', `/api/templates?space=${space.id}`)
  assert.deepEqual(list.find((x: any) => x.id === tpl.id).doc, doc)
  // Not offered in other spaces unless global.
  const other = await admin.json('POST', '/api/spaces', { name: 'Other', key: 'OTHTPL' })
  assert.ok(!(await admin.json('GET', `/api/templates?space=${other.id}`)).some((x: any) => x.id === tpl.id))
  assert.equal((await admin.call('DELETE', `/api/templates/${tpl.id}`)).status, 200)
  assert.ok(!(await admin.json('GET', `/api/templates?space=${space.id}`)).some((x: any) => x.id === tpl.id))
})

test('watching: creators watch their pages; one unread update notice per page', async () => {
  const admin = client()
  await admin.call('POST', '/api/auth/login', { email: 'a@b.co', password: 'password1' })
  const { token } = await admin.json('POST', '/api/admin/invites', { role: 'member' })
  const w = client()
  await w.json('POST', '/api/auth/register', { email: 'watcher@w.co', name: 'W', password: 'password1', invite: token })
  const space = (await admin.json('GET', '/api/spaces')).find((x: any) => x.key === 'GENERAL')
  const page = await w.json('POST', '/api/pages', { spaceId: space.id, title: 'Watched' })
  assert.equal((await w.json('GET', `/api/pages/${page.id}`)).watching, true, JSON.stringify(page))
  const doc = (s: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: s }] }] })
  await admin.call('PUT', `/api/pages/${page.id}`, { title: 'Watched', doc: doc('one'), version: 1 })
  await admin.call('PUT', `/api/pages/${page.id}`, { title: 'Watched', doc: doc('two'), version: 2 })
  const updates = (await w.json('GET', '/api/notifications')).items.filter((n: any) => n.kind === 'update' && n.pageId === page.id)
  assert.equal(updates.length, 1)
  await w.call('PUT', `/api/pages/${page.id}/watch`, { watching: false })
  await w.call('POST', '/api/notifications/read', {})
  await admin.call('PUT', `/api/pages/${page.id}`, { title: 'Watched', doc: doc('three'), version: 3 })
  assert.equal((await w.json('GET', '/api/notifications')).unread, 0)
})

test('MCP: personal token, tools act with the user’s own permissions', async () => {
  const admin = client()
  await admin.call('POST', '/api/auth/login', { email: 'a@b.co', password: 'password1' })
  const { token } = await admin.json('POST', '/api/me/tokens', { name: 'agent' })
  assert.match(token, /^ph_/)
  const rpc = async (method: string, params?: unknown, auth = token) => {
    const res = await app.request('/api/mcp', { method: 'POST', headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
    return { status: res.status, body: await res.json().catch(() => null) }
  }
  assert.equal((await rpc('initialize', { protocolVersion: '2025-06-18' })).body.result.protocolVersion, '2025-06-18')
  assert.ok((await rpc('tools/list')).body.result.tools.some((t: any) => t.name === 'create_page'))
  assert.equal((await rpc('tools/list', undefined, 'ph_wrong')).status, 401)
  const tool = async (name: string, args: unknown) => (await rpc('tools/call', { name, arguments: args })).body.result
  const space = (await admin.json('GET', '/api/spaces')).find((x: any) => x.key === 'GENERAL')
  const created = await tool('create_page', { spaceId: space.id, title: 'Agent notes', markdown: '## Steps\n\n- check **logs**\n- restart' })
  const id = Number(created.content[0].text.match(/page (\d+)/)[1])
  const page = await tool('get_page', { id })
  assert.match(page.content[0].text, /## Steps[\s\S]*- check \*\*logs\*\*/)
  await tool('update_page', { id, markdown: 'replaced' })
  assert.equal((await admin.json('GET', `/api/pages/${id}/versions`)).length, 2, 'old version kept')
  assert.match((await tool('search', { query: 'replaced' })).content[0].text, /Agent notes/)
  // A page the user can't see is an error result, not a leak.
  assert.equal((await tool('get_page', { id: 999999 })).isError, true)
  // Tokens can't create more tokens, and revoked tokens stop working.
  const viaToken = await app.request('/api/me/tokens', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{"name":"x"}' })
  assert.equal(viaToken.status, 403)
  const [t] = await admin.json('GET', '/api/me/tokens')
  await admin.call('DELETE', `/api/me/tokens/${t.id}`)
  assert.equal((await rpc('ping')).status, 401)
})

test('link previews: metadata parsing, and no fetching of internal addresses', async () => {
  const { parsePreview, privateAddress } = await import('./preview.ts')
  const p = parsePreview(`<html><head><title>Fallback</title><meta property="og:title" content="Runbook &amp; FAQ">
    <meta name="description" content="How we deploy"><meta property="og:image" content="/img.png"></head>`, new URL('https://docs.example.com/x'))
  assert.deepEqual(p, { url: 'https://docs.example.com/x', title: 'Runbook & FAQ', description: 'How we deploy', image: 'https://docs.example.com/img.png', site: 'docs.example.com' })
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.0.9', '169.254.169.254', '::1', 'fd00::1', '::ffff:127.0.0.1']) assert.ok(privateAddress(ip), ip)
  for (const ip of ['8.8.8.8', '172.32.0.1', '2606:4700::1111']) assert.ok(!privateAddress(ip), ip)
  const a = client()
  await a.call('POST', '/api/auth/login', { email: 'a@b.co', password: 'password1' })
  // IPv4 hidden in IPv6, in the forms the URL parser produces (hex) and NAT64.
  for (const ip of ['::ffff:7f00:1', '[::ffff:7f00:1]', '::ffff:a9fe:a9fe', '64:ff9b::a00:1', '2002:7f00:1::']) assert.ok(privateAddress(ip), ip)
  assert.ok(!privateAddress('::ffff:808:808'))
  for (const u of ['http://127.0.0.1:55432/', 'http://localhost:3000/', 'http://[::1]/', 'file:///etc/passwd', 'http://[::ffff:127.0.0.1]:55432/'])
    assert.ok([400, 404].includes((await a.call('GET', `/api/link-preview?url=${encodeURIComponent(u)}`)).status), u)
})

test('webhooks: signed page and comment events, none for restricted pages; personal notification webhooks', async () => {
  const got: { headers: Record<string, any>; raw: string; body: any }[] = []
  const rx = createServer((req, res) => {
    let b = ''
    req.on('data', (d) => (b += d))
    req.on('end', () => (got.push({ headers: req.headers, raw: b, body: JSON.parse(b) }), res.end('ok')))
  })
  await new Promise<void>((r) => rx.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${(rx.address() as any).port}/hook`
  const until = async (ok: () => boolean) => { for (let i = 0; i < 150 && !ok(); i++) await new Promise((r) => setTimeout(r, 20)) }
  const admin = client()
  await admin.call('POST', '/api/auth/login', { email: 'a@b.co', password: 'password1' })
  const [general] = await admin.json('GET', '/api/spaces')
  const me = client()
  const u = await me.json('POST', '/api/auth/login', { email: 'insider@sp.co', password: 'password1' })
  let hookId = 0
  try {
    assert.equal((await admin.call('POST', '/api/admin/webhooks', { name: 'x', url: 'ftp://x', events: ['page.created'] })).status, 400)
    assert.equal((await me.call('GET', '/api/admin/webhooks')).status, 403)
    const hook = await admin.json('POST', '/api/admin/webhooks', { name: 'CI', url, events: ['page.created', 'comment.created'], spaceId: general.id })
    hookId = hook.id
    assert.match(hook.secret, /^whsec_/)
    assert.ok(!JSON.stringify(await admin.json('GET', '/api/admin/webhooks')).includes(hook.secret), 'secret shown once')

    const pg = await admin.json('POST', '/api/pages', { spaceId: general.id, title: 'Hooked' })
    await until(() => got.length >= 1)
    assert.equal(got[0].body.event, 'page.created')
    assert.equal(got[0].body.page.title, 'Hooked')
    assert.equal(got[0].headers['x-pagehouse-signature'], `sha256=${createHmac('sha256', hook.secret).update(got[0].raw).digest('hex')}`)
    await admin.json('POST', `/api/pages/${pg.id}/comments`, { body: 'hi' })
    await until(() => got.length >= 2)
    assert.equal(got[1].body.event, 'comment.created')
    assert.equal(got[1].body.comment.body, 'hi')
    // Restricted pages never leave the wiki.
    await admin.call('PUT', `/api/pages/${pg.id}/restrictions`, { entries: [{ userId: 1, level: 'edit' }] })
    await admin.json('POST', `/api/pages/${pg.id}/comments`, { body: 'secret' })
    await new Promise((r) => setTimeout(r, 200))
    assert.equal(got.length, 2)
    assert.equal((await admin.json('POST', `/api/admin/webhooks/${hook.id}/test`)).status, 200)
    assert.equal(got[2].body.event, 'ping')

    // Personal webhook: the private network is off limits unless WEBHOOK_ALLOW lists the host.
    assert.equal((await me.json('POST', '/api/me/webhook/test', { url })).error, 'private address')
    process.env.WEBHOOK_ALLOW = '127.0.0.1'
    assert.equal((await me.json('POST', '/api/me/webhook/test', { url })).status, 200)
    assert.equal((await me.json('PATCH', '/api/me', { webhookUrl: url })).webhookUrl, url)
    assert.equal((await me.json('GET', '/api/me')).webhookUrl, url)
    const [visible] = await me.json('GET', '/api/spaces')
    const pg2 = await admin.json('POST', '/api/pages', { spaceId: visible.id, title: 'Ping me' })
    await admin.json('POST', `/api/pages/${pg2.id}/comments`, { body: `hey <@${u.id}>` })
    const hooks = startPersonalHooks(db)
    await hooks.tick()
    hooks.stop()
    const mine = got.find((g) => g.body.kind === 'comment_mention')
    assert.ok(mine, 'notification posted')
    assert.equal(mine.body.page.title, 'Ping me')
    assert.match(mine.body.text, /Ping me/)
  } finally {
    delete process.env.WEBHOOK_ALLOW
    await me.call('PATCH', '/api/me', { webhookUrl: '' })
    if (hookId) await admin.call('DELETE', `/api/admin/webhooks/${hookId}`)
    rx.close()
  }
})

test('monitoring: /metrics needs METRICS_TOKEN, admin health, and server errors are counted', async () => {
  assert.equal((await app.request('/metrics')).status, 404, 'off by default')
  process.env.METRICS_TOKEN = 'scrape-me'
  try {
    assert.equal((await app.request('/metrics')).status, 401)
    assert.equal((await app.request('/metrics', { headers: { authorization: 'Bearer nope' } })).status, 401)
    await app.request('/healthz')
    const text = await (await app.request('/metrics', { headers: { authorization: 'Bearer scrape-me' } })).text()
    for (const m of ['pagehouse_info{version=', 'pagehouse_http_requests_total{method="GET",route="/healthz",status="200"}', 'pagehouse_http_request_duration_seconds_bucket{route="/healthz",le="+Inf"}',
      'pagehouse_db_latency_seconds', 'pagehouse_storage_bytes{kind="files"}', 'pagehouse_notification_backlog{channel="mail"}', 'pagehouse_server_errors_total'])
      assert.ok(text.includes(m), `metrics include ${m}`)
    assert.ok(!/route="[^"]*\/\d+/.test(text), 'ids never become labels')
  } finally {
    delete process.env.METRICS_TOKEN
  }
  const admin = client()
  await admin.call('POST', '/api/auth/login', { email: 'a@b.co', password: 'password1' })
  const h = await admin.json('GET', '/api/admin/health')
  assert.equal(typeof h.db.latencyMs, 'number')
  assert.equal(typeof h.process.rssBytes, 'number')
  assert.equal(typeof h.recent.requests, 'number')
  const member = client()
  await member.call('POST', '/api/auth/login', { email: 'insider@sp.co', password: 'password1' })
  assert.equal((await member.call('GET', '/api/admin/health')).status, 403)

  // An unexpected error answers 500 as JSON and shows up for admins.
  const { recordError, recentStats } = await import('./metrics.ts')
  recordError('GET', '/api/boom', 500, 'kaboom')
  assert.equal(recentStats().errors[0].message, 'kaboom')
})

test('branding: admins set name and logo; everyone, signed in or not, reads them', async () => {
  const admin = client()
  await admin.call('POST', '/api/auth/login', { email: 'a@b.co', password: 'password1' })
  const { token } = await admin.json('POST', '/api/admin/invites', { role: 'member' })
  const bob = client()
  await bob.json('POST', '/api/auth/register', { email: 'brand@b.co', name: 'Bob', password: 'password1', invite: token })
  const anon = client()
  assert.deepEqual(await anon.json('GET', '/api/auth/branding'), { name: null, logo: null, accent: null })
  assert.equal((await bob.call('PUT', '/api/admin/branding', { name: 'Acme' })).status, 403)
  // Accent: #rrggbb only (it goes into a <style>), saved without touching the name, null for the default.
  for (const bad of ['red', '#fff', '#12345g', '#123456;}body{x:y', 3]) assert.equal((await admin.call('PUT', '/api/admin/branding', { accent: bad })).status, 400, String(bad))
  assert.equal((await admin.call('PUT', '/api/admin/branding', {})).status, 400)
  assert.deepEqual(await admin.json('PUT', '/api/admin/branding', { accent: '#AA3300' }), { accent: '#aa3300' })
  assert.equal((await anon.json('GET', '/api/auth/branding')).accent, '#aa3300')
  assert.match(brandHtml('<head></head>', { name: null, logo: null, accent: '#aa3300' }), /<style id="brand-css">html:root\{--accent:#aa3300;.*\[data-theme='dark'\]/)
  assert.equal(brandCss('#fff;}x{'), '')
  assert.ok(contrastOnWhite('#2f6feb') >= 4.5) // the default accent passes
  assert.ok(contrastOnWhite('#ffd400') < 2)
  await admin.call('PUT', '/api/admin/branding', { accent: null })
  assert.equal((await admin.call('PUT', '/api/admin/branding', { name: 1 })).status, 400)
  assert.equal((await admin.json('PUT', '/api/admin/branding', { name: '  Acme Wiki  ' })).name, 'Acme Wiki')
  const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0))
  const up = (who: { cookie: string }, type: string) => { const f = new FormData(); f.append('file', new File([png], 'a', { type })); return app.request('/api/admin/branding/logo', { method: 'PUT', headers: { cookie: who.cookie }, body: f }) }
  assert.equal((await up(bob, 'image/png')).status, 403)
  assert.equal((await up(admin, 'image/svg+xml')).status, 400)
  assert.equal((await up(admin, 'image/png')).status, 200)
  const b = await anon.json('GET', '/api/auth/branding')
  assert.equal(b.name, 'Acme Wiki') // the logo upload kept the name
  const got = await anon.call('GET', `/api/auth/branding/logo?v=${b.logo}`)
  assert.equal(got.headers.get('content-type'), 'image/png')
  assert.equal(got.headers.get('x-content-type-options'), 'nosniff')
  // A replaced logo's file is removed; one still used elsewhere (here: as a photo) is kept; so is one just written.
  const unique = (tag: string) => new File([png, new TextEncoder().encode(tag)], 'a', { type: 'image/png' })
  const put = (path: string, f: File) => { const d = new FormData(); d.append('file', f); return app.request(path, { method: 'PUT', headers: { cookie: admin.cookie }, body: d }) }
  const file = (h: string) => join(dataDir, 'files', h)
  const age = (h: string) => utimesSync(file(h), new Date(0), new Date(0))
  const tag = Date.now()
  const first = (await (await put('/api/admin/branding/logo', unique(`one${tag}`))).json()).logo
  const fresh = (await (await put('/api/admin/branding/logo', unique(`fresh${tag}`))).json()).logo
  assert.equal(existsSync(file(first)), true) // replaced at once, but too new to remove: an upload may be about to use it
  age(first)
  await put('/api/me/avatar', unique(`two${tag}`))
  const second = (await (await put('/api/admin/branding/logo', unique(`two${tag}`))).json()).logo
  age(fresh)
  age(second)
  const third = (await (await put('/api/admin/branding/logo', unique(`three${tag}`))).json()).logo
  assert.equal(existsSync(file(second)), true) // replaced, but still the admin's photo
  age(third)
  await admin.call('DELETE', '/api/admin/branding/logo')
  assert.equal(existsSync(file(third)), false) // old enough and used by nothing: removed at once
  assert.equal(existsSync(file(second)), true) // still the admin's photo
  await admin.call('DELETE', '/api/me/avatar')
  assert.equal(existsSync(file(second)), false)
  // The sweep catches what was skipped, and never an attachment.
  assert.equal(existsSync(file(fresh)), true)
  for (const h of readdirSync(join(dataDir, 'files'))) age(h)
  assert.equal(await pruneFiles(db, join(dataDir, 'files')) >= 1, true)
  assert.equal(existsSync(file(fresh)), false)
  assert.equal(existsSync(file(first)), false)
  const kept = (await db.query('SELECT DISTINCT sha256 FROM attachments')).rows
  assert.ok(kept.length > 0)
  for (const { sha256 } of kept) assert.equal(existsSync(file(sha256)), true, `attachment ${sha256}`)
  await admin.call('PUT', '/api/admin/branding', { name: '' })
  assert.deepEqual(await anon.json('GET', '/api/auth/branding'), { name: null, logo: null, accent: null })
  assert.equal((await anon.call('GET', '/api/auth/branding/logo')).status, 404)
})

test('API tokens expire; tokens from before this version keep working; SSO accounts gone from the provider stop', async () => {
  const admin = client()
  await admin.call('POST', '/api/auth/login', { email: 'a@b.co', password: 'password1' })
  const bearer = (token: string) => app.request('/api/me', { headers: { authorization: `Bearer ${token}` } })
  assert.equal((await admin.call('POST', '/api/me/tokens', { name: 'x', days: 0 })).status, 400)
  assert.equal((await admin.call('POST', '/api/me/tokens', { name: 'x', days: 366 })).status, 400)
  const made = await admin.json('POST', '/api/me/tokens', { name: 'ninety' })
  const days = (Date.parse(made.expiresAt) - Date.now()) / 86400_000
  assert.ok(Math.abs(days - 90) < 0.01, `90 days by default, got ${days}`)
  assert.equal((await bearer(made.token)).status, 200)
  // Past its date: refused and no longer listed.
  await db.query(`UPDATE api_tokens SET expires_at = now() - interval '1 second' WHERE id = $1`, [made.id])
  assert.equal((await bearer(made.token)).status, 401)
  assert.ok(!(await admin.json('GET', '/api/me/tokens')).some((t: any) => t.id === made.id))
  // A token made before this version (no expiry) still works.
  const old = await admin.json('POST', '/api/me/tokens', { name: 'legacy', days: 30 })
  await db.query('UPDATE api_tokens SET expires_at = NULL WHERE id = $1', [old.id])
  assert.equal((await bearer(old.token)).status, 200)
  assert.equal((await admin.json('GET', '/api/me/tokens')).find((t: any) => t.id === old.id).expiresAt, null)
  // Signed in by SSO, but not for longer than TOKEN_SSO_GRACE_DAYS (30): probably removed at the provider.
  const me = (await admin.json('GET', '/api/me')).id
  await db.query(`UPDATE users SET last_sso_at = now() - interval '29 days' WHERE id = $1`, [me])
  assert.equal((await bearer(old.token)).status, 200)
  await db.query(`UPDATE users SET last_sso_at = now() - interval '31 days' WHERE id = $1`, [me])
  assert.equal((await bearer(old.token)).status, 401)
  await db.query('UPDATE users SET last_sso_at = NULL WHERE id = $1', [me])
  await admin.call('DELETE', `/api/me/tokens/${old.id}`)
})

test('webhook deliveries are queued in the database and retried with growing waits', async () => {
  let fail = true
  const got: { headers: Record<string, any>; raw: string }[] = []
  const rx = createServer((req, res) => {
    let b = ''
    req.on('data', (d) => (b += d))
    req.on('end', () => (got.push({ headers: req.headers, raw: b }), (res.statusCode = fail ? 503 : 200), res.end()))
  })
  await new Promise<void>((r) => rx.listen(0, '127.0.0.1', r))
  const admin = client()
  await admin.call('POST', '/api/auth/login', { email: 'a@b.co', password: 'password1' })
  const [general] = await admin.json('GET', '/api/spaces')
  const hook = await admin.json('POST', '/api/admin/webhooks', { name: 'Flaky', url: `http://127.0.0.1:${(rx.address() as any).port}/`, events: ['page.created'], spaceId: general.id })
  const job = async () => (await db.query('SELECT attempts, done_at, last_error, run_at > now() AS later, round(extract(epoch FROM run_at - now()) / 60) AS mins FROM webhook_jobs WHERE hook_id = $1', [hook.id])).rows[0]
  const due = () => db.query('UPDATE webhook_jobs SET run_at = now() WHERE hook_id = $1 AND done_at IS NULL', [hook.id])
  try {
    await admin.json('POST', '/api/pages', { spaceId: general.id, title: 'Retry me' })
    for (let i = 0; i < 100 && (await job())?.attempts !== 1; i++) await new Promise((r) => setTimeout(r, 20))
    let j = await job()
    // First attempt failed: the job stays in the table (so a restart keeps it) and waits a minute.
    assert.deepEqual([j.attempts, j.done_at, j.last_error, j.later, Number(j.mins)], [1, null, 'HTTP 503', true, 1])
    assert.equal((await admin.json('GET', '/api/admin/webhooks')).hooks.find((h: any) => h.id === hook.id).lastError, 'HTTP 503')
    // Both header names carry the same values.
    const sig = `sha256=${createHmac('sha256', hook.secret).update(got[0].raw).digest('hex')}`
    assert.deepEqual([got[0].headers['x-pagehouse-signature'], got[0].headers['x-signature']], [sig, sig])
    assert.deepEqual([got[0].headers['x-pagehouse-event'], got[0].headers['x-event']], ['page.created', 'page.created'])
    // Not due yet: nothing is sent.
    assert.equal(await app.webhooks.runJobs(), 0)
    await due()
    await app.webhooks.runJobs()
    assert.equal(Number((await job()).mins), 4, 'then 4 minutes')
    // The receiver recovers: delivered, done, error cleared.
    fail = false
    await due()
    await app.webhooks.runJobs()
    j = await job()
    assert.ok(j.done_at)
    assert.equal(j.last_error, null)
    assert.equal(got.length, 3)
    // A receiver that never recovers: after 5 attempts the job gives up.
    fail = true
    await db.query('DELETE FROM webhook_jobs WHERE hook_id = $1', [hook.id])
    await admin.json('POST', '/api/pages', { spaceId: general.id, title: 'Give up' })
    for (let i = 0; i < 100 && (await job())?.attempts !== 1; i++) await new Promise((r) => setTimeout(r, 20))
    for (let n = 2; n <= 5; n++) (await due(), await app.webhooks.runJobs())
    j = await job()
    assert.equal(j.attempts, 5)
    assert.ok(j.done_at, 'given up')
    assert.equal(j.last_error, 'HTTP 503')
    // A secret that can't be decrypted (encrypted, but SECRET_KEY is gone) fails like any other attempt and gives up too.
    delete process.env.SECRET_KEY
    await db.query(`UPDATE webhooks SET secret = 'enc:v1:aaaa.bbbb.cccc' WHERE id = $1`, [hook.id])
    await db.query('DELETE FROM webhook_jobs WHERE hook_id = $1', [hook.id])
    await admin.json('POST', '/api/pages', { spaceId: general.id, title: 'No key' })
    for (let i = 0; i < 100 && (await job())?.attempts !== 1; i++) await new Promise((r) => setTimeout(r, 20))
    for (let n = 2; n <= 5; n++) (await due(), await app.webhooks.runJobs())
    j = await job()
    assert.deepEqual([j.attempts, !!j.done_at], [5, true])
    assert.match(j.last_error, /SECRET_KEY/)
    assert.match((await admin.json('GET', '/api/admin/webhooks')).hooks.find((h: any) => h.id === hook.id).lastError, /SECRET_KEY/)
  } finally {
    await admin.call('DELETE', `/api/admin/webhooks/${hook.id}`)
    rx.close()
  }
})

test('two-syllable Korean search goes through the Hangul pair index, in pages and comments', async () => {
  assert.deepEqual(hangulBigrams('장애 대응'), ['장애', '대응'])
  assert.deepEqual(hangulBigrams('배포a'), ['배포'])
  assert.deepEqual(hangulBigrams('ab 한'), [])
  const sql = (await db.query(`SELECT hangul_bigrams('장애 대응 a장애')`)).rows[0].hangul_bigrams.sort()
  assert.deepEqual(sql, ['대응', '장애'], 'the database cuts the same pairs')
  const admin = client()
  await admin.call('POST', '/api/auth/login', { email: 'a@b.co', password: 'password1' })
  const [general] = await admin.json('GET', '/api/spaces')
  const page = await admin.json('POST', '/api/pages', { spaceId: general.id, title: 'Postmortem' })
  await admin.json('POST', `/api/pages/${page.id}/comments`, { body: '어제 장애는 디스크 때문' })
  const hits = await admin.json('GET', `/api/search?q=${encodeURIComponent('장애')}`)
  assert.ok(hits.results.some((r: any) => r.id === page.id), 'found through the comment')
  assert.ok(!(await admin.json('GET', `/api/search?q=${encodeURIComponent('장애')}&scope=title`)).results.some((r: any) => r.id === page.id))
  // With a sequential scan ruled out, the plan uses the pair indexes (small test tables would otherwise be scanned).
  // Plain index scans too: for the UNION the planner sometimes prefers walking pages_pkey in order and filtering.
  const plan = await db.connect()
  try {
    await plan.query('SET enable_seqscan = off')
    await plan.query('SET enable_indexscan = off')
    const text = (await plan.query(`EXPLAIN SELECT x.id FROM pages x WHERE x.grams @> '{장애}'::text[] AND x.text ILIKE '%장애%'
      UNION SELECT cm.page_id FROM comments cm WHERE cm.grams @> '{장애}'::text[] AND cm.body ILIKE '%장애%'`)).rows.map((r) => r['QUERY PLAN']).join('\n')
    assert.match(text, /pages_grams/)
    assert.match(text, /comments_grams/)
  } finally {
    await plan.query('RESET enable_seqscan')
    await plan.query('RESET enable_indexscan')
    plan.release()
  }
})

test('sessions last a day unless SESSION_HOURS says otherwise', async () => {
  const res = await app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'a@b.co', password: 'password1' }) })
  assert.match(res.headers.get('set-cookie')!, /Max-Age=86400/)
  const sid = res.headers.get('set-cookie')!.split(';')[0].slice(4)
  const { hours } = (await db.query(`SELECT round(extract(epoch FROM expires_at - now()) / 3600) AS hours FROM sessions WHERE token_hash = encode(sha256($1::bytea), 'hex')`, [sid])).rows[0]
  assert.equal(Number(hours), 24)
})

test('links a browser must never follow (javascript: and the like) are taken out of saved pages and exports', async () => {
  for (const ok of ['https://x.co', 'HTTP://X.CO', 'mailto:a@b.co', 'tel:+8210', '#top', '/p/1', '../a.md', 'page.md'])
    assert.ok(safeHref(ok), ok)
  for (const bad of ['javascript:alert(1)', ' JavaScript:alert(1)', 'java\tscript:alert(1)', '\u0001javascript:x', 'data:text/html,<b>', 'vbscript:x'])
    assert.ok(!safeHref(bad), bad)
  const a = client()
  await a.call('POST', '/api/auth/login', { email: 'a@b.co', password: 'password1' })
  const [space] = await (await a.call('GET', '/api/spaces')).json()
  const text = (href: string) => ({ type: 'text', text: href.startsWith('https') ? 'ok' : 'bad', marks: [{ type: 'bold' }, { type: 'link', attrs: { href } }] })
  const doc = { type: 'doc', content: [
    { type: 'paragraph', content: [text('javascript:alert(1)'), text('https://ok.co')] },
    { type: 'linkCard', attrs: { href: 'java\nscript:alert(2)', title: 'card' } },
  ] }
  // The link mark goes, its text and other marks stay; a card keeps its title but loses the address.
  const check = async (id: number) => {
    const d = (await db.query('SELECT doc FROM pages WHERE id = $1', [id])).rows[0].doc
    assert.deepEqual(d.content[0].content.map((n: any) => n.marks), [[{ type: 'bold' }], [{ type: 'bold' }, { type: 'link', attrs: { href: 'https://ok.co' } }]])
    assert.deepEqual(d.content[1].attrs, { href: '', title: 'card' })
  }
  const page = await (await a.call('POST', '/api/pages', { spaceId: space.id, title: 'Links', doc })).json()
  await check(page.id)
  assert.equal((await a.call('PUT', `/api/pages/${page.id}`, { title: 'Links', doc, version: 1 })).status, 200)
  await check(page.id)
  // Pages stored before this check still export without the address.
  const md = toMarkdown('Links', doc)
  assert.ok(!/script:/.test(md) && md.includes('**bad**') && md.includes('[**ok**](https://ok.co)') && md.includes('[card](#)'), md)
})
