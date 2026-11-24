import { useEffect, useState } from 'react'
import { api, toast } from './api.ts'
import { t } from './i18n.ts'
import { Icon } from './icons.tsx'

/** A page's labels: each opens every page with that label; editors add (with suggestions) and remove them. */
export function Labels({ pageId, initial, canEdit }: { pageId: number; initial: string[]; canEdit: boolean }) {
  const [labels, setLabels] = useState(initial)
  const [adding, setAdding] = useState(false)
  const [input, setInput] = useState('')
  const [hints, setHints] = useState<string[]>([])
  useEffect(() => setLabels(initial), [pageId])
  useEffect(() => {
    if (!adding) return
    const timer = setTimeout(() => api<{ label: string }[]>(`/api/labels?q=${encodeURIComponent(input)}`).then((r) => setHints(r.map((x) => x.label).filter((l) => !labels.includes(l)).slice(0, 8))), 150)
    return () => clearTimeout(timer)
  }, [input, adding, labels])
  const save = (next: string[]) =>
    api<{ labels: string[] }>(`/api/pages/${pageId}/labels`, { method: 'PUT', json: { labels: next } }).then((r) => setLabels(r.labels), (e) => toast(e.message))
  const add = (l: string) => (l.trim() && save([...labels, l]), setInput(''))
  if (!labels.length && !canEdit) return null
  return (
    <div className="labels">
      {labels.map((l) => (
        <span key={l} className="label-chip">
          <a href={`#/search?label=${encodeURIComponent(l)}`}>#{l}</a>
          {canEdit && <button className="ghost icon" aria-label={t('label.remove', { label: l })} onClick={() => save(labels.filter((x) => x !== l))}><Icon name="x" size={11} /></button>}
        </span>
      ))}
      {canEdit && (adding ? (
        <span className="label-add">
          <input
            autoFocus value={input} placeholder={t('label.placeholder')} list={`labels-${pageId}`} aria-label={t('label.add')}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ',') (e.preventDefault(), add(input))
              if (e.key === 'Escape') (setAdding(false), setInput(''))
            }}
            onBlur={() => (input.trim() && add(input), setAdding(false))}
          />
          <datalist id={`labels-${pageId}`}>{hints.map((h) => <option key={h} value={h} />)}</datalist>
        </span>
      ) : (
        <button className="ghost label-new" onClick={() => setAdding(true)}>{labels.length ? '+' : t('label.add')}</button>
      ))}
    </div>
  )
}
