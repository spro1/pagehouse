import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useEditorState, type Editor } from '@tiptap/react'
import { t, type Key } from '../i18n.ts'
import { SLASH_ITEMS } from './extensions.tsx'
import { Icon } from '../icons.tsx'

// Colors chosen to read on both the light and the dark theme. Backgrounds are translucent for the same reason.
export const TEXT_COLORS: [Key, string][] = [
  ['color.gray', '#6b7280'], ['color.red', '#dc2626'], ['color.orange', '#ea580c'], ['color.yellow', '#ca8a04'],
  ['color.green', '#16a34a'], ['color.blue', '#2563eb'], ['color.purple', '#9333ea'], ['color.pink', '#db2777'],
]
export const BG_COLORS: [Key, string][] = [
  ['color.gray', 'rgba(107, 114, 128, 0.25)'], ['color.red', 'rgba(239, 68, 68, 0.25)'], ['color.orange', 'rgba(249, 115, 22, 0.25)'],
  ['color.yellow', 'rgba(250, 204, 21, 0.35)'], ['color.green', 'rgba(34, 197, 94, 0.25)'], ['color.blue', 'rgba(59, 130, 246, 0.25)'],
  ['color.purple', 'rgba(168, 85, 247, 0.25)'], ['color.pink', 'rgba(236, 72, 153, 0.25)'],
]

/** A button that opens a small panel under it; clicking outside closes it. */
function Popover({ label, tip, children, open, setOpen }: { label: ReactNode; tip: string; children: ReactNode; open: boolean; setOpen: (o: boolean) => void }) {
  const wrap = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => !wrap.current?.contains(e.target as Node) && setOpen(false)
    addEventListener('mousedown', close)
    return () => removeEventListener('mousedown', close)
  }, [open])
  return (
    <div className="toolbar-pop" ref={wrap}>
      <button type="button" title={tip} aria-label={tip} aria-haspopup="dialog" aria-expanded={open} className={open ? 'on' : ''}
        onMouseDown={(e) => (e.preventDefault(), setOpen(!open))}>
        {label}
      </button>
      {open && <div className="dropdown pop-panel" role="dialog" aria-label={tip}>{children}</div>}
    </div>
  )
}

/** A fixed toolbar above the page, like Confluence's: the formatting the selection menu has, the block types, and
 *  everything the "/" menu can insert, so nothing needs a shortcut or a slash to find. */
