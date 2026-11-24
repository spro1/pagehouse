import { useEffect, useRef, useState } from 'react'
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react'
import { BubbleMenu } from '@tiptap/react/menus'
import { CellSelection } from '@tiptap/pm/tables'
import { ApiError, api, ago, fullDate, listPeople, listPrincipals, pkey, toast, type Person, type Principal, type User } from './api.ts'
import { PrincipalLabel } from './SpaceSettings.tsx'
import { t } from './i18n.ts'
import { Icon } from './icons.tsx'
import { toMarkdown } from '../server/markdown.ts'
import { CODE_LANGUAGES, extensions, type Live } from './editor/extensions.tsx'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { ySyncPluginKey } from '@tiptap/y-tiptap'
import { AutoTextarea, Modal, confirmDialog } from './ui.tsx'
import { diffLines, type DiffLine } from './diff.ts'

// Unsaved edits are mirrored to this browser until the server confirms the save,
// so a dropped connection, a closed tab or an edit conflict never loses typing.
type Draft = { base: number; title: string; doc: unknown; at: number }
const draftKey = (id: number) => `ph:draft:${id}`
function readDraft(id: number): Draft | null {
  try {
    return JSON.parse(localStorage.getItem(draftKey(id)) ?? 'null')
  } catch {
    return null
  }
}
function writeDraft(id: number, d: Draft) {
  try {
    localStorage.setItem(draftKey(id), JSON.stringify(d))
  } catch {}
}
function clearDraft(id: number) {
  try {
    localStorage.removeItem(draftKey(id))
  } catch {}
}

type Page = {
  id: number; title: string; doc: any; version: number; updatedAt: string; updatedBy: string
  createdAt: string; createdBy: string; space: { id: number; name: string }; ancestors: { id: number; title: string }[]
  access: 'edit' | 'view'; restricted: boolean; watching: boolean
}

