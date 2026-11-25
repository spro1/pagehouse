import { useEffect, useState } from 'react'
import { api, ago, toast, type Space } from './api.ts'
import { t, type Key } from './i18n.ts'
import { copyText } from './ui.tsx'

type Hook = {
  id: number; name: string; url: string; events: string[]; spaceId: number | null; enabled: boolean
  lastAt: string | null; lastStatus: number | null; lastError: string | null
}
type Draft = Omit<Hook, 'id' | 'lastAt' | 'lastStatus' | 'lastError'> & { id?: number }
const blank: Draft = { name: '', url: '', events: ['page.created', 'page.updated', 'page.deleted', 'comment.created'], spaceId: null, enabled: true }

/** Admin tab: send page and comment events to other systems as signed JSON. */
export function Webhooks() {
  const [hooks, setHooks] = useState<Hook[]>()
  const [events, setEvents] = useState<string[]>([])
  const [spaces, setSpaces] = useState<Space[]>([])
  const [draft, setDraft] = useState<Draft | null>(null)
  const [secret, setSecret] = useState<{ name: string; value: string } | null>(null)
  const load = () => api<{ events: string[]; hooks: Hook[] }>('/api/admin/webhooks').then((r) => (setHooks(r.hooks), setEvents(r.events)))
  useEffect(() => {
    load()
    api<Space[]>('/api/spaces').then(setSpaces)
  }, [])
  if (!hooks) return null

  const save = async () => {
    if (!draft) return
    try {
      const r = await api<Hook & { secret?: string }>(draft.id ? `/api/admin/webhooks/${draft.id}` : '/api/admin/webhooks', { method: draft.id ? 'PUT' : 'POST', json: draft })
      if (r.secret) setSecret({ name: r.name, value: r.secret })
      setDraft(null)
      load()
    } catch (e: any) {
      toast(e.message)
    }
  }
  const act = async (h: Hook, what: 'test' | 'secret' | 'delete') => {
    try {
      if (what === 'test') {
        const r = await api<{ status: number; error: string | null }>(`/api/admin/webhooks/${h.id}/test`, { method: 'POST' })
        toast(r.error ? t('hook.test.fail', { error: r.error }) : t('hook.test.ok'))
      } else if (what === 'secret') {
        const r = await api<{ secret: string }>(`/api/admin/webhooks/${h.id}/secret`, { method: 'POST' })
        setSecret({ name: h.name, value: r.secret })
      } else await api(`/api/admin/webhooks/${h.id}`, { method: 'DELETE' })
      load()
    } catch (e: any) {
      toast(e.message)
    }
  }
  const spaceName = (id: number | null) => (id == null ? t('hook.allSpaces') : spaces.find((s) => s.id === id)?.name ?? `#${id}`)

  return (
    <section className="box webhooks">
      <div className="box-head">
        <div>
          <h3>{t('hook.title')}</h3>
          <p className="muted small">{t('hook.sub')}</p>
        </div>
        {!draft && <button type="button" className="primary" onClick={() => setDraft({ ...blank })}>{t('hook.add')}</button>}
      </div>

      {secret && (
        <div className="banner ok" role="status">
          <div>
            <b>{t('hook.secret.title', { name: secret.name })}</b>
            <p className="small">{t('hook.secret.note')}</p>
            <div className="row"><code>{secret.value}</code>
              <button type="button" className="link small" onClick={() => copyText(secret.value, t('common.copied'))}>{t('common.copy')}</button>
              <button type="button" className="link small" onClick={() => setSecret(null)}>{t('common.close')}</button>
            </div>
          </div>
        </div>
      )}

      {draft && (
        <form className="hook-form" onSubmit={(e) => (e.preventDefault(), save())}>
          <label className="sso-field"><span>{t('hook.name')}</span>
            <input value={draft.name} required maxLength={100} placeholder={t('hook.name.ph')} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label>
          <label className="sso-field"><span>{t('hook.url')}</span>
            <input type="url" value={draft.url} required placeholder="https://ci.example.com/hooks/pagehouse" onChange={(e) => setDraft({ ...draft, url: e.target.value })} /></label>
          <label className="sso-field"><span>{t('hook.space')}</span>
            <select value={draft.spaceId ?? ''} onChange={(e) => setDraft({ ...draft, spaceId: e.target.value ? Number(e.target.value) : null })}>
              <option value="">{t('hook.allSpaces')}</option>
              {spaces.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select></label>
          <fieldset className="hook-events">
            <legend>{t('hook.events')}</legend>
            {events.map((ev) => (
              <label key={ev} className="check">
                <input type="checkbox" checked={draft.events.includes(ev)}
                  onChange={(e) => setDraft({ ...draft, events: e.target.checked ? [...draft.events, ev] : draft.events.filter((x) => x !== ev) })} />
                <span>{t(`hook.ev.${ev}` as Key)} <code className="muted small">{ev}</code></span>
              </label>
            ))}
          </fieldset>
          <label className="check"><input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} /> {t('hook.enabled')}</label>
          <p className="muted small">{t('hook.note')}</p>
          <div className="actions">
            <button type="button" onClick={() => setDraft(null)}>{t('common.cancel')}</button>
            <button className="primary" disabled={!draft.events.length}>{t('common.save')}</button>
          </div>
        </form>
      )}

      {!hooks.length && !draft && <p className="muted small">{t('hook.none')}</p>}
      <ul className="hook-list">
        {hooks.map((h) => (
          <li key={h.id}>
            <div className="grow">
              <b>{h.name}</b> {!h.enabled && <span className="tag muted-tag">{t('hook.off')}</span>}
              <div className="muted small ellipsis">{h.url}</div>
              <div className="muted small">{spaceName(h.spaceId)} · {h.events.join(', ')}</div>
              {h.lastAt && (
                <div className={`small ${h.lastError ? 'error' : 'muted'}`}>
                  {h.lastError ? t('hook.last.fail', { when: ago(h.lastAt), error: h.lastError }) : t('hook.last.ok', { when: ago(h.lastAt), status: h.lastStatus ?? '' })}
                </div>
              )}
            </div>
            <div className="row">
              <button type="button" className="link small" onClick={() => act(h, 'test')}>{t('hook.test')}</button>
              <button type="button" className="link small" onClick={() => setDraft({ id: h.id, name: h.name, url: h.url, events: h.events, spaceId: h.spaceId, enabled: h.enabled })}>{t('hook.edit')}</button>
              <button type="button" className="link small" onClick={() => act(h, 'secret')}>{t('hook.secret.new')}</button>
              <button type="button" className="link small danger" onClick={() => act(h, 'delete')}>{t('common.delete')}</button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}
