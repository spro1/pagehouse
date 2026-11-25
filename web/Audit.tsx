import { useEffect, useState } from 'react'
import { api, fullDate, toast } from './api.ts'
import { hasKey, t } from './i18n.ts'

type Entry = {
  id: number; at: string; action: string; ok: boolean; ip: string; detail: Record<string, unknown> | null
  actor: { id: number; name: string } | null; target: { id: number; name: string | null } | null
}
const ACTIONS = ['auth.login', 'auth.sso', 'auth.register', 'auth.reset', 'user.password', 'token.create', 'token.revoke', 'user.update',
  'user.reset_link', 'user.invite', 'settings.update', 'settings.sso', 'settings.backup', 'group.create', 'group.update', 'group.delete', 'space.create', 'space.settings',
  'space.export', 'page.restrictions', 'page.delete', 'page.restore', 'page.move', 'page.export']
const label = (a: string) => { const k = `audit.${a}`; return hasKey(k) ? t(k) : a }

/** Admin tab: who signed in, changed permissions, deleted or exported what. */
export function Audit() {
  const [rows, setRows] = useState<Entry[]>([])
  const [action, setAction] = useState('')
  const [more, setMore] = useState(false)
  const load = (before?: number) =>
    api<Entry[]>(`/api/admin/audit?${new URLSearchParams({ ...(action ? { action } : {}), ...(before ? { before: String(before) } : {}) })}`)
      .then((r) => (setRows((old) => (before ? [...old, ...r] : r)), setMore(r.length === 100)), (e) => toast(e.message))
  useEffect(() => void load(), [action])
  return (
    <section className="box">
      <div className="box-head">
        <div>
          <h3>{t('audit.title')}</h3>
          <p className="muted small">{t('audit.sub')}</p>
        </div>
        <select value={action} onChange={(e) => setAction(e.target.value)} aria-label={t('audit.filter')}>
          <option value="">{t('audit.all')}</option>
          {ACTIONS.map((a) => <option key={a} value={a}>{label(a)}</option>)}
        </select>
      </div>
      <div className="table-scroll">
        <table className="grid audit">
          <thead>
            <tr><th>{t('audit.when')}</th><th>{t('audit.who')}</th><th>{t('audit.what')}</th><th>{t('audit.target')}</th><th>IP</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className={r.ok ? '' : 'failed'}>
                <td className="nowrap">{fullDate(r.at)}</td>
                <td>{r.actor?.name ?? (typeof r.detail?.email === 'string' ? r.detail.email : '—')}</td>
                <td>
                  {label(r.action)}
                  {!r.ok && <span className="tag danger">{t('audit.failed')}</span>}
                  {r.detail?.body != null && <details><summary className="muted small">{t('audit.detail')}</summary><pre className="small">{JSON.stringify(r.detail.body, null, 2)}</pre></details>}
                </td>
                <td>{r.target ? (r.action.startsWith('page.') && r.target.name ? <a href={`#/p/${r.target.id}`}>{r.target.name}</a> : r.target.name ?? `#${r.target.id}`) : ''}</td>
                <td className="muted small">{r.ip}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!rows.length && <p className="muted">{t('audit.empty')}</p>}
      {more && <button className="ghost" onClick={() => load(rows[rows.length - 1].id)}>{t('audit.more')}</button>}
    </section>
  )
}
