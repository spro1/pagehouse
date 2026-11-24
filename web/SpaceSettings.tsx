import { useEffect, useState } from 'react'
import { api, listPeople, toast, type Person } from './api.ts'
import { t, type Key } from './i18n.ts'
import { Icon } from './icons.tsx'
import { Modal } from './ui.tsx'

type Access = 'edit' | 'view' | 'none'
type Role = 'admin' | 'edit' | 'view'
type Member = { userId: number; role: Role; name: string; email: string }
const ACCESS: Access[] = ['edit', 'view', 'none']

/** Picks who can see a space: the three levels, as radio cards. Shared by "new space" and space settings. */
export function AccessChoice({ value, onChange, disabled }: { value: Access; onChange: (a: Access) => void; disabled?: boolean }) {
  return (
    <div className="choice" role="radiogroup" aria-label={t('space.access')}>
      {ACCESS.map((a) => (
        <label key={a} className={value === a ? 'on' : ''}>
          <input type="radio" name="space-access" checked={value === a} disabled={disabled} onChange={() => onChange(a)} />
          <span>
            <b><Icon name={a === 'none' ? 'lock' : a === 'view' ? 'page' : 'users'} size={14} /> {t(`space.access.${a}` as Key)}</b>
            <small>{t(`space.access.${a}.sub` as Key)}</small>
          </span>
        </label>
      ))}
    </div>
  )
}

export function SpaceSettings({ spaceId, me, onClose, onSaved }: { spaceId: number; me: { id: number }; onClose: () => void; onSaved: () => void }) {
  const [s, setS] = useState<{ name: string; defaultAccess: Access; members: Member[]; canManage: boolean }>()
  const [people, setPeople] = useState<Person[]>([])
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    api(`/api/spaces/${spaceId}/settings`).then(setS)
    listPeople().then(setPeople)
  }, [spaceId])

  const set = (patch: Partial<NonNullable<typeof s>>) => setS((x) => x && { ...x, ...patch })
  const needle = q.trim().toLowerCase()
  const matches = s && needle ? people.filter((p) => !s.members.some((m) => m.userId === p.id) && `${p.name} ${p.email}`.toLowerCase().includes(needle)).slice(0, 20) : []

  async function save() {
    if (!s) return
    setBusy(true)
    try {
      await api(`/api/spaces/${spaceId}/settings`, {
        method: 'PUT',
        json: { name: s.name, defaultAccess: s.defaultAccess, members: s.members.map(({ userId, role }) => ({ userId, role })) },
      })
      toast(t('space.saved'))
      onSaved()
      onClose()
    } catch (e: any) {
      toast(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={t('space.settings')}
      onClose={onClose}
      footer={
        <>
          <span className="note-text">{t('space.manageNote')}</span>
          <button onClick={onClose}>{s?.canManage ? t('common.cancel') : t('common.close')}</button>
          {s?.canManage && <button className="primary" disabled={busy || !s.name.trim()} onClick={save}>{t('common.save')}</button>}
        </>
      }
    >
      {!s ? (
        <div className="space-settings-loading"><span className="spinner" /></div>
      ) : (
        <div className="form">
          <label>
            {t('space.name')}
            <input value={s.name} disabled={!s.canManage} onChange={(e) => set({ name: e.target.value })} maxLength={100} />
          </label>
          <div className="field">
            <span>{t('space.access')}</span>
            <AccessChoice value={s.defaultAccess} disabled={!s.canManage} onChange={(a) => set({ defaultAccess: a })} />
          </div>
          <div className="field">
            <span>{t('space.members')}</span>
            <div className="access-area members-area">
              {s.canManage && (
                <label className="access-search">
                  <Icon name="search" />
                  <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('space.members.add')} aria-label={t('space.members.add')}
                    onKeyDown={(e) => e.key === 'Enter' && matches[0] && (e.preventDefault(), set({ members: [...s.members, { userId: matches[0].id, name: matches[0].name, email: matches[0].email, role: 'edit' }] }), setQ(''))} />
                </label>
              )}
              <ul className="people">
                {needle ? (
                  matches.length ? matches.map((p) => (
                    <li key={p.id}>
                      <span className="avatar">{p.name.slice(0, 1)}</span>
                      <span className="person"><b><span>{p.name}</span></b><small>{p.email}</small></span>
                      <button className="add-btn" onClick={() => (set({ members: [...s.members, { userId: p.id, name: p.name, email: p.email, role: 'edit' }] }), setQ(''))}>
                        <Icon name="plus" size={14} /> {t('access.addBtn')}
                      </button>
                    </li>
                  )) : <li className="muted small">{t('access.noMatch', { q: q.trim() })}</li>
                ) : s.members.length ? (
                  s.members.map((m) => (
                    <li key={m.userId}>
                      <span className="avatar">{m.name.slice(0, 1)}</span>
                      <span className="person"><b><span>{m.name}</span>{m.userId === me.id && <span className="tag">{t('common.me')}</span>}</b><small>{m.email}</small></span>
                      <select value={m.role} disabled={!s.canManage} aria-label={t('access.levelFor', { name: m.name })}
                        onChange={(e) => set({ members: s.members.map((x) => (x.userId === m.userId ? { ...x, role: e.target.value as Role } : x)) })}>
                        {(['admin', 'edit', 'view'] as Role[]).map((r) => <option key={r} value={r}>{t(`space.role.${r}` as Key)}</option>)}
                      </select>
                      {s.canManage ? (
                        <button className="ghost icon" aria-label={t('access.remove', { name: m.name })} onClick={() => set({ members: s.members.filter((x) => x.userId !== m.userId) })}>
                          <Icon name="x" size={14} />
                        </button>
                      ) : <span style={{ width: 30 }} />}
                    </li>
                  ))
                ) : <li className="muted small">{t('space.members.empty')}</li>}
              </ul>
            </div>
          </div>
        </div>
      )}
    </Modal>
  )
}
