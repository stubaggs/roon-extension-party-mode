# Party Mode on your own screen

Party Mode shares what the Party Hub shows at addresses under `/embed/`, for a screen of
your own: a dashboard, signage, a Home Assistant card, or a Party Hub of your own design.
They're read-only (guests still add tracks on their phones), and any web page may frame
them, show them as an image or read them.

Ready-made Party Hubs to start from, and to add your own to, are in
[roon-extension-party-mode-hubs](https://github.com/stubaggs/roon-extension-party-mode-hubs).

## Reaching Party Mode

Use the Party Hub's address, such as `http://192.0.2.10:8338`, and add the paths below
to it.

Party Mode speaks plain `http`, so a page on an `https` site can't reach it: browsers
block that as mixed content. Open your page from disk or from a web server of your own
on `http`. Firefox moves the images of a page opened from disk to `https` (other than for
`localhost`), so in Firefox the page needs a web server; the live stream works either way.

## Addresses

| Address | What it serves |
| --- | --- |
| `/embed/status.json` | The party's state (see [`status.json`](#statusjson)) |
| `/embed/now-playing.json` | The playing track (see [`now-playing.json`](#now-playingjson)) |
| `/embed/up-next.json` | Up next (see [`up-next.json`](#up-nextjson)) |
| `/embed/played.json` | Played (see [`played.json`](#playedjson)) |
| `/embed/events` | A live stream (server-sent events) of those four, as `status`, `now-playing`, `up-next` and `played`, each with its file's JSON: all four on connecting, then each when it changes |
| `/embed/art/<key>?size=` | A cover, from a track's `art`; `size` 120, 400 (the default) or 800. Only covers Party Mode has sent; 404 otherwise |
| `/embed/join-qr.svg` | The join QR code, the Party Hub's own: it leads to `/GuestHub` |
| `/embed/playlist-qr.svg` | The playlist QR code, leading to `/Playlist`, only while the Hub offers it as a QR code; 404 otherwise |

Two addresses outside `/embed/` are for links people tap on your screen:

| Address | What it does |
| --- | --- |
| `/GuestHub` | The guest page: opening it lets a guest in (once the party's over, it says requests are closed) |
| `/Playlist` | Downloads the playlist while the Hub offers it, as a QR code or a link; 404 otherwise |

## The JSON files

### `status.json`

| Field | Values | Meaning |
| --- | --- | --- |
| `party` | `on`, `paused`, `off` | The party's state |
| `party_name` | text | The party's name; empty if unset |
| `host_name` | text, or null | The host's name; null unless set |
| `ready` | true, false | Connected to Roon |
| `playlist` | `qr`, `link`, `off`, or null | How the playlist is offered once the party's over; null while it's on |
| `language` | a language code, or null | The Hub's language, if the host chose one |
| `roon_radio` | true, false | Roon Radio is on in the party zone |

### `now-playing.json`

`track` is null when the zone has no track (a paused one is still there), or:

| Field | Values | Meaning |
| --- | --- | --- |
| `title`, `artist`, `album` | text | The track |
| `length` | seconds, or null | The track's length; null for a station |
| `art` | an address, or null | Its cover: `/embed/art/<key>`, to add to Party Mode's address |
| `credit` | see [Who asked, who skipped](#who-asked-who-skipped) | Who asked for it |
| `queued_at` | ms since 1970, or null | When Party Mode first saw it in the queue; null for a station, or a track queued before Party Mode started |
| `state` | `playing`, `paused`, `stopped` | The zone's state |
| `station` | true, false | A radio station, not a track |
| `seek_position` | seconds | How far into the track it was at `at` |
| `at` | ms since 1970 | Party Mode's clock when `seek_position` was taken |

### `up-next.json`

| Field | Values | Meaning |
| --- | --- | --- |
| `tracks` | a list, in queue order | Each with `title`, `artist`, `album`, `length`, `art`, `credit` and `queued_at`, as in `now-playing.json`; at most 500, all Roon sends |
| `empty` | `add`, `radio`, `add_radio`, `none` | What an empty Up next would say: guests can add a track; Roon Radio picks what's next; either; or nothing to suggest (the party's paused, or adding is off with Roon Radio off) |

### `played.json`

| Field | Values | Meaning |
| --- | --- | --- |
| `tracks` | a list, newest first | This party's last 200 (it starts empty with each party, and after a restart), each with `title`, `artist`, `album`, `length`, `art`, `credit` and `queued_at`, as in `now-playing.json`, and the three below |
| `played_at` | ms since 1970 | When it started playing |
| `skipped` | true, false | It was skipped |
| `skipped_by` | see [Who asked, who skipped](#who-asked-who-skipped) | Who skipped it |

### Who asked, who skipped

| Field | Values | Meaning |
| --- | --- | --- |
| `credit` | null, or `{ kind, name, how }` | Who asked for the track; null for a station |
| `credit.kind` | `guest`, `host`, `radio` | A guest, the host, or Roon Radio |
| `credit.name` | text, or null | The guest's nickname (null if they gave none), or the host's name (null unless set); null for Roon Radio |
| `credit.how` | `add`, `next`, or null | How a guest asked: to the end, or Play next; null for the host and Roon Radio |
| `skipped_by` | null, or `{ kind, name }` | Who skipped it; null if nobody did |
| `skipped_by.kind` | `guest`, `host` | A guest pressed Skip, or the host cut it short in Roon |
| `skipped_by.name` | text, or null | As in `credit.name` |

## Building a page

- **Follow the stream.** Open `/embed/events` with `EventSource` (across sites it works
  without cookies, and reconnects by itself), and fall back to fetching the files every
  few seconds if it can't.
- **Fetch plainly**, with `fetch(url)` and no headers of your own: a request with headers
  sends an `OPTIONS` first, which gets a 404.
- **Count the position on.** It isn't sent as it moves: while `state` is `playing`, it's
  `seek_position + (now - at) / 1000`. If the party zone goes away, its last track stays,
  paused, as on the Hub.
- **Redraw the lists.** Roon gives a moved track a new id, so there's no queue id to follow
  a track by: redraw Up next and Played on each update.
- **Word it yourself.** `/embed/` gives kinds and reasons, not sentences, so a page can say
  them in its own words and language.
- **Show the right code.** Show the join code while `party` is `on` or `paused`. Once
  it's `off`, show the playlist code if `playlist` is `qr`, or a button to
  `/Playlist` if it's `link`. When the state changes, hide a code's image rather
  than only clearing its `src`: some browsers keep showing the last picture.
- **Links for a screen people tap.** Link the line under a code to `/GuestHub` or
  `/Playlist`. `/GuestHub` lets someone in only as a link they open (not as an image, a
  frame or a fetch), so in a framed page, such as a Home Assistant card, give it
  `target="_blank"`.
- **Don't poll hard.** Every request counts towards the device's requests a minute
  (Flood protection in Party Mode's settings), and every stream towards its streams. A
  page polling many times a second soon gets 429s, which show as broken images.

## What's in it, and what isn't

Any web page may read these addresses, so they never include the playlist's secret
address (the host's own, in Roon), the zone's name, the Core's name, or any setting.
Joining and the playlist are reached only through `/GuestHub` and `/Playlist`, as the
QR codes do. Guests' nicknames are in, as on the Hub: guests choose them for the party.

## A contract

New addresses and new fields may be added, but nothing under `/embed/` is renamed or
removed. A change that would break a page goes under `/embed/v2/` instead. Other
addresses (`/api/…`) are for Party Mode's own pages, change without notice, and are
closed to other sites.
