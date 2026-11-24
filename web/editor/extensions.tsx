import { Extension, Mark, Node, mergeAttributes, type Editor, type Range } from '@tiptap/core'
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, ReactRenderer, type NodeViewProps } from '@tiptap/react'
import Suggestion, { type SuggestionProps } from '@tiptap/suggestion'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import StarterKit from '@tiptap/starter-kit'
import { Image } from '@tiptap/extension-image'
import { TableKit } from '@tiptap/extension-table'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { Placeholder } from '@tiptap/extensions'
import { Highlight } from '@tiptap/extension-highlight'
import { TextAlign } from '@tiptap/extension-text-align'
import { Typography } from '@tiptap/extension-typography'
import { CodeBlockLowlight } from '@tiptap/extension-code-block-lowlight'
import { createLowlight } from 'lowlight'
import { Collaboration } from '@tiptap/extension-collaboration'
import { CollaborationCaret } from '@tiptap/extension-collaboration-caret'
import type * as Y from 'yjs'
// The languages a team wiki actually sees (infra, backend, frontend), instead of lowlight's general-purpose set.
import bash from 'highlight.js/lib/languages/bash'
import c from 'highlight.js/lib/languages/c'
import cpp from 'highlight.js/lib/languages/cpp'
import csharp from 'highlight.js/lib/languages/csharp'
import css from 'highlight.js/lib/languages/css'
import diff from 'highlight.js/lib/languages/diff'
import dockerfile from 'highlight.js/lib/languages/dockerfile'
import go from 'highlight.js/lib/languages/go'
import ini from 'highlight.js/lib/languages/ini'
import java from 'highlight.js/lib/languages/java'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import kotlin from 'highlight.js/lib/languages/kotlin'
import makefile from 'highlight.js/lib/languages/makefile'
import markdown from 'highlight.js/lib/languages/markdown'
import nginx from 'highlight.js/lib/languages/nginx'
import plaintext from 'highlight.js/lib/languages/plaintext'
import properties from 'highlight.js/lib/languages/properties'
import python from 'highlight.js/lib/languages/python'
import rust from 'highlight.js/lib/languages/rust'
import shell from 'highlight.js/lib/languages/shell'
import sql from 'highlight.js/lib/languages/sql'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'
import { forwardRef, useEffect, useImperativeHandle, useState } from 'react'
import { t } from '../i18n.ts'
import { Mention } from '@tiptap/extension-mention'
import { listPeople, type Person } from '../api.ts'

export const CALLOUTS = {
  info: { icon: 'ℹ️', label: t('callout.info') },
  warning: { icon: '⚠️', label: t('callout.warning') },
  success: { icon: '✅', label: t('callout.success') },
  danger: { icon: '⛔', label: t('callout.danger') },
} as const
type Variant = keyof typeof CALLOUTS

function CalloutView({ node, updateAttributes, editor }: NodeViewProps) {
  const variant = (node.attrs.variant in CALLOUTS ? node.attrs.variant : 'info') as Variant
  const order = Object.keys(CALLOUTS) as Variant[]
  return (
    <NodeViewWrapper className={`callout callout-${variant}`} data-callout={variant}>
      <button
        type="button"
        className="callout-icon"
        contentEditable={false}
        disabled={!editor.isEditable}
        title={t('callout.cycle', { label: CALLOUTS[variant].label })}
        onClick={() => updateAttributes({ variant: order[(order.indexOf(variant) + 1) % order.length] })}
      >
        {CALLOUTS[variant].icon}
      </button>
      <NodeViewContent className="callout-body" />
    </NodeViewWrapper>
  )
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    callout: { setCallout: (variant?: string) => ReturnType }
  }
}

