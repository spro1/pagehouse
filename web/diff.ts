// Line diff (longest common subsequence) for comparing two versions of a page as Markdown.
export type DiffLine = { kind: 'same' | 'add' | 'del'; text: string }

export function diffLines(a: string[], b: string[]): DiffLine[] {
  // Common head and tail are cheap to strip and keep the table small for typical small edits.
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let end = 0
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++
  const x = a.slice(start, a.length - end)
  const y = b.slice(start, b.length - end)
  // shortcut: O(n·m) table; past ~4M cells show it as a full replace instead of hanging the tab.
  let mid: DiffLine[]
  if (x.length * y.length > 4_000_000) mid = [...x.map((text) => ({ kind: 'del' as const, text })), ...y.map((text) => ({ kind: 'add' as const, text }))]
  else {
    const n = x.length, m = y.length
    const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1])
    mid = []
    let i = 0, j = 0
    while (i < n && j < m) {
      if (x[i] === y[j]) mid.push({ kind: 'same', text: x[i++] }), j++
      else if (L[i + 1][j] >= L[i][j + 1]) mid.push({ kind: 'del', text: x[i++] })
      else mid.push({ kind: 'add', text: y[j++] })
    }
    while (i < n) mid.push({ kind: 'del', text: x[i++] })
    while (j < m) mid.push({ kind: 'add', text: y[j++] })
  }
  return [...a.slice(0, start).map((text) => ({ kind: 'same' as const, text })), ...mid, ...a.slice(a.length - end).map((text) => ({ kind: 'same' as const, text }))]
}
