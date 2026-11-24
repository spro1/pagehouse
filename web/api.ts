import { hasKey, lang, t } from './i18n.ts'

export type PageNode = { id: number; parentId: number | null; kind: string; title: string; locked?: boolean }
export type Space = { id: number; key: string; name: string; defaultAccess?: 'edit' | 'view' | 'none'; role?: 'admin' | 'edit' | 'view' | null }
export type User = { id: number; email: string; name: string; role: string; locale: string | null; theme?: string | null }

export class ApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

export async function api<T = any>(path: string, opts: { method?: string; json?: unknown; body?: BodyInit } = {}): Promise<T> {
  const res = await fetch(path, {
    method: opts.method ?? (opts.json !== undefined || opts.body ? 'POST' : 'GET'),
    headers: opts.json !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: opts.json !== undefined ? JSON.stringify(opts.json) : opts.body,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    // The server sends a stable code plus an English message; show the code in the user's language.
    const key = `err.${data.code}`
    throw new ApiError(hasKey(key) ? t(key) : data.error ?? res.statusText, res.status)
  }
  return data
}

const locale = lang === 'ko' ? 'ko' : 'en'
const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
export function ago(iso: string | number) {
  const s = (new Date(iso).getTime() - Date.now()) / 1000
  for (const [unit, sec] of [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]] as const)
    if (Math.abs(s) >= sec) return rtf.format(Math.round(s / sec), unit)
  return t('time.justNow')
}

export const fullDate = (iso: string | number) =>
  new Date(iso).toLocaleString(locale, { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })

export { toast } from './ui.tsx'

export type Person = { id: number; name: string; email: string }
// The people list changes rarely; one request per page load serves mentions, pickers and comment chips.
let people: Promise<Person[]> | null = null
export const listPeople = () => (people ??= api<Person[]>('/api/users').catch(() => ((people = null), [])))
