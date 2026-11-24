import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode, type TextareaHTMLAttributes } from 'react'
import { t } from './i18n.ts'
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
