import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fromMarkdown, toMarkdown } from './markdown.ts'

test('markdown in: blocks and inline marks, and a round trip through our own export', () => {
  const src = [
    '## 배포 절차', '', 'Run **kubectl** with `--dry-run` then see [docs](https://k8s.io).', '',
    '- one', '  - nested', '- two', '', '1. first', '2. second', '', '- [x] done', '- [ ] todo', '',
    '> [!WARNING]', '> careful', '', '```bash', 'echo hi', '```', '', '| a | b |', '| --- | --- |', '| 1 | 2 |', '', '---',
  ].join('\n')
  const doc = fromMarkdown(src) as any
  assert.deepEqual(doc.content.map((n: any) => n.type),
    ['heading', 'paragraph', 'bulletList', 'orderedList', 'taskList', 'callout', 'codeBlock', 'table', 'horizontalRule'])
  assert.deepEqual(doc.content[1].content.map((n: any) => [n.text, n.marks?.[0]?.type]),
    [['Run ', undefined], ['kubectl', 'bold'], [' with ', undefined], ['--dry-run', 'code'], [' then see ', undefined], ['docs', 'link'], ['.', undefined]])
  assert.equal(doc.content[2].content[0].content[1].type, 'bulletList', 'nested list')
  assert.equal(doc.content[4].content[0].attrs.checked, true)
  assert.equal(doc.content[5].attrs.variant, 'warning')
  // Our export reads back to the same document.
  assert.deepEqual(fromMarkdown(toMarkdown('T', doc).replace(/^# T\n\n/, '')), doc)
})

test('markdown out: an image caption becomes the title', () => {
  const md = toMarkdown('T', { type: 'doc', content: [{ type: 'image', attrs: { src: 'a.png', alt: 'x', caption: 'say "hi"' } }] })
  assert.ok(md.includes('![x](a.png "say \\"hi\\"")'), md)
})