export function PageView({ id, me, onTitle, onDeleted }: { id: number; me: User; onTitle: (t: string) => void; onDeleted: () => void }) {
  const [page, setPage] = useState<Page | null>()
  // The page's live editing room; null when it can't be reached (an old proxy without WebSockets, say):
  // then the page saves the classic way, with a version check.
  const [live, setLive] = useState<Live | null>()
  useEffect(() => {
    setPage(undefined)
    setLive(undefined)
    api(`/api/pages/${id}`).then(setPage, () => setPage(null))
    const doc = new Y.Doc()
    const provider = new WebsocketProvider(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/collab`, String(id), doc, { disableBc: true })
    let settled = false
    const giveUp = setTimeout(() => !settled && ((settled = true), provider.destroy(), setLive(null)), 4000)
    // The page was replaced outside the room while we were away: our copy can't be merged; reload instead
    // (anything typed meanwhile is in the local draft, offered after the reload).
    provider.on('connection-close', (e: CloseEvent | null) => e?.code === 4409 && (provider.destroy(), location.reload()))
    provider.once('sync', () => {
      provider.params.epoch = String(doc.getMap('meta').get('epoch') ?? '')
      if (settled) return
      settled = true
      clearTimeout(giveUp)
      setLive({ doc, provider, user: { name: me.name, color: `hsl(${(me.id * 137) % 360} 70% 45%)` } })
    })
    return () => (clearTimeout(giveUp), provider.destroy(), doc.destroy())
  }, [id])
  if (page === null)
    return (
      <div className="empty-state">
        <h2>{t('page.notFound')}</h2>
        <p className="muted">{t('page.notFound.sub')}</p>
        <a className="btn" href="#/">{t('page.goHome')}</a>
      </div>
    )
  return page && live !== undefined
    ? <LoadedPage key={page.id} page={page} live={live} me={me} onTitle={onTitle} onDeleted={onDeleted} />
    : <div className="loading" />
}

function LoadedPage({ page, live, me, onTitle, onDeleted }: { page: Page; live: Live | null; me: User; onTitle: (t: string) => void; onDeleted: () => void }) {
  const [title, setTitle] = useState(page.title)
  const [status, setStatus] = useState<{ text: string; kind?: 'error' | 'busy' }>({ text: '' })
  const [meta, setMeta] = useState({ updatedAt: page.updatedAt, updatedBy: page.updatedBy })
  const [panel, setPanel] = useState<'history' | null>(null)
  const [menu, setMenu] = useState(false)
  const [sharing, setSharing] = useState(false)
  const [savingTpl, setSavingTpl] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!menu) return
    const close = (e: MouseEvent) => !menuRef.current?.contains(e.target as Node) && setMenu(false)
    addEventListener('mousedown', close)
    return () => removeEventListener('mousedown', close)
  }, [menu])
  const [restricted, setRestricted] = useState(page.restricted)
  const [watching, setWatching] = useState(page.watching)
  const canEdit = page.access === 'edit'
  const fileInput = useRef<HTMLInputElement>(null)
  const s = useRef({ version: page.version, title: page.title, dirty: false, saving: false, conflict: false, checkpoint: false, timer: 0 })
  // A draft left from an earlier visit that differs from what the server has.
  const [draft, setDraft] = useState<Draft | null>(() => {
    const d = canEdit ? readDraft(page.id) : null
    if (!d) return null
    if (JSON.stringify(d.doc) === JSON.stringify(page.doc) && d.title === page.title) return clearDraft(page.id), null
    return d
  })

  const editor = useEditor({
    extensions: extensions(live ?? undefined),
    ...(!live && { content: page.doc }),
    editable: canEdit,
    // In a live room, edits arriving from others are not ours to save or keep as a draft.
    onUpdate: ({ transaction }) => !transaction.getMeta(ySyncPluginKey)?.isChangeOrigin && schedule(),
    editorProps: {
      handlePaste: (_v, e) => takeFiles(e.clipboardData?.files),
      // Dropped files go where they were dropped, not where the cursor happened to be.
      handleDrop: (view, e) => {
        const ev = e as DragEvent
        if (!ev.dataTransfer?.files?.length) return false
        ev.preventDefault()
        return takeFiles(ev.dataTransfer.files, view.posAtCoords({ left: ev.clientX, top: ev.clientY })?.pos)
      },
      // Links can't be followed by a plain click while editing (that places the cursor):
      // ⌘/Ctrl-click opens them, and a plain click does when the page is read-only.
      handleClick: (view, _pos, e) => {
        const a = (e.target as HTMLElement).closest('a[href]') as HTMLAnchorElement | null
        if (!a || !(e.metaKey || e.ctrlKey || !view.editable)) return false
        window.open(a.href, '_blank', 'noopener')
        return true
      },
    },
  })

  // Uploads run one after another and each lands right after the previous one. The cursor always ends up
  // *after* the inserted content: leaving an image selected meant the next keystroke replaced (deleted) it.
  async function uploadAll(files: File[], at?: number) {
    if (!editor) return
    let pos = at ?? editor.state.selection.to
    for (const file of files) {
      setStatus({ text: t('page.uploading', { name: file.name }), kind: 'busy' })
      const form = new FormData()
      form.append('file', file)
      try {
        const a = await api(`/api/pages/${page.id}/attachments`, { body: form })
        pos = Math.min(pos, editor.state.doc.content.size)
        const content = /^image\/(png|jpeg|gif|webp)$/.test(a.mime)
          ? [{ type: 'image', attrs: { src: a.url, alt: a.name, title: a.name } }, { type: 'paragraph' }]
          : [{ type: 'text', text: `📎 ${a.name}`, marks: [{ type: 'link', attrs: { href: a.url } }] }, { type: 'text', text: ' ' }]
        editor.chain().insertContentAt(pos, content).focus().run()
        pos = editor.state.selection.to
      } catch (e: any) {
        setStatus({ text: '' })
        toast(t('page.uploadFailed', { msg: `${file.name}: ${e.message}` }))
      }
    }
  }
  function takeFiles(files?: FileList | null, at?: number) {
    if (!files?.length) return false
    void uploadAll([...files], at)
    return true
  }
  useEffect(() => {
    const dom = editor?.view.dom
    const pick = () => fileInput.current?.click()
    dom?.addEventListener('ph:pick-file', pick)
    return () => dom?.removeEventListener('ph:pick-file', pick)
  }, [editor])

  function schedule() {
    s.current.dirty = true
    if (editor) writeDraft(page.id, { base: s.current.version, title: s.current.title, doc: editor.getJSON(), at: Date.now() })
    if (!s.current.conflict) setStatus({ text: t('page.saving'), kind: 'busy' })
    if (live) {
      // The room saves for us; a title change travels through the shared doc too.
      const yt = live.doc.getText('title')
      if (yt.toString() !== s.current.title) live.doc.transact(() => (yt.delete(0, yt.length), yt.insert(0, s.current.title)))
      if (s.current.checkpoint) live.doc.getMap('meta').set('checkpoint', true), (s.current.checkpoint = false)
      return
    }
    clearTimeout(s.current.timer)
    s.current.timer = window.setTimeout(flush, 800)
  }
  // Live room: the server reports each save in the shared "meta" map; others' title edits arrive in "title".
  useEffect(() => {
    if (!live) return
    const meta = live.doc.getMap('meta')
    const yt = live.doc.getText('title')
    const onMeta = () => {
      const v = meta.get('version') as number | undefined
      if (!v || v === s.current.version) return
      s.current.version = v
      s.current.dirty = false
      clearDraft(page.id)
      setMeta({ updatedAt: meta.get('updatedAt') as string, updatedBy: meta.get('updatedBy') as string })
      setStatus({ text: t('page.saved') })
    }
    const onTitleChange = (e: Y.YTextEvent) => {
      if (e.transaction.local) return
      const v = yt.toString()
      s.current.title = v
      setTitle(v)
      onTitle(v || t('common.untitled'))
    }
    const onStatus = ({ status: st }: { status: string }) =>
      st === 'connected' ? setStatus((x) => (x.kind === 'error' ? { text: '' } : x)) : setStatus({ text: t('page.offline'), kind: 'error' })
    meta.observe(onMeta)
    yt.observe(onTitleChange)
    live.provider.on('status', onStatus)
    return () => (meta.unobserve(onMeta), yt.unobserve(onTitleChange), live.provider.off('status', onStatus))
  }, [live])
  async function flush() {
    const st = s.current
    if (live) return
    if (st.saving || !st.dirty || st.conflict || !editor) return
    st.saving = true
    st.dirty = false
    try {
      const r = await api(`/api/pages/${page.id}`, {
        method: 'PUT',
        json: { title: st.title.trim() || t('common.untitled'), doc: editor.getJSON(), version: st.version, checkpoint: st.checkpoint },
      })
      st.version = r.version
      st.checkpoint = false
      // Only forget the local copy if nothing new was typed while this save was in flight.
      if (!st.dirty) clearDraft(page.id)
      setMeta({ updatedAt: r.updatedAt, updatedBy: me.name })
      setStatus({ text: t('page.saved') })
    } catch (e: any) {
      st.dirty = true
      st.conflict = e.status === 409
      // A network failure (not an HTTP error) means offline: the edits are already in the local draft.
      const offline = !(e instanceof ApiError)
      setStatus({ text: st.conflict ? t('page.conflict') : offline ? t('page.offline') : t('page.saveFailed', { msg: e.message }), kind: 'error' })
    } finally {
      st.saving = false
      if (st.dirty && !st.conflict) st.timer = window.setTimeout(flush, 3000)
    }
  }
  // Leaving the page with unsaved edits: save now rather than lose them.
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => s.current.dirty && e.preventDefault()
    addEventListener('beforeunload', warn)
    return () => (removeEventListener('beforeunload', warn), clearTimeout(s.current.timer), void flush())
  }, [editor])
  useEffect(() => {
    const retry = () => (clearTimeout(s.current.timer), flush())
    addEventListener('online', retry)
    return () => removeEventListener('online', retry)
  }, [editor])
  useEffect(() => {
    const save = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') (e.preventDefault(), clearTimeout(s.current.timer), flush())
    }
    addEventListener('keydown', save)
    return () => removeEventListener('keydown', save)
  }, [editor])

  const titleRef = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (canEdit && page.version === 1 && page.title === t('common.untitled')) titleRef.current?.select()
  }, [])

  if (!editor) return null

  return (
    <div className="page">
      <header className="page-bar">
        <nav className="crumbs" aria-label={t('page.breadcrumb')}>
          <span>{page.space.name}</span>
          {page.ancestors.map((a) => (
            <span key={a.id}>
              <i>/</i>
              <a href={`#/p/${a.id}`}>{a.title}</a>
            </span>
          ))}
        </nav>
        <span className={`save-status ${status.kind ?? ''}`} role="status">
          {status.kind === 'busy' && <span className="spinner" />}
          {status.text}
          {s.current.conflict && (
            <button className="link" onClick={() => location.reload()}>{t('page.reload')}</button>
          )}
        </span>
        {!canEdit && <span className="tag">{t('page.viewOnly')}</span>}
        <button
          className={`ghost ${restricted ? 'locked' : ''}`}
          title={restricted ? t('page.restricted.tip') : t('page.open.tip')}
          onClick={() => setSharing(true)}
        >
          <Icon name={restricted ? 'lock' : 'unlock'} />
          <span className="label">{restricted ? t('page.restricted') : t('page.access')}</span>
        </button>
        <button
          className="ghost"
          title={t('page.copyLink')}
          onClick={() => navigator.clipboard.writeText(location.href).then(() => toast(t('page.linkCopied')))}
        >
          <Icon name="link" />
          <span className="label">{t('page.copyLink')}</span>
        </button>
        <button className={`ghost ${watching ? 'on' : ''}`} aria-pressed={watching} title={watching ? t('page.watching.tip') : t('page.watch.tip')}
          onClick={() => api(`/api/pages/${page.id}/watch`, { method: 'PUT', json: { watching: !watching } }).then((r) => (setWatching(r.watching), toast(r.watching ? t('page.watch.on') : t('page.watch.off'))), (e) => toast(e.message))}>
          <Icon name="eye" />
          <span className="label">{watching ? t('page.watching') : t('page.watch')}</span>
        </button>
        <button className={`ghost ${panel === 'history' ? 'on' : ''}`} title={t('page.history')} onClick={() => setPanel(panel ? null : 'history')}>
          <Icon name="history" />
          <span className="label">{t('page.history')}</span>
        </button>
        <div className="menu-wrap" ref={menuRef}>
          <button className="ghost icon" aria-label={t('page.more')} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}>
            <Icon name="more" />
          </button>
          {menu && (
            <div className="dropdown" role="menu">
              <button role="menuitem" onClick={() => (setMenu(false), exportMarkdown(title, editor))}>{t('page.exportMd')}</button>
              <button role="menuitem" onClick={() => (setMenu(false), print())}>{t('page.print')}</button>
              <a role="menuitem" className="menu-link" href={`/api/pages/${page.id}/export`} download onClick={() => setMenu(false)}>{t('export.page')}</a>
              <button role="menuitem" onClick={() => (setMenu(false), setSavingTpl(true))}>{t('tpl.save')}</button>
              <button
                role="menuitem"
                onClick={() => {
                  setMenu(false)
                  api(`/api/pages/${page.id}/copy`, { method: 'POST', json: { title: t('page.copy.title', { title }) } }).then((p) => {
                    dispatchEvent(new CustomEvent('ph:tree-changed'))
                    location.hash = `#/p/${p.id}`
                    toast(t('page.copied'))
                  }, (e) => toast(e.message))
                }}
              >
                {t('page.copy')}
              </button>
              {canEdit && (
                <button role="menuitem" onClick={() => (setMenu(false), dispatchEvent(new CustomEvent('ph:import', { detail: { parentId: page.id, parentTitle: title } })))}>
                  {t('import.page')}
                </button>
              )}
              <hr />
              <button
                role="menuitem"
                className="danger"
                disabled={!canEdit}
                onClick={async () => {
                  setMenu(false)
                  if (!(await confirmDialog({ title: t('page.trash.title'), body: t('page.trash.body'), ok: t('page.toTrash'), danger: true }))) return
                  s.current.dirty = false
                  try {
                    await api(`/api/pages/${page.id}`, { method: 'DELETE' })
                  } catch (e: any) {
                    return toast(e.message)
                  }
                  onDeleted()
                  toast(t('page.trashed'), {
                    label: t('common.undo'),
                    run: () =>
                      api(`/api/pages/${page.id}/restore`, { method: 'POST' }).then(() => {
                        location.hash = `#/p/${page.id}`
                        dispatchEvent(new CustomEvent('ph:tree-changed'))
                      }),
                  })
                }}
              >
                {t('page.toTrash')}
              </button>
            </div>
          )}
        </div>
      </header>

      <div className="page-body">
        <article className="doc-col">
          <textarea
            className="title"
            rows={1}
            value={title}
            aria-label={t('page.title')}
            placeholder={t('common.untitled')}
            readOnly={!canEdit}
            ref={(el) => {
              titleRef.current = el
              if (el) (el.style.height = 'auto'), (el.style.height = `${el.scrollHeight}px`)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.preventDefault(), editor.commands.focus('start'))
            }}
            onChange={(e) => {
              const v = e.target.value.replace(/\n/g, '')
              setTitle(v)
              s.current.title = v
              onTitle(v || t('common.untitled'))
              schedule()
            }}
          />
          <div className="byline">
            <span>{t('page.createdBy', { name: page.createdBy })}</span>
            <span className="dot" />
            <span title={fullDate(meta.updatedAt)}>{t('page.updated', { name: meta.updatedBy, when: ago(meta.updatedAt) })}</span>
          </div>
          {draft && (
            <div className="draft-banner" role="status">
              <Icon name="history" />
              <span className="grow">{t('draft.found', { when: ago(draft.at) })}</span>
              <button
                className="primary"
                onClick={() => {
                  editor.commands.setContent(draft.doc as any)
                  setTitle(draft.title)
                  s.current.title = draft.title
                  onTitle(draft.title)
                  s.current.checkpoint = true
                  setDraft(null)
                  schedule()
                  toast(t('draft.restored'))
                }}
              >
                {t('draft.restore')}
              </button>
              <button onClick={() => (clearDraft(page.id), setDraft(null))}>{t('draft.discard')}</button>
            </div>
          )}
          <TextMenu editor={editor} />
          <TableMenu editor={editor} />
          <CodeMenu editor={editor} />
          <EditorContent editor={editor} className="doc" onClick={(e) => {
            const id = (e.target as HTMLElement).closest('[data-comment]')?.getAttribute('data-comment')
            if (id) dispatchEvent(new CustomEvent('ph:show-comment', { detail: id }))
          }} />
          <input ref={fileInput} type="file" hidden multiple onChange={(e) => (takeFiles(e.target.files), (e.target.value = ''))} />
          <Comments pageId={page.id} me={me} editor={editor} />
        </article>
        {savingTpl && <SaveTemplateModal pageId={page.id} me={me} title={title} onClose={() => setSavingTpl(false)} />}
        {sharing && (
          <RestrictionsModal pageId={page.id} me={me} canEdit={canEdit} onClose={() => setSharing(false)} onSaved={setRestricted} />
        )}
        {panel === 'history' ? (
          <History pageId={page.id} editor={editor} canEdit={canEdit} onRestore={() => ((s.current.checkpoint = true), schedule(), setPanel(null))} onClose={() => setPanel(null)} />
        ) : (
          <Toc editor={editor} />
        )}
      </div>
    </div>
  )
}

