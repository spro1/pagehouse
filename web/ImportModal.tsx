import { useRef, useState } from 'react'
import { t, type Key } from './i18n.ts'
import { Icon } from './icons.tsx'
import { Modal } from './ui.tsx'
import type { Plan, Progress, Result, Warning } from './importer.ts'

type Props = { spaceId: number; spaceName: string; parentId: number | null; parentTitle?: string; onClose: () => void; onDone: () => void }
type Step = { s: 'pick'; error?: string } | { s: 'reading' } | { s: 'review'; plan: Plan } | { s: 'running'; p: Progress } | { s: 'done'; r: Result }

/** Page titles in tree order with their depth, for the preview list. */
function preview(plan: Plan): { title: string; depth: number }[] {
  const items: { key: string; parent: string | null; title: string }[] = plan.kind === 'pagehouse'
    ? plan.manifest.pages.map((p: any) => ({ key: String(p.id), parent: p.parentId == null ? null : String(p.parentId), title: p.title }))
    : plan.docs.map((d) => ({ key: d.key, parent: d.parent, title: d.title }))
  const kids = new Map<string | null, typeof items>()
  for (const it of items) kids.set(it.parent, [...(kids.get(it.parent) ?? []), it])
  const keys = new Set(items.map((i) => i.key))
  const out: { title: string; depth: number }[] = []
  const walk = (parent: string | null, depth: number) => {
    for (const it of kids.get(parent) ?? []) {
      out.push({ title: it.title, depth })
      if (depth < 30) walk(it.key, depth + 1)
    }
  }
  walk(null, 0)
  // Pages whose parent isn't part of the import are roots too.
  for (const it of items) if (it.parent && !keys.has(it.parent)) out.push({ title: it.title, depth: 0 })
  return out
}

// The importer pulls in the Markdown parser and ZIP reader; load it only when someone imports.
const load = () => import('./importer.ts')

