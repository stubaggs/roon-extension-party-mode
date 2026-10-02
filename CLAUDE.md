# Working on Party Mode

## Keep the docs current

Every change that affects them updates the docs in the same commit:

- **README.md** is for people installing and running a party. Update it when anything they
  see or do changes: features, settings (names, defaults, meanings), installing, the guest
  pages or party screen, troubleshooting. Plain language, no internals.
- **Developer.md** is for people working on the code. Update it when how things work
  changes: architecture, files, matching and attribution rules, tests, translations,
  Docker and publishing, known limitations.
- If a change touches neither, say so in the pull request rather than editing the docs.

## Conventions the owner has asked for

- Work on a branch and merge into `main` through a pull request, only when asked.
- **Never publish the Docker image automatically.** Publishing is manual (Actions →
  Publish Docker image). Keep the workflow's push and schedule triggers commented out, and
  put `[skip ci]` in merge commit titles.
- Bump `version` in `package.json` for a release; Roon shows it as the extension's version.
- Extension settings and the Roon status line stay in English, as in other Roon
  extensions. Guest-facing pages are translated: every page string lives in
  `public/i18n/<code>.json` (en, fr, de, es, nl), and new page text needs all of them.
- Source files carry the `Copyright 2026 Stubaggs` Apache-2.0 header.
- Run `npm test` before pushing.
