# Party Mode: developer notes

How the extension is built, what it serves, and how it's packaged and published. For
installing and using it, see the [README](README.md); for building a screen of your own,
[EMBED.md](EMBED.md).

Guests scan a QR code, search the host's Roon library and streaming services, and add
tracks to one zone's queue from their phone, with no Roon account or remote and no access
to anything else. It's packaged the way the
[Extension Manager](https://github.com/TheAppgineer/roon-extension-manager) expects: a
Docker image whose settings survive updates in a bind-mounted `config.json`.

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
| `public/` | The guest page (`index.html`, `guest.js`) the Party Hub (`hub.html`, `hub.js`, `hub.css`, `hub-check.js`) and the basic Party Hub (`basic.html`, `basic.js`, `basic.css`); no build step |
| `test/` | `npm test` |

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
`express-rate-limit` and `qrcode-generator` (`lib/qr.js` draws its codes as SVG; cookies are
read in `lib/server.js`). There are no development dependencies.

## Tests

`npm test` runs the files listed in `package.json` (add new ones there), with Node's
`assert` against a fake Core (`test/fake-roon.js`) and the real web server. The Docker
build runs them too, so a failing test stops a build. Before pushing, also build and run
the image (see [Running the image](#running-the-image)).

## Endpoints

| Address | What it is |
| --- | --- |
| `/GuestHub` | The guest page, and the way in: opening it starts or keeps a guest session while Party is On or Paused. Sent `no-store`. The join QR code carries it |
| `/PartyHub` | The Party Hub (the TV page), in the Party Hub default view |
| `/PartyHub/Standard`, `/PartyHub/Roon`, `/PartyHub/Basic` | The Party Hub in that view, whatever the setting (`data-view` on the page, `?view=` to `/api/hub`); Basic is `basic.html`, for TV browsers too old for the Party Hub |
| `/Playlist` | The party playlist, only while Party is Off and Playlist isn't Off |
| `/p/<code>` | The party playlist at the host's own address, new for each party (in Roon's status) |
| `/About`, `/About/license/<id>` | Version, the running copy's state, every library and its licence; Open the Party Hub and the Hub's address (as Roon's status shows it) with a Copy button, once connected to Roon; how to enable Party Mode until then. Roon's link for the extension (`website`) |
| `/` | "Scan the code again" |
| `/api/party`, `/api/queue`, `/api/search`, `POST /api/request`, `POST /api/skip`, `POST /api/name` | The guest page's API; need a guest session |
| `/api/hub` | The Party Hub's data; no session |
| `/api/events` | Live updates for both pages (server-sent events) |
| `/api/image/<key>` | Album art, only for image keys Party Mode has sent |
| `/i18n.js` | The page text in the browser's language |
| `/embed/…` | Read-only views, art, QR codes and live updates for other people's screens (see [EMBED.md](EMBED.md)) |

`/api/…` is only for Party Mode's own pages and may change. `/embed/…` is a promise: new
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
used or nothing: if it's busy the status says so in red. Only on the very first run, with
no port chosen, a busy 8338 moves to the next free one of the nine after it. Saving a port
that can't be opened keeps the current one and puts it back in the settings. A port that
opens moves the pages at once, then the Core connection is dropped so Roon registers the
new link: node-roon-api's discovery looks again every 10 s in its first minute and once a
minute after, so Party Mode is back in Roon's list within a minute. Roon saves
every field on the first Save, so the variable only matters before that. Links use the
machine's first non-internal IPv4 address.

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
through queue item id, hash, recording, song and a unique recent title. Tracks no guest
asked for are the Host's, or Roon Radio's: Roon Radio replaces the ending last entry with
exactly one new one, a pattern no host addition makes.

**Duplicates** are the same recording, not the same song: titles must match exactly,
then the cover decides when both have one, else the performers (search results also list
writers, which are discounted when most results with that title share them).

**Searching.** Item keys go stale when a guest's session moves on, so a stale request
replays the guest's search and retries once. A guest's operations take turns, only their
latest search counts, at most 16 guests' searches run at once, and nothing waits on Roon
longer than 30 seconds. A guest can only queue keys they were sent in their last two
searches.

**Requests press play.** Queue and Add Next leave a stopped zone stopped, so a request
sends `play` unless the zone is playing. Not on a radio station: a station plays outside
the queue and never ends, so requests wait for the host.

**Played and skips.** Roon has no play history, so Played (last 200) is recorded as tracks
start. A track left 10 seconds or more before its end without a guest's skip shows
"Skipped by Host".

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

**Party Hub layout.** Laid out for 1920 × 1080 and the same on any screen shape as at 4:3
(`--w`), scaling with the height up to 4K and 8K. Up next shows only whole tracks
(`fitRows()`), with the spare room shared above and below (`--shift`), and no numbers;
when more are queued than fit, its heading says how many (`queue.count`; "499+" when Roon
sent all it will, `queue_full`). Heights use `--vh`,
measured from `innerHeight` (iPad Safari counts its bars in `100vh`), again after load.
The Hub's CSS and script use nothing newer than Chromium 79 (TVs' built-in browsers): no
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
`arm/v6` and `arm/v7`. Dependabot updates the base digest, the npm dependencies and the
workflow's actions; its pull requests target `main` but the updates ship with the next
version.

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
`extension-manager/repository-entry.json` as it stands: image
`stubaggs/roon-extension-party-mode`, tag `latest` for `amd64`, `arm` and `arm64`, and one
bind, `/usr/src/app/config.json`. So nothing it can't supply may be required (no `VOLUME`,
required variable or port mapping). Until the entry is listed,
`extension-manager/roon-extension-party-mode.json` is the same entry as a local repository
file (the README says how to add it).

### Building every platform locally

The workflow builds `linux/amd64`, `linux/arm64`, `linux/arm/v7` and `linux/arm/v6`. On
Ubuntu, `qemu-user-binfmt` emulates the other 64-bit platform. On an arm64 machine it
doesn't register 32-bit ARM, which many recent ARM CPUs can't run; add this one line as
`/etc/binfmt.d/qemu-arm.conf` (from a file, not pasted from a terminal) and restart
`systemd-binfmt`:

```
:qemu-arm:M::\x7f\x45\x4c\x46\x01\x01\x01\x00\x00\x00\x00\x00\x00\x00\x00\x00\x02\x00\x28\x00:\xff\xff\xff\xff\xff\xff\xff\x00\xff\xff\xff\xff\xff\xff\xff\xff\xfe\xff\xff\xff:/usr/bin/qemu-arm:OPF
```

Then build each (`docker buildx build --platform linux/arm/v6 -t party-mode:local-arm-v6
--load .`; the build runs the tests) and start it off the host network so it doesn't
register with Roon:

```sh
docker run -d --name pm-smoke -p 127.0.0.1:18361:8338 --read-only --cap-drop ALL \
  --security-opt no-new-privileges -v pm-smoke:/data party-mode:local-arm-v6
docker exec pm-smoke node healthcheck.js && echo healthy
```

Emulation shows an image builds, passes and starts, not how fast it runs.

## Running the beta

The beta (`:beta`, from the `beta` branch) is a separate extension to Roon: a version with
a suffix registers as `com.stubaggs.party-mode.beta`, "Party Mode (beta)". It runs beside
the release against one Core; give it its own container, volume and party zone:

```bash
docker run -d --name roon-extension-party-mode-beta --network host --restart unless-stopped \
  --log-opt max-size=10m --log-opt max-file=3 \
  --cap-drop ALL --security-opt no-new-privileges \
  -v roon-extension-party-mode-beta-data:/data \
  stubaggs/roon-extension-party-mode:beta
```

Enable **Party Mode (beta)** in Roon and pick a different zone from the release's. If 8338
is taken it uses the next free port. To stop: remove the container and the volume, and
disable it in Roon.

## Running several copies

Two copies with the same id clash against one Core, even on different computers. Name
each extra copy with `ROON_EXTENSION_PARTY_MODE_INSTANCE` (`Garden` registers as
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

The normal log has startup links, the Core and party zone coming and going, requests
pausing and resuming, the host changing Party, and one line per request, queue insert
(with length and hash) and track start (with its credit). The **Detailed log** adds the
profile switches, the first search's categories and node-roon-api's full message log,
which includes guests' searches: for troubleshooting only. Lines carry no time; use
`docker logs -t`.

## Branches

- **`main`** is what's released: `latest`, the README people read, and the tags.
- **`beta`** is the next version's release candidate (`1.4.0-beta.1`), published by hand
  as `:beta`.
- **Fixes** to a release branch off `main` as `fix-<version>` (bumping the patch version
  first) and merge back by pull request as that release.

Whenever anything lands on `main`, merge `main` into `beta`. Dependabot's pull requests
target `main` and aren't merged there: the update ships with the next version.

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
by hand; its two accepted alerts are `js/missing-token-validation` (the SameSite cookie
and Origin check cover it) and `js/missing-rate-limiting` on static files.

### Releasing

1. Set the version without a suffix and mark its RELEASES.md section released. From
   `beta`, switch README.md, `docker-compose.yml` and
   `extension-manager/roon-extension-party-mode.json` back from the beta image and
   `-beta` names (publishing from `main` refuses otherwise).
2. Run CodeQL on the branch and check the results.
3. Merge into `main` by a pull request titled `Release <version>`, and tag the merge
   commit `v<version>` (annotated).
4. Run the publish workflow.
5. Add the image digest and the code fingerprint under the version's heading in
   RELEASES.md. The fingerprint comes from the published image
   (`docker run --rm --entrypoint node stubaggs/roon-extension-party-mode:<version> -p "require('./lib/about').fingerprint()"`)
   and must match `node -p` of the same on the tag.
6. Create the GitHub release with that version's RELEASES.md section.
7. Merge `main` into `beta`; the next candidate bumps to `-beta.1` and switches the files
   to the beta image again.

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
- **The Host header isn't checked** (DNS rebinding): a page someone on the network opens
  could read the pages and join as a guest. The Origin check still stops other sites
  making changes.

## Licence

Copyright © 2026 Stubaggs. Licensed under the Apache License, Version 2.0 (see
[LICENSE](LICENSE)).
