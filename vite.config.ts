import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { brandHtml } from './server/html.ts'

export default defineConfig({
  plugins: [
    react(),
    // In development too, the page starts with the name and logo from Admin → Branding (see server/index.ts).
    {
      name: 'branding',
      apply: 'serve',
      transformIndexHtml: async (html) => {
        const b = await fetch('http://localhost:3000/api/auth/branding').then((r) => r.json(), () => null)
        return b ? brandHtml(html, b) : html
      },
    },
  ],
  server: { proxy: { '/api': { target: 'http://localhost:3000', ws: true } } },
})
