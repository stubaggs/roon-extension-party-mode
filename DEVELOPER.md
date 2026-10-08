# Party Mode: developer notes

How the extension works, how to run and test it, and how it's packaged and published.
For installing and using it, see the [README](README.md).

Guests scan a QR code, search your Roon library and streaming services, and add tracks
to one zone's queue from their phone. They need no Roon account and no remote, and get
no access to anything else in your system.

It's packaged the way the [Extension Manager](https://github.com/TheAppgineer/roon-extension-manager)
expects: a Docker image with its settings in a bind-mounted `config.json`, and a
[repository entry](https://github.com/TheAppgineer/roon-extension-repository) that makes
it installable from inside Roon.

---

## How it fits together

```
Roon Core  ──(node-roon-api over the local network)──  app.js
                                                        │
                        RoonApiSettings   host config in Roon's Extension Settings
                        RoonApiStatus     mode, party name and Party Hub link
                        RoonApiTransport  zone state, queue subscription, skip, play
                        RoonApiBrowse     search + "Queue" / "Add Next" actions
                        RoonApiImage      album art proxy
                                                        │
                                              Express on port 8338
                                                        │
                                     /             "Scan the code again"
                                     /j/<code>     join link → session cookie → /GuestHub
                                     /GuestHub     guest page (phones)
                                     /PartyHub     QR code + queue (TV)
                                     /Download/…   the party playlist
```

| File | What it does |
| --- | --- |
| `app.js` | Wires the Roon service to the web server |
| `lib/roon-service.js` | Pairing, settings layout, search, queue actions, queue subscription |
| `lib/track-id.js` | Track identity: title and artist normalisation, length, hash |
| `lib/titles.js` | Finding Roon's browse titles (Tracks, Queue, Add Next, Profile) on a Core in any language |
| `lib/profiles.js` | Selecting the guest profile in a browse session |
| `lib/guests.js` | Guest sessions, token-bucket limits, request attribution |
| `lib/history.js` | Played-tracks list for the guest page |
| `lib/party-playlist.js` | Everything queued during the party, as the downloadable CSV |
| `lib/server.js` | REST API, server-sent events, QR code, image proxy |
| `lib/ports.js` | Opening the web port, and the next free one when it's busy |
| `healthcheck.js` | Docker's health check: is the web server answering? |
| `public/` | Guest page (`index.html`, `guest.js`) and the Party Hub (`hub.html`, `hub.js`), no build step |
| `public/marquee.js` | Scrolling long names |
| `public/i18n/`, `lib/i18n.js`, `public/i18n-runtime.js` | Page text per language, picking the language per browser, and applying it in the page |
| `lib/env.js`, `lib/log.js` | Environment variables, and the debug log switch |
| `test/` | Identity, attribution, settings and web server tests, `npm test` |

## Running it with Node.js

You need Node.js 22 or newer, as in the Docker image, and git, since the Roon API
packages come straight from GitHub:

```bash
git clone https://github.com/stubaggs/roon-extension-party-mode.git
cd roon-extension-party-mode
npm ci
npm start
```

1. In Roon, open Settings → Extensions and enable Party Mode.
2. Open its settings and pick a party zone.
3. The console prints the guest link and the Party Hub's address.

The extension writes `config.json` in the folder you start it from.

`npm ci` installs the dependencies as `package-lock.json` pins them:

| Package | What it's for |
| --- | --- |
| `node-roon-api` | Finding and pairing with the Roon Core |
| `node-roon-api-transport` | Zones, the queue, playback and skip |
| `node-roon-api-browse` | Searching, queuing and choosing the Roon profile |
| `node-roon-api-image` | Album art for the pages |
| `node-roon-api-settings` | The settings in Roon |
| `node-roon-api-status` | The status line in Roon |
| `express` | The web server for the guest pages and the Party Hub |
| `express-rate-limit` | The per-minute request limits (see [Security](#security)) |
| `cookie-parser` | Guest sessions, and the language a guest picks |
| `qrcode` | The join and playlist QR codes |

The `node-roon-api*` packages are Roon Labs' own, from `github:roonlabs/…`, not npm.
There are no development dependencies: the tests use Node's built-in `assert`.

## Tests

`npm test` runs the test files listed in `package.json`; add a new file there. Before
pushing, run it, then build and run the image locally (see [Running the image by
hand](#running-the-image-by-hand)). The Docker build runs the tests too, so a failing
test stops a build.

- `test/fake-roon.js` is a fake Core shaped like a real browse menu (Library → Search,
  Settings → Profile), with its own position and profile per session.
- `test/server.test.js` runs the real web server against a stand-in for Roon. It checks
  the Party Hub's answers, the join-link pages, the guest API's `no_session` and `closed`
  errors, and the security headers.
- `test/station.test.js` checks requests waiting and skips refused during a radio
  station, on a zone shaped like the one a Core reported.
- `test/roon-radio.test.js` checks Roon Radio's picks are told from the host's, with the
  queue updates a Core sent as the queue ran out.
- `test/fixtures/` holds real search results from a Core for the duplicate check:
  "bad guy" (covers) and "pere ubu waiting for mary" (one band, five albums).

## Host settings (in Roon)

Party mode comes first, as the switch hosts use most. Then, in order: the party zone and
the Roon profile (how the party plays in Roon), the party name, the party host name,
Party Hub language (see [Choosing the language](#choosing-the-language)), Playlist on the
Party Hub (see [The party playlist](#the-party-playlist)), the allowances (Adding tracks,
which includes playing next, then Skipping), and the collapsed Advanced group: Hide names
in downloadable playlist, the web port, then the browse titles.

### Party mode

It's stored as `enabled`, its name when it was an on/off "Guest access": `true`,
`"paused"` or `false`. `partyMode()` in `lib/roon-service.js` reads it and treats
anything else as on.

| Mode | Music | Guests |
| --- | --- | --- |
| On | Plays | Add tracks, play next, skip |
| Paused | Pauses if playing. **Unpause** presses play, if Roon allows | Stay in, but requests and skips are refused (409 `paused`) |
| Off | Pauses | The guest pages close |

Back to On from Off doesn't press play: a new party waits for the host or the first
request. Leaving Off starts a new party, with a new join code and a new playlist
(`party_mode_changed` in `lib/server.js`).

Roon's settings have no buttons, so the dropdown's choices are worded from the saved
mode (`partyModeChoices()`): "Pause" while on, "Unpause" while paused, and "start a new
party" while off. The layout sent back after a save is rebuilt from the new mode, so
the wording swaps over at once.

### Party zone

Roon's zone picker lists **endpoints**, not zones, so a zone made by grouping three
speakers appears as three separate endpoints. Picking any one of them plays to the whole
group, because Roon resolves an endpoint to the zone that contains it right now. So the
picker's label names the zone it resolves to:

```
Party zone — plays to Kitchen + Living Room + Study (3 endpoints)
```

The setting stores one endpoint, not the group, and grouping is dynamic. So the zone
means "whichever zone holds this endpoint right now". Ungroup the speakers mid-party and
the extension quietly follows that one endpoint: guests keep adding tracks, but only
that speaker plays. Nothing errors, since the endpoint still exists. Regroup and it
follows the group again. The label is the place to check what it's pointing at.

### Party profile

The Party profile setting picks the Roon profile guests' tracks are played under, so
they count toward that profile's play history and Roon Radio instead of yours.

Left unset, nothing is selected and guests play under the profile Roon gives a new
session: "Guest" on a Core in October 2026, never the host's. The API doesn't name that
profile, and the Guest profile can be deleted, so `_readDefaultProfile` opens a new
session each time the settings open and reads its Profile entry, selecting nothing. The
choice reads "Roon's default (Guest)", or "Roon's default profile" when that can't be
read. What a Core gives new sessions once Guest is deleted hasn't been seen.

Roon's API has no profile call, so the extension opens the Profile entry in Roon's
Settings menu and selects the profile there.

Roon keeps the profile **per browse session and per hierarchy**:

- each `multi_session_key` has its own profile in each hierarchy;
- a session nobody has selected one in uses Roon's default, "Guest";
- a queue action counts toward the profile of the session and hierarchy it was made in.

This was found on a real Core: selecting in a guest's "settings" hierarchy switched it
there ("Guest" → "Pat"), while tracks the same guest queued from the "search" hierarchy
still counted as Guest.

So guests search and queue in Roon's main **"browse"** hierarchy, the only one holding
both pieces:

```
Library  → Search (takes input) → Tracks → a track → Queue / Add Next
Settings → Profile → the profiles
```

Before a guest's first search or request, `RoonService._profileFor` selects the profile in
that guest's browse session through Settings → Profile (`selectProfileInBrowse`). It does
this once per guest, and again after the setting changes or the Core reconnects. The
search then runs through Library → Search in the same session (`_openSearch`).

Library and Settings are found by what they hold, not their names (`openTopEntry` in
`lib/titles.js`). Library is the top-level entry with a search box (an item with
`input_prompt`); Settings is the one with the Profile entry. The extension's own session
in the "settings" hierarchy (`party-profile`) only reads the list for the settings
dropdown.

The Profile entry is matched by its title: "Profile" in English, or a translation. On a
Core in another language that doesn't match, put its title in "Profile entry in
Settings". If something doesn't match, the setting shows what Roon offered and the
console logs it. The console also logs `Profile "Party" selected for guest session …`,
with Roon's answer and the profile before and after.

### Party name

Left blank, the party name is the party zone's name. For a grouped zone, that's Roon's
name for the group, such as "Kitchen + Living Room". It follows the zone if you change
it, and the setting shows which name that is.

With neither a name nor a zone, the pages say "Party" in the guest's language
(`party.default_name`): the server sends them an empty name (`RoonService.pageName`).
Roon's status line says "Party", in English like the rest of the settings.

### Party host name

Stored as `host_name`, blank by default. Set, it stands in for "Host" wherever the host's
tracks and skips show: the tag on the guest page and the Party Hub, "Skipped by Host" in
Played (through `played.skipped_by`, as for a guest), the playlist file and the log. It's
tidied like a guest's name (`cleanName()`), sent to the pages as `host_name` with the
queue data, and reserved, so no guest can take it. Left blank, the pages say "Host" in
each guest's language (`credit.host`, `played.skipped_by_host`).

In the gendered languages those defaults are neutral: a plural ("the hosts", as in
Spanish *Anfitriones*, Russian *Хозяева*) or a neutral form (German *Gastgebende*), so
neither a man nor a woman is assumed. Japanese uses 主催者 ("organiser"), since ホスト
also means host-club staff. The older masculine words, and the feminine ones, are reserved
as guest names (`_reserved_host_words` in each language file).

### Party Hub language

Stored as `hub_language`, `''` for Automatic. See [Choosing the
language](#choosing-the-language).

### Playlist on the Party Hub

Stored as `playlist_download`: `'qr'`, `'link'` or `'off'`. See [The party
playlist](#the-party-playlist).

### Allowances

Each guest has separate allowances for adding, playing next and skipping, on a
token-bucket model: they start with N goes and earn one back every M minutes.

- 0 goes per guest means no limit.
- 0 minutes means a used go never comes back.
- Changing the number mid-party applies to guests already there, counting what they've
  used (`GuestStore._refill`): 5 with one used becomes 9 of 10, or 2 of 3. Lowered below
  what a guest has used, they have none left, with nothing owed if it goes up again.
- To stop guests doing something at all, set its "Let guests …" to No.
- Playing next is a way of adding, so it needs adding on: with "Let guests add tracks" on
  No, play next is off whatever its own setting says (`GuestStore.check`, and the
  `capabilities` `/api/party` sends). So its settings sit in the Adding tracks group,
  after the adding ones, as "Also let guests play a track next". The two counts are named
  after the guest page's buttons, "Add to queue" per guest and "Play it next" per guest,
  so it's clear both add a track. Skipping stays independent: a host can let guests only
  skip, as a veto.

Adding and playing next are on by default; skipping is off. The defaults:

| | Goes | Earn one back every |
| --- | --- | --- |
| Adding | 5 | 10 minutes |
| Playing next | 1 | 60 minutes |
| Skipping | 1 | 60 minutes |

About 15 tracks play an hour. Adding is set so one guest can't queue far faster than that
(the queue only grows at the end, so an early burst holds everyone else back), while a few
guests together still earn more than can play. Playing next jumps everyone already
waiting, and Roon puts each one straight after the current track, so it stays rare. These
apply until the host saves the settings in Roon, which stores every value; a guest who
rescans gets a new session with full allowances, so they keep things polite rather than
enforce anything.

### Hide names in downloadable playlist (Advanced)

Stored as `playlist_hide_names`, off by default. See [The party
playlist](#the-party-playlist).

### Web port (Advanced)

The default, 8338, has to be free on the machine itself, since the container shares the
host's network. It stays clear of:

- common defaults: 8080, 3000, 5000, 8000, 8443 and 9000;
- Roon's own ports: UDP 9003, TCP 9100–9200 and 9330–9339;
- the other Extension Manager extensions: 8088, 9010 and 3000.

If you change it, stay between 1024 and 49151. The OS hands out higher ports for
outgoing connections.

- **Saving a new port** moves the guest pages and the Party Hub there straight away. The
  extension then reconnects to the Core so the link Roon shows is updated; it drops out of
  Roon's list for up to ten seconds. Open pages and phones on the old port need the new
  link or a fresh scan.
- **Busy at startup:** the extension uses the next free one of the following nine ports,
  and the status line says so ("port 8338 was busy"). The QR code and links follow. If all
  ten are taken, it still connects to Roon and asks for another port in the settings.
- **Busy when chosen in the settings:** the extension stays on its current port and says
  so.
- **`ROON_EXTENSION_PARTY_MODE_PORT`** only sets the first run's port. Roon saves every
  field on the first Save, the port included, even when only the zone was chosen. From
  then on the saved port wins and the variable is ignored, so change the port with Web
  port in Roon.

Links and QR codes use the machine's first non-internal IPv4 address.

### Browse titles (Advanced)

Roon translates its menus, and the API doesn't say which language the Core uses. The
extension first tries the titles in the Advanced group, or the English ones (`Tracks`,
`Queue`, `Add Next`, `Profile`) when those are blank. When one isn't found, it works the
menu out instead (`lib/titles.js`):

- **Track category:** the search category whose items open straight into play actions.
  Albums and artists open into further lists.
- **Profile entry:** the word for "Profile" in the languages Roon is translated into.
- **Queue and Add Next:** by position in a track's action list (Play Now, Add Next,
  Queue, Start Radio), and only when the list has exactly those four actions. Any other
  shape is refused rather than guessed, since pressing the wrong one could play a guest's
  track straight away.

What it found shows in each setting's hint and in the console (`Browse titles: using
"Titel" as the Track category`). Typing the Core's own title into a setting overrides the
detection. The first search's result categories are logged too (`Search (Library →
Search) result categories: …`), to check what the search covers.

### Status line

Once the zone is up, Roon's status line reads the same way in every mode
(`statusText()`): the mode and the party's name, then the Party Hub's address on its own
line.

```
Paused: House Party
Party Hub at http://…/PartyHub
```

Before that, it says what's missing: no Core, no zone, or the zone is unavailable.

## The guest page

It's at `/GuestHub` (any case), where the join link sends guests. Before 1.2.0 it was at
`/`, which now shows the "Scan the code again" page (`messagePage()`). It isn't
redirected, so an old bookmark needs a fresh scan.

- **Allowances are on the buttons they limit:** "Add to queue · 3 left", greyed out
  when used up. Skip shows nothing until it's used up, then "in 5 min". Buttons are
  relabelled in place from `party.allowances` (`labelButton` in `public/guest.js`), and the
  page fetches the allowances again when a used go is due back.
- **A line under the search box** appears only when requests are closed or paused.
- **Skip shows only when Roon will skip.** The queue data carries `can_skip`, Roon's
  `is_next_allowed`: false on a radio station, and on the last track with Roon Radio off,
  when there's nothing to skip to. The guest page shows Skip only when the host allows
  skipping and that's true (`showSkip()`, which also runs when Party mode changes and
  the page reloads its settings). `POST /api/skip` answers 409 `cant_skip` without using
  the guest's skip, and `RoonService.skip()` refuses one too.
- **The name tag**, top right, opens the name dialog. The 🌐 button beside it chooses the
  language (see [Translating the pages](#translating-the-pages)).

### Names

Guests are asked for a name on their first visit. It shows as a badge on the tracks they
add, in Up next, Played and on the Party Hub. The phone remembers it, or that they
skipped, so a rescan doesn't ask again.

A guest without a name shows as "Anon" (`credit.guest`, translated on the pages; "Anon" in
the playlist file and the log). It's only a display name: the session's name stays
empty.

Names are compared by `nameKey()` (`lib/guests.js`): case, accents, spaces and punctuation
ignored, so "Sam", "sam." and "S A M" are one name.

- **Party Mode's own labels can't be taken.** `POST /api/name` refuses "Host", "Roon
  Radio", "Radio station" and "Anon" in all 30 languages (`credit.host`, `credit.radio`,
  `playing.station`, `credit.guest`), the word "radio" in each (`_reserved_radio_words`),
  the single words for the host, masculine and feminine (`_reserved_host_words`, such as
  "Gastgeber, Gastgeberin" or "Hostess"), and the host name when one is set, with 400
  `name_reserved`, so a Host tag always means the host. The `_reserved` lists are in
  each language file; the fixed ones are gathered into `RESERVED_NAMES` at startup. A
  name that only contains one ("Hostess Jo", "Radio Ga Ga") is fine.
- **A name another guest uses is asked about, not refused.** Two guests can share a name,
  and a guest who rescans comes back under their old name while their old session still
  holds it. So `POST /api/name` answers 409 `name_taken` (`GuestStore.nameInUse`) until
  it's sent again with `confirm: true`. The dialog stays open and asks ("Someone here is
  already called Sam. Use it anyway?"), and its button becomes "Use it anyway". The name
  the phone remembers is sent with `confirm`, so a returning guest isn't asked.

Naming yourself later, or changing your name, reaches everything you've already added:

- Each session has a `ref`: random, and separate from its `id`, which is the session
  cookie.
- Requests, Played entries, skips and playlist rows record the `ref`.
- `POST /api/name` renames by it (`GuestStore.rename`, `PlayHistory.rename`,
  `PartyPlaylist.rename`) and pushes a fresh queue to the pages.

The `ref` never leaves the server. The pages' credits come from `requester()`, which has
none, and `PlayHistory.list()` strips it.

## Tracks: identity, credits and duplicates

### What Roon says about a track

Roon gives extensions no stable track ID. A browse `item_key` expires with the browse
session, and a `queue_item_id` exists only while the track is queued. So a track is
recognised by what each side carries:

| | Title | Credits | Artwork | Length |
| --- | --- | --- | --- | --- |
| Search result | yes | performers and writers | yes | **no** |
| Queue item, now playing | yes | performers | yes | yes |

Opening a search result, or its action list, adds nothing: no album, length or id.

The length arrives just after a request. Roon reports a queue `insert` with the real
`queue_item_id` and length, and it's matched to the pending request. From then on the
track is known by its queue item id, and once it leaves the queue by its hash:
`sha1(version-sensitive title, sorted artists, length)`, truncated.

### Crediting a track

Roon's queue items don't say who added them. Crediting tries five steps, most exact first:

1. the queue item id;
2. the hash;
3. the same recording, by version-sensitive title;
4. the same song, ignoring version tags;
5. a title only one recent request has.

A request is bound to its queue item when Roon reports the insert, which is exact. Steps
3 to 5 match on title and artist, ignoring remaster tags, artist separators and extra
artists. A request whose insert doesn't arrive within a minute (the host cleared the
queue, say) falls back to them.

A track no guest asked for is **Roon Radio**'s or the **Host**'s (`kind` `radio` or
`host`; a radio station gets no credit). Roon doesn't say which, but Roon Radio adds its
picks in a way of its own, seen on a Core in October 2026: as the last queue entry ends,
one update replaces it with exactly one new entry, which then plays as the queue's first
item. The host's additions are appended to what's there, or put into an empty queue. So
`RoonService._noteRadioPick` marks an entry that arrives that way, with Roon Radio on, as
Roon Radio's, before `queue_changed`, and `requester()` credits everything else to the
host. The marks are in memory, so after a restart Roon Radio's picks already queued are
the host's.

"Host" is only what's left when no guest is found, and Roon can report a guest's insert
before the request finishes. So the playlist looks again at its Host entries while they're
still queued, and once more when the file is made.

Because Roon Radio adds its next pick only as the playing track ends, Up next is usually
empty while it runs. What an empty Up next says is chosen by the server
(`emptyMessage()`, sent as `empty` with the queue data, so both pages agree), checked in
this order:

| Situation | Says |
| --- | --- |
| Party paused | Nothing lined up. (`queue.empty`) |
| Guests can't add tracks, Roon Radio on and a track playing | Roon Radio picks what's next. (`queue.empty_radio`) |
| Guests can't add tracks | Nothing lined up. |
| Roon Radio on and a track playing (not a station) | Nothing lined up. Add a track, or leave it to Roon Radio. (`queue.empty_add_radio`) |
| Anything else | Nothing lined up. Add a track. (`queue.empty_add`) |

Roon Radio doesn't count for a paused or stopped zone, which it doesn't start, or for a
radio station. A settings change sends the queue data again, so the message follows it.

The console logs each request, each queue insert with its length and hash, and each
track start, with its credit. Look there when a badge is wrong.

### Duplicates

A duplicate is the same recording, not the same song: a remaster, a live take, a single
edit or a cover is a fair request even when the original is queued. `sameRecordingAsQueued`
(`lib/track-id.js`) decides:

1. **The titles must match exactly,** version tags included.
2. **Then the artwork, when both sides have it.** The image key is the album's cover, and
   the only thing that tells one album's version from another's. A different cover is
   another album, so not a duplicate. The same cover is a duplicate, unless no artist is
   shared (two performers on one compilation).
3. **Otherwise, the credits.** A search result credits writers too ("FINNEAS, Billie
   Eilish, 2CELLOS"); a queue item only performers ("Billie Eilish"). So `sharedCredits`
   treats names on at least half of the results with that title as writers (with fewer
   than three results, none are), and what's left must include a queued artist. A result
   crediting only writers is the original, and is compared on all its names.

Credits come last because they can't tell a band's own versions from a cover: "Pere Ubu"
and "Pere Ubu, Allen Ravenstine" read just like "Leonard Cohen" and "Jeff Buckley, Leonard
Cohen".

Search marks queued results `in_queue`, so guests always see "In the queue". With Block
tracks already in the queue on, they're also `blocked`: the page won't offer them, and
`/api/request` refuses them (`already_queued`).

## Searching and browse sessions

Each guest has their own browse session (`multi_session_key`), in the "browse" hierarchy
(see [Party profile](#party-profile)).

- **Item keys go stale.** They're only valid until that guest's session moves on. If a
  request's key has gone stale, the server replays the guest's search and retries once.
  That covers the usual case of a guest searching again before tapping.
- **A guest's operations take turns** (`RoonService._inSession`). A session has one
  position, and a search or a request is several steps through it. When two interleaved,
  one search opened Tracks while another took the session back to the result categories,
  and the first then read "Tracks, Artists, TIDAL" as tracks.
- **Only the latest search runs.** A search still waiting when the same guest searches
  again is dropped (`search` returns null), and the page ignores out-of-date answers too.
- **Only tracks come back:** `action_list` items, never a category.

## Played history and skips

Roon's API has no play history, so the extension records the guest page's Played list
itself, as tracks start (last 200 tracks).

- **A guest's skip** marks the playing track (`markSkipped`), and Played shows "Skipped by
  Sam". The mark is made before the skip reaches Roon, since the next track can start
  before Roon answers, and is undone if the skip fails.
- **A skip made in Roon** is inferred. `RoonService._notePosition` keeps the furthest
  position Roon reported for the playing track; zone updates can carry a reset one. A
  track left 10 seconds or more before its end (`SKIP_MARGIN` in `lib/history.js`), with
  no guest skip, shows "Skipped by Host" (`skipped_by_host`), like the Host tag on tracks
  queued in Roon. Anything that cuts a track short counts, such as Play Now on another
  track in Roon.
- **No judgement without data:** a track with no length or no reported position is never
  marked, so radio streams and zones that report no position never show it.

## Radio stations

A live radio station plays outside Roon's queue and never ends. Seen on a Core in October
2026 (ABC Triple J on a zone with a queue left over from before):

- **Now playing** is the station's name, with no artist, no length and a position that
  counts up; this station sent no song titles. Seeking, next and previous are blocked.
  Paused, the zone reports `stopped`, still with no length and no seeking.
- **The queue stays as it was.** The track the station replaced is still the queue's
  current item. Queue adds after it, at the end; Add Next goes straight after it.
- **So a request never plays** while the station does, and pressing play only resumes
  the station.

`isStation()` (`lib/roon-service.js`) recognises one: a now playing with no length that
can't be seeked. A track always has a length, even while it loads.

**Requests wait for the host.** A guest's track is queued as usual, but nothing is pressed
afterwards: play would only resume the station. The host plays the queue from Roon (the
README says how).

Taking over automatically was tried and dropped as too clunky. What the Core did
(October 2026), for whoever tries again:

- The transport's `play_from_here` stops the station and plays from that entry, but the
  Core never answers it, so it can't be waited for.
- With Loop off it drops every entry before the one played from, other guests' requests
  included; with Loop on it moves them to the back under new ids.
- Play Now on a track replaced the whole queue with that one track.

**Elsewhere:**

- The pages get `now_playing.station`. They label it "Radio station" (`playing.station`)
  while it plays, and "Paused" like a track when it doesn't. Both say requests wait for
  the host (`queue.waiting_for_host`, worded to suit anything else that holds requests
  for the host): the guest page in the line under the search box, the Party Hub under
  the station. While the party is paused, the paused message takes that place on both.
- Skip is hidden, because Roon doesn't allow next on a station (see
  [The guest page](#the-guest-page)).
- `requester()` credits a station to nobody: it isn't Roon Radio, and no guest asked for it.
- Played never lists a station. The track it replaced moves into Played as it starts
  (`PlayHistory.update`), as "Skipped by Host" if it was cut short.

## The party playlist

Roon's browse API offers extensions Play Now, Add Next, Queue and Start Radio on a track,
and Play Now, Shuffle, Add Next, Queue and Start Radio on a playlist. Nothing creates or
edits a playlist (checked against a Core in October 2026). So the playlist is a download,
not a Roon playlist.

**What's recorded.** `lib/party-playlist.js` records every queue entry the party zone
gets, once per `queue_item_id`. That includes what was queued before the extension
started, Roon Radio picks and the host's own additions. Credits are kept when an entry is
first seen, because turning Party mode off clears attributions; renaming still reaches
them (see [Names](#names)).

**Moved entries.** Roon gives an entry it only moves a new id. With Loop on, a track that
has played goes to the back of the queue; playing the queue from a later entry does the
same with the ones before it. So an entry that appears in the same update as one with
the same fingerprint (`trackHash`, or title, artist and album without a length) leaves the
queue is the same entry moved: its track takes the new id and isn't listed again. A track
queued again later is listed again.

**The file.** `GET /Download/playlist.csv` serves it (`/api/playlist.csv`, its address
before 1.2.0, still works) as CSV in the form Soundiiz imports:

- lower-case `title`, `artist` and `album` headers; importers ignore the other columns;
- commas between fields, and Roon's ` / ` between artists written as `, `;
- UTF-8 without a byte order mark. A BOM hides the first header from an importer, at the
  cost of Excel's double-click guessing the encoding wrong;
- column names and credits in English, which import services expect, except that the
  host name, when set, credits the host's tracks;
- a guest name a spreadsheet would read as a formula gets a leading apostrophe. Track
  details are left as Roon gives them, so they still match;
- with Hide names in downloadable playlist (`playlist_hide_names`, Advanced, off by
  default) every guest's track is credited `Anon`; Roon Radio and Host stay. Only the
  file changes: the names are still recorded, so turning it off shows them again, and
  the pages and log still show them.

Times are local to the extension, which in Docker is UTC unless `TZ` is set.

**Where it's offered.** The URL needs no session, like the rest of the Party Hub, and
always works. The Hub only offers it while Party mode is off, which is how a host ends a
party. The Playlist on the Party Hub setting decides how:

- `playlist_download` is `'qr'`, `'link'` or `'off'`, read through `playlistDisplay()`,
  which also turns the brief yes/no form into `'qr'` or `'off'`.
- `/api/hub` passes it as `playlist`. The Hub shows a QR code from
  `GET /Download/playlist-qr.svg` with the link under it, a button, or nothing.
- The setting's hint in Roon gives the download address, which `app.js` hands over with
  `setPlaylistUrl()` alongside the website link.

**How long it's kept.** In memory:

- **At most 5000 tracks** (`MAX_TRACKS`), about two weeks of non-stop play. The queue
  subscription shows the first 500 entries, so the list grows only as fast as music plays
  and guests add to it.
- **Past the limit**, the oldest entries no guest asked for (the host's and Roon Radio's)
  go first, and guests' requests only when they alone are too many.
- **`seen`**, the queue ids already recorded, loses an id with its track, so it is never
  larger than the list. It can't simply be cut to the ids still queued: an entry pushed
  past the 500 shown comes back into view later, and a resubscription empties the queue
  for a moment, so either would record tracks twice.
- **Title, artist and album** are cut to 200 characters.
- **It starts over** when the extension restarts, the party zone changes, or Party mode
  comes back on from Off (a new party). What is still queued at that moment is recorded
  again.

## Translating the pages

The guest page and the Party Hub take their text from `public/i18n/<code>.json`, one file
per language. Each browser gets its own language, so guests at the same party can each
see theirs. Anything not translated, or a missing key, falls back to `en.json`. Track,
artist and album names are shown as Roon gives them.

Available (30): English (`en`), Arabic (`ar`), Egyptian Arabic (`ar-EG`), Bulgarian (`bg`),
Czech (`cs`), Danish (`da`), German (`de`), Greek (`el`), Spanish (`es`), Finnish (`fi`),
French (`fr`), Hebrew (`he`), Hungarian (`hu`), Italian (`it`), Japanese (`ja`), Korean
(`ko`), Norwegian Bokmål (`nb`), Dutch (`nl`), Polish (`pl`), Portuguese (`pt`, Portugal),
Brazilian Portuguese (`pt-BR`), Romanian (`ro`), Russian (`ru`), Swedish (`sv`), Thai
(`th`), Turkish (`tr`), Ukrainian (`uk`), Vietnamese (`vi`), Simplified Chinese
(`zh-Hans`) and Traditional Chinese (`zh-Hant`).

The non-English files are AI drafts (thanks, Claude), so apologies for any poor
translations. Corrections from native speakers are welcome.

### Adding a language

1. Copy `en.json` to, for example, `de.json`, and translate the values.
2. Keep the `{name}`, `{count}` and `{wait}` placeholders.
3. Entries like `{ "one": …, "other": … }` are plurals, picked by the language's own rules
   (`Intl.PluralRules`). Add `zero`, `two`, `few` and `many` where the language has them:
   Arabic has all six; Czech, Polish, Russian and Ukrainian need `few` and `many`;
   Japanese, Korean, Chinese, Thai and Vietnamese need only `other`. A form left out falls
   back to `other`.
4. Fill in `_reserved_host_words`: the language's single words for the host, masculine
   and feminine, comma-separated (English "Host, Hostess", German "Gastgeber,
   Gastgeberin"), or just the one where it has no gender (Hungarian "Házigazda"); and
   `_reserved_radio_words`, its word for "radio" ("Радио"). Guests can't use them as
   names. Like
   `_language`, it isn't page text: keys starting with `_reserved` aren't sent to the
   pages (`wordLists()` in `lib/i18n.js`).
5. Restart the extension to pick up the new file.

`npm test` checks that each translation uses the same keys and placeholders as English,
and that every key the pages and `messagePage()` use is in `en.json`.

### Choosing the language

**From the browser** (`pick()` and `match()` in `lib/i18n.js`). Accept-Language entries
are tried best first. Each is matched as the tag itself (`pt-BR`), then as the language
with its region or script, then as the language alone (`fr-CA` gets `fr`). A few codes are
mapped:

- `no` and `nn` to `nb`, and the old `iw` to `he`;
- Chinese by script: `zh-TW`, `zh-HK`, `zh-MO` and `zh-Hant-…` get `zh-Hant`, and every
  other `zh` gets `zh-Hans`.

Nothing matching, or `*`, gets English.

**By the guest.** The 🌐 button beside the name tag (just the globe; its label reads
"Language: English. Change") opens a list of every language by its own name (`list()`),
plus "Automatic", the phone's language.

- A choice is saved as a `party_lang` cookie for a year. It isn't HttpOnly, because the
  page sets it. "Automatic" deletes it.
- `pick()` honours the cookie before Accept-Language, so the page reloads to switch.
- `/i18n.js` tells the page whether the language was chosen (`chosen`), to mark the list,
  and varies on `Cookie`.
- The same cookie applies to the Party Hub and the join pages in that browser.

**For the Party Hub, by the host.** A TV's browser is often hard to set, so the Party Hub
language setting (`hub_language`, `''` for Automatic) can fix the Hub's language for
every screen. Its choices are "Automatic" and the languages by their own names
(`list()`); the title and hint stay in English, like the other settings. A chosen
language wins over the Hub browser's cookie and Accept-Language (`hubLanguage()` in
`lib/server.js`); guests' pages never use it. The Hub page and its text ask for it:
`/PartyHub` is written in it, and the Hub loads `/i18n.js?for=hub`. `/api/hub` returns
`language`, so an open Hub reloads when the host changes the setting. A value that isn't
a language reads as Automatic.

### Right to left

Hebrew and Arabic pages get `dir="rtl"` (`dir()` in `lib/i18n.js`). The runtime sets it,
and the server writes it into the Party Hub and its message pages.

- The styles use logical properties (`inset-inline-end`, `padding-inline`,
  `text-align: start`), so they mirror, and scrolling names slide the other way.
- Text guests type (search, name) takes its direction from what's typed (`dir="auto"`).
- A guest's name or a language name dropped into a sentence is wrapped in first-strong
  isolates (U+2068…U+2069), on a right-to-left page or when the name itself is right to
  left. So "Requested by יוסי" and "דולגה על ידי Sam" keep their order (`isolate()` in
  `i18n-runtime.js`).

### Long translations

Translations run longer than English: Arabic and Hungarian button labels pass 35
characters with the allowance. So:

- action buttons wrap rather than overflow, and lose their indent on phones under 400px;
- toasts are as wide as their message, up to the screen's width;
- a track, artist or album name in a different script from the page keeps the page's
  alignment.

## The Party Hub's name

The TV page is the **Party Hub**, at `/PartyHub`. Express routes ignore case, so
`/partyhub` works too. Roon's Extensions link and status line point there.

Its tab title is the party's name plus "Hub" (`page.hub_title`, `{name} Hub`). The
server writes it into the page, with the page's `lang`, before sending it, so bookmarks
and home-screen icons get it as the page arrives. `hub.js` sets it again on each update,
so a renamed party shows straight away. Safari on macOS drops what open tabs' titles have
in common, so with the guest page ("House Party") open beside it, the Hub's tab reads
just "Hub".

It was the RoonParty screen before 1.2.0. `/roonparty` redirects (301) to `/PartyHub`, and
`/api/roonparty` still answers alongside `/api/hub`, so a screen left open across the
upgrade keeps working until it reloads.

## Accessibility

The pages were checked by hand against WCAG 2.2 AA (October 2026). Keep these when
changing them:

- **Contrast.** Text colours in `public/party.css` are all at least 4.5:1 on the
  background. Text fields use `--field-edge`, 3:1 against the page and the field.
- **Focus survives redraws.** The guest page rebuilds its search results on every
  change, so `renderResults(focusKey)` puts focus back on the row just opened or
  requested. Results that can't be requested (`blocked`, or just added) are
  `aria-disabled` rows, not dead buttons.
- **Announce, don't read out.** The results list isn't a live region. A hidden
  `role="status"` line says how many tracks were found (`search.results`, a plural).
- **Used-up buttons stay reachable.** They're `aria-disabled`, not `disabled`, so a screen
  reader still hears "Skip, in 5 min". Pressing one shows why in a toast. They're outlined
  rather than faded, so the wait stays readable.
- **The name dialog** makes the page behind `inert`, closes on Escape (as Skip or
  Cancel), and hands focus back to the button that opened it.
- **Moving text stops.** Long names scroll twice to the end and back, pause on hover,
  then keep their "…" (`marquee.js`; the count is in `party.css`). With reduced motion
  they never scroll.
- **Numbered lists** are `<ol>`, and the visible number is `aria-hidden` so it isn't read
  twice. Album covers have empty `alt` text: the title next to them says it all.
- **Say why, in the guest's language.** The guest page shows nothing until it knows
  whether it can open. Then it says "Scan the code again" (no session) or "Requests are
  closed" (the API answers `closed` while Party mode is off), never one in place of the
  other. An old or closed join link (`/j/<code>`) gets a small HTML page from
  `messagePage()` in `lib/server.js`, with `lang` and a viewport, rather than plain text a
  phone shows tiny.
- **QR codes say what they are.** Their `alt` text names the code ("QR code for the
  guest page", `screen.qr_alt`) rather than repeating the link under it, which a screen
  reader would then hear twice.
- **Headings follow the page.** On the Party Hub, "Requests are closed" is an `<h2>`, in
  the place of the playing track's title, which is one too.

## Security

- **Access is a shared join code, not a login.** Anyone who can reach the port and has
  scanned the code can add tracks. The Party Hub and its endpoints need no session, and
  they include the join link, so the code proves someone opened the Hub, not that they're
  in the room. Don't expose the port to the internet.
- **Allowances are per session.** A guest who scans the code again gets a new session
  with full allowances.
- **Guests can only queue what they were shown.** Browse item keys are short and numbered
  in sequence, so `POST /api/request` only takes a key this guest was sent in their search
  results (`GuestStore.offer`, the last 400 per guest). It uses the title and artist the
  server sent, not the phone's. So a guest can't send the key of an album, a playlist or a
  search category, which would queue all of it, or pass one track off as another to get
  past the duplicate check. A key never sent answers `unknown_track`.
- **Allowances are taken before Roon is asked**, and handed back (`GuestStore.refund`) if
  Roon refuses, for requests and skips alike. So several sent at once can't all pass the
  check before any is counted.
- **Input limits.** Names go through `cleanName()` (`lib/guests.js`). It removes control
  characters, which could fake log lines, and direction overrides, which can show a name
  back to front. The 24-character limit counts characters, so an emoji isn't cut in half.
  Searches stop at 200 characters. At most 2000 sessions are held; the longest idle goes
  first.
- **Session cookies stay private.** A guest's tracks are linked to them by a separate
  `ref`, never the session `id` (see [Names](#names)).
- **Other sites can't act for a guest.** The `party_sid` cookie is `SameSite=lax`, so a
  browser doesn't send it with a POST another site starts, and the API takes only JSON,
  which a plain form can't send. As a second lock, a POST whose `Origin` names another
  site, or `null`, gets 403 `cross_origin` before its body is read (`sameOrigin()`). One
  with no `Origin` (not a browser) passes; it still needs the cookie. `SameSite=strict`
  isn't used: a guest arriving from the camera app would land without their new cookie.
- **Sessions last 12 hours from last use** (`SESSION_TTL_MS`, `lib/guests.js`). Every
  guest API call renews the `party_sid` cookie for the same 12 hours, so a guest who keeps
  using the page stays in. One idle that long gets "Scan the code again" on their next
  action, and a new session (name and allowances start over) when they scan.
- **Nothing outlives a session.** When a session ends, `GuestStore.onDrop` tells
  `RoonService.forgetSession()`, which drops the guest's profile marker; a guest's
  latest-search ticket is kept only while a search waits.
- **Headers.** Every response carries a Content-Security-Policy that allows only the
  extension's own scripts, styles, images and connections. The pages have no inline script
  or style; `marquee.js` sets styles through the DOM, which the policy allows. Responses
  also carry `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and a
  `Permissions-Policy` that switches off browser features the pages never use (camera,
  microphone, location, payment and the like). `Cross-Origin-Resource-Policy:
  same-origin` and `Cross-Origin-Embedder-Policy: require-corp` stop other sites
  embedding the extension's files, and the pages loading anything from elsewhere;
  everything they load is their own, and neither applies to the Party Hub shown in a
  frame. There's no `Cross-Origin-Opener-Policy`: browsers ignore it over plain HTTP on
  a LAN address, and log an error on every page saying so. Guest pages refuse to be framed
  (`frame-ancestors 'none'`, `X-Frame-Options: DENY`); the Party Hub may be, for a
  dashboard on the TV. `test/server.test.js` covers all of this.
- **Plain errors.** An unknown address gets a plain `Not found`, and a malformed request a
  plain `Bad request`, both with the headers above, instead of Express's own error page,
  which names Express and drops them. Anything else is logged and answered `Something
  went wrong`.
- **Requests a minute are limited, per device** (by IP address, `perMinute()` in
  `lib/server.js`, with `express-rate-limit`): 600 of any kind, and 60 searches, since
  each search runs in the Roon Core. That's far above what a phone or the Party Hub
  sends; the limits are there for a misbehaving or rogue device on the Wi-Fi, which could
  otherwise swamp a Pi Zero or the Core. Past one, the answer is 429 `too_many_requests`
  (with `Retry-After`) until the minute is up, and the guest page says to wait a minute.
  `rate_limited` is a different thing: a guest's allowance used up. Set them with
  `ROON_EXTENSION_PARTY_MODE_RATE_LIMIT` and `…_SEARCH_LIMIT` (see [Environment
  variables](#environment-variables)); 0 turns one off. Some guest Wi-Fi networks put
  every phone behind one address, which then shares the limits: raise them there.
- **Album art gives up.** `/api/image/:key` needs no session, and Roon never answers for
  an image key it doesn't know. So `getImage()` stops waiting after 5 seconds
  (`IMAGE_TIMEOUT_MS`) and answers 404, rather than holding the connection open.

## Installing it from Roon

Once the image is on Docker Hub and the entry is in the Extension Repository, install it
with the [Extension Manager](https://github.com/TheAppgineer/roon-extension-manager).

The Manager runs it with host networking, since Roon discovery uses UDP broadcast on
port 9003. It bind-mounts `config.json`, so settings survive updates.

## Code scanning

`.github/workflows/codeql.yml` runs GitHub's CodeQL when started by hand: Actions →
CodeQL → Run workflow, on `experimental` before merging into `main`. Its push, pull
request and weekly triggers are commented out. It analyses the JavaScript, with the
security-extended queries, and the workflows themselves (`.github/codeql/codeql-config.yml` leaves out
`node_modules` and `test`). It only reads the code. Results are under the repository's
Security tab → Code scanning. Two JavaScript alerts are known and accepted:
`js/missing-token-validation`, which doesn't see the `SameSite` cookie and Origin check
(see [Security](#security)), and `js/missing-rate-limiting` on static files.

## Publishing the image

`.github/workflows/docker-publish.yml` builds `linux/amd64`, `linux/arm/v6`,
`linux/arm/v7` and `linux/arm64`, and pushes `stubaggs/roon-extension-party-mode` to Docker
Hub. Its tags depend on the branch chosen under **Use workflow from**:

| Branch | Tags | Who gets it |
| --- | --- | --- |
| `main` | `latest`, and the version (`1.1.1`) | The Extension Manager (`repository-entry.json` asks for `latest`), and Docker users on `latest`. The version tag lets anyone pin or roll back |
| `experimental` | `experimental`, and the version (`1.2.0-experimental`) | Only those who ask for `:experimental` |

The workflow refuses any other branch. It also refuses `experimental` when its
`package.json` version has no suffix, so an experimental build can never take `latest` or
a release's number.

### Running the workflow

It only runs when started by hand: Actions → Publish Docker image → Run workflow. Two
triggers are commented out:

- `push` would publish on every merge to `main`;
- a weekly `schedule` would rebuild and republish every Monday, so installs pick up
  base-image security fixes.

Its GitHub token can read the code and sign the image's provenance (`id-token` and
`attestations`), nothing else. Docker's actions and `actions/attest` are pinned to commits
rather than tags that could be moved, since the job holds the Docker Hub token and can
sign. Dependabot updates the pins.

From `main`, it refuses to publish a version that's already on Docker Hub: a release
number names one image for good, so people can pin it, and its digest in RELEASES.md stays
true. To publish again, bump the version. `experimental` versions can be republished.

It needs two repository secrets, under Settings → Secrets and variables → Actions:

| Secret | Value |
| --- | --- |
| `DOCKERHUB_USERNAME` | `stubaggs` |
| `DOCKERHUB_TOKEN` | A Docker Hub access token with Read & Write scope |

The Extension Manager checks Docker Hub for a newer `latest`, so publishing a new `latest`
is how an update reaches people who have it installed.

### Releasing

1. Bump `version` in `package.json` and give RELEASES.md its section.
2. Run CodeQL on `experimental` (see [Code scanning](#code-scanning)) and check its results.
3. Merge into `main` through a pull request.
4. Tag the merge commit `v<version>` (an annotated tag, from `v1.1.0` on).
5. Run the workflow by hand. Its `tags: ['v*']` trigger is commented out with `push`, so
   tagging doesn't publish.
6. Copy the digest from the run's summary into RELEASES.md, under the version's heading:
   ``Docker image: `stubaggs/roon-extension-party-mode:<version>@sha256:…` ``.
7. Create the GitHub release for the tag, with that version's section of RELEASES.md as
   its notes.

### Checking an image against the code

Every image the workflow publishes carries, for each platform:

- BuildKit's **provenance** (`provenance: mode=max`): the commit
  (`org.opencontainers.image.revision`), the Dockerfile and the build's inputs. It's
  unsigned, so it says what the publisher claims rather than proving it.
- An **SBOM** (`sbom: true`) listing every package in the image.
- A **signed attestation** from `actions/attest`, made with a Sigstore certificate that
  only this workflow in this repository can get. It's pushed to Docker Hub beside the
  image and stored on GitHub. This is the one that proves the image came from the
  workflow, at the commit it names.

To check a published image:

```sh
# the commit, Dockerfile and inputs it was built from
docker buildx imagetools inspect stubaggs/roon-extension-party-mode:1.3.1 \
  --format '{{json .Provenance}}'
# the packages inside
docker buildx imagetools inspect stubaggs/roon-extension-party-mode:1.3.1 \
  --format '{{json .SBOM}}'
# the signature: built by this repository's workflow, and from which commit
gh attestation verify oci://stubaggs/roon-extension-party-mode:1.3.1 \
  --repo stubaggs/roon-extension-party-mode
```

`gh attestation` needs a recent GitHub CLI (Ubuntu's 2.46 package doesn't have it).
It checks the image's digest against the signed record, so it fails
for any image the workflow didn't build. Add `--source-ref refs/heads/main` to require a
release built from `main`, or `--format json` to see the commit (`sourceRepositoryDigest`).
Images up to 1.3.0 have the unsigned provenance only (1.2.0 and 1.3.0 name the commits of
`v1.2.0` and `v1.3.0`); the signed attestation and SBOM start with the next release.

Pinning a digest (`stubaggs/roon-extension-party-mode:1.3.0@sha256:…`, as RELEASES.md lists
them) gets exactly that image, whatever happens to the tags later. The Extension Manager
always installs `latest`.

### The Dockerfile

It builds in two stages:

1. Install dependencies exactly as `package-lock.json` pins them (`npm ci`, which needs
   `git` for the Roon packages on GitHub), and run `npm test`, so a failing test stops the
   build.
2. Copy only the app and its dependencies onto a clean base, with a health check that
   requests the Party Hub's data (`/api/hub`) on the configured port. npm, npx,
   corepack and yarn are removed from it: the extension needs only `node`, and they're
   most of what vulnerability scanners report in a Node image. So `npm` doesn't work
   inside the container; build a new image instead.

The health check runs every 60 seconds and allows 15 seconds, with a minute's grace at
startup. Each check starts Node, which takes seconds on a Pi Zero or Pi 1, so a tighter
timeout would report a slow Pi as unhealthy, and more frequent checks would take CPU from
serving guests. Nothing restarts an unhealthy container in a plain Docker or Compose
setup; the status shows in `docker ps`. Even under QEMU emulation (testing `arm` images
on another machine), where Node takes about 10 seconds to start, the check passes.

The image covers both 32-bit ARM variants because Docker reports every 32-bit ARM host as
`arm`, the key the repository entry uses: Pi Zero and Pi 1 need `arm/v6`, later Pis
`arm/v7`.

### The base image

The base is `node:22-alpine`, pinned by digest. Node 22 is the newest line with 32-bit ARM
images (`node:24-alpine` has neither `linux/arm/v6` nor `linux/arm/v7`), and is
supported until April 2027. Before then, move to Node 24 and drop both from the workflow,
and `arm` from the repository entry: Pi Zero, Pi 1 and 32-bit Raspberry Pi OS lose
support. Move `engines` in `package.json` and the Node version in [Running it with
Node.js](#running-it-with-nodejs) along with it.

Dependabot (`.github/dependabot.yml`) checks the base weekly. When the official image is
rebuilt with Alpine or Node security fixes, its digest changes, and Dependabot opens a
pull request updating both `FROM` lines. It skips major Node versions, so it never moves
the image to Node 24 on its own.

Merging that pull request changes only the Dockerfile: the fixes reach installed copies
once a new image is published. To update by hand, change both `FROM` lines together;
`docker buildx imagetools inspect node:22-alpine` prints the current digest.

It also checks the npm dependencies and the workflow's actions weekly. Minor and patch
npm updates come as one pull request; each needs `npm test` and the local Docker check
before merging, like any change.

### Running the image by hand

Install it as the README's [With Docker](README.md#with-docker) says; `docker-compose.yml`
does the same. Both lock the container down:

- `--read-only` (`read_only: true`): the image's files can't change. node-roon-api
  rewrites `config.json` in place, which works on the mounted file, and nothing else
  writes to disk. A new feature that writes a file needs a mount or a `tmpfs` for it.
- `--cap-drop ALL`: no Linux capabilities. The extension runs as uid 1000, listens above
  port 1024 and finds the Core by UDP multicast and broadcast, none of which needs one.
- `--security-opt no-new-privileges`: nothing in the container can gain privileges.

The Extension Manager starts the container its own way, so these don't apply there; it
creates `config.json` writable itself.

`config.json` must exist and be writable by uid 1000 before the container starts. Without
it, Docker makes a directory in its place, and the extension can't save its settings or
Roon's pairing; Roon's status line and the console say so. `chmod 666` works without
`sudo`, but leaves the pairing token readable by every account on the host.

## Running the experimental version

New features are tried out before each release in an **experimental** version. It's
built from the `experimental` branch and published by hand as the `:experimental` Docker
tag (see [Publishing the image](#publishing-the-image)). It may change or break between
updates.

It's a separate extension to Roon (`extensionIdentity()` in `lib/roon-service.js`):

- a version with a suffix registers as `com.stubaggs.party-mode.experimental`, named
  "Party Mode (experimental)";
- a release keeps `com.stubaggs.party-mode`.

Roon tells extensions apart by id, wherever they run. So the two run side by side against
one Core, on one machine or two, each enabled, set up and paired on its own (checked
October 2026). But two copies with the **same** id clash, even on separate machines: run
at most one release and one experimental build per Core, unless the copies are named (see
[Running several copies](#running-several-copies)).

Give the experimental one its own folder, container name, `config.json` and party zone:

```bash
mkdir roon-extension-party-mode-experimental && cd roon-extension-party-mode-experimental
touch config.json && sudo chown 1000 config.json && chmod 600 config.json
docker run -d --name roon-extension-party-mode-experimental --network host --restart unless-stopped \
  --log-opt max-size=10m --log-opt max-file=3 \
  --read-only --cap-drop ALL --security-opt no-new-privileges \
  -v "$PWD/config.json:/usr/src/app/config.json" \
  stubaggs/roon-extension-party-mode:experimental
```

1. In Roon, enable **Party Mode (experimental)** under **Settings → Extensions** and
   choose its settings.
2. Pick a different party zone from the released Party Mode's. Two on one zone would both
   pause and resume it, each with its own join code.

If the released one already uses port 8338, the experimental one takes the next free port,
and its status line in Roon says so.

To stop trying it, remove the container
(`docker rm -f roon-extension-party-mode-experimental`, or `party-mode-experimental` if
you set it up before 1.3.0) and disable it in Roon. The Extension Manager always installs
the released version.

## Running several copies

Roon tells extensions apart by id, so two copies of the same version clash against one
Core, even on different computers. To run more, give each extra copy a name with
`ROON_EXTENSION_PARTY_MODE_INSTANCE`, for example
`-e ROON_EXTENSION_PARTY_MODE_INSTANCE=Garden`.

A named copy registers as its own extension (`extensionIdentity()`):

- `com.stubaggs.party-mode.garden`, shown in Roon as "Party Mode (Garden)";
- "Party Mode (experimental, Dev)" for a named experimental build.

The id uses the name's letters and digits, with accents dropped: "Kitchen & Bar" becomes
`kitchen-bar`. A name with none of those ("厨房") gets a short hash instead. The console's
first line says which name a copy registered as.

Left unset, which is everyone else, nothing changes: same id, same name, same pairing. A
named copy is new to Roon the first time: enable it and set it up, with its own
`config.json` and party zone. Renaming it later makes it a new extension again.

### Names with spaces

In `docker-compose.yml`, write the name as it is:

```yaml
    environment:
      - ROON_EXTENSION_PARTY_MODE_INSTANCE=Living Room
```

or `ROON_EXTENSION_PARTY_MODE_INSTANCE: Living Room` in the `key: value` style.

- Don't quote the value after the `=` in the list style: YAML keeps the quotes, and they'd
  show in Roon's name for it (the id ignores them).
- ` #` starts a YAML comment, so quote the whole line for such a name, or for one starting
  with a symbol such as `&`, `*` or `!`: `- "ROON_EXTENSION_PARTY_MODE_INSTANCE=Bar #2"`.
- With `docker run`, the shell needs the quotes:
  `-e "ROON_EXTENSION_PARTY_MODE_INSTANCE=Living Room"`.

## Environment variables

Every environment variable is named `ROON_EXTENSION_PARTY_MODE_<SETTING>` and read
through `lib/env.js` (`envValue`). The hyphenated spelling,
`ROON-EXTENSION-PARTY-MODE_<SETTING>`, works too: Docker can pass it, though shells can't
set it. A renamed variable keeps its old name working, checked after the new ones.

| Variable | Meaning |
| --- | --- |
| `ROON_EXTENSION_PARTY_MODE_PORT` | The first port, before settings are first saved in Roon; after that, use Web port in Roon (default 8338; was `PARTY_PORT`). |
| `ROON_EXTENSION_PARTY_MODE_INSTANCE` | A name for this copy, so it runs as a separate extension alongside others against one Core (see Running several copies). Unset for normal use. |
| `ROON_EXTENSION_PARTY_MODE_RATE_LIMIT` | Requests a minute from one device, of any kind (default 600; 0 for no limit). See Security. |
| `ROON_EXTENSION_PARTY_MODE_SEARCH_LIMIT` | Searches a minute from one device (default 60; 0 for no limit). |
| `ROON_EXTENSION_PARTY_MODE_DEBUG` | `1`, `true`, `yes` or `on` turns on the detailed log (see Logging). |

## Logging

The normal log is short:

- the port and links at startup;
- one line per guest request (`Request (add) from Sam: …`);
- one per queue insert (`Queued: …`, with length and hash);
- one per track start (`Playing: … -> Sam`);
- one when each guest's session gets the profile;
- warnings.

`ROON_EXTENSION_PARTY_MODE_DEBUG=1` (`lib/log.js`) adds detail: the profile before and
after each switch, the profiles on offer, the first search's result categories, and
node-roon-api's own log of every message to and from the Core (its `log_level`,
otherwise `"none"`). That last part is large and includes guests' searches and Roon's
full replies, so it's for troubleshooting only.

`docker-compose.yml` and the README's `docker run` cap the container log at 3 × 10 MB.

## Known limitations

- **No queue reordering.** Roon's API can add a track to the end of the queue or right
  after the current one, and it can skip, but it can't move a track already in the
  queue. So a guest can ask for a track to play next when they add it, but nobody can
  promote one that's already waiting. Music Assistant's "boost an upcoming song" has no
  Roon equivalent.
- **A request presses play.** Roon's Queue and Add Next leave a paused or stopped zone as
  it is, so a track requested after the queue ran out would sit there unplayed. After
  either succeeds, `performAction` sends `play` unless the zone is already playing or
  loading. That also resumes a zone the host paused in Roon (Party mode's Paused refuses
  requests instead). There's no setting to turn it off. A failed `play` is logged, and the
  request still counts, since the track was queued. On a radio station nothing is
  pressed: the request waits for the host (see [Radio stations](#radio-stations)).
- **Roon Radio is recognised by its pattern** (see [Crediting a track](#crediting-a-track)).
  A track the host adds at the very moment the last one ends looks the same and is taken
  for Roon Radio's; after a restart, Roon Radio's picks already queued are the host's.
- **Some duplicates can't be seen from search** (see [Duplicates](#duplicates)):
  - Two versions on one album with the same title and artist, such as an album version
    and a single edit, look alike, so the second is refused. Once queued, they're told
    apart by length.
  - Roon groups an album's versions (library and streaming copies, remasters, deluxe
    editions) and search shows only the primary. The others have their own artwork, so
    if the host queues one from Versions in Roon, guests can still request the primary's
    copy. Guests' requests all use the primary, so they catch each other. (Seen with
    library and TIDAL copies, October 2026.)
- **Credits can swap.** Two guests asking for the same recording are credited in the
  order they asked. If Roon reports those two inserts out of order, the badges swap.
- **A rescan starts a new session**, and so does coming back after 12 hours without using
  the page. Tracks added before it keep the name they had then.
- **Everything is kept in memory.** Played (the last 200 tracks), the playlist (5000) and
  who asked for what start over when the extension restarts. Played and the playlist also
  start over when the party zone changes.
- **The queue subscription is per zone.** Changing the party zone starts a new
  subscription. The old one is ignored rather than torn down, since the API has no
  convenient unsubscribe.

## Licence

Copyright 2026 Stubaggs. Licensed under the Apache License, Version 2.0 (see `LICENSE`),
matching the other extensions in the Appgineer repository.