// Panel block (info / warning / ...). Same shape as Confluence panels and Notion callouts, so imports map onto it.
export const Callout = Node.create({
  name: 'callout',
  group: 'block',
  content: 'block+',
  defining: true,
  addAttributes: () => ({
    variant: { default: 'info', parseHTML: (el) => el.getAttribute('data-callout'), renderHTML: (a) => ({ 'data-callout': a.variant }) },
  }),
  parseHTML: () => [{ tag: 'div[data-callout]' }],
  renderHTML: ({ HTMLAttributes }) => ['div', mergeAttributes(HTMLAttributes, { class: 'callout' }), 0],
  addNodeView: () => ReactNodeViewRenderer(CalloutView),
  addCommands() {
    return {
      setCallout:
        (variant = 'info') =>
        ({ commands }) =>
          commands.wrapIn(this.name, { variant }),
    }
  },
})

type SlashItem = { title: string; hint: string; icon: string; keywords: string; run: (e: Editor, r: Range) => void }

// Keywords stay bilingual so '/table' and '/표' both work whatever the UI language.
export const SLASH_ITEMS: SlashItem[] = [
  { title: t('slash.text'), hint: t('slash.text.hint'), icon: '¶', keywords: 'text paragraph 본문', run: (e, r) => e.chain().focus().deleteRange(r).setParagraph().run() },
  { title: t('slash.h1'), hint: t('slash.h1.hint'), icon: 'H1', keywords: 'h1 heading title 제목', run: (e, r) => e.chain().focus().deleteRange(r).setHeading({ level: 1 }).run() },
  { title: t('slash.h2'), hint: t('slash.h2.hint'), icon: 'H2', keywords: 'h2 heading title 제목', run: (e, r) => e.chain().focus().deleteRange(r).setHeading({ level: 2 }).run() },
  { title: t('slash.h3'), hint: t('slash.h3.hint'), icon: 'H3', keywords: 'h3 heading title 제목', run: (e, r) => e.chain().focus().deleteRange(r).setHeading({ level: 3 }).run() },
  { title: t('slash.bullet'), hint: t('slash.bullet.hint'), icon: '•', keywords: 'bullet list ul 목록', run: (e, r) => e.chain().focus().deleteRange(r).toggleBulletList().run() },
  { title: t('slash.ordered'), hint: t('slash.ordered.hint'), icon: '1.', keywords: 'number ordered list ol 번호', run: (e, r) => e.chain().focus().deleteRange(r).toggleOrderedList().run() },
  { title: t('slash.todo'), hint: t('slash.todo.hint'), icon: '☑', keywords: 'todo task check 할일 체크', run: (e, r) => e.chain().focus().deleteRange(r).toggleTaskList().run() },
  { title: t('slash.table'), hint: t('slash.table.hint'), icon: '▦', keywords: 'table grid 표 테이블', run: (e, r) => e.chain().focus().deleteRange(r).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
  ...(Object.entries(CALLOUTS) as [Variant, (typeof CALLOUTS)[Variant]][]).map(([v, c]) => ({
    title: t('slash.panel', { label: c.label }), hint: t('slash.panel.hint'), icon: c.icon, keywords: `callout panel note 패널 콜아웃 ${v} ${c.label}`,
    run: (e: Editor, r: Range) => e.chain().focus().deleteRange(r).setCallout(v).run(),
  })),
  { title: t('slash.code'), hint: t('slash.code.hint'), icon: '</>', keywords: 'code snippet 코드', run: (e, r) => e.chain().focus().deleteRange(r).toggleCodeBlock().run() },
  {
    title: t('slash.diagram'), hint: t('slash.diagram.hint'), icon: '◇', keywords: 'diagram mermaid flowchart sequence 다이어그램 흐름도 순서도',
    run: (e, r) => e.chain().focus().deleteRange(r).insertContent({ type: 'codeBlock', attrs: { language: 'mermaid' }, content: [{ type: 'text', text: 'flowchart LR\n  A[시작] --> B{확인}\n  B -->|예| C[배포]\n  B -->|아니오| D[수정]' }] }).run(),
  },
  { title: t('slash.quote'), hint: t('slash.quote.hint'), icon: '❝', keywords: 'quote blockquote 인용', run: (e, r) => e.chain().focus().deleteRange(r).toggleBlockquote().run() },
  { title: t('slash.divider'), hint: t('slash.divider.hint'), icon: '—', keywords: 'divider hr line rule 구분선', run: (e, r) => e.chain().focus().deleteRange(r).setHorizontalRule().run() },
  {
    title: t('slash.file'), hint: t('slash.file.hint'), icon: '📎', keywords: 'image file upload attach 이미지 파일 첨부',
    run: (e, r) => {
      e.chain().focus().deleteRange(r).run()
      e.view.dom.dispatchEvent(new CustomEvent('ph:pick-file', { bubbles: true }))
    },
  },
]

type MenuHandle = { onKeyDown: (e: KeyboardEvent) => boolean }

// "@" in a page: pick a teammate. They get a notification when the page is saved.
const PeopleMenu = forwardRef<MenuHandle, SuggestionProps<Person>>(function PeopleMenu({ items, command }, ref) {
  const [sel, setSel] = useState(0)
  useEffect(() => setSel(0), [items])
  useImperativeHandle(ref, () => ({
    onKeyDown: (e) => {
      if (!items.length) return false
      if (e.key === 'ArrowDown') return setSel((s) => (s + 1) % items.length), true
      if (e.key === 'ArrowUp') return setSel((s) => (s + items.length - 1) % items.length), true
      if (e.key === 'Enter' || e.key === 'Tab') return command({ id: String(items[sel].id), label: items[sel].name } as any), true
      return false
    },
  }))
  if (!items.length) return <div className="slash-menu people-menu"><div className="muted pad">{t('mention.none')}</div></div>
  return (
    <div className="slash-menu people-menu" role="listbox">
      {items.map((u, i) => (
        <button key={u.id} role="option" aria-selected={i === sel} className={i === sel ? 'active' : ''} onMouseEnter={() => setSel(i)}
          onMouseDown={(e) => (e.preventDefault(), command({ id: String(u.id), label: u.name } as any))}>
          <span className="avatar">{u.name.slice(0, 1)}</span>
          <span><b>{u.name}</b><small>{u.email}</small></span>
        </button>
      ))}
    </div>
  )
})

/** Positions a suggestion popup under (or above) the caret. Shared by the "/" and "@" menus. */
function popup<T>(Comp: any) {
  let r: ReactRenderer<MenuHandle, SuggestionProps<T>> | null = null
  const place = (p: SuggestionProps<T>) => {
    const rect = p.clientRect?.()
    const el = r?.element as HTMLElement | undefined
    if (!rect || !el) return
    const below = rect.bottom + 320 < innerHeight
    el.style.left = `${Math.min(rect.left, innerWidth - 300)}px`
    el.style.top = below ? `${rect.bottom + 6}px` : `${rect.top - 6}px`
    el.style.transform = below ? '' : 'translateY(-100%)'
  }
  return {
    onStart: (p: SuggestionProps<T>) => {
      r = new ReactRenderer(Comp, { props: p, editor: p.editor })
      const el = r.element as HTMLElement
      el.style.position = 'fixed'
      el.style.zIndex = '50'
      document.body.appendChild(el)
      place(p)
    },
    onUpdate: (p: SuggestionProps<T>) => (r?.updateProps(p), place(p)),
    onKeyDown: ({ event }: { event: KeyboardEvent }) => (event.key === 'Escape' ? (r?.destroy(), r?.element.remove(), (r = null), true) : !!r?.ref?.onKeyDown(event)),
    onExit: () => (r?.destroy(), r?.element.remove(), (r = null)),
  }
}

const People = Mention.configure({
  HTMLAttributes: { class: 'mention' },
  renderText: ({ node }) => `@${node.attrs.label}`,
  renderHTML: ({ options, node }) => ['span', { ...options.HTMLAttributes, 'data-type': 'mention', 'data-id': node.attrs.id }, `@${node.attrs.label}`],
  suggestion: {
    char: '@',
    items: async ({ query }) => {
      const q = query.toLowerCase()
      return (await listPeople()).filter((u) => !q || u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q)).slice(0, 8)
    },
    render: () => popup<Person>(PeopleMenu),
  },
})
const SlashMenu = forwardRef<MenuHandle, SuggestionProps<SlashItem>>(function SlashMenu({ items, command }, ref) {
  const [sel, setSel] = useState(0)
  useEffect(() => setSel(0), [items])
  useEffect(() => document.querySelector('.slash-menu .active')?.scrollIntoView({ block: 'nearest' }), [sel])
  useImperativeHandle(ref, () => ({
    onKeyDown: (e) => {
      if (!items.length) return false
      if (e.key === 'ArrowDown') return setSel((s) => (s + 1) % items.length), true
      if (e.key === 'ArrowUp') return setSel((s) => (s + items.length - 1) % items.length), true
      if (e.key === 'Enter') return command(items[sel]), true
      return false
    },
  }))
  if (!items.length) return <div className="slash-menu"><div className="muted pad">{t('slash.none')}</div></div>
  return (
    <div className="slash-menu" role="listbox">
      {items.map((it, i) => (
        <button
          key={it.title}
          role="option"
          aria-selected={i === sel}
          className={i === sel ? 'active' : ''}
          onMouseEnter={() => setSel(i)}
          onMouseDown={(e) => (e.preventDefault(), command(it))}
        >
          <span className="slash-icon">{it.icon}</span>
          <span>
            <b>{it.title}</b>
            <small>{it.hint}</small>
          </span>
        </button>
      ))}
    </div>
  )
})

