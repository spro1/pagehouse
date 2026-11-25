import { useEffect, useState } from 'react'
import { api, ago, fullDate, toast } from './api.ts'
import { t } from './i18n.ts'
import { Icon } from './icons.tsx'

const units = ['B', 'KB', 'MB', 'GB', 'TB']
export function bytes(n: number) {
  let i = 0
  while (n >= 1024 && i < units.length - 1) (n /= 1024), i++
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`
}
const duration = (s: number) => (s < 3600 ? `${Math.max(1, Math.round(s / 60))}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`)

export function Monitor() {
  const [d, setD] = useState<any>()
  const [limit, setLimit] = useState('')
  const load = () =>
    api('/api/admin/stats').then((x) => {
      setD(x)
      setLimit(x.storage.limitBytes ? String(+(x.storage.limitBytes / 1024 ** 3).toFixed(2)) : '')
    })
  useEffect(() => void load(), [])
  if (!d) return <div className="skeleton" style={{ height: 320, marginTop: 24 }} />

  const s = d.storage
  // The bar is measured against the limit if one is set, otherwise against what the disk could still hold.
  const cap = s.limitBytes ?? (s.disk ? s.usedBytes + s.disk.free : s.usedBytes)
  const pct = cap ? Math.min(100, (s.usedBytes / cap) * 100) : 0
  const warn = s.limitBytes ? pct >= 80 : !!s.disk && s.disk.free / s.disk.total < 0.1
  const every = d.backups?.policy?.intervalHours ?? 24
  const stale = !d.backups?.latestAuto || Date.now() - new Date(d.backups.latestAuto).getTime() > every * 1.5 * 3600 * 1000
  const maxEdits = Math.max(1, ...d.activity.map((a: any) => a.edits))
  const c = d.counts

  async function saveLimit(value: number | null) {
    try {
      await api('/api/admin/settings', { method: 'PUT', json: { storageLimitGb: value } })
      toast(t('mon.limit.saved'))
      load()
    } catch (e: any) {
      toast(e.message)
    }
  }

  return (
    <div className="monitor">
      {warn && <div className="banner warn"><Icon name="settings" /> {t('mon.warn', { pct: Math.round(pct) })}</div>}
      <Health />

      <section className="box">
        <div className="box-head">
          <h3>{t('mon.storage')}</h3>
          <button className="ghost" onClick={load}>{t('mon.refresh')}</button>
        </div>
        <div className="usage-line">
          <b>{t('mon.used', { used: bytes(s.usedBytes) })}</b>
          <span className="muted">{s.limitBytes ? t('mon.ofLimit', { limit: bytes(s.limitBytes) }) : t('mon.noLimit')}</span>
        </div>
        <div className={`meter ${warn ? 'warn' : ''}`} role="meter" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
          <span className="seg db" style={{ width: `${cap ? (s.dbBytes / cap) * 100 : 0}%` }} />
          <span className="seg files" style={{ width: `${cap ? (s.fileBytes / cap) * 100 : 0}%` }} />
        </div>
        <div className="legend">
          <span><i className="dot db" /> {t('mon.db')} {bytes(s.dbBytes)}</span>
          <span><i className="dot files" /> {t('mon.files')} {bytes(s.fileBytes)}</span>
          {s.disk && <span className="muted">{t('mon.disk', { free: bytes(s.disk.free), total: bytes(s.disk.total) })}</span>}
        </div>
        {s.fileBytesBeforeDedup > s.fileBytes && <p className="muted small">{t('mon.dedup', { saved: bytes(s.fileBytesBeforeDedup - s.fileBytes) })}</p>}
        <form
          className="limit-form"
          onSubmit={(e) => {
            e.preventDefault()
            const v = Number(limit)
            if (v > 0) saveLimit(v)
          }}
        >
          <label>
            <span>{t('mon.limit')} <span className="hint">· {t('mon.limit.hint')}</span></span>
            <span className="row">
              <input type="number" min="0.001" step="any" value={limit} onChange={(e) => setLimit(e.target.value)} placeholder="—" aria-label={t('mon.limit')} />
              <span className="muted">GB</span>
              <button className="primary" disabled={!(Number(limit) > 0)}>{t('mon.limit.set')}</button>
              {s.limitBytes && <button type="button" onClick={() => saveLimit(null)}>{t('mon.limit.clear')}</button>}
            </span>
          </label>
        </form>
      </section>

      <div className="grid-2">
        <section className="box">
          <h3>{t('mon.backups')}</h3>
          {!d.backups ? (
            <p className="muted small">{t('mon.backups.none')}</p>
          ) : (
            <>
              <p className={stale ? 'error' : ''}>
                {d.backups.latestAuto ? (
                  <span title={fullDate(d.backups.latestAuto)}>{t('mon.backups.latest', { when: ago(d.backups.latestAuto) })}</span>
                ) : t('mon.backups.never')}
              </p>
              <p className="muted small">{t('mon.backups.count', { n: d.backups.count, size: bytes(d.backups.bytes) })}</p>
              {stale && <p className="error small">{t('mon.backups.stale')}</p>}
              <BackupPolicyForm policy={d.backups.policy} onSaved={load} />
            </>
          )}
        </section>
        <section className="box">
          <h3>{t('mon.system')}</h3>
          <p>Pagehouse {d.system.version} <span className="muted small">· {t('mon.uptime', { t: duration(d.system.uptimeSeconds) })}</span></p>
          <p className="muted small">Node {d.system.node} · PostgreSQL {d.system.postgres}</p>
        </section>
      </div>

      <section className="box">
        <h3>{t('mon.content')}</h3>
        <div className="stats">
          {[
            [t('mon.users'), c.activeUsers], [t('mon.pages'), c.pages], [t('mon.trashed'), c.trashed], [t('mon.versions'), c.versions],
            [t('mon.comments'), c.comments], [t('mon.attachments'), c.attachments], [t('mon.editors'), c.activeEditors30d],
          ].map(([label, n]) => (
            <div key={label} className="stat"><b>{Number(n).toLocaleString()}</b><span>{label}</span></div>
          ))}
        </div>
        <h3 className="sub">{t('mon.activity')}</h3>
        <div className="bars" role="img" aria-label={t('mon.activity')}>
          {d.activity.map((a: any) => (
            <div key={a.day} className="bar" title={`${a.day}: ${a.edits}`}>
              <span style={{ height: `${(a.edits / maxEdits) * 100}%` }} />
              <small>{a.day.slice(8)}</small>
            </div>
          ))}
        </div>
      </section>

      <section className="box">
        <h3>{t('mon.spaces')}</h3>
        <div className="table-scroll">
          <table className="grid">
            <thead><tr><th>{t('mon.col.space')}</th><th>{t('mon.col.pages')}</th><th>{t('mon.col.files')}</th><th>{t('mon.col.last')}</th></tr></thead>
            <tbody>
              {d.spaces.map((sp: any) => (
                <tr key={sp.id}>
                  <td>{sp.name} <span className="muted small">{sp.key}</span></td>
                  <td>{sp.pages.toLocaleString()}</td>
                  <td>{bytes(sp.fileBytes)}</td>
                  <td className="muted">{sp.lastEdit ? ago(sp.lastEdit) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {d.largestFiles.length > 0 && (
        <section className="box">
          <h3>{t('mon.largest')}</h3>
          <div className="table-scroll">
            <table className="grid">
              <tbody>
                {d.largestFiles.map((f: any) => (
                  <tr key={f.id}>
                    <td className="ellipsis" style={{ maxWidth: 280 }}>📎 {f.name}</td>
                    <td><a href={`#/p/${f.pageId}`}>{f.page}</a> {f.trashed && <span className="tag">{t('mon.trashedTag')}</span>}</td>
                    <td className="num">{bytes(f.size)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  )
}

