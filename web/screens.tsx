import { useEffect, useState } from 'react'
import { api, ago, fullDate, toast, type User } from './api.ts'
import { LANGS, lang, setLang, t, type Lang } from './i18n.ts'
import { Icon } from './icons.tsx'
import { TEMPLATES, type Template } from './templates.ts'
import { Modal, confirmDialog } from './ui.tsx'
import { Monitor } from './Monitor.tsx'
import { mentionsToNames, notificationText } from './Notifications.tsx'
import { AccessChoice } from './SpaceSettings.tsx'
import { THEMES, applyTheme, theme, type Theme } from './theme.ts'
import { highlight, searchUrl } from './Search.tsx'

export function NewSpaceModal({ onClose, onCreated }: { onClose: () => void; onCreated: (s: any) => void }) {
  const [name, setName] = useState('')
  const [key, setKey] = useState('')
  const [touched, setTouched] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [access, setAccess] = useState<'edit' | 'view' | 'none'>('edit')
  const autoKey = name.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 10)
  return (
    <Modal
      title={t('space.new')}
      onClose={onClose}
      onSubmit={async (e) => {
        e.preventDefault()
        setBusy(true)
        try {
          onCreated(await api('/api/spaces', { json: { name, key: touched ? key : autoKey, defaultAccess: access } }))
        } catch (err: any) {
          setError(err.message)
        } finally {
          setBusy(false)
        }
      }}
      footer={
        <>
          <span className="grow" />
          <button type="button" onClick={onClose}>{t('common.cancel')}</button>
          <button className="primary" disabled={busy || !name.trim()}>{t('common.create')}</button>
        </>
      }
    >
      <div className="form">
        <label>
          {t('space.name')}
          <input value={name} onChange={(e) => (setName(e.target.value), setError(''))} placeholder={t('space.name.ph')} required maxLength={100} />
        </label>
        <label>
          <span>{t('space.key')} <span className="hint">· {t('space.key.hint')}</span></span>
          <input
            value={touched ? key : autoKey}
            onChange={(e) => (setTouched(true), setKey(e.target.value.toUpperCase()), setError(''))}
            placeholder="PLATFORM"
            required
            maxLength={20}
            pattern="[A-Za-z0-9]+"
          />
        </label>
        <div className="field">
          <span>{t('space.access')}</span>
          <AccessChoice value={access} onChange={setAccess} />
        </div>
        <div className="form-msg error" role="alert">{error}</div>
      </div>
    </Modal>
  )
}

export function Palette({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState('')
  const [results, setResults] = useState<{ id: number; title: string; snippet: string }[]>([])
  const [searched, setSearched] = useState('')
  const [total, setTotal] = useState(0)
  const all = () => ((location.hash = searchUrl(q.trim())), onClose())
  const [sel, setSel] = useState(0)
  useEffect(() => {
    if (!q.trim()) return setResults([]), setSearched(''), setTotal(0)
    const timer = setTimeout(() => api(`/api/search?limit=8&q=${encodeURIComponent(q)}`).then((r) => (setResults(r.results), setTotal(r.total), setSearched(q), setSel(0))), 160)
    return () => clearTimeout(timer)
  }, [q])
  useEffect(() => document.querySelector('.palette-results .on')?.scrollIntoView({ block: 'nearest' }), [sel])
  const go = (id: number) => ((location.hash = `#/p/${id}`), onClose())
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-label={t('nav.search')}>
        <div className="palette-input">
          <Icon name="search" size={18} />
          <input
            autoFocus
            value={q}
            placeholder={t('search.placeholder')}
            aria-label={t('nav.search')}
            role="combobox"
            aria-expanded={results.length > 0}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose()
              if (e.key === 'ArrowDown') (e.preventDefault(), setSel((s) => Math.min(s + 1, results.length - 1)))
              if (e.key === 'ArrowUp') (e.preventDefault(), setSel((s) => Math.max(s - 1, 0)))
              if (e.key === 'Enter') (e.metaKey || e.ctrlKey || !results[sel] ? q.trim() && all() : go(results[sel].id))
            }}
          />
          {q && <span className="spinner" style={{ visibility: q !== searched ? 'visible' : 'hidden' }} />}
        </div>
        <div className="palette-results" role="listbox">
          {results.map((r, i) => (
            <button key={r.id} role="option" aria-selected={i === sel} className={i === sel ? 'on' : ''} onMouseMove={() => setSel(i)} onClick={() => go(r.id)}>
              <span className="palette-title"><Icon name="page" size={14} /> {highlight(r.title, q)}</span>
              {r.snippet && <small>{highlight(r.snippet, q)}</small>}
            </button>
          ))}
          {searched && q.trim() && (
            <button className="palette-all" onClick={all}>
              <Icon name="search" size={14} /> {t('search.allResults', { q: q.trim() })}
              <span className="muted small">{t('search.count', { n: total })}</span>
            </button>
          )}
          {!results.length && (
            <div className="palette-empty">
              <Icon name="search" size={28} />
              <span>{searched && q.trim() ? t('search.none') : t('search.empty')}</span>
            </div>
          )}
        </div>
        <div className="palette-foot">
          <span><kbd>↑</kbd> <kbd>↓</kbd> {t('search.move')}</span>
          <span><kbd>Enter</kbd> {t('search.open')}</span>
          <span><kbd>Esc</kbd> {t('search.close')}</span>
          <span className="grow" />
          <span><kbd>{/Mac/.test(navigator.platform) ? '⌘' : 'Ctrl'}</kbd> <kbd>Enter</kbd> {t('search.allShort')}</span>
        </div>
      </div>
    </div>
  )
}