const Slash = Extension.create({
  name: 'slash',
  addProseMirrorPlugins() {
    return [
      Suggestion<SlashItem>({
        editor: this.editor,
        pluginKey: new PluginKey('slash'),
        char: '/',
        allowSpaces: true,
        allow: ({ state, range }) => !state.doc.resolve(range.from).parent.type.spec.code,
        items: ({ query }) => {
          const q = query.toLowerCase()
          const words = q.split(/\s+/).filter(Boolean)
          return SLASH_ITEMS.filter((i) => {
            const hay = `${i.title} ${i.keywords}`.toLowerCase()
            return words.every((w) => hay.includes(w)) || hay.replace(/\s+/g, '').includes(q.replace(/\s+/g, ''))
          })
        },
        command: ({ editor, range, props }) => props.run(editor, range),
        render: () => {
          let r: ReactRenderer<MenuHandle, SuggestionProps<SlashItem>> | null = null
          const place = (p: SuggestionProps<SlashItem>) => {
            const rect = p.clientRect?.()
            const el = r?.element as HTMLElement | undefined
            if (!rect || !el) return
            const below = rect.bottom + 320 < innerHeight
            el.style.left = `${Math.min(rect.left, innerWidth - 300)}px`
            el.style.top = below ? `${rect.bottom + 6}px` : `${rect.top - 6}px`
            el.style.transform = below ? '' : 'translateY(-100%)'
          }
          return {
            onStart: (p) => {
              r = new ReactRenderer(SlashMenu, { props: p, editor: p.editor })
              const el = r.element as HTMLElement
              el.style.position = 'fixed'
              el.style.zIndex = '50'
              document.body.appendChild(el)
              place(p)
            },
            onUpdate: (p) => {
              r?.updateProps(p)
              place(p)
              if (r) (r.element as HTMLElement).style.display = !p.items.length && /\s/.test(p.query) ? 'none' : ''
            },
            onKeyDown: ({ event }) => {
              if (event.key === 'Escape') return r?.destroy(), r?.element.remove(), (r = null), true
              if (r && (r.element as HTMLElement).style.display === 'none') return false
              return !!r?.ref?.onKeyDown(event)
            },
            onExit: () => (r?.destroy(), r?.element.remove(), (r = null)),
          }
        },
      }),
    ]
  },
})