function SaveTemplateModal({ pageId, me, title, onClose }: { pageId: number; me: User; title: string; onClose: () => void }) {
  const [name, setName] = useState(title)
  const [icon, setIcon] = useState('📄')
  const [global, setGlobal] = useState(false)
  const [busy, setBusy] = useState(false)
  const save = async () => {
    setBusy(true)
    try {
      await api('/api/templates', { json: { pageId, name, icon, global } })
      toast(t('tpl.saved'))
      onClose()
    } catch (e: any) {
      toast(e.message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal title={t('tpl.save')} onClose={onClose} onSubmit={(e) => (e.preventDefault(), save())} footer={
      <>
        <span className="note-text">{t('tpl.save.note')}</span>
        <button type="button" onClick={onClose}>{t('common.cancel')}</button>
        <button className="primary" disabled={busy || !name.trim()}>{t('common.save')}</button>
      </>
    }>
      <div className="form">
        <div className="row">
          <label style={{ width: 80 }}>{t('tpl.icon')}<input value={icon} onChange={(e) => setIcon(e.target.value)} maxLength={4} /></label>
          <label style={{ flex: 1 }}>{t('tpl.name')}<input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} autoFocus /></label>
        </div>
        {me.role === 'admin' && (
          <label className="check"><input type="checkbox" checked={global} onChange={(e) => setGlobal(e.target.checked)} /> {t('tpl.global')}</label>
        )}
      </div>
    </Modal>
  )
}

function TextMenu({ editor }: { editor: Editor }) {
  const st = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'), italic: e.isActive('italic'), strike: e.isActive('strike'), code: e.isActive('code'),
      highlight: e.isActive('highlight'), link: e.isActive('link'),
    }),
  })
  const [linking, setLinking] = useState<string | null>(null)
  const c = () => editor.chain().focus()
  const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+'
  const btn = (label: string, tip: string, on: boolean, run: () => void) => (
    <button key={tip} title={tip} aria-label={tip} aria-pressed={on} className={on ? 'on' : ''} onMouseDown={(e) => (e.preventDefault(), run())}>
      {label}
    </button>
  )
  const applyLink = () => {
    const href = linking?.trim()
    if (href) c().extendMarkRange('link').setLink({ href: /^[a-z]+:|^[/#]/i.test(href) ? href : `https://${href}` }).run()
    else c().extendMarkRange('link').unsetLink().run()
    setLinking(null)
  }
  return (
    <BubbleMenu
      editor={editor}
      pluginKey="textMenu"
      shouldShow={({ editor: e, state }) => e.isEditable && !state.selection.empty && !e.isActive('codeBlock') && !e.isActive('image') && !e.isActive('linkCard')}
      className="bubble"
    >
      {linking !== null ? (
        <form className="link-edit" onSubmit={(e) => (e.preventDefault(), applyLink())}>
          <input
            autoFocus
            value={linking}
            placeholder={t('fmt.linkPlaceholder')}
            aria-label={t('fmt.link')}
            onChange={(e) => setLinking(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && (setLinking(null), editor.commands.focus())}
          />
          <button type="submit" className="primary">{t('common.save')}</button>
          {st.link && (
            <button type="button" onClick={() => (c().extendMarkRange('link').unsetLink().run(), setLinking(null))}>{t('fmt.unlink')}</button>
          )}
        </form>
      ) : (
        <>
          {btn('B', `${t('fmt.bold')} (${mod}B)`, st.bold, () => c().toggleBold().run())}
          {btn('I', `${t('fmt.italic')} (${mod}I)`, st.italic, () => c().toggleItalic().run())}
          {btn('S', t('fmt.strike'), st.strike, () => c().toggleStrike().run())}
          {btn('</>', t('fmt.code'), st.code, () => c().toggleCode().run())}
          {btn('🖍', t('fmt.highlight'), st.highlight, () => c().toggleHighlight().run())}
          <button title={t('fmt.link')} aria-label={t('fmt.link')} className={st.link ? 'on' : ''} onMouseDown={(e) => (e.preventDefault(), setLinking(editor.getAttributes('link').href ?? ''))}>
            <Icon name="link" size={14} />
          </button>
          {st.link && (
            <button title={t('fmt.openLink')} aria-label={t('fmt.openLink')} onMouseDown={(e) => (e.preventDefault(), window.open(editor.getAttributes('link').href, '_blank', 'noopener'))}>
              {t('fmt.open')}
            </button>
          )}
          <button title={t('comments.inline')} aria-label={t('comments.inline')} onMouseDown={(e) => {
            e.preventDefault()
            const { from, to } = editor.state.selection
            dispatchEvent(new CustomEvent('ph:inline-comment', { detail: { from, to, quote: editor.state.doc.textBetween(from, to, ' ').slice(0, 2000) } }))
          }}>
            <Icon name="comment" size={14} />
          </button>
          <span className="sep" />
          {btn('H2', t('fmt.h2'), false, () => c().toggleHeading({ level: 2 }).run())}
          {btn('H3', t('fmt.h3'), false, () => c().toggleHeading({ level: 3 }).run())}
        </>
      )}
    </BubbleMenu>
  )
}

function TableMenu({ editor }: { editor: Editor }) {
  const c = () => editor.chain().focus()
  // Merging needs several selected cells; splitting needs a merged cell. Show what is possible right now.
  const can = useEditorState({
    editor,
    selector: ({ editor: e }) => ({ merge: e.can().mergeCells(), split: e.can().splitCell(), multi: e.state.selection instanceof CellSelection }),
  })
  const btn = (label: string, run: () => void, opts: { danger?: boolean; disabled?: boolean; title?: string } = {}) => (
    <button
      key={label}
      className={opts.danger ? 'danger' : ''}
      disabled={opts.disabled}
      title={opts.title}
      onMouseDown={(e) => (e.preventDefault(), !opts.disabled && run())}
    >
      {label}
    </button>
  )
  return (
    <BubbleMenu
      editor={editor}
      pluginKey="tableMenu"
      shouldShow={({ editor: e, state }) => e.isEditable && e.isActive('table') && (state.selection.empty || state.selection instanceof CellSelection)}
      options={{ placement: 'bottom-start', offset: 8 }}
      getReferencedVirtualElement={() => {
        const { node } = editor.view.domAtPos(editor.state.selection.from)
        const table = (node instanceof Element ? node : node.parentElement)?.closest('table')
        return table ? { getBoundingClientRect: () => table.getBoundingClientRect() } : null
      }}
      className="bubble table-menu"
    >
      {btn(t('table.rowAbove'), () => c().addRowBefore().run())}
      {btn(t('table.rowBelow'), () => c().addRowAfter().run())}
      {btn(t('table.colLeft'), () => c().addColumnBefore().run())}
      {btn(t('table.colRight'), () => c().addColumnAfter().run())}
      <span className="sep" />
      {btn(t('table.mergeCells'), () => c().mergeCells().run(), { disabled: !can.merge, title: can.merge ? undefined : t('table.mergeHint') })}
      {can.split && btn(t('table.splitCell'), () => c().splitCell().run())}
      <span className="sep" />
      {btn(t('table.delRow'), () => c().deleteRow().run())}
      {btn(t('table.delCol'), () => c().deleteColumn().run())}
      {btn(t('table.header'), () => c().toggleHeaderRow().run())}
      {btn(t('table.delete'), () => c().deleteTable().run(), { danger: true })}
      {!can.multi && !can.split && <span className="table-hint">{t('table.mergeHint')}</span>}
    </BubbleMenu>
  )
}

function CodeMenu({ editor }: { editor: Editor }) {
  const lang = useEditorState({ editor, selector: ({ editor: e }) => (e.isActive('codeBlock') ? e.getAttributes('codeBlock').language ?? '' : null) })
  return (
    <BubbleMenu editor={editor} pluginKey="codeMenu" shouldShow={({ editor: e }) => e.isEditable && e.isActive('codeBlock')} options={{ placement: 'top-end' }} className="bubble">
      <select
        aria-label={t('code.language')}
        value={lang ?? ''}
        onChange={(e) => editor.chain().focus().updateAttributes('codeBlock', { language: e.target.value || null }).run()}
      >
        <option value="">{t('code.auto')}</option>
        {CODE_LANGUAGES.map((l) => (
          <option key={l} value={l}>{l}</option>
        ))}
      </select>
    </BubbleMenu>
  )
}

function Toc({ editor }: { editor: Editor }) {
  const headings = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      const out: { level: number; text: string; pos: number }[] = []
      e.state.doc.descendants((n, pos) => {
        if (n.type.name === 'heading' && n.textContent.trim()) out.push({ level: n.attrs.level, text: n.textContent, pos })
        return n.type.name !== 'heading'
      })
      return out
    },
    equalityFn: (a, b) => JSON.stringify(a) === JSON.stringify(b),
  })
  if (headings.length < 2) return <aside className="side-col" />
  const min = Math.min(...headings.map((h) => h.level))
  return (
    <aside className="side-col">
      <nav className="toc" aria-label={t('toc.title')}>
        <div className="side-title">{t('toc.title')}</div>
        {headings.map((h) => (
          <a
            key={h.pos}
            href="#"
            style={{ paddingLeft: (h.level - min) * 12 + 8 }}
            onClick={(e) => {
              e.preventDefault()
              const dom = editor.view.nodeDOM(h.pos) as HTMLElement | null
              dom?.scrollIntoView({ behavior: 'smooth', block: 'start' })
            }}
          >
            {h.text}
          </a>
        ))}
      </nav>
    </aside>
  )
}

