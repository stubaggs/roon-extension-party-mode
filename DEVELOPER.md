# Party Mode: developer notes

How the extension is built, what it serves, and how it's packaged and published. For
installing and using it, see the [README](README.md); for building a screen of your own,
[EMBED.md](EMBED.md).

Guests scan a QR code, search the host's Roon library and streaming services, and add
tracks to one zone's queue from their phone, with no Roon account or remote and no access
to anything else. It ships as a Docker image that also installs through the
[Extension Manager](https://github.com/TheAppgineer/roon-extension-manager).

---

## How it fits together

```
Roon Core  ──(node-roon-api over the local network)──  app.js
                                                        │
                        RoonApiSettings   the settings in Roon
                        RoonApiStatus     the status line in Roon
                        RoonApiTransport  zone state, queue subscription, skip, play
                        RoonApiBrowse     search, Queue / Add Next, the Roon profile
                        RoonApiImage      album art
                                                        │
                                              Express on port 8338
```

| File | What it does |
| --- | --- |
| `app.js` | Wires the Roon service to the web server |
| `lib/roon-service.js` | Pairing, the settings layout, search, queue actions, the queue subscription, the status line |
| `lib/server.js` | The web server: pages, API, live updates, security headers |
| `lib/embed.js` | The `/embed/` views, built field by field |
| `lib/guests.js` | Guest sessions, allowances (token buckets), names |
| `lib/track-id.js` | Track identity, crediting and the duplicate check |
| `lib/titles.js` | Finding Roon's menu entries on a Core in any language |
| `lib/profiles.js` | Selecting the Roon profile in a browse session |
| `lib/history.js` | The guest page's Played list and skips |
| `lib/party-playlist.js` | The downloadable party playlist |
| `lib/qr.js` | The join and playlist QR codes, as SVG |
| `lib/art-cache.js` | Album art kept in memory, and the image keys that may be fetched |
| `lib/about.js` | The About page |
| `lib/i18n.js`, `public/i18n/`, `public/i18n-runtime.js` | Page text in 30 languages |
| `lib/ports.js`, `lib/env.js`, `lib/log.js` | The web port, environment variables, logging |
| `healthcheck.js` | Docker's health check |
| `party-mode-setup.sh` | The setup program for Linux (see [Setup program](#setup-program)) |
| `public/` | The guest page (`index.html`, `guest.js`), the Party Hub (`hub.html`, `hub.js`, `hub.css`, `hub-check.js`) and the basic Party Hub (`basic.html`, `basic.js`, `basic.css`); no build step |
| `test/` | `npm test` |
| `images/` | The title image (1280×640 for GitHub's social preview, 1600×840) and screenshots of the Party Hub and guest page; not in the Docker image |

## Running it with Node.js

Node.js 22 or newer, and git (the Roon API packages come from GitHub):

```bash
git clone https://github.com/stubaggs/roon-extension-party-mode.git
cd roon-extension-party-mode
npm ci
npm start
```

Enable Party Mode in Roon (Settings → Extensions) and pick a party zone; the console
prints the guest link and the Party Hub's address. Settings are written to `config.json`
in the folder it's started from.

Dependencies: Roon Labs' `node-roon-api*` packages (from `github:roonlabs/…`), `express`,
`express-rate-limit` and `qrcode-generator`. There are no development dependencies.

## Tests

`npm test` runs the files listed in `package.json` (add new ones there), with Node's
`assert` against a fake Core (`test/fake-roon.js`) and the real web server. The Docker
build runs them too, so a failing test stops a build. Before pushing, also build and run
the image (see [Running the image](#running-the-image)).

`party-mode-setup.sh` isn't in `npm test` (the image has no bash): check it with
`docker run --rm -v "$PWD:/mnt:ro" koalaman/shellcheck:stable /mnt/party-mode-setup.sh`.

## Endpoints

| Address | What it is |
| --- | --- |
| `/GuestHub` | The guest page, and the way in: opening it starts or keeps a guest session while Party is On or Paused. Sent `no-store`. The join QR code carries it |
| `/PartyHub` | The Party Hub (the TV page), in the Party Hub default view |
| `/PartyHub/Standard`, `/PartyHub/Roon`, `/PartyHub/Basic` | The Party Hub in that view, whatever the setting (`data-view` on the page, `?view=` to `/api/hub`); Basic is `basic.html`, for TV browsers too old for the Party Hub |
| `/Playlist` | The party playlist, only while Party is Off and Playlist isn't Off |
| `/p/<code>` | The party playlist at the host's own address, new for each party (in Roon's status) |
| `/About`, `/About/license/<id>` | Version, the running copy's state, every library and its licence, and the Party Hub's address; Roon's link for the extension (`website`) |
| `/` | "Scan the code again" |
| `/api/party`, `/api/queue`, `/api/search`, `POST /api/request`, `POST /api/skip`, `POST /api/name` | The guest page's API; need a guest session |
| `/api/hub` | The Party Hub's data; no session |
| `/api/events` | Live updates for both pages (server-sent events) |
| `/api/image/<key>` | Album art, only for image keys Party Mode has sent |
| `/i18n.js` | The page text in the browser's language |
| `/embed/…` | Read-only views, art, QR codes and live updates for other people's screens (see [EMBED.md](EMBED.md)) |

`/api/…` is only for Party Mode's own pages and may change. `/embed/…` is a contract: new
addresses and fields may be added, nothing renamed or removed (tests check each view's
exact fields); a breaking change would go under `/embed/v2/`.

Guest API errors are JSON `{ "error": … }`: 401 `no_session`; 403 `closed` (Party Off,
with `playlist: true` while `/Playlist` answers) or `cross_origin`; 409 `paused`,
`already_queued`, `cant_skip` or `name_taken` (sent again with `confirm: true` to accept);
400 `unknown_track` or `name_reserved`; 429 `rate_limited` (an allowance used up) or
`disabled` (the host turned it off), with `next_in`, or `too_many_requests` (Flood
protection).

## Settings (in Roon)

Party is alone at the top; everything else is in groups that start folded: **Party
setup**, **Guest requests** and **Advanced**. Every title and hint stays within 51
characters (a test checks it). Roon has no buttons, coloured hints or nested groups, so:
choices are worded from the saved state ("Pause", "Unpause", "start a new party"), a
field that needs the host gets a red box from an empty `error`, and Advanced's sub-headings
are `label` items.

| Setting | Stored as | Values |
| --- | --- | --- |
| Party | `enabled` | `true` (On), `"paused"`, `false` (Off); anything else reads as On |
| Zone | `zone` | an output; follows whichever zone holds it, grouped or not |
| Roon profile | `guest_profile` | a profile name, or unset for Roon's default for new sessions (Guest) |
| Name | `party_name` | blank: the pages say "Party" in the guest's language |
| Host name | `host_name` | at most 24 characters; blank: "Host" in each language |
| Invites | `guest_invite` | `true` (default): the guest page can show the join code |
| Party Hub default view | `hub_playing` | `'simple'` (Standard, default), `'roon'` (Roon Display) or `'basic'` (Basic) |
| Party Hub language | `hub_language` | `''` (Automatic) or a language code |
| Playlist | `playlist_download` | `'qr'`, `'link'` or `'off'` |
| Guest requests | `allow_add`, `allow_next`, `allow_skip` and their counts; `prevent_duplicates` | for adding, playing next and skipping: allowed or not, goes per guest (0 = no limit) and minutes per extra go (0 = never); Block tracks already in the queue |
| Detailed log | `detailed_log` | Off by default; turns on without a restart |
| Hide names in downloadable playlist | `playlist_hide_names` | off by default |
| Web port | `port` | 8338 by default |
| Flood protection | `request_limits`, `rate_limit`, `search_limit` | Default (1200 page loads and 200 searches a minute per device) or Custom (0 = no limit) |
| Roon menu names | `title_tracks`, `title_add`, `title_next`, `title_profile` | blank: found on the Core |

**Party.** Paused pauses the music and refuses requests; Off pauses, drops every guest
session and closes the guest pages; leaving Off starts a new party with a new playlist.
Back to On never presses play. While the party zone or the Core is gone, an On party
pauses itself after 10 seconds, without saving anything, and is On again when they're
back; the pages keep the last track meanwhile.

**Zone.** Roon's picker lists outputs, not zones, so the label names the zone the output
belongs to right now. Ungrouping mid-party leaves only that output playing.

**Roon profile.** Roon's API has no profile call, and Roon keeps the profile per browse
session and per hierarchy. So each guest searches and queues in their own session of the
main "browse" hierarchy (Library → Search → Tracks → Queue / Add Next), and the profile is
selected in that session through Settings → Profile before their first search, and again
after the setting changes, the Core reconnects or a step fails.

**Web port.** A port chosen in the settings or with `ROON_EXTENSION_PARTY_MODE_PORT` is
used, or nothing is: if it's busy, the status says so in red. Only on the very first run,
with no port chosen, does a busy 8338 move to the next free one of the nine after it.
Saving a port that can't be opened keeps the current one. A new port moves the pages at
once, then the Core connection is dropped so Roon registers the new link (back in Roon's
list within a minute; see [Known limitations](#known-limitations)). Roon saves every field
on the first Save, so the variable only matters before that. Links use the machine's first
non-internal IPv4 address.

**Roon menu names.** Roon translates its menus and the API doesn't say the language.
Blank fields are found on the Core: the Tracks category by what it opens into, Profile by
its word in Roon's languages, and Queue and Add Next by position, only when a track's
action list is exactly Play Now, Add Next, Queue, Start Radio. A Core that doesn't match
needs its own words typed in.

**Status line.** Once the zone is up: `Party: …`, `Name: …` (only when set), `Zone: …`,
`Hub: …`, `Playlist: …` (the secret address). A line about the detailed log comes first
while it's on, and a refused save comes first in red, since Roon closes the window anyway.

## How it works

**Track identity.** Roon gives no stable track ID, and search results carry no length.
A request is bound to its queue item when Roon reports the insert; after that the track
is known by `sha1(version-sensitive title, sorted artists, length)`. Crediting falls back
through queue item id, hash, recording, song and a unique recent title, each looked up
by key, not by a scan, and remembered until the credits change. A credit is kept while
its track is queued and a day after, and at most 5000 more, like the playlist. Tracks
no guest asked for are the Host's, or Roon Radio's: Roon Radio replaces the ending last
entry with exactly one new one, a pattern no host addition makes.

**Duplicates** are the same recording, not the same song: titles must match exactly,
then the cover decides when both have one, else the performers (search results also list
writers, which are discounted when most results with that title share them).

**The queue the pages get** is built once and shared by `/api/queue`, live-update
connects and broadcasts. It's rebuilt on each queue broadcast, when what it's built from
(queue, zone, Core, party name, mode, settings, credits) has changed, or after
2 s. Its `queue_full` says Roon sent all of the queue it will (500), so the guest page's
and the Hub's track counts say "499+"; `played_full`, that Played is at its 200, "200+".

**Searching.** Item keys go stale when a guest's session moves on, so a stale request
replays the guest's search and retries once. A guest's operations take turns, only their
latest search counts, at most 16 guests' searches run at once, and nothing waits on Roon
longer than 30 seconds. A guest can only queue keys they were sent in their last two
searches.

**Requests press play.** Queue and Add Next leave a stopped zone stopped, so a request
sends `play` unless the zone is playing. Not on a radio station: a station plays outside
the queue and never ends, so requests wait for the host.

**Played and skips.** Roon has no play history, so Played (last 200) is recorded as tracks
start, in memory: a new party, a restart or another zone starts it over. A track left 10
seconds or more before its end without a guest's skip shows "Skipped by Host".

**The playlist** is a CSV download in the form Soundiiz imports (Roon's API can't make
playlists): every queue entry the party zone gets, once, at most 5000, in memory. Its
address `/p/<code>` is 8 Crockford base32 characters (`7KQ4-M9XD`), new for each party,
matched however it's typed. Times are the extension's local time (UTC in Docker unless
`TZ` is set).

**Guest page browsers.** `guest.js` is ES2017 with no build step: Chrome 55, Safari 10.3
(iOS 10.3), Firefox 52 or newer. It asks `fetch` for cookies (`credentials:
'same-origin'`: older browsers leave them out by default), and Skip in the nickname
dialog falls back from `requestSubmit` (Safari 16) to a submit event. `i18n-runtime.js`
is ES5 (the basic Party Hub loads it too), with English's one/other plurals where
`Intl.PluralRules` is missing.

**Party Hub layout.** Laid out for 1920 × 1080, the same on any screen shape as at 4:3
(`--w`), and scaled with the height up to 4K and 8K. Up next shows only whole tracks
(`fitRows()`); when more are queued than fit, its heading says how many. Heights use
`--vh`, measured from `innerHeight` (iPad Safari counts its bars in `100vh`). The Hub's
CSS and script use nothing newer than Chromium 79 (TVs' built-in browsers): no
`aspect-ratio`, no flex `gap`, no `inset` or `*-inline` shorthands. **Roon Display** frames
Roon's own display page (`http://<Core address>:<port>/display/`, found from discovery;
`127.0.0.1` becomes this computer's network address), 16:15 so Roon picks a 4:3 artist
picture, sandboxed, shown only once Party Mode has checked the page answers and never on
a phone-width screen. Its zone is chosen in Roon (the zone's Displays) and kept in the
browser.

**Basic Party Hub** (`basic.html`): for TV browsers too old for the Party Hub, which
`hub-check.js` sends there first thing (no CSS `clamp()`, or no MediaQueryList events).
One 16:9 stage, 120 × 67.5 rem in fixed positions, scaled by setting the root font size
(text stays sharp) and letterboxed in the page's colour; ES5, XMLHttpRequest, EventSource
where there is one (else polling), six Up next rows, no frame or menu. A long party name
steps down in size to fit (`fitName()`), then ends with an ellipsis. Checked back to
Chrome 53 and Firefox 47.

## Translations

Page text is in `public/i18n/<code>.json`, 30 languages (the list is in `lib/i18n.js`);
a missing key falls back to `en.json`. Settings and Roon's status line stay in English.
The non-English files are AI drafts: corrections from native speakers are welcome.

To add a language: copy `en.json`, translate the values, keep `{name}`, `{count}` and
`{wait}`, give plurals the forms the language uses (`Intl.PluralRules`: Arabic all six;
Czech, Polish, Russian and Ukrainian `few` and `many`; CJK, Thai and Vietnamese only
`other`), fill in `_reserved_host_words` and `_reserved_radio_words` (words guests can't
take as names; not sent to the pages), and restart. `npm test` checks keys and
placeholders. Say "tracks", not songs, with a neutral word as Roon does.

The language comes from a `party_lang` cookie (the guest's 🌐 choice), else
Accept-Language (`no`/`nn` → `nb`, `iw` → `he`, Chinese by script), else English. The
Party Hub language setting overrides both on the Hub. Hebrew and Arabic pages are
right to left; names dropped into sentences are wrapped in first-strong isolates.

## Security

- **Access is being on the network.** Anyone who can reach the port can open `/GuestHub`;
  don't expose it to the internet. A guest can only add to the party zone's queue and
  skip, within the allowances. Party Off drops every session.
- **Sessions:** `party_sid`, HttpOnly, `SameSite=lax`, 12 hours from last use, at most
  2000 (the longest idle goes first). Allowances are taken before Roon is asked and given
  back if it refuses. Clearing cookies starts a new session: allowances keep things
  polite rather than enforce them.
- **Other sites can't act for a guest:** JSON-only POSTs, and a POST whose `Origin` is
  another site gets 403. `/GuestHub` only starts a session for a page someone opens
  (`Sec-Fetch-Dest: document`).
- **Headers:** a strict Content-Security-Policy (no inline script or style),
  `nosniff`, `no-referrer`, a restrictive `Permissions-Policy`, CORP and COEP. Guest
  pages can't be framed; the Party Hub and `/embed/` can. With Roon Display the Hub allows
  that one frame source and drops COEP.
- **Limits:** Flood protection per device, live-update streams capped per device and in
  total, slow connections cut off (10 s for headers, 30 s for a request), searches 200
  characters, names 24, album art only for keys Party Mode has sent.
- **Never sent to pages:** the zone's name, the Core's name, settings, or the secret
  playlist address. `/embed/` is built field by field for that reason.
- **Not checked:** the Host header (DNS rebinding). See [Known limitations](#known-limitations).

## Accessibility

Checked against WCAG 2.2 AA. Keep text at 4.5:1 contrast, focus where it was after a
redraw, used-up buttons `aria-disabled` (not `disabled`) so their wait is read, dialogs
`inert` behind with Escape and Tab kept inside, moving text that stops (and never moves
with reduced motion), and QR codes' `alt` text naming the code.

## Icon

`public/icon.svg` is drawn into `favicon.ico` (16, 32, 48 px PNGs), `apple-touch-icon.png`
(180 px, square corners) and `icon-192.png`/`icon-512.png`. After changing the SVG, render
each size with a transparent background (a headless browser screenshot with
`omitBackground`), and check the 16 px one still reads in a tab.

## Docker

### The image

Two stages: `npm ci` and `npm test`, then the app alone on `node:22-alpine` (pinned by
digest), running as uid 1000, with npm, npx, corepack and yarn removed. The health check
asks `/api/hub` every 60 s (15 s allowed, a minute's grace), loose enough for a Pi 1.
Node 22 is the newest line with 32-bit ARM images; moving to Node 24 means dropping
`arm/v6` and `arm/v7`.

### Running the image

The README's `docker run` and `docker-compose.yml` use host networking (Roon discovery
is UDP broadcast), `--cap-drop ALL` and `no-new-privileges`; Compose adds `read_only`
and a 512 MB memory limit, and both cap the log at 3 × 10 MB.

**Where settings are kept.** node-roon-api writes `config.json` in `/usr/src/app`; in the
image that's a link to `/data/config.json`. So:

- a named volume on `/data` (`roon-extension-party-mode-data`) is filled from the image
  and needs no setup;
- a folder bind-mounted on `/data` must be writable by uid 1000;
- a file bind-mounted on `/usr/src/app/config.json` (the Extension Manager's way) must
  exist and be writable by uid 1000 before the container starts, or Docker makes a
  directory there;
- with none of these, settings are lost when the container is recreated, and Roon sees a
  new, unpaired extension.

There's no `VOLUME` instruction, as it would give every Extension Manager install an
unused anonymous volume. An unwritable `config.json` is warned about at startup and after
each save; the Roon pairing is kept in memory and written once it's writable again.
Read-only works with any of the mounts; anything new that writes a file needs a mount or
a `tmpfs`.

**Extension Manager.** Every version must install and upgrade through the entry in
`extension-manager/repository-entry.json` as it stands (image
`stubaggs/roon-extension-party-mode`, tag `latest` for `amd64`, `arm` and `arm64`, one bind
on `/usr/src/app/config.json`), so nothing it can't supply may be required: no `VOLUME`,
required variable or port mapping. `extension-manager/roon-extension-party-mode.json` is
the same entry as a local repository file.

### Setup program

`party-mode-setup.sh` (bash, Linux and DietPi) installs, checks, updates and uninstalls
Party Mode with Docker or with the Extension Manager: whiptail menus sized for 80 × 24,
plain prompts without whiptail, and `--status`. It keeps no state; each run reads Docker.
`SETUP_VERSION` is its own version, shown in `--help` and on every screen: raise it with
every change, since a copy kept on a computer says so when the one at `SETUP_URL` is later.

- **Copies** are containers on `stubaggs/roon-extension-party-mode` (or with its
  `org.opencontainers.image.source` label): the Manager's has the Manager's data on
  `/home/node/.rem`, Compose's has `com.docker.compose.*` labels, the rest are `docker run`.
- **Docker** uses the README's `docker run` options and a volume on `/data`, named
  `roon-extension-party-mode[-<suffix word>][-<name>]` (`-data` for the volume); images
  without `/data` (before 1.4.0) run without `--read-only`, and `--memory` is left out
  where Docker reports no memory limit support (Raspberry Pi kernels). A copy that would be the same
  extension to Roon as one installed is offered a name (`ROON_EXTENSION_PARTY_MODE_INSTANCE`).
  Updating recreates the container with its name, settings mount and the variables given
  to it; Compose copies are updated and removed with Compose.
- **Extension Manager** (container `roon-extension-manager`): only the latest release. Until
  Party Mode is in the Manager's own list (read from where the Manager reads it;
  `PARTY_MODE_SETUP_REPOSITORY_URL` replaces it for tests, `file://` works), the script
  writes a local entry in the Manager's `repos/`, and removes it on uninstall, on request
  (while Party Mode isn't installed) or once listed, restarting the Manager so it reads
  the change. It never changes the Manager's copy: install and uninstall point to the
  Manager's settings in Roon and check for the copy after; updates are the Manager's. The
  Manager's uninstall leaves `binds/roon-extension-party-mode/` (the settings).
- **One way per computer** (see [Known limitations](#known-limitations)): installing one way
  is refused while Party Mode is installed the other, and the main menu's Fix keeps one if
  both are found.

### Building every platform locally

The workflow builds `linux/amd64`, `linux/arm64`, `linux/arm/v7` and `linux/arm/v6`. With
QEMU (`qemu-user-binfmt`), build one with `docker buildx build --platform linux/arm/v6 -t
party-mode:local-arm-v6 --load .` (the build runs the tests), and start it off the host
network so it doesn't register with Roon:

```sh
docker run -d --name pm-smoke -p 127.0.0.1:18361:8338 --read-only --cap-drop ALL \
  --security-opt no-new-privileges -v pm-smoke:/data party-mode:local-arm-v6
docker exec pm-smoke node healthcheck.js && echo healthy
```

Many arm64 CPUs can't run 32-bit ARM, and QEMU doesn't register it there by itself: it
needs a `binfmt.d` entry for `qemu-arm`.

## Running several copies

Two copies with the same id clash against one Core, even on different computers. A
version with a suffix is its own extension (`1.4.0-beta.1` registers as
`com.stubaggs.party-mode.beta`, "Party Mode (beta)"), so the beta runs beside the release.
Name each extra copy with `ROON_EXTENSION_PARTY_MODE_INSTANCE` (`Garden` registers as
`com.stubaggs.party-mode.garden`, "Party Mode (Garden)"; letters and digits only, accents
dropped, a hash for names with neither). A named copy is a new extension to Roon, with its
own settings and zone; renaming it makes another.

In `docker-compose.yml`, write a name with spaces unquoted in the list style
(`- ROON_EXTENSION_PARTY_MODE_INSTANCE=Living Room`: quotes after `=` would show in
Roon), but quote the whole line if the name has ` #` or starts with a symbol. With
`docker run`, quote it for the shell.

## Environment variables

Named `ROON_EXTENSION_PARTY_MODE_<SETTING>` and read through `lib/env.js`; the hyphenated
`ROON-EXTENSION-PARTY-MODE_<SETTING>` works too, and renamed ones keep their old name.

| Variable | Meaning |
| --- | --- |
| `ROON_EXTENSION_PARTY_MODE_PORT` | The first run's port (default 8338); after that, Web port in Roon |
| `ROON_EXTENSION_PARTY_MODE_INSTANCE` | A name for this copy (see [Running several copies](#running-several-copies)) |
| `ROON_EXTENSION_PARTY_MODE_DEBUG` | `1`, `true`, `yes` or `on`: the detailed log from the start |
| `ROON_EXTENSION_PARTY_MODE_BUILD` | Set by the publish workflow for the About page; its commit also follows the version in Roon (`1.4.0 (b51496d)`). Not for setting by hand |

## Logging

Every line starts with a tag saying what it's about, so `grep` finds one kind:

- **`[Roon]`**: the Core, the party zone and Roon's answers: connections, zones coming
  and going, and what Roon refused or failed.
- **`[Guest]`**: what guests do: names, searches, requests, skips.
- **`[PartyMode]`**: Party Mode itself and the host's settings: startup, the tracks it
  follows and credits, playlist downloads.

Info and Detailed lines go to standard output, Warning and Error to standard error; the
About page counts warnings and errors. Detailed lines appear only while the **Detailed
log** setting (or `ROON_EXTENSION_PARTY_MODE_DEBUG`) is on: they include what guests
type, so they're for troubleshooting only. node-roon-api's own lines (Detailed) have no
tag. Lines carry no time; use `docker logs -t`.

### Error

| Event | Example |
| --- | --- |
| No free web port at startup | `[PartyMode] Ports 8338-8348 are all in use. Pick another web port in the settings.` |
| Can't move to a new web port | `[PartyMode] Could not move to port 8340: …` |
| Unexpected error answering a page | `[PartyMode] Unexpected error:` and the stack |

### Warning

| Event | Example |
| --- | --- |
| `config.json` not writable | `[PartyMode] config.json in /data is not writable by this user (uid 1000), …` |
| Connection to the Core lost | `[Roon] Lost the connection to the Roon Core: …` |
| Party zone not in Roon, or gone | `[Roon] Party zone "Lounge" is no longer available in Roon` |
| Requests paused for the zone or Core | `[Roon] Requests are paused until party zone "Lounge" is back` |
| Profile problems | `[Roon] Profile "Party" not found (Roon has: …)`, `[Roon] Could not switch profile: …` |
| A guest's session couldn't get the profile | `[Roon] Could not select profile "Party" for a guest: …` |
| A request's action not found in Roon | `[Roon] No "Add to queue" action and not the usual four actions; …` |
| Roon refused to start or pause playback | `[Roon] Could not start playback for a request: …` |

### Info

| Event | Example |
| --- | --- |
| Started, and its links | `[PartyMode] Party Mode listening on port 8338`, `[PartyMode] Guest link: http://192.0.2.10:8338/GuestHub` |
| Web port taken, another used | `[PartyMode] Port 8338 is in use, using 8339 instead` |
| `config.json` writable again | `[PartyMode] config.json is writable again: settings and the Roon pairing are saved` |
| Connected to the Core | `[Roon] Connected to the Roon Core "Studio"` |
| A menu or action found under another name | `[Roon] Browse titles: using "Bibliothek" as the library on this Core` |
| Guest requests' profile | `[PartyMode] Guest requests use the Roon profile "Party"` |
| Party zone back | `[Roon] Party zone "Lounge" is available again` |
| Requests back on | `[Roon] Requests are back on` |
| The host changes Party | `[PartyMode] Party: Paused (was On)` |
| Detailed log turned on or off | `[PartyMode] Detailed log on` |
| A guest names themselves | `[Guest] RA8lxj…: name "Sam" (was Anon)` |
| A guest's session gets the profile, at their first search | `[Guest] RA8lxj…: profile "Party"` |
| Request | `[Guest] Request (add) from Sam: "Gold" / "Spandau Ballet"` |
| Request Roon failed | `[Roon] Request (next) from Sam failed: "Gold" / …: <error>` |
| Playback started for a request | `[PartyMode] Started playback in "Lounge" for a request` |
| Queued for a guest | `[PartyMode] Queued: "Gold" / "Spandau Ballet" 290s [c47dd885da0f] -> Sam` |
| Started playing, with its credit | `[PartyMode] Playing: "Gold" / "Spandau Ballet" [c47dd885da0f] -> Sam` |
| Credited after it started | `[PartyMode] Credited: "Gold" / "Spandau Ballet" -> Sam` |
| Skip | `[Guest] Skip from Sam: "Gold" / "Spandau Ballet"` |
| Skip Roon failed | `[Roon] Skip from Sam failed: <error>` |
| Ended early with no guest skip: skipped in Roon, or Roon couldn't play it (Roon doesn't say which) | `[Roon] Ended early: "Gold" / … at 38 of 290 s (…)` |
| Paused with the party | `[PartyMode] Paused "Lounge": party paused or off` |
| Playlist downloaded | `[PartyMode] Playlist downloaded (152 tracks, from its own address)` |

### Detailed

| Event | Example |
| --- | --- |
| The profiles on offer | `[Roon] Profiles on offer: Party, Guest, …` |
| The profile before and after a guest's switch | `[Roon] Guest RA8lxj…: Roon answered list; profile before "Guest", after "Party"` |
| Search | `[Guest] Search from Sam: "abba" (12 results)`; a refused one (`[Guest] … refused: not_ready`) or failed one (`[Roon] … failed: …`) |
| The first search's result categories | `[Roon] Search (Library → Search) result categories: …` |
| Request or skip refused, with the reason | `[Guest] Request (add) from Sam refused: rate_limited: "Gold" / …` |
| Roon stopped sending the queue (e.g. after a Core restart); asked again within 5 s | `[Roon] Queue subscription ended: …` |
| node-roon-api's log of every message to and from the Core | `-> REQUEST 74 com.roonlabs.transport:2/control {…}` |

## Branches

- **`main`** is what's released. Fixes to a release go on a branch off `main`
  (`fix-<version>`) and back by pull request.
- **`beta`** is the next version's release candidate (`1.4.0-beta.1`), published as
  `:beta` for testers.

## Publishing the image

`.github/workflows/docker-publish.yml` runs only by hand (Actions → Publish Docker
image), building the four platforms and pushing `stubaggs/roon-extension-party-mode`:

| Branch | Tags |
| --- | --- |
| `main` | `latest` and the version; refuses a version with a suffix or one already on Docker Hub |
| `beta` | `beta` and the version; refuses a version without `-beta` |

Release numbers are immutable on Docker Hub too. It needs the secrets `DOCKERHUB_USERNAME`
and `DOCKERHUB_TOKEN` (Read & Write). Each image carries BuildKit provenance, an SBOM and a
signed attestation (`actions/attest`). CodeQL (`.github/workflows/codeql.yml`) also runs
by hand.

### Checking an image

```sh
docker buildx imagetools inspect stubaggs/roon-extension-party-mode:<version> --format '{{json .Provenance}}'
docker buildx imagetools inspect stubaggs/roon-extension-party-mode:<version> --format '{{json .SBOM}}'
gh attestation verify oci://stubaggs/roon-extension-party-mode:<version> --repo stubaggs/roon-extension-party-mode
```

`gh attestation verify` fails for any image the workflow didn't build. Pin a version
number, or a digest from RELEASES.md, to stay on one image.

## Known limitations

- **No queue reordering:** Roon's API can add to the end or next, and skip, but can't move
  a queued track.
- **A request presses play**, which also resumes a zone the host paused in Roon (Party's
  Paused refuses requests instead).
- **Roon Radio is recognised by its pattern:** a host addition at the very moment the last
  track ends is taken for Roon Radio's, and after a restart its queued picks are the
  host's.
- **Some duplicates can't be seen from search:** two versions on one album with the same
  title and artist, and an album's other versions, which search doesn't show.
- **Credits can swap** if Roon reports two inserts of the same recording out of order.
- **Back in Roon's list within a minute:** node-roon-api looks for the Core every 10 s in
  the first minute after Party Mode starts, then once a minute. So after the extension is
  disabled in Roon, or the Core restarts, it can be missing from Roon's Extensions list
  for up to a minute.
- **Everything is in memory:** Played, the playlist and credits start over on a restart.
- **Sessions can take tens of megabytes** if all 2000 are filled, which anyone on the
  network could do; the longest idle go first, and real guests rejoin by themselves.
- **The Extension Manager and Docker don't mix on one computer:** the Manager finds its new
  container by Docker's name filter, which matches part of a name, so containers named
  `roon-extension-party-mode-…` stall its installs and updates at "Installing".
- **The Host header isn't checked** (DNS rebinding): a page someone on the network opens
  could read the pages and join as a guest. The Origin check still stops other sites
  making changes.

## Licence

Copyright © 2026 Stubaggs. Licensed under the Apache License, Version 2.0 (see
[LICENSE](LICENSE)).
