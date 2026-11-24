// Every language must define every key, so a missing translation fails CI instead of showing English mid-sentence.
import { test } from 'node:test'
import assert from 'node:assert/strict'

;(globalThis as any).localStorage = { getItem: () => null, setItem: () => {} }
;(globalThis as any).document = { documentElement: {} }
const { LANGS, t } = await import('./i18n.ts')

test('all languages define the same keys', () => {
  const base = Object.keys(LANGS.en.dict).sort()
  for (const [code, { dict }] of Object.entries(LANGS)) assert.deepEqual(Object.keys(dict).sort(), base, code)
})

test('placeholders are filled', () => {
  assert.equal(t('page.createdBy', { name: 'Kim' }), 'Created by Kim')
})
