import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode, type TextareaHTMLAttributes } from 'react'
import { t } from './i18n.ts'
import { brandCss } from '../server/html.ts'
import { Icon } from './icons.tsx'

type ModalProps = {
  title: string
  onClose: () => void
  children: ReactNode
  /** Buttons (and an optional note) pinned to the bottom bar. */
  footer?: ReactNode
  /** When set, body and footer become one form so Enter submits it. */
  onSubmit?: (e: FormEvent<HTMLFormElement>) => void
  size?: 'sm' | 'wide'
}

export function Modal({ title, onClose, children, footer, onSubmit, size }: ModalProps) {
  const box = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && close.current()
    addEventListener('keydown', esc)
    // Land keyboard focus inside the dialog: the first field, otherwise the main button.
    const first = box.current?.querySelector<HTMLElement>('.modal-body input:not([type=radio]), .modal-body textarea, .modal-body select')
      ?? box.current?.querySelector<HTMLElement>('.modal-foot button.primary')
    first?.focus()
    return () => (removeEventListener('keydown', esc), prev?.focus())
  }, [])
  const inner = (
    <>
      <div className="modal-body">{children}</div>
      {footer && <div className="modal-foot">{footer}</div>}
    </>
  )
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={box} className={`modal ${size ?? ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button type="button" className="ghost icon" aria-label={t('common.close')} onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>
        {onSubmit ? (
          <form onSubmit={onSubmit} style={{ display: 'contents' }}>
            {inner}
          </form>
        ) : (
          inner
        )}
      </div>
    </div>
  )
}

/** Textarea that grows with its content instead of showing a resize handle. */
export const AutoTextarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { maxRows?: number }>(function AutoTextarea(props, outer) {
  const { maxRows = 12, ...rest } = props
  const ref = useRef<HTMLTextAreaElement>(null)
  useImperativeHandle(outer, () => ref.current!)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    const line = parseFloat(getComputedStyle(el).lineHeight) || 22
    const max = line * maxRows + 18
    el.style.height = `${Math.min(el.scrollHeight + 2, max)}px`
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden'
  }, [props.value, maxRows])
  return <textarea ref={ref} {...rest} />
})

// Promise-based replacement for window.confirm, rendered by <Hosts/>.
type Ask = { title: string; body?: string; ok: string; danger?: boolean; resolve: (v: boolean) => void }
let showAsk: (a: Ask) => void = () => {}
export const confirmDialog = (o: Omit<Ask, 'resolve'>) => new Promise<boolean>((resolve) => showAsk({ ...o, resolve }))

type ToastMsg = { text: string; action?: { label: string; run: () => void }; id: number }
let showToast: (m: ToastMsg) => void = () => {}
export const toast = (text: string, action?: ToastMsg['action']) => showToast({ text, action, id: Date.now() })

/** Copies text and says so. The Clipboard API only exists on HTTPS or localhost; on a plain-HTTP address
 *  (http://10.0.0.5:3000, common on internal networks) fall back to the older copy command. */
export async function copyText(text: string, done: string) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return toast(done)
    }
  } catch {}
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.cssText = 'position:fixed;top:0;left:0;opacity:0'
  // The copy command copies the focused selection, so focus the scratch field, then give focus back
  // (inside the editor the cursor stays where it was).
  const back = document.activeElement as HTMLElement | null
  document.body.append(area)
  area.focus()
  area.select()
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {}
  area.remove()
  back?.focus?.({ preventScroll: true })
  toast(ok ? done : t('common.copyFailed'))
}

export function Hosts() {
  const [ask, setAsk] = useState<Ask | null>(null)
  const [msg, setMsg] = useState<ToastMsg | null>(null)
  useEffect(() => {
    showAsk = setAsk
    let timer = 0
    showToast = (m) => {
      setMsg(m)
      clearTimeout(timer)
      timer = window.setTimeout(() => setMsg(null), m.action ? 6000 : 2600)
    }
  }, [])
  const answer = (v: boolean) => (ask?.resolve(v), setAsk(null))
  return (
    <>
      {ask && (
        <Modal
          title={ask.title}
          onClose={() => answer(false)}
          size="sm"
          footer={
            <>
              <span className="grow" />
              <button onClick={() => answer(false)}>{t('common.cancel')}</button>
              <button className={ask.danger ? 'danger-fill' : 'primary'} onClick={() => answer(true)}>{ask.ok}</button>
            </>
          }
        >
          <p className="muted" style={{ margin: 0 }}>{ask.body}</p>
        </Modal>
      )}
      {msg && (
        <div className="toast" role="status" key={msg.id}>
          <span>{msg.text}</span>
          {msg.action && (
            <button className="toast-action" onClick={() => (msg.action!.run(), setMsg(null))}>
              {msg.action.label}
            </button>
          )}
        </div>
      )}
    </>
  )
}

// Bumped when you change your own photo, so the new one shows at once instead of after the cache expires.
let avatarBust = 0
export const bumpAvatar = () => (avatarBust = Date.now())

/** A person's photo, or their initial when they have none (or it fails to load). */
export function Avatar({ id, name, size }: { id?: number | null; name: string; size?: 'lg' }) {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [id])
  const initial = (name || '?').slice(0, 1)
  return (
    <span className={`avatar${size ? ` ${size}` : ''}`}>
      {id && !failed ? <img src={`/api/users/${id}/avatar${avatarBust ? `?v=${avatarBust}` : ''}`} alt="" onError={() => setFailed(true)} /> : initial}
    </span>
  )
}

// Name and logo an admin set (Admin → Branding). The tab title and favicon follow them.
export type Branding = { name: string | null; logo: string | null; accent: string | null }
let branding: Branding = { name: null, logo: null, accent: null }
const iconLink = document.querySelector<HTMLLinkElement>('link[rel=icon]')
const defaultIcon = iconLink?.dataset.default ?? iconLink?.href ?? ''
/** The name to show in text: the admin's choice, else the product's. */
export const productName = () => branding.name || t('app.name')
export const logoUrl = (hash: string) => `/api/auth/branding/logo?v=${hash}`
export function applyBranding(b: Branding) {
  branding = b
  document.title = b.name || t('app.name')
  const icon = document.querySelector<HTMLLinkElement>('link[rel=icon]')
  if (icon) icon.href = b.logo ? logoUrl(b.logo) : defaultIcon
  // The server already put this in the page; keep it in step when an admin changes the color.
  const css = document.getElementById('brand-css') ?? document.head.appendChild(Object.assign(document.createElement('style'), { id: 'brand-css' }))
  css.textContent = b.accent ? brandCss(b.accent) : ''
  dispatchEvent(new Event('ph:branding'))
}
fetch('/api/auth/branding').then((r) => (r.ok ? r.json() : Promise.reject())).then(applyBranding, () => {})

export function useBranding() {
  const [b, setB] = useState(branding)
  useEffect(() => {
    const on = () => setB(branding)
    addEventListener('ph:branding', on)
    return () => removeEventListener('ph:branding', on)
  }, [])
  return b
}

/** Logo and product name, as on the sign-in screens. */
export function Brand() {
  const b = useBranding()
  return (
    <div className="brand">
      {b.logo ? <img className="logo img" src={logoUrl(b.logo)} alt="" /> : <span className="logo">P</span>} {b.name || t('app.name')}
    </div>
  )
}
