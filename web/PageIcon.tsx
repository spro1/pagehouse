import { useEffect, useRef, useState } from 'react'
import { api, toast } from './api.ts'
import { t } from './i18n.ts'

// A starter set; any other emoji can be typed or pasted (the OS emoji picker works in the box).
const EMOJIS = ('📄 📝 📌 📎 📚 📖 📊 📈 📅 🗓️ ✅ ☑️ ❗ ❓ 💡 🔥 ⭐ 🚀 🎯 🏁 🛠️ 🔧 ⚙️ 🧪 🐛 🔒 🔑 🛡️ ☁️ 🖥️ 💻 📱 🌐 🗄️ 📦 🧩 ' +
  '👋 🙌 👥 🤝 💬 📣 🎉 🏆 💰 🧭 🗺️ 🏠 🏢 ✈️ 🧠 ❤️ 🟢 🟡 🔴 🔵').split(' ')

/** The emoji before a page title. Editors add, change or remove it; readers just see it. */
export function PageIcon({ pageId, initial, canEdit }: { pageId: number; initial: string | null; canEdit: boolean }) {
  const [icon, setIcon] = useState(initial)
  const [open, setOpen] = useState(false)
  const [typed, setTyped] = useState('')
  const wrap = useRef<HTMLDivElement>(null)
  useEffect(() => setIcon(initial), [pageId])
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => !wrap.current?.contains(e.target as Node) && setOpen(false)
    addEventListener('mousedown', close)
    return () => removeEventListener('mousedown', close)
  }, [open])
  const save = (next: string | null) =>
    api<{ icon: string | null }>(`/api/pages/${pageId}/icon`, { method: 'PUT', json: { icon: next } }).then((r) => {
      setIcon(r.icon)
      setOpen(false)
      setTyped('')
      dispatchEvent(new CustomEvent('ph:tree-changed'))
      dispatchEvent(new CustomEvent('ph:quick-changed'))
    }, (e) => toast(e.message))
  if (!icon && !canEdit) return null
  return (
    <div className={`page-icon ${icon ? 'has' : ''}`} ref={wrap}>
      {icon ? (
        <button className="page-icon-btn" disabled={!canEdit} aria-label={t('icon.change')} title={canEdit ? t('icon.change') : undefined} onClick={() => setOpen(!open)}>{icon}</button>
      ) : (
        <button className="ghost page-icon-add" onClick={() => setOpen(!open)}>☺ {t('icon.add')}</button>
      )}
      {open && (
        <div className="emoji-pop" role="dialog" aria-label={t('icon.pick')}>
          <div className="emoji-grid">
            {EMOJIS.map((e) => <button key={e} className="ghost" aria-label={e} onClick={() => save(e)}>{e}</button>)}
          </div>
          <form className="emoji-foot" onSubmit={(e) => (e.preventDefault(), typed.trim() && save(typed.trim()))}>
            <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={t('icon.type')} aria-label={t('icon.type')} />
            {icon && <button type="button" onClick={() => save(null)}>{t('icon.remove')}</button>}
          </form>
        </div>
      )}
    </div>
  )
}
