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
`localhost`), so there the page needs a web server; the live stream works either way.

## Addresses

| Address | What it serves |
| --- | --- |
| `/embed/status.json` | `party` (`on`, `paused` or `off`), `party_name`, `host_name` (null unless set), `ready` (connected to Roon), `playlist` (how it's offered once the party's over: `qr`, `link` or `off`; null while it's on), `language` (the Hub's language if the host chose one, else null), `roon_radio` (Roon Radio on in the party zone) |
| `/embed/now-playing.json` | `track`: null, or `title`, `artist`, `album`, `length` (s, null for a station), `art`, `credit`, `queued_at`, `state` (`playing`, `paused`, `stopped`), `station`, `seek_position` (s) at `at` (Party Mode's time, ms) |
| `/embed/up-next.json` | `tracks` (`title`, `artist`, `album`, `length`, `art`, `credit`, `queued_at`), and `empty`: what an empty Up next would say, as a reason (`add`, `radio`, `add_radio`, `none`) |
| `/embed/played.json` | `tracks`, newest first: `title`, `artist`, `album`, `length`, `art`, `credit`, `queued_at`, `played_at` (ms), `skipped`, `skipped_by` |
| `/embed/events` | A live stream (server-sent events) of those four, as `status`, `now-playing`, `up-next` and `played`: all four on connecting, then each when it changes |
| `/embed/art/<key>?size=` | A cover, from a track's `art`; `size` 120, 400 (the default) or 800 |
| `/embed/join-qr.svg` | The join QR code, the Party Hub's own: it leads to `/GuestHub` |
| `/embed/playlist-qr.svg` | The playlist QR code, leading to `/Playlist`, only while the Hub offers it as a QR code; 404 otherwise |

Two addresses outside `/embed/` are for links people tap on your screen:

| Address | What it does |
| --- | --- |
| `/GuestHub` | The guest page: opened, it lets the guest in (once the party's over, it says requests are closed) |
| `/Playlist` | Downloads the playlist while the Hub offers it, as a QR code or a link; 404 otherwise |

## The fields

- **`credit`** is null (a station) or `{ "kind": "guest" | "host" | "radio", "name", "how" }`:
  a guest's nickname as they gave it (null if they gave none), the host's name if set, null
  for Roon Radio; `how` is a guest's `add` (to the end) or `next` (Play next), else null.
- **`skipped_by`** is null, or `{ "kind": "guest" | "host", "name" }` (the host skipped
  it in Roon).
- **`queued_at`** (ms) is when Party Mode first saw the track in the queue, kept into
  Played; null if it didn't (a station, or queued before Party Mode started).
- **`album`** is the playing track's and, kept from then, each played track's. Up next's
  is usually empty: Roon gives the album only for the playing track.
- **The position** moves on its own between events: while `state` is `playing`, it's
  `seek_position + (now - at) / 1000`. A zone that's gone keeps its last track, paused,
  as on the Hub.
- **No queue id:** Roon gives a track it moves a new one, so it can't follow a track;
  redraw the list instead.
- **Text is yours to choose:** `/embed/` gives kinds and reasons, not sentences, so a page
  can say them in its own words and language.

## Building a page

- **Follow the stream.** Open `/embed/events` with `EventSource` (across sites it works
  without cookies, and reconnects by itself), and fall back to fetching the files every
  few seconds if it can't.
- **Fetch plainly**, with `fetch(url)` and no headers of your own: a request with headers
  sends an `OPTIONS` first, which gets a 404.
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

## A promise

New addresses and new fields may be added, but nothing under `/embed/` is renamed or
removed. A change that would break a page goes under `/embed/v2/` instead. Other
addresses (`/api/…`) are for Party Mode's own pages, change without notice, and are
closed to other sites.
