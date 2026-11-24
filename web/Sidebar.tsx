import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { api, toast, type PageNode, type Space, type User } from './api.ts'
import { t } from './i18n.ts'
import { Icon } from './icons.tsx'
import { Bell } from './Notifications.tsx'
import { applyTheme, theme as currentTheme, type Theme } from './theme.ts'

type Props = {
  me: User; spaces: Space[]; spaceId?: number; pages: PageNode[]; current: number | null; route: string
  onSpace: (id: number) => void; onNewSpace: () => void; onNewPage: (parentId: number | null) => void
  onSearch: () => void; onMoved: () => void; onLogout: () => void; onClose: () => void; onSpaceSettings: () => void
}

export function Sidebar(p: Props) {
  const space = p.spaces.find((s) => s.id === p.spaceId)
  const [spaceMenu, setSpaceMenu] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!spaceMenu) return
    const close = (e: MouseEvent) => !menuRef.current?.contains(e.target as Node) && setSpaceMenu(false)
    addEventListener('mousedown', close)
    return () => removeEventListener('mousedown', close)
  }, [spaceMenu])
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform)

  return (
    <nav className="sidebar" aria-label={t('nav.label')}>
      <div className="sidebar-top">
        <div className="space-switch" ref={menuRef}>
          <button className="space-btn" onClick={() => setSpaceMenu(!spaceMenu)} aria-expanded={spaceMenu} aria-haspopup="menu">
            <span className="space-badge">{space?.name.slice(0, 1) ?? '?'}</span>
            <span className="space-name">{space?.name ?? t('space.fallback')}</span>
            {space?.defaultAccess === 'none' && <span className="space-lock" title={t('space.private')}><Icon name="lock" size={13} /></span>}
            <Icon name="down" size={14} />
          </button>
          {spaceMenu && (
            <div className="dropdown wide" role="menu">
              {p.spaces.map((s) => (
                <button key={s.id} role="menuitem" className={s.id === p.spaceId ? 'on' : ''} onClick={() => (p.onSpace(s.id), setSpaceMenu(false))}>
                  <span className="space-badge sm">{s.name.slice(0, 1)}</span>
                  <span className="grow">{s.name}</span>
                  {s.defaultAccess === 'none' && <span className="space-lock" title={t('space.private')}><Icon name="lock" size={12} /></span>}
                  <span className="muted small">{s.key}</span>
                </button>
              ))}
              <hr />
              {p.spaceId && (
                <>
                  <button role="menuitem" onClick={() => (setSpaceMenu(false), p.onSpaceSettings())}>
                    <Icon name="users" /> {t('space.settings')}
                  </button>
                  <button role="menuitem" onClick={() => (setSpaceMenu(false), dispatchEvent(new CustomEvent('ph:import', { detail: { parentId: null } })))}>
                    <Icon name="plus" /> {t('import.space')}
                  </button>
                  <a role="menuitem" className="menu-link" href={`/api/spaces/${p.spaceId}/export`} download onClick={() => setSpaceMenu(false)}>
                    <Icon name="page" /> {t('export.space')}
                  </a>
                  <hr />
                </>
              )}
              <button role="menuitem" onClick={() => (setSpaceMenu(false), p.onNewSpace())}>
                <Icon name="plus" /> {t('nav.newSpace')}
              </button>
            </div>
          )}
        </div>
        <Bell />
        <button className="ghost icon close-nav" aria-label={t('nav.closeMenu')} onClick={p.onClose}>
          <Icon name="x" />
        </button>
      </div>

      <button className={`nav-item search-trigger ${p.route === 'search' ? 'on' : ''}`} onClick={p.onSearch}>
        <Icon name="search" />
        <span className="grow">{t('nav.search')}</span>
        <kbd>{isMac ? '⌘K' : 'Ctrl K'}</kbd>
      </button>
      <a className={`nav-item ${p.route === 'home' ? 'on' : ''}`} href="#/">
        <Icon name="home" /> {t('nav.home')}
      </a>
      {p.spaceId && (
        <a className={`nav-item ${p.route === 'trash' ? 'on' : ''}`} href={`#/s/${p.spaceId}/trash`}>
          <Icon name="trash" /> {t('nav.trash')}
        </a>
      )}

      <QuickLinks current={p.current} />

      <div className="tree-head">
        <span>{t('nav.pages')}</span>
        <button className="ghost icon" title={t('nav.newPage')} aria-label={t('nav.newPage')} onClick={() => p.onNewPage(null)}>
          <Icon name="plus" size={14} />
        </button>
      </div>
      <Tree pages={p.pages} current={p.current} onAdd={p.onNewPage} onMoved={p.onMoved} />
      {!p.pages.length && <p className="muted small pad">{t('nav.noPages')}</p>}
      <button className="nav-item new-page" onClick={() => p.onNewPage(null)}>
        <Icon name="plus" /> {t('nav.newPage')}
      </button>

      <div className="sidebar-foot">
        {p.me.role === 'admin' && (
          <a className={`nav-item ${p.route === 'admin' ? 'on' : ''}`} href="#/admin">
            <Icon name="settings" /> {t('nav.admin')}
          </a>
        )}
        <div className="me">
          <span className="avatar">{p.me.name.slice(0, 1)}</span>
          <a href="#/settings" className={`me-name ${p.route === 'settings' ? 'on' : ''}`}>{p.me.name}</a>
          <ThemeButton />
          <button className="ghost icon" title={t('nav.logout')} aria-label={t('nav.logout')} onClick={p.onLogout}>
            <Icon name="logout" />
          </button>
        </div>
      </div>
    </nav>
  )
}