type Entry = Principal & { level: 'view' | 'edit' }

function RestrictionsModal({ pageId, me, canEdit, onClose, onSaved }: {
  pageId: number; me: User; canEdit: boolean; onClose: () => void; onSaved: (restricted: boolean) => void
}) {
  const [entries, setEntries] = useState<Entry[]>()
  const [inherited, setInherited] = useState<{ id: number; title: string }[]>([])
  const [users, setUsers] = useState<Principal[]>([])
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    api(`/api/pages/${pageId}/restrictions`).then((r) => (setEntries(r.entries), setInherited(r.inherited)))
    listPrincipals().then(setUsers)
  }, [pageId])

  const restricted = !!entries?.length
  const needle = q.trim().toLowerCase()
  const matches = needle
    ? users.filter((u) => !entries?.some((e) => pkey(e) === pkey(u)) && (u.name + ' ' + (u.email ?? '')).toLowerCase().includes(needle)).slice(0, 20)
    : []
  const add = (u: Principal) => (setEntries([...(entries ?? []), { ...u, level: 'view' }]), setQ(''))
  // Turning restriction on starts with yourself as editor, the same thing the server enforces.
  const restrictOn = () => !restricted && setEntries([{ userId: me.id, name: me.name, email: me.email, level: 'edit' }])
  const locked = (e: Entry) => e.userId === me.id && me.role !== 'admin'

  async function save() {
    if (!entries) return
    setBusy(true)
    try {
      const r = await api(`/api/pages/${pageId}/restrictions`, {
        method: 'PUT',
        json: { entries: entries.map(({ userId, groupId, level }) => (groupId ? { groupId, level } : { userId, level })) },
      })
      onSaved(r.restricted || inherited.length > 0)
      toast(r.restricted ? t('access.saved') : t('access.cleared'))
      dispatchEvent(new CustomEvent('ph:tree-changed'))
      onClose()
    } catch (err: any) {
      toast(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={t('access.title')}
      onClose={onClose}
      footer={
        <>
          <span className="note-text">{canEdit ? t('access.adminNote') : t('access.viewOnlyNote')}</span>
          <button onClick={onClose}>{canEdit ? t('common.cancel') : t('common.close')}</button>
          {canEdit && <button className="primary" disabled={busy || !entries} onClick={save}>{t('common.save')}</button>}
        </>
      }
    >
      <div className="segmented" role="radiogroup" aria-label={t('access.title')}>
        <button role="radio" aria-checked={!restricted} className={!restricted ? 'on' : ''} disabled={!canEdit || !entries} onClick={() => setEntries([])}>
          <Icon name="unlock" size={14} /> {t('access.everyone')}
        </button>
        <button role="radio" aria-checked={restricted} className={restricted ? 'on' : ''} disabled={!canEdit || !entries} onClick={restrictOn}>
          <Icon name="lock" size={14} /> {t('access.selected')}
        </button>
      </div>
      <p className="segmented-hint">{restricted ? t('access.only.sub') : t('access.open.sub')}</p>

      <div className="access-area">
        {!entries ? (
          <div className="access-empty"><span className="spinner" /></div>
        ) : !restricted ? (
          <div className="access-empty">
            <Icon name="unlock" size={28} />
            <span>{t('access.openEmpty')}</span>
            {canEdit && <span className="small">{t('access.openEmpty.hint')}</span>}
          </div>
        ) : (
          <>
            {canEdit && (
              <label className="access-search">
                <Icon name="search" />
                <input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && matches[0] && (e.preventDefault(), add(matches[0]))}
                  placeholder={t('access.add')}
                  aria-label={t('access.search')}
                />
              </label>
            )}
            <ul className="people">
              {needle ? (
                matches.length ? (
                  matches.map((u) => (
                    <li key={pkey(u)}>
                      <PrincipalLabel p={u} />
                      <button className="add-btn" onClick={() => add(u)}><Icon name="plus" size={14} /> {t('access.addBtn')}</button>
                    </li>
                  ))
                ) : (
                  <li className="muted small">{t('access.noMatch', { q: q.trim() })}</li>
                )
              ) : (
                entries.map((e) => (
                  <li key={pkey(e)}>
                    <PrincipalLabel p={e} me={me} />
                    <select
                      value={e.level}
                      aria-label={t('access.levelFor', { name: e.name })}
                      disabled={!canEdit || locked(e)}
                      onChange={(ev) => setEntries(entries.map((x) => (pkey(x) === pkey(e) ? { ...x, level: ev.target.value as Entry['level'] } : x)))}
                    >
                      <option value="view">{t('access.view')}</option>
                      <option value="edit">{t('access.edit')}</option>
                    </select>
                    {/* Placeholder keeps rows aligned when the remove button is hidden. */}
                    {canEdit && !locked(e) ? (
                      <button className="ghost icon" aria-label={t('access.remove', { name: e.name })} onClick={() => setEntries(entries.filter((x) => pkey(x) !== pkey(e)))}>
                        <Icon name="x" size={14} />
                      </button>
                    ) : (
                      canEdit && <span style={{ width: 30 }} />
                    )}
                  </li>
                ))
              )}
            </ul>
          </>
        )}
      </div>

      {inherited.length > 0 && (
        <div className="inherit-note">
          <Icon name="lock" size={14} />
          <span>{t('access.inherited', { pages: inherited.map((p) => `“${p.title}”`).join(', ') })}</span>
        </div>
      )}
    </Modal>
  )
}

