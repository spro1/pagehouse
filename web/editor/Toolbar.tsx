import { useEffect, useRef, useState } from 'react'
import { useEditorState, type Editor } from '@tiptap/react'
import { t } from '../i18n.ts'
import { SLASH_ITEMS } from './extensions.tsx'
import { Icon } from '../icons.tsx'

/** A fixed toolbar above the page, like Confluence's: the formatting the selection menu has, the block types, and
 *  everything the "/" menu can insert, so nothing needs a shortcut or a slash to find. */
export function Toolbar({ editor }: { editor: Editor }) {
  const st = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      block: e.isActive('heading', { level: 1 }) ? 'h1' : e.isActive('heading', { level: 2 }) ? 'h2' : e.isActive('heading', { level: 3 }) ? 'h3' : 'p',
      bold: e.isActive('bold'), italic: e.isActive('italic'), strike: e.isActive('strike'), code: e.isActive('code'), highlight: e.isActive('highlight'),
      bullet: e.isActive('bulletList'), ordered: e.isActive('orderedList'), task: e.isActive('taskList'),
      undo: e.can().undo(), redo: e.can().redo(),
    }),
  })
  const [insert, setInsert] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!insert) return
    const close = (e: MouseEvent) => !wrap.current?.contains(e.target as Node) && setInsert(false)
    addEventListener('mousedown', close)
    return () => removeEventListener('mousedown', close)
  }, [insert])
  const c = () => editor.chain().focus()
  const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+'
  // mousedown + preventDefault keeps the editor's selection, so the button acts on what was selected.
  const btn = (label: React.ReactNode, tip: string, on: boolean, run: () => void, disabled = false) => (
    <button key={tip} type="button" title={tip} aria-label={tip} aria-pressed={on} disabled={disabled} className={on ? 'on' : ''}
      onMouseDown={(e) => (e.preventDefault(), run())}>
      {label}
    </button>
  )
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
      {btn(<s>S</s>, t('fmt.strike'), st.strike, () => c().toggleStrike().run())}
      {btn('</>', t('fmt.code'), st.code, () => c().toggleCode().run())}
      {btn('🖍', t('fmt.highlight'), st.highlight, () => c().toggleHighlight().run())}
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
      <div className="toolbar-insert" ref={wrap}>
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