type Drop = { id: number; where: 'before' | 'after' | 'inside' }

function Tree({ pages, current, onAdd, onMoved }: { pages: PageNode[]; current: number | null; onAdd: (p: number) => void; onMoved: () => void }) {
  const [open, setOpen] = useState<Set<number>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem('ph:open') ?? '[]'))
    } catch {
      return new Set()
    }
  })
  const [drag, setDrag] = useState<number | null>(null)
  const [drop, setDrop] = useState<Drop | null>(null)
  const children = useMemo(() => {
    const m = new Map<number | null, PageNode[]>()
    for (const p of pages) m.set(p.parentId, [...(m.get(p.parentId) ?? []), p])
    return m
  }, [pages])
  const byId = useMemo(() => new Map(pages.map((p) => [p.id, p])), [pages])

  useEffect(() => {
    try {
      localStorage.setItem('ph:open', JSON.stringify([...open]))
    } catch {}
  }, [open])
  // Keep the path to the current page expanded.
  useEffect(() => {
    setOpen((prev) => {
      const next = new Set(prev)
      for (let p = byId.get(current ?? -1); p?.parentId; p = byId.get(p.parentId)) next.add(p.parentId)
      return next.size === prev.size ? prev : next
    })
  }, [current, byId])

  const toggle = (id: number) =>
    setOpen((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })

  const isInside = (id: number, ancestor: number) => {
    for (let p = byId.get(id); p; p = p.parentId ? byId.get(p.parentId) : undefined) if (p.id === ancestor) return true
    return false
  }

  function over(e: DragEvent, id: number) {
    if (drag === null || isInside(id, drag)) return
    e.preventDefault()
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const y = (e.clientY - r.top) / r.height
    setDrop({ id, where: y < 0.25 ? 'before' : y > 0.75 ? 'after' : 'inside' })
  }

  async function dropIt() {
    if (drag === null || !drop) return
    const target = byId.get(drop.id)!
    let parentId: number | null, index: number
    if (drop.where === 'inside') {
      parentId = target.id
      index = Number.MAX_SAFE_INTEGER
    } else {
      parentId = target.parentId
      const sibs = (children.get(parentId) ?? []).filter((x) => x.id !== drag)
      index = sibs.findIndex((x) => x.id === target.id) + (drop.where === 'after' ? 1 : 0)
    }
    setDrag(null)
    setDrop(null)
    try {
      await api(`/api/pages/${drag}/move`, { json: { parentId, index } })
      if (parentId) setOpen((o) => new Set(o).add(parentId!))
      onMoved()
    } catch (e: any) {
      toast(e.message)
    }
  }

  const render = (parent: number | null, depth: number) => (
    <ul role={parent === null ? 'tree' : 'group'}>
      {(children.get(parent) ?? []).map((p) => {
        const hasKids = children.has(p.id)
        const cls = ['node', p.id === current && 'active', drag === p.id && 'dragging', drop?.id === p.id && `drop-${drop.where}`]
          .filter(Boolean)
          .join(' ')
        return (
          <li key={p.id} role="treeitem" aria-expanded={hasKids ? open.has(p.id) : undefined} aria-selected={p.id === current}>
            <div
              className={cls}
              style={{ paddingLeft: depth * 14 + 4 }}
              draggable
              onDragStart={(e) => (setDrag(p.id), (e.dataTransfer.effectAllowed = 'move'))}
              onDragEnd={() => (setDrag(null), setDrop(null))}
              onDragOver={(e) => over(e, p.id)}
              onDragLeave={() => setDrop((d) => (d?.id === p.id ? null : d))}
              onDrop={(e) => (e.preventDefault(), dropIt())}
            >
              <button
                className="caret"
                onClick={() => toggle(p.id)}
                aria-label={open.has(p.id) ? t('tree.collapse') : t('tree.expand')}
                tabIndex={hasKids ? 0 : -1}
                style={{ visibility: hasKids ? 'visible' : 'hidden' }}
              >
                <span className={open.has(p.id) ? 'rot' : ''}>
                  <Icon name="chevron" size={13} />
                </span>
              </button>
              <a href={`#/p/${p.id}`} draggable={false}>{p.title || t('common.untitled')}</a>
              {p.locked && (
                <span className="lock" title={t('tree.locked')} aria-label={t('tree.locked')}>
                  <Icon name="lock" size={12} />
                </span>
              )}
              <button className="add" onClick={() => onAdd(p.id)} title={t('tree.addChild')} aria-label={t('tree.addChild')}>
                <Icon name="plus" size={13} />
              </button>
            </div>
            {open.has(p.id) && hasKids && render(p.id, depth + 1)}
          </li>
        )
      })}
    </ul>
  )
  return <div className="tree">{render(null, 0)}</div>
}

