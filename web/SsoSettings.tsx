import { useEffect, useState } from 'react'
import { api, toast } from './api.ts'
import { t } from './i18n.ts'
import { copyText } from './ui.tsx'

type Sso = {
  source: 'env' | 'admin'; enabled: boolean; issuer: string; clientId: string; hasSecret: boolean; label: string
  autoCreate: boolean; trustEmail: boolean; passwordLogin: boolean; redirectUri: string
}

/** Admin tab: single sign-on with an OpenID Connect provider (Keycloak, Entra ID, Google Workspace, Okta, …). */
export function SsoSettings() {
  const [s, setS] = useState<Sso>()
  const [secret, setSecret] = useState('')
  const [busy, setBusy] = useState(false)
  const [check, setCheck] = useState<{ ok: boolean; text: string }>()
  useEffect(() => void api<Sso>('/api/admin/sso').then(setS), [])
  if (!s) return null
  const locked = s.source === 'env'
  const set = (patch: Partial<Sso>) => (setS({ ...s, ...patch }), setCheck(undefined))
  const test = async () => {
    setBusy(true)
    type Check = { ok: boolean; issuer?: string; error?: string }
    const r: Check = await api<Check>('/api/admin/sso/test', { json: { issuer: s.issuer } }).catch((e): Check => ({ ok: false, error: e.message }))
    setCheck(r.ok ? { ok: true, text: t('sso.test.ok', { issuer: r.issuer ?? s.issuer }) } : { ok: false, text: t('sso.test.fail', { error: r.error ?? '' }) })
    setBusy(false)
  }
  const save = async (enabled = s.enabled) => {
    setBusy(true)
    try {
      const r = await api<Sso>('/api/admin/sso', { method: 'PUT', json: { ...s, enabled, clientSecret: secret } })
      setS(r)
      setSecret('')
      toast(t(r.enabled ? 'sso.saved.on' : 'sso.saved.off'))
    } catch (e: any) {
      toast(e.message)
    } finally {
      setBusy(false)
    }
  }
  const field = (label: string, input: React.ReactNode, hint?: string) => (
    <label className="sso-field"><span>{label}</span>{input}{hint && <small className="muted">{hint}</small>}</label>
  )
  const check1 = (key: 'autoCreate' | 'trustEmail' | 'passwordLogin', label: string, hint: string) => (
    <label className="check sso-check">
      <input type="checkbox" checked={s[key]} disabled={locked} onChange={(e) => set({ [key]: e.target.checked })} />
      <span><b>{label}</b><small className="muted">{hint}</small></span>
    </label>
  )
  return (
    <section className="box sso">
      <div className="box-head">
        <div>
          <h3>{t('sso.title')}</h3>
          <p className="muted small">{t('sso.sub')}</p>
        </div>
        <span className={`tag ${s.enabled ? '' : 'muted-tag'}`}>{t(s.enabled ? 'sso.on' : 'sso.off')}</span>
      </div>
      {locked && <div className="banner warn">{t('sso.env')}</div>}

      <div className="sso-redirect">
        <span className="small muted">{t('sso.redirect')}</span>
        <div className="row">
          <code>{s.redirectUri}</code>
          <button type="button" className="link small" onClick={() => copyText(s.redirectUri, t('common.copied'))}>{t('common.copy')}</button>
        </div>
        <small className="muted">{t('sso.redirect.hint')}</small>
      </div>

      {field(t('sso.issuer'), <div className="row">
        <input value={s.issuer} disabled={locked} placeholder="https://sso.example.com/realms/company" onChange={(e) => set({ issuer: e.target.value })} />
        <button type="button" disabled={busy || !s.issuer} onClick={test}>{t('sso.test')}</button>
      </div>, t('sso.issuer.hint'))}
      {check && <div className={`banner ${check.ok ? 'ok' : 'warn'}`} role="status">{check.text}</div>}
      {field(t('sso.clientId'), <input value={s.clientId} disabled={locked} onChange={(e) => set({ clientId: e.target.value })} />)}
      {field(t('sso.secret'), <input type="password" autoComplete="new-password" value={secret} disabled={locked}
        placeholder={s.hasSecret ? t('sso.secret.kept') : ''} onChange={(e) => setSecret(e.target.value)} />, t('sso.secret.hint'))}
      {field(t('sso.label'), <input value={s.label} disabled={locked} placeholder={t('sso.label.ph')} maxLength={60} onChange={(e) => set({ label: e.target.value })} />)}

      {check1('autoCreate', t('sso.autoCreate'), t('sso.autoCreate.hint'))}
      {check1('passwordLogin', t('sso.passwordLogin'), t('sso.passwordLogin.hint'))}
      {check1('trustEmail', t('sso.trustEmail'), t('sso.trustEmail.hint'))}

      {!locked && (
        <div className="actions">
          {s.enabled
            ? <>
                <button type="button" disabled={busy} onClick={() => save(false)}>{t('sso.disable')}</button>
                <button type="button" className="primary" disabled={busy} onClick={() => save()}>{t('common.save')}</button>
              </>
            : <button type="button" className="primary" disabled={busy || !s.issuer || !s.clientId} onClick={() => save(true)}>{t('sso.enable')}</button>}
        </div>
      )}
    </section>
  )
}