const lowlight = createLowlight({ bash, c, cpp, csharp, css, diff, dockerfile, go, ini, java, javascript, json, kotlin, makefile, markdown, nginx, plaintext, properties, python, rust, shell, sql, typescript, xml, yaml })
lowlight.registerAlias({ xml: ['html', 'svg'], bash: ['sh', 'zsh'], yaml: ['yml'], javascript: ['js', 'jsx'], typescript: ['ts', 'tsx'], ini: ['toml'], dockerfile: ['docker'], python: ['py'] })

/** Text an inline comment points at. Overlaps other comments; the comment list decides which ones are highlighted. */
export const CommentMark = Mark.create({
  name: 'comment',
  inclusive: false,
  excludes: '',
  addAttributes: () => ({ id: { default: null, parseHTML: (el) => el.getAttribute('data-comment'), renderHTML: (a) => ({ 'data-comment': a.id }) } }),
  parseHTML: () => [{ tag: 'span[data-comment]' }],
  renderHTML: ({ HTMLAttributes }) => ['span', mergeAttributes({ class: 'inline-comment' }, HTMLAttributes), 0],
})

// ---------- Mermaid diagrams: a ```mermaid code block shows the rendered diagram under it ----------
let mermaidLib: Promise<typeof import('mermaid').default> | null = null
const svgCache = new Map<string, string>()
function renderMermaid(src: string, el: HTMLElement) {
  const done = (svg: string) => ((el.innerHTML = svg), el.classList.remove('loading'))
  if (svgCache.has(src)) return done(svgCache.get(src)!)
  mermaidLib ??= import('mermaid').then((m) => {
    const dark = document.documentElement.dataset.theme === 'dark' || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches)
    // strict: labels can't carry HTML or script; the SVG is sanitized by mermaid itself.
    m.default.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'default' })
    return m.default
  })
  mermaidLib
    .then((m) => m.render(`mmd-${Math.random().toString(36).slice(2)}`, src))
    .then(({ svg }) => (svgCache.size > 100 && svgCache.clear(), svgCache.set(src, svg), done(svg)))
    .catch((e) => ((el.textContent = `${t('mermaid.error')}: ${String(e?.message ?? e).split('\n')[0]}`), el.classList.add('error'), el.classList.remove('loading')))
}
const MermaidPreview = Extension.create({
  name: 'mermaidPreview',
  addProseMirrorPlugins: () => [
    new Plugin({
      key: new PluginKey('mermaidPreview'),
      props: {
        decorations(state) {
          const decos: Decoration[] = []
          state.doc.descendants((node, pos) => {
            if (node.type.name !== 'codeBlock' || node.attrs.language !== 'mermaid' || !node.textContent.trim()) return
            const src = node.textContent
            // Keyed by the source, so the widget is only rebuilt when the diagram text changes.
            decos.push(Decoration.widget(pos + node.nodeSize, () => {
              const el = document.createElement('div')
              el.className = 'mermaid-preview loading'
              el.contentEditable = 'false'
              renderMermaid(src, el)
              return el
            }, { key: `mmd:${src}`, side: -1, ignoreSelection: true }))
            return false
          })
          return DecorationSet.create(state.doc, decos)
        },
      },
    }),
  ],
})

export type Live = { doc: Y.Doc; provider: { awareness: unknown } & Record<string, any>; user: { name: string; color: string } }

/** With `live`, the editor is bound to a shared Yjs document (co-editing): undo then follows only your own edits. */
export function extensions(live?: Live) {
  return [
    StarterKit.configure({ codeBlock: false, link: { openOnClick: false, autolink: true }, ...(live && { undoRedo: false }) }),
    ...(live ? [Collaboration.configure({ document: live.doc }), CollaborationCaret.configure({ provider: live.provider, user: live.user })] : []),
    CodeBlockLowlight.configure({ lowlight, defaultLanguage: null }),
    Image,
    TableKit.configure({ table: { resizable: true } }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Highlight,
    CommentMark,
    MermaidPreview,
    TextAlign.configure({ types: ['heading', 'paragraph'] }),
    Typography,
    Callout,
    Slash,
    People,
    Placeholder.configure({
      placeholder: ({ node }) => (node.type.name === 'heading' ? t('page.placeholder.heading') : t('page.placeholder')),
      includeChildren: false,
    }),
  ]
}

export const CODE_LANGUAGES = lowlight.listLanguages().sort()
