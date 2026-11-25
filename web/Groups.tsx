import { useEffect, useState } from 'react'
import { api, listPeople, toast, type Person } from './api.ts'
import { t } from './i18n.ts'
import { Icon } from './icons.tsx'
import { Modal, confirmDialog, Avatar } from './ui.tsx'

type Group = { id: number; name: string; size: number }

/** Admin tab: groups, which can then be given space roles and page access like a person. */
export function Groups() {
  const [groups, setGroups] = useState<Group[]>([])
  const [editing, setEditing] = useState<number | 'new' | null>(null)
  const load = () => api<Group[]>('/api/groups').then(setGroups)
  useEffect(() => void load(), [])
  return (
    <section className="box">
      <div className="box-head">
        <div>
          <h3>{t('group.title', { n: groups.length })}</h3>
          <p className="muted small">{t('group.sub')}</p>
        </div>
        <button className="primary" onClick={() => setEditing('new')}><Icon name="plus" size={14} /> {t('group.new')}</button>
      </div>
      <ul className="people">
        {groups.map((g) => (
          <li key={g.id}>
            <span className="avatar"><Icon name="users" size={14} /></span>
            <span className="person"><b><span>{g.name}</span></b><small>{t('group.size', { n: g.size })}</small></span>
            <button className="link small" onClick={() => setEditing(g.id)}>{t('group.edit')}</button>
            <button className="link small danger" onClick={async () => {
              if (!(await confirmDialog({ title: t('group.delete.title', { name: g.name }), body: t('group.delete.body'), ok: t('group.delete'), danger: true }))) return
              api(`/api/admin/groups/${g.id}`, { method: 'DELETE' }).then(load, (e) => toast(e.message))
            }}>{t('group.delete')}</button>
          </li>
        ))}
        {!groups.length && <li className="muted small">{t('group.empty')}</li>}
      </ul>
      {editing !== null && <GroupModal id={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={load} />}
    </section>
  )
}

function GroupModal({ id, onClose, onSaved }: { id: number | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState('')
  const [members, setMembers] = useState<Person[]>([])
  const [people, setPeople] = useState<Person[]>([])
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    listPeople().then(setPeople)
    if (id) api(`/api/admin/groups/${id}`).then((g) => (setName(g.name), setMembers(g.members)))
  }, [id])
  const needle = q.trim().toLowerCase()
  const matches = needle ? people.filter((p) => !members.some((m) => m.id === p.id) && `${p.name} ${p.email}`.toLowerCase().includes(needle)).slice(0, 20) : []
  const add = (p: Person) => (setMembers([...members, p]), setQ(''))
  async function save() {
    setBusy(true)
    try {
      await api(id ? `/api/admin/groups/${id}` : '/api/admin/groups', { method: id ? 'PUT' : 'POST', json: { name, members: members.map((m) => m.id) } })
      onSaved()
      onClose()
    } catch (e: any) {
      toast(e.message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal title={id ? t('group.edit') : t('group.new')} onClose={onClose} footer={
      <>
        <button onClick={onClose}>{t('common.cancel')}</button>
        <button className="primary" disabled={busy || !name.trim()} onClick={save}>{t('common.save')}</button>
      </>
    }>
      <div className="form">
        <label>{t('group.name')}<input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} autoFocus /></label>
        <div className="field">
          <span>{t('group.members', { n: members.length })}</span>
          <div className="access-area members-area">
            <label className="access-search">
              <Icon name="search" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('space.members.add')} aria-label={t('space.members.add')}
                onKeyDown={(e) => e.key === 'Enter' && matches[0] && (e.preventDefault(), add(matches[0]))} />
            </label>
            <ul className="people">
              {needle
                ? matches.length
                  ? matches.map((p) => (
                      <li key={p.id}>
                        <Avatar id={p.id} name={p.name} />
                        <span className="person"><b><span>{p.name}</span></b><small>{p.email}</small></span>
                        <button className="add-btn" onClick={() => add(p)}><Icon name="plus" size={14} /> {t('access.addBtn')}</button>
                      </li>
                    ))
                  : <li className="muted small">{t('access.noMatch', { q: q.trim() })}</li>
                : members.map((m) => (
                    <li key={m.id}>
                      <Avatar id={m.id} name={m.name} />
                      <span className="person"><b><span>{m.name}</span></b><small>{m.email}</small></span>
                      <button className="ghost icon" aria-label={t('access.remove', { name: m.name })} onClick={() => setMembers(members.filter((x) => x.id !== m.id))}>
                        <Icon name="x" size={14} />
                      </button>
                    </li>
                  ))}
            </ul>
          </div>
        </div>
      </div>
    </Modal>
  )
}