type Policy = { intervalHours: number; keep: number; maxAgeDays: number; manualMaxAgeDays: number }

/** How often backups run and how long they're kept. The backup container reads it before each run. */
function BackupPolicyForm({ policy, onSaved }: { policy: Policy; onSaved: () => void }) {
  const [p, setP] = useState(policy)
  const num = (k: keyof Policy, min: number, max: number, unit: string) => (
    <label className="policy-field">
      <span>{t(`mon.policy.${k}`)}</span>
      <span className="row">
        <input type="number" min={min} max={max} step={1} value={p[k]} onChange={(e) => setP({ ...p, [k]: Math.trunc(Number(e.target.value)) })} />
        <span className="muted small">{unit}</span>
      </span>
    </label>
  )
  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    try {
      await api('/api/admin/backup-policy', { method: 'PUT', json: p })
      toast(t('mon.policy.saved'))
      onSaved()
    } catch (err: any) {
      toast(err.message)
    }
  }
  return (
    <form className="backup-policy" onSubmit={save}>
      <h4>{t('mon.policy')}</h4>
      {num('intervalHours', 1, 168, t('mon.policy.hours'))}
      {num('keep', 1, 365, t('mon.policy.count'))}
      {num('maxAgeDays', 0, 3650, t('mon.policy.days'))}
      {num('manualMaxAgeDays', 0, 3650, t('mon.policy.days'))}
      <p className="muted small">{t('mon.policy.hint')}</p>
      <div className="actions"><button className="primary">{t('common.save')}</button></div>
    </form>
  )
}

