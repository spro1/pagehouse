import { t } from './i18n.ts'
import './theme.ts'
import { createRoot } from 'react-dom/client'
import { App, reloadForNewRelease } from './App.tsx'
import './styles.css'

// The browser words its own form warnings ("fill out this field", "use at least 8 characters") in the OS language,
// not the one picked in Pagehouse. Replace them with ours, for every form in the app.
addEventListener('invalid', (e) => {
  const el = e.target as HTMLInputElement
  const v = el.validity
  el.setCustomValidity('')
  if (v.valueMissing) el.setCustomValidity(t('valid.required'))
  else if (v.typeMismatch && el.type === 'email') el.setCustomValidity(t('valid.email'))
  else if (v.tooShort) el.setCustomValidity(t('valid.tooShort', { n: el.minLength }))
  else if (v.tooLong) el.setCustomValidity(t('valid.tooLong', { n: el.maxLength }))
  else if (v.typeMismatch && el.type === 'url') el.setCustomValidity(t('valid.url'))
}, true)
// After an upgrade, a tab still running the old release can't load its old code files: reload once to get the new
// release. The flag stops a loop if loading keeps failing for another reason (network down).
addEventListener('vite:preloadError', (e) => {
  e.preventDefault()
  reloadForNewRelease()
})
// A custom message sticks until cleared, so clear it as the person types.
addEventListener('input', (e) => (e.target as HTMLInputElement).setCustomValidity?.(''), true)

createRoot(document.getElementById('root')!).render(<App />)