function History({ pageId, editor, canEdit, onRestore, onClose }: { pageId: number; editor: Editor; canEdit: boolean; onRestore: () => void; onClose: () => void }) {
  const [versions, setVersions] = useState<any[]>()
  const [comparing, setComparing] = useState<[any, any] | null>(null)
  useEffect(() => {
    api(`/api/pages/${pageId}/versions`).then(setVersions)
  }, [pageId])
  return (
    <aside className="side-col panel">
      <div className="side-title">
        {t('history.title')}
        <button className="ghost icon" aria-label={t('common.close')} onClick={onClose}><Icon name="x" size={14} /></button>
      </div>
      <p className="muted small">{t('history.note')}</p>
      <ol className="history-list">
      {versions?.map((v, i) => (
        <li key={v.id} className={`version ${i === 0 ? 'current' : ''}`}>
          <div>
            <b>{fullDate(v.createdAt)}</b>
            {i === 0 && <span className="tag">{t('history.current')}</span>}
          </div>
          <div className="muted small">{v.author} · {v.title}</div>
          {versions[i + 1] && <button className="link" onClick={() => setComparing([versions[i + 1], v])}>{t('history.changes')}</button>}
          {i > 0 && canEdit && (
            <button
              className="link"
              onClick={async () => {
                if (!(await confirmDialog({ title: t('history.confirm.title'), body: t('history.confirm.body'), ok: t('history.restore') }))) return
                const old = await api(`/api/versions/${v.id}`)
                editor.commands.setContent(old.doc)
                onRestore()
                toast(t('history.restored'))
              }}
            >
              {t('history.restore')}
            </button>
          )}
        </li>
      ))}
      </ol>
      {versions && !versions.length && <p className="muted">{t('history.empty')}</p>}
      {comparing && <DiffModal older={comparing[0]} newer={comparing[1]} onClose={() => setComparing(null)} />}
    </aside>
  )
}

