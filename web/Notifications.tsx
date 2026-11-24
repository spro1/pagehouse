import { useEffect, useRef, useState } from 'react'
import { api, ago, fullDate, listPeople } from './api.ts'
import { t, type Key } from './i18n.ts'
import { Icon } from './icons.tsx'

type Item = { id: number; kind: string; createdAt: string; readAt: string | null; pageId: number; page: string; excerpt: string | null; actor: string | null }

/** Comments keep mentions as <@id>; show them as names. */
export async function mentionsToNames(text: string) {
  const people = await listPeople()
  return text.replace(/<@(\d+)>/g, (_m, id) => `@${people.find((p) => p.id === Number(id))?.name ?? '?'}`)
}

export function notificationText(i: Item) {
  return t(`notif.${i.kind}` as Key, { actor: i.actor ?? '?', page: `“${i.page}”` })
}

/** The bell in the sidebar: unread count, refreshed every minute and when the tab regains focus. */
export function Bell() {
  const [unread, setUnread] = useState(0)
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<(Item & { text?: string })[] | null>(null)
  const box = useRef<HTMLDivElement>(null)

  const count = () => api<{ unread: number }>('/api/notifications/count').then((r) => setUnread(r.unread), () => {})
  useEffect(() => {
    count()
    const timer = setInterval(count, 60_000)
    addEventListener('focus', count)
    return () => (clearInterval(timer), removeEventListener('focus', count))
  }, [])
  useEffect(() => {
    if (!open) return
    api<{ items: Item[]; unread: number }>('/api/notifications').then(async (r) => {
      setUnread(r.unread)
      setItems(await Promise.all(r.items.map(async (i) => ({ ...i, excerpt: i.excerpt ? await mentionsToNames(i.excerpt) : null }))))
    })
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false)
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    addEventListener('mousedown', close)
    addEventListener('keydown', esc)
    return () => (removeEventListener('mousedown', close), removeEventListener('keydown', esc))
  }, [open])

  const read = async (ids?: number[]) => {
    await api('/api/notifications/read', { json: ids ? { ids } : {} })
    setItems((l) => l?.map((i) => (!ids || ids.includes(i.id) ? { ...i, readAt: i.readAt ?? new Date().toISOString() } : i)) ?? null)
    count()
  }

  return (
    <div className="bell" ref={box}>
      <button className="ghost icon" aria-label={t('notif.open', { n: unread })} aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="bell" />
        {unread > 0 && <span className="badge">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <div className="notif-panel" role="dialog" aria-label={t('notif.title')}>
          <div className="notif-head">
            <b>{t('notif.title')}</b>
            <button className="link small" disabled={!unread} onClick={() => read()}>{t('notif.markAll')}</button>
          </div>
          <div className="notif-list">
            {!items && <div className="notif-empty"><span className="spinner" /></div>}
            {items && !items.length && <div className="notif-empty"><Icon name="bell" size={26} />{t('notif.empty')}</div>}
            {items?.map((i) => (
              <a
                key={i.id}
                href={`#/p/${i.pageId}`}
                className={`notif ${i.readAt ? '' : 'unread'}`}
                onClick={() => (setOpen(false), !i.readAt && read([i.id]))}
              >
                <span className="avatar">{(i.actor ?? '?').slice(0, 1)}</span>
                <span className="notif-body">
                  <span>{notificationText(i)}</span>
                  {i.excerpt && <small className="notif-excerpt">{i.excerpt}</small>}
                  <small className="muted" title={fullDate(i.createdAt)}>{ago(i.createdAt)}</small>
                </span>
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
