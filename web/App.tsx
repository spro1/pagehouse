import { Component, Suspense, lazy, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { api, toast, type PageNode, type Space, type User } from './api.ts'
import { lang, setLang, t } from './i18n.ts'
import { SearchPage } from './Search.tsx'
import { Icon } from './icons.tsx'
import { Sidebar } from './Sidebar.tsx'
// The editor (Tiptap, syntax highlighting) is most of the bundle: load it only when a page opens,
// and fetch it in the background once the app is idle so opening the first page stays instant.
export function reloadForNewRelease() {
  try {
    if (sessionStorage.getItem('ph:reloaded') === location.href) return
    sessionStorage.setItem('ph:reloaded', location.href)
  } catch {}
  location.reload()
}
const loadPageView = () =>
  import('./PageView.tsx').then(
    (m) => {
      try {
        sessionStorage.removeItem('ph:reloaded')
      } catch {}
      return m
    },
    (e) => (reloadForNewRelease(), Promise.reject(e)),
  )
const PageView = lazy(() => loadPageView().then((m) => ({ default: m.PageView })))
if ('requestIdleCallback' in window) requestIdleCallback(() => void loadPageView())
else setTimeout(() => void loadPageView(), 1500)
import { Admin, Home, LangSelect, NewSpaceModal, Palette, Settings, Trash } from './screens.tsx'
import type { Template } from './templates.ts'
import { Brand, Hosts, productName } from './ui.tsx'
import { ImportModal } from './ImportModal.tsx'
import { SpaceSettings } from './SpaceSettings.tsx'
import { ExportPage } from './ExportPage.tsx'
import { applyTheme, theme, type Theme } from './theme.ts'

type Route =
  | { name: 'home' } | { name: 'page'; id: number } | { name: 'trash'; spaceId: number }
  | { name: 'admin' } | { name: 'settings' } | { name: 'invite' | 'reset'; token: string }
  | { name: 'search'; params: URLSearchParams } | { name: 'export'; params: URLSearchParams }

function parseRoute(): Route {
  const h = location.hash.slice(1)
  let m
  if ((m = h.match(/^\/p\/(\d+)/))) return { name: 'page', id: Number(m[1]) }
  if ((m = h.match(/^\/s\/(\d+)\/trash/))) return { name: 'trash', spaceId: Number(m[1]) }
  if ((m = h.match(/^\/(invite|reset)\/([a-f0-9]+)/))) return { name: m[1] as 'invite' | 'reset', token: m[2] }
  if ((m = h.match(/^\/search(?:\?(.*))?$/))) return { name: 'search', params: new URLSearchParams(m[1] ?? '') }
  if ((m = h.match(/^\/export\?(.*)$/))) return { name: 'export', params: new URLSearchParams(m[1]) }
  if (h === '/admin' || h.startsWith('/admin/')) return { name: 'admin' }
  if (h === '/settings') return { name: 'settings' }
  return { name: 'home' }
}

function useRoute() {
  const [route, setRoute] = useState(parseRoute)
  useEffect(() => {
    const on = () => setRoute(parseRoute())
    addEventListener('hashchange', on)
    return () => removeEventListener('hashchange', on)
  }, [])
  return route
}

export function App() {
  const route = useRoute()
  const [me, setMe] = useState<User | null>()
  // The language belongs to the account: switch to it, or save the one picked before signing in.
  const signIn = (u: User) => {
    if (u.locale && u.locale !== lang) return setLang(u.locale as typeof lang)
    if (!u.locale) api('/api/me', { method: 'PATCH', json: { locale: lang } }).catch(() => {})
    if (u.theme && u.theme !== theme) applyTheme(u.theme as Theme)
    setMe(u)
  }
  useEffect(() => {
    api('/api/me').then(signIn, () => setMe(null))
    // Name or photo changed in Settings.
    const changed = (e: Event) => setMe((e as CustomEvent<User>).detail)
    addEventListener('ph:me', changed)
    return () => removeEventListener('ph:me', changed)
  }, [])
  if (me === undefined) return null
  // Invite and reset links work whether or not someone is signed in on this browser.
  const signedOut = !me || route.name === 'invite' || route.name === 'reset'
  return (
    <>
      {signedOut ? (
        <Auth route={route} onDone={(u) => ((location.hash = '#/'), signIn(u))} />
      ) : (
        me.mustChangePassword ? (
          <MustChangePassword me={me} onDone={() => setMe({ ...me, mustChangePassword: false })} />
        ) : (
          <Workspace me={me} route={route} onLogout={() => setMe(null)} />
        )
      )}
      <Hosts />
    </>
  )
}

function Auth({ route, onDone }: { route: Route; onDone: (u: User) => void }) {
  const token = route.name === 'invite' || route.name === 'reset' ? route.token : undefined
  const [status, setStatus] = useState<{ needsSetup: boolean; signupOpen: boolean; link: string | null; sso: string | null; passwordLogin: boolean; mail: boolean }>()
  const [mode, setMode] = useState<'login' | 'register' | 'reset' | 'forgot'>('login')
  const [sent, setSent] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    api(`/api/auth/status${token ? `?token=${token}` : ''}`).then((s) => {
      setStatus(s)
      setMode(s.link === 'reset' ? 'reset' : s.needsSetup || s.link === 'invite' ? 'register' : 'login')
      if (token && !s.link) setError(t('auth.linkInvalid'))
      const ssoError = new URLSearchParams(location.search).get('sso_error')
      if (ssoError) setError(t(`auth.sso.${ssoError}` as any)), history.replaceState(null, '', location.pathname)
    })
  }, [token])
  if (!status) return null
  const which = status.needsSetup ? 'setup' : mode
  return (
    <div className="auth-wrap">
      <form
        className="auth form"
        onSubmit={async (e) => {
          e.preventDefault()
          setError('')
          setBusy(true)
          const f: any = Object.fromEntries(new FormData(e.currentTarget))
          try {
            if (mode === 'forgot') return void (await api('/api/auth/forgot', { json: { email: f.email } }), setSent(true))
            if (mode === 'reset') onDone(await api('/api/auth/reset', { json: { token, password: f.password } }))
            else if (mode === 'register') onDone(await api('/api/auth/register', { json: { ...f, invite: token } }))
            else onDone(await api('/api/auth/login', { json: f }))
          } catch (err: any) {
            setError(err.message)
          } finally {
            setBusy(false)
          }
        }}
      >
        <Brand />
        <h1>{t(`auth.${which}.title`)}</h1>
        <p className="muted">{t(`auth.${which}.sub`)}</p>
        {status.sso && mode === 'login' && !status.needsSetup && (
          <>
            <a className="btn primary big sso" href="/api/auth/oidc/start">{/(로그인|sign[ -]?in|log[ -]?in)\s*$/i.test(status.sso) ? status.sso : t('auth.sso.button', { name: status.sso })}</a>
            {status.passwordLogin && <div className="divider muted small">{t('auth.sso.or')}</div>}
          </>
        )}
        {status.needsSetup && <label>{t('auth.setupToken')}<input name="setupToken" required autoComplete="off" autoFocus spellCheck={false} />
          <small className="muted">{t('auth.setupToken.hint')}</small></label>}
        {mode === 'register' && <label>{t('auth.name')}<input name="name" required autoComplete="name" autoFocus={!status.needsSetup} /></label>}
        {mode !== 'reset' && <label>{t('auth.email')}<input name="email" type="email" required autoComplete="email" autoFocus={mode === 'login'} /></label>}
        {mode === 'forgot' && sent && <div className="banner ok" role="status">{t('auth.forgot.sent')}</div>}
        {mode !== 'forgot' && <label>
          {t('auth.password')}
          <input
            name="password"
            type="password"
            minLength={mode === 'login' ? undefined : 8}
            required
            autoFocus={mode === 'reset'}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          />
        </label>}
        {error && <div className="error" role="alert">{error}</div>}
        {!(mode === 'forgot' && sent) && <button className="primary big" disabled={busy}>{t(`auth.submit.${mode}`)}</button>}
        {status.signupOpen && !status.needsSetup && !token && (
          <button type="button" className="link" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
            {mode === 'login' ? t('auth.toRegister') : t('auth.toLogin')}
          </button>
        )}
        {mode === 'login' && (status.mail
          ? <button type="button" className="link" onClick={() => (setMode('forgot'), setError(''), setSent(false))}>{t('auth.forgot.link')}</button>
          : <p className="muted small">{t('auth.forgot')}</p>)}
        {mode === 'forgot' && <button type="button" className="link" onClick={() => setMode('login')}>{t('auth.toLogin')}</button>}
      </form>
      <LangSelect />
    </div>
  )
}

