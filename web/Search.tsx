import { useEffect, useRef, useState } from 'react'
import { api, ago, fullDate, type Space } from './api.ts'
import { t } from './i18n.ts'
import { Icon } from './icons.tsx'

export type Hit = {
  id: number; title: string; snippet: string; updatedAt: string; updatedBy: string; space: string; spaceId: number; path: string[]
}
type Filters = { q: string; space: string; author: string; days: string; scope: string; sort: string; label: string }
const KEYS: (keyof Filters)[] = ['q', 'space', 'author', 'days', 'scope', 'sort', 'label']
const PAGE = 20

export function searchUrl(q: string) {
  return `#/search?q=${encodeURIComponent(q)}`
}

/** Highlights every search word inside `text`. */
export function highlight(text: string, q: string) {
  const all = q.trim().split(/\s+/).filter(Boolean)
  // One-character words ("1", "a") would light up everywhere; mark them only when they are the whole query.
  const words = (all.length > 1 ? all.filter((w) => w.length > 1) : all).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  if (!words.length) return text
  const parts = text.split(new RegExp(`(${words.join('|')})`, 'gi'))
  return parts.map((p, i) => (i % 2 ? <mark key={i}>{p}</mark> : p))
}

export function SearchPage({ initial }: { initial: URLSearchParams }) {
  const [f, setF] = useState<Filters>(() => Object.fromEntries(KEYS.map((k) => [k, initial.get(k) ?? ''])) as Filters)
  const [input, setInput] = useState(f.q)
  const [data, setData] = useState<{ total: number; results: Hit[] } | null>(null)
  const [busy, setBusy] = useState(false)
  const [spaces, setSpaces] = useState<Space[]>([])
  const [users, setUsers] = useState<{ id: number; name: string }[]>([])
  const [labels, setLabels] = useState<{ label: string; pages: number }[]>([])
  const box = useRef<HTMLInputElement>(null)

  useEffect(() => {
    api('/api/spaces').then(setSpaces)
    api('/api/users').then(setUsers)
    api('/api/labels').then(setLabels)
    box.current?.focus()
  }, [])

  const query = (extra: Record<string, string | number>) => {
    const qs = new URLSearchParams()
    for (const k of KEYS) if (f[k]) qs.set(k, f[k])
    for (const [k, v] of Object.entries(extra)) qs.set(k, String(v))
    return qs.toString()
  }

  // Search as the filters change; keep the URL in step so a search can be shared or bookmarked.
  useEffect(() => {
    const qs = new URLSearchParams()
    for (const k of KEYS) if (f[k]) qs.set(k, f[k])
    history.replaceState(null, '', `#/search?${qs}`)
    if (!f.q.trim() && !f.label) return setData(null)
    let live = true
    setBusy(true)
    api(`/api/search?${query({ limit: PAGE })}`)
      .then((r) => live && setData(r))
      .finally(() => live && setBusy(false))
    return () => void (live = false)
  }, [f])

  // Typing waits a moment; pressing Enter searches right away.
  useEffect(() => {
    if (input === f.q) return
    const timer = setTimeout(() => setF((x) => ({ ...x, q: input })), 300)
    return () => clearTimeout(timer)
  }, [input])

  const set = (k: keyof Filters) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }))
  const more = async () => {
    if (!data) return
    setBusy(true)
    try {
      const r = await api(`/api/search?${query({ limit: PAGE, offset: data.results.length })}`)
      setData({ total: r.total, results: [...data.results, ...r.results] })
    } finally {
      setBusy(false)
    }
  }
  const filtered = !!(f.space || f.author || f.days || f.scope || f.label)

  return (
    <div className="screen search-screen">
      <h1>{t('search.title')}</h1>
      <form className="search-box" onSubmit={(e) => (e.preventDefault(), setF((x) => ({ ...x, q: input })))}>
        <Icon name="search" size={18} />
        <input ref={box} value={input} onChange={(e) => setInput(e.target.value)} placeholder={t('search.placeholder')} aria-label={t('search.title')} />
        {busy && <span className="spinner" />}
      </form>

      <div className="search-filters">
        <select value={f.space} onChange={set('space')} aria-label={t('search.space')}>
          <option value="">{t('search.anySpace')}</option>
          {spaces.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <select value={f.author} onChange={set('author')} aria-label={t('search.author')}>
          <option value="">{t('search.anyone')}</option>
          {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
        <select value={f.days} onChange={set('days')} aria-label={t('search.period')}>
          <option value="">{t('search.anytime')}</option>
          <option value="7">{t('search.days7')}</option>
          <option value="30">{t('search.days30')}</option>
          <option value="365">{t('search.days365')}</option>
        </select>
        <select value={f.scope} onChange={set('scope')} aria-label={t('search.scope')}>
          <option value="">{t('search.scopeAll')}</option>
          <option value="title">{t('search.titleOnly')}</option>
        </select>
        {(labels.length > 0 || f.label) && (
          <select value={f.label} onChange={set('label')} aria-label={t('label.filter')}>
            <option value="">{t('label.any')}</option>
            {f.label && !labels.some((l) => l.label === f.label) && <option value={f.label}>#{f.label}</option>}
            {labels.map((l) => <option key={l.label} value={l.label}>#{l.label} ({l.pages})</option>)}
          </select>
        )}
        <span className="grow" />
        <select value={f.sort} onChange={set('sort')} aria-label={t('search.sort')}>
          <option value="">{t('search.sortRelevance')}</option>
          <option value="recent">{t('search.sortRecent')}</option>
        </select>
      </div>

      {!f.q.trim() && !f.label ? (
        <div className="empty-box"><Icon name="search" size={28} /><p>{t('search.hint')}</p></div>
      ) : data && (
        <>
          <div className="search-count">
            {t('search.count', { n: data.total })}
            {filtered && (
              <button className="link small" onClick={() => setF((x) => ({ ...x, space: '', author: '', days: '', scope: '', label: '' }))}>{t('search.clear')}</button>
            )}
          </div>
          {data.results.length === 0 ? (
            <div className="empty-box"><Icon name="search" size={28} /><p>{t('search.none')}</p></div>
          ) : (
            <ul className="search-results">
              {data.results.map((r) => (
                <li key={r.id}>
                  <a href={`#/p/${r.id}`}>
                    <span className="search-path">{[r.space, ...r.path].join(' / ')}</span>
                    <span className="search-title"><Icon name="page" size={15} /> {highlight(r.title, f.q)}</span>
                    {r.snippet && <span className="search-snippet">{highlight(r.snippet, f.q)}</span>}
                    <span className="search-meta" title={fullDate(r.updatedAt)}>{t('search.editedBy', { name: r.updatedBy, when: ago(r.updatedAt) })}</span>
                  </a>
                </li>
              ))}
            </ul>
          )}
          {data.results.length < data.total && (
            <div className="search-more">
              <button onClick={more} disabled={busy}>{t('search.more', { n: data.total - data.results.length })}</button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
