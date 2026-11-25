## What and why

<!-- What changes, and the problem it solves. Link the issue: "Fixes #123". -->

## How it was checked

<!-- Tests added or run, and what you tried by hand (screenshots for UI changes). -->

## Checklist

- [ ] `npm run typecheck` and `npm test` pass
- [ ] Server changes have a test
- [ ] New UI text is in `web/i18n.ts` in both `en` and `ko`
- [ ] No user data can be lost: deletes stay soft, migrations only add (never edit a released one)
- [ ] Docs updated if behaviour or settings changed (README, `docs/`)