/** What one save changed, as a Markdown line diff. */
function DiffModal({ older, newer, onClose }: { older: any; newer: any; onClose: () => void }) {
  const [lines, setLines] = useState<DiffLine[]>()
  useEffect(() => {
    Promise.all([api(`/api/versions/${older.id}`), api(`/api/versions/${newer.id}`)]).then(([a, b]) => {
      const md = (v: any) => toMarkdown(v.title, v.doc).split('\n')
      setLines(diffLines(md(a), md(b)))
    })
  }, [older.id, newer.id])
  const changed = lines?.filter((l) => l.kind !== 'same').length ?? 0
  // Long unchanged stretches fold down to a few lines of context around each change.
  const shown = lines?.filter((l, i) => l.kind !== 'same' || lines.slice(Math.max(0, i - 2), i + 3).some((x) => x.kind !== 'same'))
  return (
    <Modal title={t('history.changes.title', { when: fullDate(newer.createdAt), name: newer.author })} onClose={onClose} size="wide"
      footer={<button onClick={onClose}>{t('common.close')}</button>}>
      {!lines ? <span className="spinner" /> : !changed ? <p className="muted">{t('history.changes.none')}</p> : (
        <pre className="diff">{shown!.map((l, i) => <div key={i} className={`diff-${l.kind}`}>{l.kind === 'add' ? '+ ' : l.kind === 'del' ? '- ' : '  '}{l.text || ' '}</div>)}</pre>
      )}
    </Modal>
  )
}

