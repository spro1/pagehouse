import { test } from 'node:test'
import assert from 'node:assert/strict'
import { diffLines } from './diff.ts'

test('line diff finds additions, removals and keeps unchanged lines', () => {
  const d = diffLines(['a', 'b', 'c', 'd'], ['a', 'c', 'x', 'd'])
  assert.deepEqual(d.map((l) => `${l.kind[0]}${l.text}`), ['sa', 'db', 'sc', 'ax', 'sd'])
  assert.deepEqual(diffLines([], ['n']), [{ kind: 'add', text: 'n' }])
})
