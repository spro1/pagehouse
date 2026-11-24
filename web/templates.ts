// Starting documents for new pages. Plain ProseMirror JSON so they survive export and migration as-is.
import { lang, t, type Key } from './i18n.ts'

const text = (s: string) => ({ type: 'text', text: s })
const p = (s = '') => ({ type: 'paragraph', content: s ? [text(s)] : [] })
const h = (level: number, k: Key) => ({ type: 'heading', attrs: { level }, content: [text(t(k))] })
const cell = (s = '', header = false) => ({ type: header ? 'tableHeader' : 'tableCell', content: [p(s)] })
const table = (head: Key[], rows: number) => ({
  type: 'table',
  content: [
    { type: 'tableRow', content: head.map((k) => cell(t(k), true)) },
    ...Array.from({ length: rows }, () => ({ type: 'tableRow', content: head.map(() => cell()) })),
  ],
})
const callout = (variant: string, s: string) => ({ type: 'callout', attrs: { variant }, content: [p(s)] })
const tasks = (n: number) => ({
  type: 'taskList',
  content: Array.from({ length: n }, () => ({ type: 'taskItem', attrs: { checked: false }, content: [p()] })),
})
const bullets = () => ({ type: 'bulletList', content: [{ type: 'listItem', content: [p()] }] })

function weekLabel(d = new Date()) {
  const week = Math.ceil((d.getDate() + new Date(d.getFullYear(), d.getMonth(), 1).getDay()) / 7)
  if (lang === 'ko') return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${week}주차`
  return `${d.toLocaleDateString('en', { month: 'short', year: 'numeric' })}, week ${week}`
}
const today = () => new Date().toLocaleDateString(lang === 'ko' ? 'ko' : 'en-CA')

export type Template = { key: string; name: string; desc: string; icon: string; title: () => string; doc: () => object }

export const TEMPLATES: Template[] = [
  {
    key: 'blank', name: t('tpl.blank'), desc: t('tpl.blank.desc'), icon: '📄',
    title: () => t('common.untitled'), doc: () => ({ type: 'doc', content: [p()] }),
  },
  {
    key: 'weekly', name: t('tpl.weekly'), desc: t('tpl.weekly.desc'), icon: '🗓️',
    title: () => t('tpl.weekly.title', { week: weekLabel() }),
    doc: () => ({
      type: 'doc',
      content: [
        callout('info', t('tpl.weekly.note')),
        h(2, 'tpl.weekly.done'),
        table(['tpl.col.owner', 'tpl.col.task', 'tpl.col.progress', 'tpl.col.status'], 3),
        h(2, 'tpl.weekly.next'),
        table(['tpl.col.owner', 'tpl.col.task', 'tpl.col.goal'], 3),
        h(2, 'tpl.weekly.issues'),
        bullets(),
      ],
    }),
  },
  {
    key: 'meeting', name: t('tpl.meeting'), desc: t('tpl.meeting.desc'), icon: '📝',
    title: () => t('tpl.meeting.title', { date: today() }),
    doc: () => ({
      type: 'doc',
      content: [
        table(['tpl.col.when', 'tpl.col.where', 'tpl.col.who'], 1),
        h(2, 'tpl.meeting.agenda'),
        bullets(),
        h(2, 'tpl.meeting.discussion'),
        p(),
        h(2, 'tpl.meeting.decisions'),
        callout('success', ''),
        h(2, 'tpl.meeting.actions'),
        tasks(2),
      ],
    }),
  },
  {
    key: 'tech', name: t('tpl.tech'), desc: t('tpl.tech.desc'), icon: '🛠️',
    title: () => t('tpl.tech.title'),
    doc: () => ({
      type: 'doc',
      content: [
        callout('info', t('tpl.tech.summary')),
        h(2, 'tpl.tech.background'),
        p(),
        h(2, 'tpl.tech.design'),
        p(),
        h(2, 'tpl.tech.verify'),
        table(['tpl.col.item', 'tpl.col.method', 'tpl.col.result'], 2),
        h(2, 'tpl.tech.refs'),
        bullets(),
      ],
    }),
  },
]
