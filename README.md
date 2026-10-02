# Roon Extension: Party Mode

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

Party zone, party name, guest access on/off, and web port. Saving a new port moves the
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

The last group of settings is the one to check if your Core is not in English. Roon
localises browse titles, so the extension matches on the strings `Tracks`, `Queue` and
`Add Next`. Put your Core's equivalents there.

## Installing it from Roon

Once the image is on Docker Hub and the entry is in the Extension Repository, install it
with the [Extension Manager](https://github.com/TheAppgineer/roon-extension-manager):
Roon → Settings → Extensions → Extension Manager → Settings, pick the category, pick
Party Mode, choose Install. The Manager runs it with host networking (Roon discovery uses
UDP broadcast on port 9003) and bind-mounts `config.json` so settings survive updates.

## Publishing the image

`.github/workflows/docker-publish.yml` builds `linux/amd64`, `linux/arm/v7` and
`linux/arm64` and pushes `stubaggs/roon-extension-party-mode:latest` to Docker Hub. For
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

`docker-compose.yml` does the same thing. Create `config.json` first (`touch config.json`)
or Docker makes a directory in its place.

## Getting it into the Extension Repository

Fork `TheAppgineer/roon-extension-repository`, add the object from `repository-entry.json`
to the "Playback" category in `repository.json`, bump the `version` at the top of that
file, and open a pull request. Only do this after the image is on Docker Hub: the Manager
installs straight from it.

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

## Ideas worth adding

- Blocking explicit tracks, or a genre allowlist, using the browse hierarchy
- Persisting token buckets against a device fingerprint so a page refresh does not matter
  (they are already server-side, but a new scan gets a fresh session)
- A veto: three guests tap skip on the same track before it goes

## Licence

Apache-2.0, matching the other extensions in the Appgineer repository.
