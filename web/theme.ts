// Light, dark, or follow the device. Applied before the first paint (imported by main.tsx), saved on the account.
export type Theme = 'system' | 'light' | 'dark'
export const THEMES: Theme[] = ['system', 'light', 'dark']

function stored(): Theme {
  try {
    const t = localStorage.getItem('ph:theme') as Theme | null
    if (t && THEMES.includes(t)) return t
  } catch {}
  return 'system'
}

export let theme: Theme = stored()

export function applyTheme(t: Theme) {
  theme = t
  if (t === 'system') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = t
  try {
    localStorage.setItem('ph:theme', t)
  } catch {}
  dispatchEvent(new CustomEvent('ph:theme', { detail: t }))
}

applyTheme(theme)
