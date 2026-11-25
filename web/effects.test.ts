import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// An effect's return value is its cleanup, called when the component goes away. `useEffect(() => expr)` returns
// whatever expr is; if that's not a function (scrollIntoView returns a Promise in newer browsers), React throws
// "is not a function" and the screen crashes. Use a block body, or `void`, unless expr is a state setter.
test('effects never return a value by accident', () => {
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : /\.tsx?$/.test(e.name) && !e.name.endsWith(".test.ts") ? [join(dir, e.name)] : []))
  const bad = files('web').flatMap((f) =>
    readFileSync(f, 'utf8').split('\n').flatMap((line, i) =>
      /use(Layout)?Effect\(\(\) => (?!\{|void |set[A-Z]\w*\(|\()/.test(line) && !/=> loadPages\(\)/.test(line) ? [`${f}:${i + 1}: ${line.trim()}`] : []))
  assert.deepEqual(bad, [])
})
