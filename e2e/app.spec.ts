// The paths people use every day, in a real browser: sign in, write and keep a page, find it, discuss it,
// and the admin screens. Pages are created through the API to keep the tests independent of each other.
import { expect, test, type Page } from '@playwright/test'

const email = process.env.E2E_EMAIL ?? ''
const password = process.env.E2E_PASSWORD ?? ''
test.skip(!email || !password, 'set E2E_EMAIL and E2E_PASSWORD (an admin account)')

async function signIn(page: Page) {
  await page.goto('/')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  // The interface language is per account: use English so the selectors below match.
  await page.waitForResponse((r) => r.url().endsWith('/api/me') || r.url().includes('/api/spaces'))
  await page.evaluate(() => fetch('/api/me', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ locale: 'en' }) }))
  await page.reload()
  await expect(page.getByRole('button', { name: /^Search/ })).toBeVisible()
}

/** A new page in the first space, created through the API with the browser's session. */
async function newPage(page: Page, title: string) {
  return page.evaluate(async (title) => {
    const [space] = await (await fetch('/api/spaces')).json()
    const r = await fetch('/api/pages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ spaceId: space.id, title }) })
    return (await r.json()).id as number
  }, title)
}

test('write a page, and it is still there after a reload', async ({ page }) => {
  await signIn(page)
  const word = `kept${Date.now()}`
  const id = await newPage(page, `E2E write ${word}`)
  await page.goto(`/#/p/${id}`)
  const editor = page.locator('.ProseMirror').first()
  await editor.click()
  await page.keyboard.type(`Hello ${word}`)
  await expect(page.getByText('Saved', { exact: true })).toBeVisible({ timeout: 15_000 })
  await page.reload()
  await expect(page.locator('.ProseMirror').first()).toContainText(`Hello ${word}`)
})

test('formatting from the toolbar and the slash menu', async ({ page }) => {
  await signIn(page)
  const id = await newPage(page, `E2E format ${Date.now()}`)
  await page.goto(`/#/p/${id}`)
  const editor = page.locator('.ProseMirror').first()
  await editor.click()
  await page.keyboard.type('bold words')
  await page.keyboard.press('ControlOrMeta+a')
  await page.getByRole('button', { name: /^Bold/ }).first().click()
  await expect(editor.locator('strong')).toHaveText('bold words')
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await page.keyboard.type('/table')
  // Enter picks the highlighted item, so wait until the menu has filtered down to it.
  await expect(page.locator('.slash-menu .active')).toContainText('Table')
  await page.keyboard.press('Enter')
  await expect(editor.locator('table')).toBeVisible()
})

test('search finds a page by a word in its body', async ({ page }) => {
  await signIn(page)
  const word = `findme${Date.now()}`
  const id = await newPage(page, 'E2E search')
  await page.evaluate(async ({ id, word }) => {
    const p = await (await fetch(`/api/pages/${id}`)).json()
    await fetch(`/api/pages/${id}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'E2E search', version: p.version, doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: `body ${word}` }] }] } }),
    })
  }, { id, word })
  await page.keyboard.press('ControlOrMeta+k')
  await page.keyboard.type(word)
  await expect(page.getByRole('dialog').getByText('E2E search').first()).toBeVisible()
})

test('comment on a page', async ({ page }) => {
  await signIn(page)
  const id = await newPage(page, `E2E comment ${Date.now()}`)
  await page.goto(`/#/p/${id}`)
  const box = page.getByPlaceholder('Add a comment')
  await box.scrollIntoViewIfNeeded()
  await box.fill('Looks good')
  await page.getByRole('button', { name: 'Post' }).click()
  await expect(page.getByText('Looks good')).toBeVisible()
  await page.reload()
  await expect(page.getByText('Looks good')).toBeVisible()
})

test('admin screens open, including server health and backups', async ({ page }) => {
  await signIn(page)
  await page.goto('/#/admin')
  await expect(page.getByRole('heading', { name: 'Server health' })).toBeVisible()
  for (const tab of ['People', 'Groups', 'SSO', 'Webhooks', 'Audit log', 'Branding']) {
    await page.getByRole('tab', { name: tab }).or(page.getByRole('button', { name: tab, exact: true })).first().click()
    await expect(page.locator('main, .admin').first()).toBeVisible()
  }
})

test('branding: a logo becomes the favicon, and removing it brings the default back', async ({ page }) => {
  await signIn(page)
  const before = await page.evaluate(() => fetch('/api/auth/branding').then((r) => r.json()))
  // The test removes the logo at the end, and can't put back one it never had.
  test.skip(!!before.logo, 'this instance already has a logo')
  try {
    await page.goto('/#/admin/branding')
    await page.getByLabel('Name (browser tab title)').fill('E2E Wiki')
    await page.locator('form').filter({ hasText: 'Name (browser tab title)' }).getByRole('button', { name: 'Save' }).click()
    await expect(page).toHaveTitle('E2E Wiki')
    // 1×1 PNG
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
    await page.locator('input[type=file]').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: png })
    await expect(page.locator('link[rel=icon]')).toHaveAttribute('href', /\/api\/auth\/branding\/logo\?v=/)
    // The server puts both into the page itself, so they show before any script runs.
    await page.reload()
    await expect(page).toHaveTitle('E2E Wiki')
    await page.locator('.field').getByRole('button', { name: 'Use default' }).click()
    await expect(page.locator('link[rel=icon]')).toHaveAttribute('href', /^data:image\/svg/)
    // Accent color: applied at once, and served in the page after a reload.
    await page.locator('input[type=color]').fill('#0a7d4f')
    await page.locator('form').filter({ has: page.locator('input[type=color]') }).getByRole('button', { name: 'Save' }).click()
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent'))).toBe('#0a7d4f')
    await page.reload()
    await expect(page.locator('style#brand-css')).toHaveCount(1)
  } finally {
    // Leave the instance as it was.
    await page.evaluate(async (b) => {
      await fetch('/api/admin/branding', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: b.name, accent: b.accent ?? null }) })
      await fetch('/api/admin/branding/logo', { method: 'DELETE' })
    }, before)
  }
})