export function ImportModal({ spaceId, spaceName, parentId, parentTitle, onClose, onDone }: Props) {
  const [step, setStep] = useState<Step>({ s: 'pick' })
  const [over, setOver] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const folder = useRef<HTMLInputElement>(null)
  const where = parentTitle ? `“${parentTitle}”` : t('import.top', { space: spaceName })

  async function choose(files: File[]) {
    if (!files.length) return
    setStep({ s: 'reading' })
    try {
      const m = await load()
      const plan = m.plan(await m.readFiles(files))
      if (plan.kind !== 'pagehouse' && !plan.docs.length) return setStep({ s: 'pick', error: t('import.empty') })
      setStep({ s: 'review', plan })
    } catch (e: any) {
      setStep({ s: 'pick', error: t('import.failed', { msg: e.message }) })
    }
  }
  async function start(plan: Plan) {
    const m = await load()
    setStep({ s: 'running', p: { done: 0, total: plan.kind === 'pagehouse' ? plan.manifest.pages.length : plan.docs.length, current: '' } })
    const r = await m.run(plan, spaceId, parentId, (p) => setStep({ s: 'running', p }))
    setStep({ s: 'done', r })
    onDone()
  }

  const count = step.s === 'review' ? (step.plan.kind === 'pagehouse' ? step.plan.manifest.pages.length : step.plan.docs.length) : 0
  const busy = step.s === 'reading' || step.s === 'running'
  const footer = (
    <>
      <span className="note-text">{t('import.safe')}</span>
      {step.s === 'done' ? (
        <>
          <button onClick={() => setStep({ s: 'pick' })}>{t('import.again')}</button>
          {step.r.created[0] && (
            <button className="primary" onClick={() => ((location.hash = `#/p/${step.r.created[0].id}`), onClose())}>
              {t('import.openFirst', { title: step.r.created[0].title.slice(0, 24) })}
            </button>
          )}
        </>
      ) : (
        <>
          <button onClick={onClose} disabled={step.s === 'running'}>{t('common.cancel')}</button>
          <button className="primary" disabled={step.s !== 'review'} onClick={() => step.s === 'review' && start(step.plan)}>
            {t('import.start', { n: count })}
          </button>
        </>
      )}
    </>
  )

  return (
    <Modal title={t('import.title')} onClose={busy ? () => {} : onClose} footer={footer}>
      <p className="muted small import-where">{t('import.into', { where })}</p>
      <div className="import-area">
        {step.s === 'pick' && (
          <div
            className={`dropzone ${over ? 'over' : ''}`}
            onDragOver={(e) => (e.preventDefault(), setOver(true))}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => (e.preventDefault(), setOver(false), choose([...e.dataTransfer.files]))}
          >
            <Icon name="page" size={28} />
            <p>
              {t('import.drop')}{' '}
              <button className="link" onClick={() => input.current?.click()}>{t('import.choose')}</button>{' '}
              {t('import.or')}{' '}
              <button className="link" onClick={() => folder.current?.click()}>{t('import.chooseFolder')}</button>
            </p>
            <p className="muted small">{t('import.formats')}</p>
            {step.error && <p className="error">{step.error}</p>}
            <input ref={input} type="file" hidden multiple accept=".md,.markdown,.html,.htm,.txt,.zip" onChange={(e) => choose([...(e.target.files ?? [])])} />
            <input ref={folder} type="file" hidden {...{ webkitdirectory: '' }} onChange={(e) => choose([...(e.target.files ?? [])])} />
          </div>
        )}
        {step.s === 'reading' && <div className="import-center"><span className="spinner" /> {t('import.reading')}</div>}
        {step.s === 'review' && (
          <div className="import-review">
            <div className="import-kind"><Icon name="page" /> <b>{t(`import.kind.${step.plan.kind}` as Key)}</b></div>
            <p className="muted small">{t('import.found', { n: count })}</p>
            <ul className="import-list">
              {preview(step.plan).slice(0, 300).map((d, i) => (
                <li key={i} style={{ paddingLeft: d.depth * 16 }}>{d.depth ? '└ ' : ''}{d.title}</li>
              ))}
            </ul>
            {step.plan.skipped.length > 0 && <p className="muted small">{t('import.skipped', { n: step.plan.skipped.length })}</p>}
            {!!step.plan.notes?.length && <p className="muted small">{t('import.notes', { list: step.plan.notes.join(', ') })}</p>}
          </div>
        )}
        {step.s === 'running' && (
          <div className="import-center column">
            <div className="progress"><span style={{ width: `${(step.p.done / Math.max(step.p.total, 1)) * 100}%` }} /></div>
            <b>{t('import.running', { done: step.p.done, total: step.p.total })}</b>
            <span className="muted small ellipsis">{step.p.current}</span>
          </div>
        )}
        {step.s === 'done' && (
          <div className="import-review">
            <div className="import-kind ok"><b>✓ {t('import.done', { n: step.r.created.length })}</b></div>
            {step.r.warnings.length > 0 && <Warnings list={step.r.warnings} onOpen={onClose} />}
          </div>
        )}
      </div>
    </Modal>
  )
}

const KINDS: Warning['kind'][] = ['page-failed', 'file-too-big', 'file-failed', 'file-missing', 'link-outside']

/** What the import couldn't carry over, grouped by why, each group saying what to do; pages open on click. */
function Warnings({ list, onOpen }: { list: Warning[]; onOpen: () => void }) {
  return (
    <div className="import-warnings">
      <p className="muted small">{t('import.warnings', { n: list.length })}</p>
      {KINDS.map((k) => {
        const items = list.filter((w) => w.kind === k)
        if (!items.length) return null
        return (
          <details key={k} open={k !== 'link-outside'}>
            <summary><b>{t(`import.w.${k}` as Key)}</b> <span className="muted">({items.length})</span></summary>
            <p className="muted small">{t(`import.w.${k}.fix` as Key)}</p>
            <ul className="import-list warn">
              {items.map((w, i) => (
                <li key={i}>
                  {w.pageId ? <a href={`#/p/${w.pageId}`} onClick={onOpen}>{w.page}</a> : w.page}
                  {w.item && <span className="muted"> — {w.item}</span>}
                </li>
              ))}
            </ul>
          </details>
        )
      })}
    </div>
  )
}