/** Cycles system → light → dark; saved to the account. */
function ThemeButton() {
  const [th, setTh] = useState<Theme>(currentTheme)
  useEffect(() => {
    const on = (e: Event) => setTh((e as CustomEvent).detail)
    addEventListener('ph:theme', on)
    return () => removeEventListener('ph:theme', on)
  }, [])
  const next: Theme = th === 'system' ? 'light' : th === 'light' ? 'dark' : 'system'
  const label = t('theme.toggle', { mode: t(`theme.${th}`) })
  return (
    <button className="ghost icon theme-btn" title={label} aria-label={label}
      onClick={() => (applyTheme(next), api('/api/me', { method: 'PATCH', json: { theme: next } }).catch(() => {}))}>
      <Icon name={th === 'system' ? 'monitor' : th === 'light' ? 'sun' : 'moon'} />
    </button>
  )
}

type Quick = { id: number; title: string; kind: string }
/** Favorites and recently viewed pages, across spaces. Refreshed as pages open and stars change. */
function QuickLinks({ current }: { current: number | null }) {
  const [q, setQ] = useState<{ starred: Quick[]; recent: Quick[] }>({ starred: [], recent: [] })
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem('ph.recentOpen') !== '0'
    } catch {
      return true
    }
  })
  useEffect(() => {
    const load = () => api('/api/me/quick').then(setQ, () => {})
    load()
    addEventListener('ph:quick-changed', load)
    return () => removeEventListener('ph:quick-changed', load)
  }, [current])
  const toggle = () => {
    setOpen(!open)
    try {
      localStorage.setItem('ph.recentOpen', open ? '0' : '1')
    } catch {}
  }
  const link = (x: Quick) => (
    <a key={x.id} className={`nav-item quick ${x.id === current ? 'on' : ''}`} href={`#/p/${x.id}`}>
      <Icon name="page" size={14} /> <span className="ellipsis">{x.title || t('common.untitled')}</span>
    </a>
  )
  return (
    <>
      {q.starred.length > 0 && (
        <>
          <div className="tree-head"><span>{t('nav.starred')}</span></div>
          {q.starred.map(link)}
        </>
      )}
      {q.recent.length > 0 && (
        <>
          <div className="tree-head">
            <span>{t('nav.recent')}</span>
            <button className="ghost icon" aria-expanded={open} aria-label={t('nav.recent')} onClick={toggle}><Icon name={open ? 'down' : 'chevron'} size={14} /></button>
          </div>
          {open && q.recent.filter((x) => x.id !== current).slice(0, 5).map(link)}
        </>
      )}
    </>
  )
}
