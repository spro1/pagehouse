// Email for notifications. Off unless SMTP_URL is set. Every minute, unread notifications older than a few minutes
// are sent as one email per person (reading them in the app first means no email at all).
import nodemailer from 'nodemailer'
import type { Db } from './db.ts'

const DELAY_MIN = 3
export const TEXT = {
  en: {
    subject: (n: number) => (n === 1 ? '1 new notification' : `${n} new notifications`),
    mention: '{actor} mentioned you in {page}', comment_mention: '{actor} mentioned you in a comment on {page}',
    reply: '{actor} replied to your comment on {page}', comment: '{actor} commented on {page}', update: '{actor} updated {page}',
    footer: 'You can turn these emails off in Settings.',
  },
  ko: {
    subject: (n: number) => `새 알림 ${n}개`,
    mention: '{actor}님이 {page}에서 나를 언급했습니다', comment_mention: '{actor}님이 {page}의 댓글에서 나를 언급했습니다',
    reply: '{actor}님이 {page}에서 내 댓글에 답했습니다', comment: '{actor}님이 {page}에 댓글을 달았습니다', update: '{actor}님이 {page}을(를) 수정했습니다',
    footer: '설정에서 이메일 알림을 끌 수 있습니다.',
  },
}
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

export const mailEnabled = () => !!process.env.SMTP_URL

let direct: ReturnType<typeof nodemailer.createTransport> | null = null
/** One message right away (password reset); notifications go through the batching mailer below. */
export async function sendMail(to: string, subject: string, text: string) {
  if (!process.env.SMTP_URL) throw new Error('mail is not configured')
  direct ??= nodemailer.createTransport(process.env.SMTP_URL)
  await direct.sendMail({ from: process.env.SMTP_FROM || 'Pagehouse <pagehouse@localhost>', to, subject, text })
}

export function startMailer(db: Db) {
  if (!process.env.SMTP_URL) return () => {}
  const transport = nodemailer.createTransport(process.env.SMTP_URL)
  const from = process.env.SMTP_FROM || 'Pagehouse <pagehouse@localhost>'
  const base = process.env.PUBLIC_URL?.replace(/\/$/, '') ?? ''
  let running = false
  const tick = async () => {
    if (running) return
    running = true
    try {
      // Claim a batch atomically, so two app instances never send the same notice twice.
      const rows = (await db.query(
        `UPDATE notifications n SET emailed_at = now()
         FROM users u WHERE n.id IN (
           SELECT id FROM notifications WHERE emailed_at IS NULL AND read_at IS NULL
             AND created_at < now() - make_interval(mins => $1) ORDER BY id LIMIT 500 FOR UPDATE SKIP LOCKED)
           AND u.id = n.user_id
         RETURNING n.id, n.user_id, n.kind, n.page_id, u.email, u.locale, u.email_notify,
           (SELECT title FROM pages WHERE id = n.page_id) AS page, (SELECT name FROM users WHERE id = n.actor_id) AS actor`,
        [DELAY_MIN],
      )).rows
      const byUser = new Map<number, typeof rows>()
      for (const r of rows) if (r.email_notify) byUser.set(r.user_id, [...(byUser.get(r.user_id) ?? []), r])
      for (const items of byUser.values()) {
        const L = TEXT[items[0].locale === 'ko' ? 'ko' : 'en']
        const line = (r: any) => (L[r.kind as 'mention'] ?? r.kind).replace('{actor}', r.actor ?? '?').replace('{page}', `“${r.page}”`)
        const link = (r: any) => (base ? `${base}/#/p/${r.page_id}` : '')
        await transport.sendMail({
          from, to: items[0].email, subject: `[Pagehouse] ${L.subject(items.length)}`,
          text: items.map((r) => `- ${line(r)}${link(r) ? `\n  ${link(r)}` : ''}`).join('\n') + `\n\n${L.footer}`,
          html: `<ul>${items.map((r) => `<li>${link(r) ? `<a href="${esc(link(r))}">${esc(line(r))}</a>` : esc(line(r))}</li>`).join('')}</ul><p style="color:#888">${esc(L.footer)}</p>`,
        }).catch((e) => console.error(`mail to user ${items[0].user_id} failed:`, e.message))
      }
    } catch (e) {
      console.error('mailer:', (e as Error).message)
    } finally {
      running = false
    }
  }
  const timer = setInterval(tick, 60_000)
  timer.unref()
  return () => clearInterval(timer)
}