export function Home({ me, spaceId, onCreate }: { me: User; spaceId?: number; onCreate: (tpl: Template) => void }) {
  const [d, setD] = useState<{ viewed: any[]; created: any[]; forYou: any[] }>()
  useEffect(() => {
    api('/api/home').then(async (r) => {
      // comment excerpts keep mentions as <@id>
      setD({ ...r, forYou: await Promise.all(r.forYou.map(async (i: any) => ({ ...i, excerpt: i.excerpt ? await mentionsToNames(i.excerpt) : null }))) })
    })
  }, [])
  const hour = new Date().getHours()
  const greet = hour < 12 ? 'home.morning' : hour < 18 ? 'home.afternoon' : 'home.evening'
  const list = (items: any[] | undefined, empty: string, meta: (r: any) => string, metaTitle: (r: any) => string) =>
    !items ? <div className="skeleton" style={{ height: 180 }} /> : !items.length ? <p className="home-empty">{empty}</p> : (
      <ul className="recent">
        {items.map((r) => (
          <li key={r.id}>
            <a href={`#/p/${r.id}`}>
              <span className="recent-title"><Icon name="page" size={15} /><span>{r.title}</span></span>
              <span className="muted small home-meta" title={metaTitle(r)}>{meta(r)}</span>
            </a>
          </li>
        ))}
      </ul>
    )
  return (
    <div className="home">
      <h1>{t(greet, { name: me.name })}</h1>
      <div className="quick-create" aria-label={t('home.templates')}>
        {TEMPLATES.map((tpl) => (
          <button key={tpl.key} disabled={!spaceId} title={spaceId ? tpl.desc : t('home.needSpace')} onClick={() => onCreate(tpl)}>
            <span aria-hidden="true">{tpl.icon}</span> {tpl.name}
          </button>
        ))}
        <button disabled={!spaceId} title={t('tpl.import.desc')} onClick={() => dispatchEvent(new CustomEvent('ph:import', { detail: { parentId: null } }))}>
          <span aria-hidden="true">📥</span> {t('tpl.import')}
        </button>
      </div>
      <div className="home-grid">
        <section>
          <h3>{t('home.viewed')}</h3>
          {list(d?.viewed, t('home.viewed.empty'), (r) => `${r.space} · ${ago(r.viewedAt)}`, (r) => fullDate(r.viewedAt))}
        </section>
        <section>
          <h3>{t('home.forYou')}</h3>
          {!d ? <div className="skeleton" style={{ height: 180 }} /> : !d.forYou.length ? <p className="home-empty">{t('home.forYou.empty')}</p> : (
            <ul className="recent for-you">
              {d.forYou.map((i) => (
                <li key={i.id} className={i.readAt ? '' : 'unread'}>
                  <a href={`#/p/${i.pageId}`}>
                    <span className="avatar">{(i.actor ?? '?').slice(0, 1)}</span>
                    <span className="notif-body">
                      <span>{notificationText(i)}</span>
                      {i.excerpt && <small className="notif-excerpt">{i.excerpt}</small>}
                      <small className="muted" title={fullDate(i.createdAt)}>{ago(i.createdAt)}</small>
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
      <section>
        <h3>{t('home.created')}</h3>
        {list(d?.created, t('home.created.empty'), (r) => `${r.space} · ${r.createdBy} · ${ago(r.createdAt)}`, (r) => fullDate(r.createdAt))}
      </section>
    </div>
  )
}

export function Trash({ spaceId, onRestored }: { spaceId: number; onRestored: () => void }) {
  const [items, setItems] = useState<any[]>()
  useEffect(() => {
    api(`/api/spaces/${spaceId}/trash`).then(setItems)
  }, [spaceId])
  return (
    <div className="screen">
      <h1>{t('trash.title')}</h1>
      <p className="muted">{t('trash.sub')}</p>
      {items && !items.length && <div className="empty-box"><Icon name="trash" size={28} /><p>{t('trash.empty')}</p></div>}
      {items && items.length > 0 && (
        <ul className="rows">
          {items.map((it) => (
            <li key={it.id}>
              <span>{it.title}</span>
              <span className="muted small" title={fullDate(it.deletedAt)}>{t('trash.deletedAt', { when: ago(it.deletedAt) })}</span>
              <button
                onClick={async () => {
                  try {
                    await api(`/api/pages/${it.id}/restore`, { method: 'POST' })
                    setItems((l) => l!.filter((x) => x.id !== it.id))
                    toast(t('page.restored'))
                    onRestored()
                  } catch (e: any) {
                    toast(e.message)
                  }
                }}
              >
                {t('trash.restore')}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

const link = (kind: string, token: string) => `${location.origin}/#/${kind}/${token}`

export function Admin({ me }: { me: User }) {
  const [users, setUsers] = useState<any[]>([])
  const [shared, setShared] = useState<{ label: string; url: string } | null>(null)
  const load = () => api('/api/admin/users').then(setUsers)
  useEffect(() => void load(), [])
  const patch = async (id: number, body: object) => {
    try {
      await api(`/api/admin/users/${id}`, { method: 'PATCH', json: body })
      load()
    } catch (e: any) {
      toast(e.message)
    }
  }
  const invite = async (role: 'member' | 'admin') => {
    const { token } = await api('/api/admin/invites', { json: { role } })
    setShared({ label: t(role === 'admin' ? 'admin.invite.admin' : 'admin.invite.member'), url: link('invite', token) })
  }
  const [tab, setTab] = useState<'overview' | 'people'>(() => (location.hash.includes('people') ? 'people' : 'overview'))
  return (
    <div className="screen wide">
      <h1>{t('admin.title')}</h1>
      <div className="tabs" role="tablist">
        {(['overview', 'people'] as const).map((k) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
            {t(k === 'overview' ? 'admin.tab.overview' : 'admin.tab.people')}
          </button>
        ))}
      </div>
      {tab === 'overview' ? <Monitor /> : <>
      <section className="box">
        <div className="box-head">
          <div>
            <h3>{t('admin.invite')}</h3>
            <p className="muted small">{t('admin.invite.sub')}</p>
          </div>
          <div className="row">
            <button onClick={() => invite('member')}>{t('admin.invite.member')}</button>
            <button onClick={() => invite('admin')}>{t('admin.invite.admin')}</button>
          </div>
        </div>
        {shared && <CopyBox label={shared.label} url={shared.url} />}
      </section>
      <section className="box">
        <h3>{t('admin.users', { n: users.length })}</h3>
        <div className="table-scroll">
          <table className="grid">
            <thead>
              <tr>
                <th>{t('admin.col.name')}</th><th>{t('admin.col.email')}</th><th>{t('admin.col.role')}</th><th>{t('admin.col.status')}</th><th />
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className={u.disabledAt ? 'dim' : ''}>
                  <td>{u.name}{u.id === me.id && <span className="tag">{t('common.me')}</span>}</td>
                  <td>{u.email}</td>
                  <td>
                    <select value={u.role} disabled={u.id === me.id} onChange={(e) => patch(u.id, { role: e.target.value })} aria-label={t('admin.col.role')}>
                      <option value="member">{t('admin.role.member')}</option>
                      <option value="admin">{t('admin.role.admin')}</option>
                    </select>
                  </td>
                  <td><span className={`status-dot ${u.disabledAt ? 'off' : 'on'}`} />{u.disabledAt ? t('admin.disabled') : t('admin.active')}</td>
                  <td className="row-actions">
                    {u.id !== me.id && (
                      <>
                        <button
                          className="link small"
                          onClick={async () => {
                            const { token } = await api(`/api/admin/users/${u.id}/reset-link`, { method: 'POST' })
                            setShared({ label: t('admin.resetLink.label', { name: u.name }), url: link('reset', token) })
                          }}
                        >
                          {t('admin.resetLink')}
                        </button>
                        <button
                          className={`link small ${u.disabledAt ? '' : 'danger'}`}
                          onClick={async () => {
                            if (!u.disabledAt && !(await confirmDialog({ title: t('admin.disable.title', { name: u.name }), body: t('admin.disable.body'), ok: t('admin.disable'), danger: true }))) return
                            patch(u.id, { disabled: !u.disabledAt })
                          }}
                        >
                          {u.disabledAt ? t('admin.enable') : t('admin.disable')}
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      </>}
    </div>
  )
}

function CopyBox({ label, url }: { label: string; url: string }) {
  return (
    <div className="copybox">
      <span className="small muted">{label}</span>
      <div className="row">
        <input readOnly value={url} onFocus={(e) => e.target.select()} aria-label={label} />
        <button className="primary" onClick={() => navigator.clipboard.writeText(url).then(() => toast(t('common.copied')))}>{t('common.copy')}</button>
      </div>
    </div>
  )
}

/** With `account`, the choice is saved to the signed-in user so it follows them to every device. */
export function LangSelect({ account }: { account?: boolean }) {
  const choose = async (l: Lang) => {
    if (account) await api('/api/me', { method: 'PATCH', json: { locale: l } }).catch(() => {})
    setLang(l)
  }
  return (
    <label className="lang-select">
      <Icon name="globe" size={14} />
      <select value={lang} aria-label={t('settings.language')} onChange={(e) => choose(e.target.value as Lang)}>
        {Object.entries(LANGS).map(([code, l]) => (
          <option key={code} value={code}>{l.label}</option>
        ))}
      </select>
    </label>
  )
}

export function Settings({ me }: { me: User }) {
  const [msg, setMsg] = useState<{ text: string; error?: boolean }>()
  return (
    <div className="screen narrow">
      <h1>{t('settings.title')}</h1>
      <section className="box profile">
        <span className="avatar lg">{me.name.slice(0, 1)}</span>
        <div>
          <b>{me.name}</b> {me.role === 'admin' && <span className="tag">{t('admin.role.admin')}</span>}
          <div className="muted small">{me.email}</div>
        </div>
      </section>
      <section className="box">
        <h3>{t('theme.label')}</h3>
        <p className="muted small">{t('theme.note')}</p>
        <ThemeSelect />
      </section>
      <section className="box">
        <h3>{t('settings.language')}</h3>
        <p className="muted small">{t('settings.language.note')}</p>
        <LangSelect account />
      </section>
      <section className="box">
        <h3>{t('settings.password')}</h3>
        <form
          className="form"
          onSubmit={async (e) => {
            e.preventDefault()
            const form = e.currentTarget
            const f = Object.fromEntries(new FormData(form))
            if (f.next !== f.confirm) return setMsg({ text: t('settings.mismatch'), error: true })
            try {
              await api('/api/me/password', { json: { current: f.current, next: f.next } })
              form.reset()
              setMsg({ text: t('settings.changed') })
            } catch (err: any) {
              setMsg({ text: err.message, error: true })
            }
          }}
        >
          <label>{t('settings.current')}<input name="current" type="password" required autoComplete="current-password" /></label>
          <label>{t('settings.new')}<input name="next" type="password" minLength={8} required autoComplete="new-password" /></label>
          <label>{t('settings.confirm')}<input name="confirm" type="password" minLength={8} required autoComplete="new-password" /></label>
          {msg && <div className={msg.error ? 'error' : 'ok'} role="status">{msg.text}</div>}
          <div className="actions"><button className="primary">{t('settings.change')}</button></div>
        </form>
      </section>
    </div>
  )
}

/** Theme picker; the choice is applied at once and saved to the account. */
export function ThemeSelect() {
  const [value, setValue] = useState<Theme>(theme)
  return (
    <div className="segmented three" role="radiogroup" aria-label={t('theme.label')}>
      {THEMES.map((th) => (
        <button key={th} role="radio" aria-checked={value === th} className={value === th ? 'on' : ''}
          onClick={() => (setValue(th), applyTheme(th), api('/api/me', { method: 'PATCH', json: { theme: th } }).catch(() => {}))}>
          <Icon name={th === 'system' ? 'monitor' : th === 'light' ? 'sun' : 'moon'} size={14} /> {t(`theme.${th}`)}
        </button>
      ))}
    </div>
  )
}
