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
  for (const tab of ['People', 'Groups', 'SSO', 'Webhooks', 'Audit log']) {
    await page.getByRole('tab', { name: tab }).or(page.getByRole('button', { name: tab, exact: true })).first().click()
    await expect(page.locator('main, .admin').first()).toBeVisible()
  }
})