type Comment = { id: number; parentId: number | null; body: string; quote?: string | null; resolvedAt: string | null; createdAt: string; authorId: number; author: string }

type Pending = { quote: string; from: number; to: number }

function Comments({ pageId, me, editor }: { pageId: number; me: User; editor: Editor }) {
  const [list, setList] = useState<Comment[]>([])
  const [showResolved, setShowResolved] = useState(false)
  const [pending, setPending] = useState<Pending | null>(null)
  const ref = useRef<HTMLElement>(null)
  useEffect(() => {
    const start = (e: Event) => {
      setPending((e as CustomEvent<Pending>).detail)
      setTimeout(() => ref.current?.querySelector<HTMLElement>('.inline-composer textarea')?.focus(), 50)
      ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
    // Clicking commented text in the page jumps to its thread.
    const jump = (e: Event) => {
      const el = document.getElementById(`comment-${(e as CustomEvent<string>).detail}`)
      if (el) (el.scrollIntoView({ behavior: 'smooth', block: 'center' }), el.classList.add('flash'), setTimeout(() => el.classList.remove('flash'), 1200))
    }
    addEventListener('ph:inline-comment', start)
    addEventListener('ph:show-comment', jump)
    return () => (removeEventListener('ph:inline-comment', start), removeEventListener('ph:show-comment', jump))
  }, [])
  const postInline = async (body: string) => {
    if (!pending) return
    const c = await api(`/api/pages/${pageId}/comments`, { json: { body, quote: pending.quote } })
    // Mark the range if it still holds the quoted text (the page may have changed while typing).
    const { from, to, quote } = pending
    if (to <= editor.state.doc.content.size && editor.state.doc.textBetween(from, to, ' ') === quote)
      editor.chain().setTextSelection({ from, to }).setMark('comment', { id: String(c.id) }).setTextSelection(to).run()
    setList((l) => [...l, c])
    setPending(null)
  }
  useEffect(() => {
    const load = () => api(`/api/pages/${pageId}/comments`).then(setList)
    load()
    addEventListener('ph:comments-changed', load)
    return () => removeEventListener('ph:comments-changed', load)
  }, [pageId])
  const post = async (body: string, parentId: number | null = null) => {
    const c = await api(`/api/pages/${pageId}/comments`, { json: { body, parentId } })
    setList((l) => [...l, c])
  }
  const top = list.filter((c) => !c.parentId)
  const open = top.filter((c) => !c.resolvedAt)
  const resolved = top.filter((c) => c.resolvedAt)
  const thread = (c: Comment) => (
    <div key={c.id} id={`comment-${c.id}`} className={`comment ${c.resolvedAt ? 'resolved' : ''}`}>
      {c.quote && (
        <button className="comment-quote" title={t('comments.showInPage')}
          onClick={() => document.querySelector(`.doc [data-comment="${c.id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })}>
          {c.quote}
        </button>
      )}
      <CommentBody c={c} me={me} onDelete={() => setList((l) => l.filter((x) => x.id !== c.id && x.parentId !== c.id))} />
      {list.filter((r) => r.parentId === c.id).map((r) => (
        <div key={r.id} className="reply">
          <CommentBody c={r} me={me} onDelete={() => setList((l) => l.filter((x) => x.id !== r.id))} />
        </div>
      ))}
      <div className="comment-actions">
        <Composer placeholder={t('comments.reply')} compact onSubmit={(b) => post(b, c.id)} />
        <button
          className="link"
          onClick={async () => {
            await api(`/api/comments/${c.id}`, { method: 'PATCH', json: { resolved: !c.resolvedAt } })
            setList((l) => l.map((x) => (x.id === c.id ? { ...x, resolvedAt: c.resolvedAt ? null : new Date().toISOString() } : x)))
          }}
        >
          {c.resolvedAt ? t('comments.reopen') : t('comments.resolve')}
        </button>
      </div>
    </div>
  )
  return (
    <section className="comments" aria-label={t('comments.title')} ref={ref}>
      {/* Only open inline comments are highlighted in the page; resolved and deleted ones fade out. */}
      <style>{open.filter((c) => c.quote).map((c) => `.doc [data-comment="${c.id}"]`).join(',') + '{background:var(--c-warning);border-bottom:2px solid var(--c-warning-line);cursor:pointer}'}</style>
      <h3>{t('comments.title')} {open.length > 0 && <span className="count">{open.length}</span>}</h3>
      {pending && (
        <div className="comment inline-composer">
          <div className="comment-quote">{pending.quote}</div>
          <Composer placeholder={t('comments.placeholder')} onSubmit={postInline} />
          <button className="link small" onClick={() => setPending(null)}>{t('common.cancel')}</button>
        </div>
      )}
      {open.map(thread)}
      <Composer placeholder={t('comments.placeholder')} onSubmit={(b) => post(b)} />
      {resolved.length > 0 && (
        <button className="link small" onClick={() => setShowResolved(!showResolved)}>
          {t(showResolved ? 'comments.hideResolved' : 'comments.showResolved', { n: resolved.length })}
        </button>
      )}
      {showResolved && resolved.map(thread)}
    </section>
  )
}

function CommentBody({ c, me, onDelete }: { c: Comment; me: User; onDelete: () => void }) {
  return (
    <>
      <div className="comment-head">
        <span className="avatar">{c.author.slice(0, 1)}</span>
        <b>{c.author}</b>
        <span className="muted small" title={fullDate(c.createdAt)}>{ago(c.createdAt)}</span>
        {(c.authorId === me.id || me.role === 'admin') && (
          <button
            className="link small muted-link"
            onClick={async () => {
              if (!(await confirmDialog({ title: t('comments.delete.title'), body: t('comments.delete.body'), ok: t('common.delete'), danger: true }))) return
              try {
                await api(`/api/comments/${c.id}`, { method: 'DELETE' })
              } catch (e: any) {
                return toast(e.message)
              }
              onDelete()
              toast(t('comments.deleted'), {
                label: t('common.undo'),
                run: () => api(`/api/comments/${c.id}/restore`, { method: 'POST' }).then(() => dispatchEvent(new CustomEvent('ph:comments-changed'))),
              })
            }}
          >
            {t('common.delete')}
          </button>
        )}
      </div>
      <CommentText body={c.body} />
    </>
  )
}

// Comments store mentions as <@id>. While typing they read as "@Name"; they are converted when posting.
function Composer({ placeholder, compact, onSubmit }: { placeholder: string; compact?: boolean; onSubmit: (b: string) => Promise<void> }) {
  const [v, setV] = useState('')
  const [busy, setBusy] = useState(false)
  const [people, setPeople] = useState<Person[]>([])
  const [picked, setPicked] = useState<Person[]>([])
  const [query, setQuery] = useState<{ text: string; at: number } | null>(null)
  const [sel, setSel] = useState(0)
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => void listPeople().then(setPeople), [])
  const matches = query ? people.filter((p) => `${p.name} ${p.email}`.toLowerCase().includes(query.text.toLowerCase())).slice(0, 6) : []

  const track = (value: string, caret: number) => {
    const m = value.slice(0, caret).match(/(^|\s)@([^\s@]{0,30})$/)
    setQuery(m ? { text: m[2], at: caret - m[2].length - 1 } : null)
    setSel(0)
  }
  const pick = (p: Person) => {
    if (!query) return
    const next = `${v.slice(0, query.at)}@${p.name} ${v.slice(query.at + 1 + query.text.length)}`
    setV(next)
    setPicked((l) => (l.some((x) => x.id === p.id) ? l : [...l, p]))
    setQuery(null)
    requestAnimationFrame(() => ref.current?.focus())
  }
  const submit = async () => {
    if (!v.trim() || busy) return
    // Longest names first so "@Kim Lee" is not taken for "@Kim".
    let body = v.trim()
    for (const p of [...picked].sort((a, b) => b.name.length - a.name.length)) body = body.split(`@${p.name}`).join(`<@${p.id}>`)
    setBusy(true)
    try {
      await onSubmit(body)
      setV('')
      setPicked([])
    } catch (e: any) {
      toast(e.message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className={`composer ${compact ? 'compact' : ''}`}>
      <AutoTextarea
        ref={ref}
        value={v}
        rows={compact ? 1 : 2}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(e) => (setV(e.target.value), track(e.target.value, e.target.selectionStart))}
        onKeyDown={(e) => {
          if (matches.length && query) {
            if (e.key === 'ArrowDown') return e.preventDefault(), setSel((s) => (s + 1) % matches.length)
            if (e.key === 'ArrowUp') return e.preventDefault(), setSel((s) => (s + matches.length - 1) % matches.length)
            if (e.key === 'Enter' || e.key === 'Tab') return e.preventDefault(), pick(matches[sel])
            if (e.key === 'Escape') return setQuery(null)
          }
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit()
        }}
      />
      {query && matches.length > 0 && (
        <div className="slash-menu people-menu composer-mentions" role="listbox">
          {matches.map((p, i) => (
            <button key={p.id} role="option" aria-selected={i === sel} className={i === sel ? 'active' : ''} onMouseEnter={() => setSel(i)} onMouseDown={(e) => (e.preventDefault(), pick(p))}>
              <span className="avatar">{p.name.slice(0, 1)}</span>
              <span><b>{p.name}</b><small>{p.email}</small></span>
            </button>
          ))}
        </div>
      )}
      {v.trim() && (
        <div className="composer-foot">
          <span className="muted small">{t('comments.hint')}</span>
          <button className="primary" disabled={busy} onClick={submit}>{t('comments.post')}</button>
        </div>
      )}
    </div>
  )
}

/** Comment text with <@id> mentions shown as name chips. */
function CommentText({ body }: { body: string }) {
  const [people, setPeople] = useState<Person[]>([])
  useEffect(() => void listPeople().then(setPeople), [])
  const parts = body.split(/<@(\d+)>/)
  return (
    <p className="comment-text">
      {parts.map((part, i) =>
        i % 2 ? <span key={i} className="mention-chip">@{people.find((p) => p.id === Number(part))?.name ?? '…'}</span> : part,
      )}
    </p>
  )
}

// One page as a single .md file. Attachment links point back to this wiki; the ZIP export bundles the files instead.
function exportMarkdown(title: string, editor: Editor) {
  const md = toMarkdown(title, editor.getJSON(), (u) => (u.startsWith('/') ? location.origin + u : u))
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }))
  a.download = `${title.replace(/[\\/:*?"<>|]/g, '_') || 'page'}.md`
  a.click()
  URL.revokeObjectURL(a.href)
}