/** Signed in with a temporary password from an admin: pick your own before anything else. */
function MustChangePassword({ me, onDone }: { me: User; onDone: () => void }) {
  const [error, setError] = useState('')
  return (
    <div className="auth-wrap">
      <form className="auth form" onSubmit={async (e) => {
        e.preventDefault()
        const f: any = Object.fromEntries(new FormData(e.currentTarget))
        if (f.next !== f.confirm) return setError(t('settings.mismatch'))
        try {
          await api('/api/me/password', { json: { current: f.current, next: f.next } })
          toast(t('auth.temp.done'))
          onDone()
        } catch (err: any) {
          setError(err.message)
        }
      }}>
        <Brand />
        <h1>{t('auth.temp.title')}</h1>
        <p className="muted">{t('auth.temp.sub', { name: me.name })}</p>
        <label>{t('auth.temp.current')}<input name="current" type="password" required autoComplete="current-password" autoFocus /></label>
        <label>{t('settings.new')}<input name="next" type="password" minLength={8} required autoComplete="new-password" /></label>
        <label>{t('settings.confirm')}<input name="confirm" type="password" minLength={8} required autoComplete="new-password" /></label>
        {error && <div className="error" role="alert">{error}</div>}
        <button className="primary big">{t('auth.submit.reset')}</button>
      </form>
    </div>
  )
}

