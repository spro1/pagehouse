import { useEffect, useState } from 'react'
import { api, type Space } from './api.ts'
import { t } from './i18n.ts'
import { Icon } from './icons.tsx'
import { toast } from './ui.tsx'

/** Export a space, or a page with its subpages: pick the format, then wait here while the file is built. */
export function ExportPage({ params }: { params: URLSearchParams }) {
  const spaceId = Number(params.get('space')) || null
  const pageId = Number(params.get('page')) || null
  const [what, setWhat] = useState<string>()
  const [format, setFormat] = useState<'md' | 'html'>('md')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (pageId) api<{ title: string }>(`/api/pages/${pageId}`).then((p) => setWhat(t('export.page.what', { name: p.title })), () => setWhat(''))
    else if (spaceId) api<Space[]>('/api/spaces').then((s) => setWhat(t('export.space.what', { name: s.find((x) => x.id === spaceId)?.name ?? '' })))
  }, [spaceId, pageId])
  if (!spaceId && !pageId) return null

  async function run() {
    setBusy(true)
    try {
      const res = await fetch(`/api/${pageId ? `pages/${pageId}` : `spaces/${spaceId}`}/export${format === 'html' ? '?format=html' : ''}`)
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText)
      const name = decodeURIComponent(res.headers.get('content-disposition')?.match(/filename\*=UTF-8''([^;]+)/)?.[1] ?? 'export.zip')
      const a = document.createElement('a')
      a.href = URL.createObjectURL(await res.blob())
      a.download = name
      a.click()
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000)
      toast(t('export.done', { name }))
    } catch (e: any) {
      toast(e.message)
    } finally {
      setBusy(false)
    }
  }

  const option = (f: 'md' | 'html') => (
    <label className={`export-option ${format === f ? 'on' : ''}`}>
      <input type="radio" name="format" checked={format === f} onChange={() => setFormat(f)} disabled={busy} />
      <span><b>{t(`export.${f}`)}</b><small className="muted">{t(`export.${f}.sub`)}</small></span>
    </label>
  )
  return (
    <div className="screen narrow">
      <h1>{t('export.title')}</h1>
      <p className="muted">{what}</p>
      <section className="box">
        <h3>{t('export.format')}</h3>
        <div className="export-options">{option('md')}{option('html')}</div>
        <div className="actions">
          {busy && <span className="muted small export-busy"><span className="spinner" /> {t('export.busy')}</span>}
          <button className="primary" disabled={busy || what === undefined} onClick={run}><Icon name="page" /> {t('export.start')}</button>
        </div>
      </section>
    </div>
  )
}