export function Toolbar({ editor }: { editor: Editor }) {
  const st = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      block: e.isActive('heading', { level: 1 }) ? 'h1' : e.isActive('heading', { level: 2 }) ? 'h2' : e.isActive('heading', { level: 3 }) ? 'h3' : 'p',
      bold: e.isActive('bold'), italic: e.isActive('italic'), underline: e.isActive('underline'), strike: e.isActive('strike'),
      code: e.isActive('code'), link: e.isActive('link'),
      color: (e.getAttributes('textStyle').color as string | undefined) ?? null,
      bg: (e.getAttributes('highlight').color as string | undefined) ?? (e.isActive('highlight') ? 'default' : null),
      align: e.isActive({ textAlign: 'center' }) ? 'center' : e.isActive({ textAlign: 'right' }) ? 'right' : 'left',
      bullet: e.isActive('bulletList'), ordered: e.isActive('orderedList'), task: e.isActive('taskList'),
      undo: e.can().undo(), redo: e.can().redo(),
    }),
  })
  const [insert, setInsert] = useState(false)
  const [colors, setColors] = useState(false)
  const [linking, setLinking] = useState(false)
  const [href, setHref] = useState('')
  const insertWrap = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!insert) return
    const close = (e: MouseEvent) => !insertWrap.current?.contains(e.target as Node) && setInsert(false)
    addEventListener('mousedown', close)
    return () => removeEventListener('mousedown', close)
  }, [insert])
  const c = () => editor.chain().focus()
  const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+'
  // mousedown + preventDefault keeps the editor's selection, so the button acts on what was selected.
  const btn = (label: ReactNode, tip: string, on: boolean, run: () => void, disabled = false) => (
    <button key={tip} type="button" title={tip} aria-label={tip} aria-pressed={on} disabled={disabled} className={on ? 'on' : ''}
      onMouseDown={(e) => (e.preventDefault(), run())}>
      {label}
    </button>
  )
  const swatch = (name: Key, value: string | null, on: boolean, run: () => void, kind: 'text' | 'bg') => (
    <button key={`${kind}${value}`} type="button" className={`swatch ${on ? 'on' : ''}`} title={t(name)} aria-label={`${t(kind === 'text' ? 'color.text' : 'color.bg')}: ${t(name)}`}
      aria-pressed={on} onMouseDown={(e) => (e.preventDefault(), run(), setColors(false))}>
      <span style={kind === 'text' ? { color: value ?? undefined } : { background: value ?? undefined }}>{kind === 'text' ? 'A' : ''}</span>
    </button>
  )
  const applyLink = () => {
    const v = href.trim()
    if (v) c().extendMarkRange('link').setLink({ href: /^[a-z]+:|^[/#]/i.test(v) ? v : `https://${v}` }).run()
    else c().extendMarkRange('link').unsetLink().run()
    setLinking(false)
  }
  const here = () => ({ from: editor.state.selection.from, to: editor.state.selection.from })
  return (
    <div className="toolbar" role="toolbar" aria-label={t('toolbar.label')}>
      {btn(<Icon name="undo" size={15} />, `${t('toolbar.undo')} (${mod}Z)`, false, () => c().undo().run(), !st.undo)}
      {btn(<Icon name="redo" size={15} />, `${t('toolbar.redo')} (${mod}⇧Z)`, false, () => c().redo().run(), !st.redo)}
      <span className="sep" />
      <select value={st.block} aria-label={t('toolbar.block')} onChange={(e) => {
        const v = e.target.value
        v === 'p' ? c().setParagraph().run() : c().setHeading({ level: Number(v[1]) as 1 | 2 | 3 }).run()
      }}>
        <option value="p">{t('slash.text')}</option>
        <option value="h1">{t('slash.h1')}</option>
        <option value="h2">{t('slash.h2')}</option>
        <option value="h3">{t('slash.h3')}</option>
      </select>
      <span className="sep" />
      {btn(<b>B</b>, `${t('fmt.bold')} (${mod}B)`, st.bold, () => c().toggleBold().run())}
      {btn(<i>I</i>, `${t('fmt.italic')} (${mod}I)`, st.italic, () => c().toggleItalic().run())}
      {btn(<u>U</u>, `${t('fmt.underline')} (${mod}U)`, st.underline, () => c().toggleUnderline().run())}
      {btn(<s>S</s>, t('fmt.strike'), st.strike, () => c().toggleStrike().run())}
      {btn('</>', t('fmt.code'), st.code, () => c().toggleCode().run())}
      <Popover open={colors} setOpen={setColors} tip={t('color.title')}
        label={<span className="color-btn"><span>A</span><i style={{ background: st.color ?? 'currentColor' }} /></span>}>
        <div className="pop-label">{t('color.text')}</div>
        <div className="swatches">
          {swatch('color.default', null, !st.color, () => c().unsetColor().run(), 'text')}
          {TEXT_COLORS.map(([n, v]) => swatch(n, v, st.color === v, () => c().setColor(v).run(), 'text'))}
        </div>
        <div className="pop-label">{t('color.bg')}</div>
        <div className="swatches">
          {swatch('color.none', null, !st.bg, () => c().unsetHighlight().run(), 'bg')}
          {BG_COLORS.map(([n, v]) => swatch(n, v, st.bg === v, () => c().setHighlight({ color: v }).run(), 'bg'))}
        </div>
      </Popover>
      <Popover open={linking} setOpen={(o) => (setHref(o ? (editor.getAttributes('link').href ?? '') : ''), setLinking(o))} tip={t('fmt.link')}
        label={<span className={st.link ? 'on-text' : ''}><Icon name="link" size={15} /></span>}>
        <form className="link-edit" onSubmit={(e) => (e.preventDefault(), applyLink())}>
          <input autoFocus value={href} placeholder={t('fmt.linkPlaceholder')} aria-label={t('fmt.link')} onChange={(e) => setHref(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && (setLinking(false), editor.commands.focus())} />
          <button type="submit" className="primary">{t('common.save')}</button>
          {st.link && <button type="button" onClick={() => (c().extendMarkRange('link').unsetLink().run(), setLinking(false))}>{t('fmt.unlink')}</button>}
        </form>
      </Popover>
      {btn(<span className="clear-fmt">T<sub>×</sub></span>, t('fmt.clear'), false, () => c().unsetAllMarks().unsetTextAlign().run())}
      <span className="sep" />
      {(['left', 'center', 'right'] as const).map((a) =>
        btn(<Icon name={`align-${a}` as 'align-left'} size={15} />, t(`align.${a}`), st.align === a, () => c().setTextAlign(a).run()))}
      <span className="sep" />
      {btn('•', t('slash.bullet'), st.bullet, () => c().toggleBulletList().run())}
      {btn('1.', t('slash.ordered'), st.ordered, () => c().toggleOrderedList().run())}
      {btn('☑', t('slash.todo'), st.task, () => c().toggleTaskList().run())}
      <span className="sep" />
      {/* The most used inserts get their own button; the rest are under "Insert". */}
      {['▦', '📎', '</>'].map((icon) => {
        const item = SLASH_ITEMS.find((i) => i.icon === icon)!
        return btn(icon === '</>' ? '{ }' : icon, item.title, false, () => item.run(editor, here()))
      })}
      <div className="toolbar-insert" ref={insertWrap}>
        <button type="button" aria-haspopup="menu" aria-expanded={insert} onMouseDown={(e) => (e.preventDefault(), setInsert(!insert))}>
          + {t('toolbar.insert')}
        </button>
        {insert && (
          <div className="dropdown" role="menu">
            {SLASH_ITEMS.map((i) => (
              <button key={i.title} role="menuitem" type="button" onMouseDown={(e) => (e.preventDefault(), setInsert(false), i.run(editor, here()))}>
                <span className="slash-icon">{i.icon}</span>
                <span className="grow ellipsis">{i.title}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
