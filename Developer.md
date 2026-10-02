# Party Mode: developer notes

How the extension works, how to run and test it, and how it is packaged and published.
For installing and using it, see the [README](README.md).

Guests scan a QR code, search your Roon library and streaming services, and add tracks
to one zone's queue from their phone. No Roon account, no remote, no access to anything
else in your system.

Packaged the way the [Extension Manager](https://github.com/TheAppgineer/roon-extension-manager)
expects: a Docker image with settings persisted in a bind-mounted `config.json`, and a
[repository entry](https://github.com/TheAppgineer/roon-extension-repository) that makes
it installable from inside Roon.

---

## How it fits together

```
Roon Core  ──(node-roon-api over the local network)──  app.js
                                                        │
                        RoonApiSettings   host config in Roon's Extension Settings
                        RoonApiStatus     "RoonParty at http://…"
                        RoonApiTransport  zone state, queue subscription, skip
                        RoonApiBrowse     search + "Queue" / "Add Next" actions
                        RoonApiImage      album art proxy
                                                        │
                                              Express on port 8338
                                                        │
                                     /            guest page (phones)
                                     /roonparty    QR code + queue (TV)
```

| File | What it does |
| --- | --- |
| `app.js` | Wires the Roon service to the web server |
| `lib/roon-service.js` | Pairing, settings layout, search, queue actions, queue subscription |
| `lib/track-id.js` | Track identity: title and artist normalisation, length, hash |
| `lib/guests.js` | Guest sessions, token-bucket limits, request attribution |
| `lib/history.js` | Played-songs list for the guest page |
| `lib/server.js` | REST API, server-sent events, QR code, image proxy |
| `public/` | Guest page and the RoonParty screen, no build step |
| `public/i18n/`, `lib/i18n.js` | Page text per language, and picking the language per browser |
| `test/` | Identity, attribution and settings tests, `npm test` |

## How a track is identified

Roon gives extensions no stable track ID to hold on to. A browse `item_key` is a
cursor into a browse session and expires; a `queue_item_id` exists only while the
track is queued and has no counterpart on a browse item. So identity is rebuilt from
what both sides carry — and the two sides carry different things:

| | title | artist | length |
| --- | --- | --- | --- |
| Search result (browse item) | yes | yes | **no** |
| Queue item | yes | yes | yes |
| Now playing | yes | yes | yes |

Because a search result has no length, the length and hash cannot be known when a
guest taps Request. They are learned a moment later: Roon reports a queue `insert`
for the track it just added, carrying the real `queue_item_id` and length, and that
item is matched back to the pending request. Attribution then works from the queue
item id rather than from a title guess, and the hash — `sha1(version-sensitive title,
sorted artists, length)`, truncated — keeps identifying the track after it leaves the
queue and appears in Played.

Crediting a track falls through five steps, exact first: queue item id, hash, same
recording by version-sensitive title, same song ignoring version tags, then a title
only one recent request has. Duplicate checking stops at the version-sensitive step,
because the last two deliberately treat a remaster as the original.

## Running it during development

```bash
npm install
node app.js
```

Then open Roon → Settings → Extensions and enable Party Mode. Open its settings, pick a
party zone, and the console prints the guest link and RoonParty URL. The extension writes
`config.json` next to `app.js`.

## Host settings (in Roon)

Party zone, party name, guest access on/off, and web port. Left blank, the party name is
the party zone's name (for a grouped zone, Roon's name for the group, such as "Kitchen +
Living Room"), and follows the zone if you change it; the setting shows which name that
is. Saving a new port moves the
guest and RoonParty pages there straight away, then the extension reconnects to the Core
(it drops out of Roon's list for up to ten seconds) so the link Roon shows is updated.
Open pages and phones on the old port need the new link or a fresh scan. `PARTY_PORT`
sets the port to start on before one has been saved in Roon.

The default port is 8338. The container shares the host's network, so the port has to be
free on the machine itself; 8338 was picked to stay clear of common defaults (8080, 3000,
5000, 8000, 8443, 9000), Roon's own ports (UDP 9003, TCP 9100-9200 and 9330-9339) and the
other Extension Manager extensions (8088, 9010, 3000). If you change it, stay between 1024
and 49151: higher ports are handed out by the OS for outgoing connections.

If the saved port is taken when the extension starts, it uses the next free one of the
following nine, and Roon's status line says so ("port 8338 was busy"); the QR code and
links follow. If all ten are taken, it still connects to Roon and asks for another port
in the settings. A port chosen in the settings while running is not swapped for another:
if it is busy, the extension stays where it is and says so.

### Guest profile

"Roon profile for guest requests" picks the Roon profile the extension uses, so the
tracks guests add count toward that profile's play history and Roon Radio instead of
yours. A "Guests" profile keeps party plays out of your own history. "Leave as it is"
doesn't touch the profile.

Roon's API has no profile call, so the extension opens the Profile entry in Roon's
Settings menu and selects the profile there.

Roon keeps the profile **per browse session and per hierarchy**: each
`multi_session_key` has its own profile in each hierarchy, a session nobody has selected
one in uses Roon's default ("Guest"), and a queue action counts toward the profile of the
session and hierarchy it was made in. Found on a real Core: selecting in a guest's
"settings" hierarchy switched it there ("Guest" → "Pat") while songs the same guest
queued from the "search" hierarchy still counted as Guest.

So guests search and queue in Roon's main **"browse"** hierarchy, the only one holding
both pieces:

```
Library  → Search (takes input) → Tracks → a track → Queue / Add Next
Settings → Profile → the profiles
```

Before a guest's first search or request, `RoonService._profileFor` selects the chosen
profile in that guest's browse session through Settings → Profile
(`selectProfileInBrowse`), once per guest, and again after the setting changes or the
Core reconnects. Their search then runs through Library → Search in the same session
(`_openSearch`), and everything after it (track category, action list) is unchanged.
Library and Settings are found by what they hold, not their names (`openTopEntry` in
`lib/titles.js`): Library is the top-level entry with a search box (an item with
`input_prompt`), Settings the one with the Profile entry. The extension's own session in
the "settings" hierarchy (`party-profile`) only reads the list for the settings dropdown.

The console logs `Profile "Party" selected for guest session …` with Roon's answer and
the profile before and after, and the first search's result categories
(`Search (Library → Search) result categories: …`), to check what the search covers. The
Profile entry is matched by its title, "Profile" in English, or its translations; on a
Core in another language that doesn't match, put its title in "Profile entry in
Settings". If something doesn't match, the setting shows what Roon offered and the
console logs it. Tests use a fake Core shaped like a real browse menu
(`test/fake-roon.js`).

### Picking the party zone

Roon's zone picker lists **endpoints**, not zones, so a zone made by grouping three
speakers appears as its three separate endpoints. Picking any one of them plays to the
whole group, because Roon resolves an endpoint to the zone that currently contains it.
That is why the picker's label names the zone it resolves to:

```
Party zone — plays to Kitchen + Living Room + Study (3 endpoints)
```

The setting stores one endpoint, not the group, and grouping is dynamic. So the zone
means "whichever zone holds this endpoint right now": ungroup the speakers while a party
is running and the extension quietly follows that one endpoint — guests keep adding
tracks, but only that speaker plays. Nothing errors, since the endpoint still exists.
Regroup and it follows the group again. The label is the place to check what it is
actually pointing at.

Links use the machine's first non-internal IPv4 address. Per-action allowances follow the token
bucket model: each guest starts with N goes and earns one back every M minutes, with
separate budgets for adding, playing next, and skipping. 0 goes per guest means no limit,
and 0 minutes means a used go never comes back; to stop guests doing something at all,
set its "Let guests …" to No. Adding and playing next are on
by default, skipping is off.

**Browse titles.** Roon localises its menus and the API doesn't say which language the
Core uses. The extension tries the titles in the collapsed **Advanced** group at the bottom of the
settings first (English by default: `Tracks`, `Queue`, `Add Next`, `Profile`), so an English Core behaves exactly as
written. When one isn't found, it works the menu out instead (`lib/titles.js`):

- **Track category:** the search category whose items open straight into play actions
  (albums and artists open into further lists).
- **Profile entry:** the word for "Profile" in the languages Roon is translated into.
- **Queue and Add Next:** by position in a track's action list (Play Now, Add Next,
  Queue, Start Radio), and only when the list has exactly those four actions. Any other
  shape is refused rather than guessed, since pressing the wrong one could play a
  guest's track straight away.

What it found shows in each setting's hint and in the console (`Browse titles: using
"Titel" as the Track category`). Typing the Core's own title into a setting overrides
the detection.

## Translating the pages

Available: English (`en`), French (`fr`), German (`de`), Spanish (`es`), Dutch (`nl`). The
non-English files are drafts (Thanks Claude), apologies for poor translations.

The guest page and the RoonParty screen take their text from `public/i18n/<code>.json`,
one file per language. Each browser gets the language it asks for (its
`Accept-Language`), so guests at the same party can each see their own; anything not
translated, or a missing key, falls back to `en.json`. Track, artist and album names come
from Roon as they are.

To add a language, copy `en.json` to e.g. `de.json` and translate the values, keeping the
`{name}`, `{count}` and `{wait}` placeholders. Entries like `{ "one": …, "other": … }` are
plurals, picked by the language's own rules; add `few`, `many` and so on where the
language has them. Times follow the language's clock format automatically. `npm test`
checks that a translation uses the same keys and placeholders as English. Restart the
extension to pick up a new file.

## Installing it from Roon

Once the image is on Docker Hub and the entry is in the Extension Repository, install it
with the [Extension Manager](https://github.com/TheAppgineer/roon-extension-manager):
Roon → Settings → Extensions → Extension Manager → Settings, pick the category, pick
Party Mode, choose Install. The Manager runs it with host networking (Roon discovery uses
UDP broadcast on port 9003) and bind-mounts `config.json` so settings survive updates.

## Publishing the image

`.github/workflows/docker-publish.yml` builds `linux/amd64`, `linux/arm/v6`,
`linux/arm/v7` and `linux/arm64` and pushes `stubaggs/roon-extension-party-mode:latest` to Docker Hub. For
now it only runs when started by hand (Actions → Publish Docker image → Run workflow);
the commented-out `push` trigger in the workflow publishes on every merge to `main` once
restored, and a commented-out weekly `schedule` rebuilds and republishes every Monday so
installs pick up base-image security fixes without a manual publish. It needs two
repository secrets, under Settings → Secrets and variables → Actions:

| Secret | Value |
| --- | --- |
| `DOCKERHUB_USERNAME` | `stubaggs` |
| `DOCKERHUB_TOKEN` | A Docker Hub access token with Read & Write scope |

The Extension Manager checks Docker Hub for a newer `latest`, so publishing a new
`latest` is how an update reaches people who have it installed.

The Dockerfile builds in two stages. The first installs dependencies exactly as
`package-lock.json` pins them (`npm ci`, which needs `git` for the Roon packages on
GitHub) and runs `npm test`, so a failing test stops the build. The second copies only
the app and its dependencies onto a clean base, with a health check that requests the
RoonParty data on the configured port.

The image is built for `linux/amd64`, `linux/arm64` and both 32-bit ARM variants:
Docker reports every 32-bit ARM host as `arm`, the key the repository entry uses, and
Pi Zero and Pi 1 need `arm/v6` while later Pis use `arm/v7`.

The base is `node:22-alpine`, pinned by digest. Node 22 is the newest line with 32-bit
ARM images (Node 24 dropped `linux/arm/v7`) and is supported until April 2027; before
then, move to Node 24 and drop `arm/v7` from the workflow and the repository entry.

Dependabot (`.github/dependabot.yml`) checks the base weekly. When the official image is
rebuilt with Alpine or Node security fixes, its digest changes and Dependabot opens a pull
request updating both `FROM` lines. It skips major Node versions, so it never moves the
image to Node 24 on its own. Merging that pull request changes the Dockerfile only: the
fixes reach installed copies once a new image is published. To update by hand, change
both `FROM` lines together (`docker buildx imagetools inspect node:22-alpine` prints the
current digest).

To run the image by hand instead:

```bash
docker run -d --name party-mode --network host \
  -v "$PWD/config.json:/usr/src/app/config.json" \
  stubaggs/roon-extension-party-mode:latest
```

`docker-compose.yml` does the same thing. Create `config.json` first and make it writable
(`touch config.json && chmod 666 config.json`): otherwise Docker makes a directory in its
place, and the extension, which runs as the image's unprivileged `node` user (uid 1000),
can't save its settings. If it can't, Roon's status line and the console say so. The
Extension Manager creates the file writable itself.

## Known limitations

**No queue reordering.** Roon's API can add a track to the end of the queue or directly
after the current one, and it can skip. It cannot move an item that is already in the
queue. So a guest can ask for a track to play next when they add it, but nobody can
promote a track that is already waiting. If you have seen Music Assistant's "boost an
upcoming song", that part does not have a Roon equivalent.

**Nicknames are optional.** Guests are asked for a name on their first visit; it shows as
a badge on the songs they add, in Up next, Played and on the RoonParty screen. The phone
remembers it (or that they skipped), so a rescan doesn't ask again. Unnamed requests show
as "a guest".

**"Roon Radio" is a guess.** Roon doesn't say where a track came from. When Roon Radio
is switched on for the party zone, any track no guest added is labelled "Roon Radio",
which includes tracks the host queues from the Roon app.

**Duplicates are per recording, not per song.** A remaster, a live take or a single
edit is a fair request even when the original is queued, so duplicate checking is
version-sensitive. The limit is that a search result has no length: where two
recordings share a title and artist and differ only in length — an album version and
a single edit both titled "Hey Jude" — they cannot be told apart at search time and
the second is refused as a duplicate. Once both are queued they are distinct, and get
their own badges.

**Attribution is exact once a track is queued, best-effort before that.** Roon queue
items carry no "who added this" field. A request is bound to its real queue item when
Roon reports the insert, which is exact; the fallbacks below that match on title and
artist, and ignore remaster tags, artist separators and extra artists. Two guests
asking for the same recording are credited in the order they asked, so if those two
inserts arrive out of order the badges swap. A request whose insert never arrives
within a minute — the host clears the queue, say — falls back to title matching. The
console logs each request, each queue insert with its length and hash, and each track
start, which is the place to look when a badge is wrong.

**Browse sessions are stateful.** Item keys are only valid until that guest's browse
session moves on. The server replays the search and retries once when a key has gone
stale, which covers the usual case of a guest searching again before tapping.

**Access control is a shared join code, not a login.** Anyone who can reach the port and
has scanned the code can add tracks. The RoonParty screen and its endpoints need no session at all.
Do not expose this to the internet.

**Played history is the extension's own.** Roon's API has no play history, so the
"Played" list on the guest page is recorded by the extension as tracks start. It is kept
in memory (last 200 songs) and starts over when the extension restarts or the party zone
changes.

**The queue subscription is per zone.** Changing the party zone starts a new subscription;
the old one is ignored rather than torn down, since the API has no convenient unsubscribe.

## Licence

Copyright 2026 Stubaggs. Licensed under the Apache License, Version 2.0 (see `LICENSE`),
matching the other extensions in the Appgineer repository.