type HealthData = {
  db: { latencyMs: number; connections: number | null; waiting: number | null }
  process: { uptimeSeconds: number; rssBytes: number; heapUsedBytes: number; loopDelayP99Ms: number }
  recent: { minutes: number; requests: number; serverErrors: number; slow: number; errors: { at: string; method: string; path: string; status: number; message: string }[] }
  collab: { rooms: number; connections: number }
  backlog: { mail: number; webhooks: number }
  webhooksFailing: number
  mailFailed: number
  backup: { lastAt: string | null; overdue: boolean } | null
}

/** This instance's health: problems first, then the numbers behind them. Refreshes every 30 seconds. */
function Health() {
  const [h, setH] = useState<HealthData>()
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const load = () => api<HealthData>('/api/admin/health').then(setH, () => {})
    load()
    const id = setInterval(load, 30_000)
    return () => clearInterval(id)
  }, [])
  if (!h) return null
  const problems: string[] = []
  if (h.db.latencyMs > 200) problems.push(t('health.p.db', { ms: h.db.latencyMs }))
  if (h.db.waiting) problems.push(t('health.p.pool', { n: h.db.waiting }))
  if (h.process.loopDelayP99Ms > 200) problems.push(t('health.p.loop', { ms: h.process.loopDelayP99Ms }))
  if (h.recent.serverErrors) problems.push(t('health.p.errors', { n: h.recent.serverErrors, m: h.recent.minutes }))
  if (h.backup?.overdue) problems.push(t('health.p.backup'))
  if (h.backlog.mail) problems.push(t('health.p.mail', { n: h.backlog.mail }))
  if (h.backlog.webhooks) problems.push(t('health.p.hooks', { n: h.backlog.webhooks }))
  if (h.webhooksFailing) problems.push(t('health.p.hookFail', { n: h.webhooksFailing }))
  const tile = (label: string, value: string, bad = false) => (
    <div className={`health-tile${bad ? ' bad' : ''}`}><span className="muted small">{label}</span><b>{value}</b></div>
  )
  return (
    <section className="box health">
      <div className="box-head">
        <h3>{t('health.title')}</h3>
        <span className={`tag ${problems.length ? 'warn-tag' : ''}`}>{problems.length ? t('health.issues', { n: problems.length }) : t('health.ok')}</span>
      </div>
      {problems.length > 0 && <ul className="health-problems">{problems.map((p) => <li key={p}>{p}</li>)}</ul>}
      <div className="health-grid">
        {tile(t('health.db'), `${h.db.latencyMs} ms`, h.db.latencyMs > 200)}
        {tile(t('health.memory'), bytes(h.process.rssBytes))}
        {tile(t('health.loop'), `${h.process.loopDelayP99Ms} ms`, h.process.loopDelayP99Ms > 200)}
        {tile(t('health.requests', { m: h.recent.minutes }), `${h.recent.requests}`)}
        {tile(t('health.errors'), `${h.recent.serverErrors}`, h.recent.serverErrors > 0)}
        {tile(t('health.slow'), `${h.recent.slow}`)}
        {tile(t('health.live'), t('health.liveValue', { rooms: h.collab.rooms, conns: h.collab.connections }))}
        {tile(t('health.backlog'), `${h.backlog.mail} / ${h.backlog.webhooks}`, h.backlog.mail + h.backlog.webhooks > 0)}
      </div>
      <p className="muted small">{t('health.note', { up: duration(h.process.uptimeSeconds) })}</p>
      {h.recent.errors.length > 0 && (
        <details open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
          <summary className="small">{t('health.recentErrors', { n: h.recent.errors.length })}</summary>
          <ul className="health-errors">
            {h.recent.errors.map((e, i) => (
              <li key={i}><span className="muted" title={fullDate(e.at)}>{ago(e.at)}</span> <code>{e.method} {e.path}</code> {e.message}</li>
            ))}
          </ul>
        </details>
      )}
    </section>
  )
}
