# Working on Party Mode

## Keep the docs current

Every change that affects them updates the docs in the same commit, except the README:

- **README.md** is for people installing and running a party, and the owner edits it.
  Don't change it unless asked. When a change affects anything they see or do (features,
  settings: names, defaults, meanings; installing, the guest pages or the Party Hub,
  troubleshooting), remind the owner what the README should add or clarify instead.
- **DEVELOPER.md** is for people working on the code. Update it when how things work
  changes: architecture, files, matching and attribution rules, tests, translations,
  Docker and publishing, known limitations.
- **RELEASES.md** is the user-friendly list of changes, newest version first. Every
  change people would notice (features, settings, fixes, the pages) adds a line under the
  version in progress, in the same commit, in the README's plain language. Internal
  changes (refactors, tests, workflows) don't go in. Security fixes are summed up as
  "Various security enhancements", with details only for what a host or guest would
  notice in normal use. A version bump in `package.json`
  starts a new section; the version in progress says it isn't released yet. On `experimental`, `package.json`'s
  version keeps a suffix (`1.2.0-experimental`) until the release bump: the publish
  workflow refuses an experimental build without one.
- If a change touches none of these, say so in the pull request rather than editing the docs.
- Example addresses in the docs and tests use the TEST-NET-1 range `192.0.2.0/24` (e.g.
  `http://192.0.2.10:8338/PartyHub`), never a real private address. Tests that bind a
  port use `127.0.0.1`.

## Conventions the owner has asked for

- Branches follow DEVELOPER.md's [Branches](DEVELOPER.md#branches): `main` is released,
  `experimental` is the next version, big work gets a branch off `experimental`, fixes to
  the release a branch off `main` (`fix-<version>`). Merge into `main` only through a
  pull request, and only when asked. Never merge Dependabot's pull requests on `main`;
  take the update into `experimental`. Whenever something lands on `main`, merge `main`
  into `experimental` before the next change there.
- **Never publish the Docker image without asking first, every time, and never set it to
  publish automatically.** Claude may run the workflow (Actions → Publish Docker image,
  or `gh workflow run docker-publish.yml --ref <branch>`) only after the owner says yes to
  that specific publish; a yes never covers the next one. Keep its push, tags and schedule
  triggers commented out, and put `[skip ci]` in merge commit titles. After every
  release, ask the owner whether to publish it.
- Bump `version` in `package.json` for a release; Roon shows it as the extension's version.
- After merging a release into `main`, tag the merge commit with an annotated tag
  `v<version>` (e.g. `v1.1.0`) and push the tag. The workflow's `tags` trigger stays
  commented out, so a tag doesn't publish the Docker image either.
- Once the Docker image for a release is published, add its digest (from the
  workflow run's summary, or `docker buildx imagetools inspect`) under the version's
  heading in RELEASES.md: ``Docker image: `stubaggs/roon-extension-party-mode:<version>@sha256:…` ``.
  Release numbers on Docker Hub are never republished; the workflow refuses to.
- Once the Docker image for a release is published, create a GitHub release for
  the tag (`gh release create v<version> --verify-tag --title "Party Mode <version>"
  --latest`). Its notes are that version's section of RELEASES.md, followed by a link to
  the full history in RELEASES.md.
- Extension settings and the Roon status line stay in English, as in other Roon
  extensions. Guest-facing pages are translated: every page string lives in
  `public/i18n/<code>.json` (30 languages, listed in DEVELOPER.md), and new page text
  needs all of them.
- Say **tracks**, not songs, in everything people see (pages, settings, docs): a track
  may be a poem or a speech. In translations use a neutral word, as Roon does (fr
  "morceau", de "Titel", es "pista", nl "nummer", it "brano", pt "faixa", sv/nb "spår"/
  "spor", da "nummer", fi "kappale", pl "utwór", cs "skladba", hu "szám", ro "piesă",
  ru/uk "трек", bg "запис", el "κομμάτι", tr "parça", vi "bài", he "רצועה", ar "مقطع",
  ar-EG "تراك", th "แทร็ก", ko "트랙", ja "トラック", zh "曲目"). "Song" stays only where it means the
  song as opposed to one recording of it, as in duplicate matching.
- Environment variables are named `ROON_EXTENSION_PARTY_MODE_<SETTING>` and read through
  `lib/env.js`, which also accepts the hyphenated `ROON-EXTENSION-PARTY-MODE_` spelling.
  When renaming one, keep the old name working.
- Source files carry the `Copyright 2026 Stubaggs` Apache-2.0 header.
- Run `npm test` before pushing.