function Workspace({ me, route, onLogout }: { me: User; route: Route; onLogout: () => void }) {
  const [spaces, setSpaces] = useState<Space[]>([])
  const [spaceId, setSpaceId] = useState<number | undefined>(() => {
    try {
      return Number(localStorage.getItem('ph:space')) || undefined
    } catch {
      return undefined
    }
  })
  const [pages, setPages] = useState<PageNode[]>([])
  const [palette, setPalette] = useState(false)
  const [newSpace, setNewSpace] = useState(false)
  const [navOpen, setNavOpen] = useState(false)
  // Desktop: the sidebar can be folded away; remembered per browser.
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem('ph.nav.collapsed') === '1' } catch { return false } })
  const fold = (v: boolean) => {
    setCollapsed(v)
    try { localStorage.setItem('ph.nav.collapsed', v ? '1' : '0') } catch { /* private mode: not remembered */ }
  }
  const collapsedNow = useRef(collapsed)
  collapsedNow.current = collapsed
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === '\\') (e.preventDefault(), fold(!collapsedNow.current))
    }
    addEventListener('keydown', key)
    return () => removeEventListener('keydown', key)
  }, [])
  // Sidebar width: drag its edge. At most 40% of the window, and never so wide that the page gets narrower than 720 px.
  const NAV_DEFAULT = 268
  const navMax = () => Math.max(220, Math.min(window.innerWidth * 0.4, window.innerWidth - 720))
  const [navW, setNavW] = useState(() => {
    try { return Number(localStorage.getItem('ph.nav.width')) || NAV_DEFAULT } catch { return NAV_DEFAULT }
  })
  const saveNavW = (w: number) => {
    setNavW(w)
    try { localStorage.setItem('ph.nav.width', String(w)) } catch { /* not remembered */ }
  }
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault()
    const move = (ev: PointerEvent) => setNavW(Math.round(Math.min(navMax(), Math.max(220, ev.clientX))))
    const up = (ev: PointerEvent) => {
      removeEventListener('pointermove', move)
      removeEventListener('pointerup', up)
      document.body.classList.remove('resizing')
      saveNavW(Math.round(Math.min(navMax(), Math.max(220, ev.clientX))))
    }
    document.body.classList.add('resizing')
    addEventListener('pointermove', move)
    addEventListener('pointerup', up)
  }
  // A width saved on a big screen is clamped on a smaller one, also when the window shrinks.
  const [, setWinW] = useState(window.innerWidth)
  useEffect(() => {
    const on = () => setWinW(window.innerWidth)
    addEventListener('resize', on)
    return () => removeEventListener('resize', on)
  }, [])
  const shownNavW = Math.min(navW, navMax())
  // The page area's width (the window minus the sidebar) decides whether the table of contents fits beside the text.
  const mainRef = useRef<HTMLElement>(null)
  const [narrow, setNarrow] = useState(false)
  useEffect(() => {
    const el = mainRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setNarrow(el.clientWidth < 1100))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  // Scrollbars show while scrolling only (see .scrolling in styles.css).
  const scrollTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const onMainScroll = (e: React.UIEvent<HTMLElement>) => {
    const el = e.currentTarget
    el.classList.add('scrolling')
    clearTimeout(scrollTimer.current)
    scrollTimer.current = setTimeout(() => el.classList.remove('scrolling'), 900)
  }
  const [spaceSettings, setSpaceSettings] = useState(false)
  const reloadSpaces = () =>
    api('/api/spaces').then((s: Space[]) => {
      setSpaces(s)
      setSpaceId((cur) => (s.some((x) => x.id === cur) ? cur : s[0]?.id))
    })
  const [importing, setImporting] = useState<{ parentId: number | null; parentTitle?: string } | null>(null)
  useEffect(() => {
    const open = (e: Event) => setImporting((e as CustomEvent).detail ?? { parentId: null })
    addEventListener('ph:import', open)
    return () => removeEventListener('ph:import', open)
  }, [])

  useEffect(() => {
    api('/api/spaces').then((s: Space[]) => {
      setSpaces(s)
      setSpaceId((cur) => (s.some((x) => x.id === cur) ? cur : s[0]?.id))
    })
  }, [])
  // Only the newest request may fill the tree: a big space's slow response must not overwrite the space switched to since.
  const latestTree = useRef(0)
  const loadPages = useCallback(() => {
    if (!spaceId) return
    const n = ++latestTree.current
    api(`/api/spaces/${spaceId}/pages`).then((ps) => n === latestTree.current && setPages(ps))
  }, [spaceId])
  useEffect(() => {
    addEventListener('ph:tree-changed', loadPages)
    return () => removeEventListener('ph:tree-changed', loadPages)
  }, [loadPages])
  useEffect(() => {
    try {
      if (spaceId) localStorage.setItem('ph:space', String(spaceId))
    } catch {}
  }, [spaceId])
  // Opening a page from another space (search, recent, link) switches the sidebar to it.
  useEffect(() => {
    if (route.name === 'page') api(`/api/pages/${route.id}`).then((p) => setSpaceId(p.spaceId), () => {})
    if (route.name === 'trash') setSpaceId(route.spaceId)
    setNavOpen(false)
  }, [route])
  // Teammates add, move and restrict pages too; refresh the tree on each navigation so it doesn't go stale.
  useEffect(() => loadPages(), [route, loadPages])
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') (e.preventDefault(), setPalette((v) => !v))
    }
    addEventListener('keydown', k)
    return () => removeEventListener('keydown', k)
  }, [])

  async function createPage(parentId: number | null, tpl?: Template) {
    if (!spaceId) return toast(t('home.needSpace'))
    try {
      const p = await api('/api/pages', { json: { spaceId, parentId, title: tpl?.title() ?? t('common.untitled'), doc: tpl?.doc() } })
      setPages((ps) => [...ps, p])
      location.hash = `#/p/${p.id}`
    } catch (e: any) {
      toast(e.message)
    }
  }

  const current = route.name === 'page' ? route.id : null
  let main
  if (route.name === 'page')
    main = (
      <PageView
        id={route.id}
        me={me}
        onTitle={(title) => setPages((ps) => ps.map((p) => (p.id === route.id ? { ...p, title } : p)))}
        onDeleted={() => ((location.hash = '#/'), loadPages())}
      />
    )
  else if (route.name === 'trash') main = <Trash spaceId={route.spaceId} onRestored={loadPages} />
  else if (route.name === 'admin' && me.role === 'admin') main = <Admin me={me} />
  else if (route.name === 'settings') main = <Settings me={me} />
  else if (route.name === 'search') main = <SearchPage key={route.params.toString()} initial={route.params} />
  else if (route.name === 'export') main = <ExportPage key={route.params.toString()} params={route.params} />
  else main = <Home me={me} spaceId={spaceId} onCreate={(tpl) => createPage(null, tpl)} />

  return (
    <div className={`layout ${navOpen ? 'nav-open' : ''} ${collapsed ? 'nav-collapsed' : ''} ${narrow ? 'narrow-page' : ''}`} style={{ '--nav-w': `${shownNavW}px` } as React.CSSProperties}>
      <button className="nav-toggle ghost icon" aria-label={t('nav.menu')} aria-expanded={navOpen} onClick={() => setNavOpen(true)}>
        <Icon name="menu" size={18} />
      </button>
      {collapsed && (
        <button className="nav-expand ghost icon" title={t('nav.expand')} aria-label={t('nav.expand')} onClick={() => fold(false)}>
          <Icon name="sidebar" size={18} />
        </button>
      )}
      {navOpen && <div className="nav-backdrop" onClick={() => setNavOpen(false)} />}
      <Sidebar
        me={me}
        spaces={spaces}
        spaceId={spaceId}
        pages={pages}
        current={current}
        route={route.name}
        onSpace={(id) => ((location.hash = '#/'), setSpaceId(id))}
        onNewSpace={() => setNewSpace(true)}
        onNewPage={(parent) => createPage(parent)}
        onSearch={() => (setNavOpen(false), setPalette(true))}
        onMoved={loadPages}
        onLogout={() => api<{ redirect?: string | null }>('/api/auth/logout', { method: 'POST' }).then((r) => (r.redirect ? location.assign(r.redirect) : onLogout()))}
        onClose={() => setNavOpen(false)}
        onSpaceSettings={() => setSpaceSettings(true)}
        onCollapse={() => fold(true)}
      />
      {!collapsed && (
        <div className="nav-resize" role="separator" aria-orientation="vertical" aria-label={t('nav.resize')} title={t('nav.resize')}
          aria-valuenow={shownNavW} aria-valuemin={220} aria-valuemax={Math.round(navMax())} tabIndex={0}
          onPointerDown={startResize} onDoubleClick={() => saveNavW(NAV_DEFAULT)}
          onKeyDown={(e) => {
            const step = e.key === 'ArrowLeft' ? -16 : e.key === 'ArrowRight' ? 16 : 0
            if (step) (e.preventDefault(), saveNavW(Math.min(navMax(), Math.max(220, shownNavW + step))))
          }} />
      )}
      <main ref={mainRef} onScroll={onMainScroll}>
        <Crash key={location.hash}><Suspense fallback={<div className="loading" />}>{main}</Suspense></Crash>
      </main>
      {palette && <Palette onClose={() => setPalette(false)} />}
      {spaceSettings && spaceId && (
        <SpaceSettings spaceId={spaceId} me={me} onClose={() => setSpaceSettings(false)} onSaved={() => (reloadSpaces(), loadPages())} />
      )}
      {importing && spaceId && (
        <ImportModal
          spaceId={spaceId}
          spaceName={spaces.find((s) => s.id === spaceId)?.name ?? ''}
          parentId={importing.parentId}
          parentTitle={importing.parentTitle}
          onClose={() => setImporting(null)}
          onDone={loadPages}
        />
      )}
      {newSpace && (
        <NewSpaceModal
          onClose={() => setNewSpace(false)}
          onCreated={(s) => {
            setSpaces((ss) => [...ss, s].sort((a, b) => a.name.localeCompare(b.name)))
            setSpaceId(s.id)
            setNewSpace(false)
            location.hash = '#/'
          }}
        />
      )}
    </div>
  )
}

/** Something broke while drawing a screen: show that instead of a blank page, keep the sidebar, and let the person
 *  reload. Moving to another page (the key changes) tries again. */
class Crash extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  componentDidCatch(error: Error) {
    console.error(error)
  }
  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="screen">
        <div className="empty-box">
          <p><b>{t('crash.title')}</b></p>
          <p className="muted small">{t('crash.body', { name: productName() })}</p>
          <button className="primary" onClick={() => location.reload()}>{t('crash.reload')}</button>
        </div>
      </div>
    )
  }
}
