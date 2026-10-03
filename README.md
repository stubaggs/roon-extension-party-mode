# Party Mode for Roon

Let your guests pick the music. They scan a QR code with their phone, search your Roon
library and streaming services, and add tracks to the party's queue. No app to install, no
Roon account, and no access to anything else in your Roon setup.

- **Guests add tracks** from their phone, or jump one to play next, if you allow it.
- **Skipping** the current track is an option you can turn on.
- **Fair shares:** each guest gets a number of tracks, earning more back over time.
- **Names on tracks:** guests can give a nickname, shown next to the tracks they add.
- **A party screen** for a TV or tablet: QR code, what's playing and the whole queue.
- **Up next and Played** lists, so everyone can see what's coming and what's been on.
- **Keep the party's playlist:** download everything that was queued as a spreadsheet
  file, ready to import into a music service.
- **Roon Radio** tracks are labelled, so guests know what the radio picked.
- **In their language:** the guest pages appear in English, French, German, Spanish or
  Dutch, following each phone's language.

## What you need

- A Roon Core.
- A computer on the same network that runs the extension, usually the same machine as the
  [Extension Manager](https://github.com/TheAppgineer/roon-extension-manager) (any
  64-bit PC, NAS or Raspberry Pi, including Pi Zero and Pi 1).
- Guests' phones on the same Wi-Fi as that computer.

## Installing

### With the Extension Manager

1. In Roon, open **Settings → Extensions → Extension Manager → Settings**.
2. Pick the **Playback** category, then **Party Mode**, and choose **Install**.
3. Back in **Settings → Extensions**, find **Party Mode** and click **Enable**.

The Extension Manager handles updates from then on.

### With Docker

```bash
touch config.json && chmod 666 config.json
docker run -d --name party-mode --network host --restart unless-stopped \
  --log-opt max-size=10m --log-opt max-file=3 \
  -v "$PWD/config.json:/usr/src/app/config.json" \
  stubaggs/roon-extension-party-mode:latest
```

The `--log-opt` settings keep the log from growing without limit.

`config.json` keeps your settings when the image is updated. Then enable **Party Mode**
under **Settings → Extensions** in Roon.

## Starting a party

1. In Roon, open **Settings → Extensions → Party Mode → Settings** and pick the **Party
   zone**: where the music plays. Give the party a name if you like; otherwise it's
   named after the zone.
2. Click **Party Mode**'s link in the Extensions list to open the **party screen**. Put it
   on a TV, a tablet or a laptop where guests can see it.
3. Guests scan the QR code on the party screen with their phone camera. That's it.

When you're done taking requests, set **Party mode** to **Off**. The party screen swaps the QR code
for "Requests are closed" and a **Download the playlist** button; click it on a computer
rather than the TV. You get a CSV file of every track that was
queued in the party zone: title, artist, album, length, who asked for it and when. Roon
can't import it directly, but it's in the format Soundiiz imports: in Soundiiz, choose
**Import playlist**, then the file, and pick TIDAL, Qobuz or Spotify. Roon then shows it
with your playlists. Excel on Windows can garble accented names when you double-click the
file; Google Sheets, Numbers and Excel's **Data → From Text/CSV** read it correctly.

**Party mode**, at the top of the settings, runs the party:

- **On**: guests add tracks.
- **Paused**, for a speech or the cake: the music pauses and guests' requests wait, with
  the QR code still up. Back to **On**, the music carries on where it was.
- **Off**, when you're done taking requests: the music pauses, guests can't add tracks, and the party screen
  says requests are closed, with the playlist to download. Turning it back on starts
  a new party, with a new QR code (old links stop working) and a new playlist, so
  download the old one first.

## Settings

| Setting | What it does |
| --- | --- |
| Party mode | On, Paused (music and requests on hold) or Off (requests closed, playlist ready). See above. |
| Party zone | Where the music plays. If you pick a speaker that's grouped with others, the whole group plays. |
| Party name | Shown on the party screen. Leave blank to use the zone's name. |
| Roon profile for guest requests | The Roon profile the tracks are played under. Choose a "Guests" profile to keep party tracks out of your own history and recommendations. |
| Web port | The port the guest pages use (8338). Only change it if something else on the computer uses 8338. |
| Adding tracks | Whether guests can add tracks, whether a track already in the queue can be added again, how many each guest gets, and how many minutes until they get another. |
| Playing next | The same, for putting a track straight after the current one. |
| Skipping | The same, for skipping the current track. Off unless you turn it on. |
| Advanced | Only needed if search or queueing doesn't work on a Core that isn't in English. Usually it sorts itself out. |

In the per-guest numbers, **0 means no limit**. For "Minutes to earn one back", **0 means
never**.

## Good to know

- **Guests can't rearrange the queue.** They can add a track to the end, or play one next
  when they add it, but Roon doesn't let anyone move a track that's already queued.
- **A guest's track gets the music going again.** If the party zone is paused, or the
  queue has run out, adding a track presses play. For a speech, set **Party mode** to
  **Paused** instead of pausing in Roon: that holds the requests too.
- **Played starts fresh** when the extension restarts or you change the party zone.
- **The downloadable playlist starts fresh** when the extension restarts, you change the
  party zone, or you turn **Party mode** back on from **Off**, which counts as a new party
  (from **Paused** it doesn't).
  Download it before any of those. Tracks still in the queue carry over to the new list.
- **"Roon Radio" is a best guess.** With Roon Radio on, any track no guest added is
  labelled Roon Radio, including tracks you queue from the Roon app yourself.
- **Keep it at home.** Anyone on your network who has scanned the code can add tracks, and
  the party screen needs no code at all. Don't open the port to the internet.

## Troubleshooting

**Party Mode doesn't appear in Roon's Extensions list.** The computer running it must be on
the same network as the Roon Core. With Docker, use `--network host`, as above.

**Phones can't open the page after scanning.** Check that the phones are on the same Wi-Fi as
the computer running Party Mode, and that the computer's firewall allows port 8338.

**"That code has expired".** Party mode was switched off and on, which makes a new code.
Scan the code on the party screen again.

**Roon says settings can't be saved.** The extension can't write `config.json`. With Docker,
run `chmod 666 config.json` on the file you mounted.

**The status says a port was busy.** Something else on the computer uses that port. Party
Mode picks the next free one and the QR code follows it. To choose one yourself, change
**Web port** in the settings.

**Search finds nothing, or adding fails, on a Core in another language.** Open the
**Advanced** section of the settings and fill in the titles your Core uses.

**The wrong name is on a track.** Names are matched to tracks as Roon queues them, so this is
rare. If it keeps happening, open an issue with the extension's log (`docker logs
party-mode`, or the log in the Extension Manager), which records each request and each
track that starts.

**Something else isn't working.** Start the extension with
`ROON_EXTENSION_PARTY_MODE_DEBUG=1` (with Docker, add `-e ROON_EXTENSION_PARTY_MODE_DEBUG=1`)
for a detailed log, including every message to and from Roon, and
include it in an issue. Turn it off again afterwards: it's large and records what guests
search for.

## For developers

How it works, running it from source, tests, translations and publishing:
[Developer.md](Developer.md).

## Licence

Copyright 2026 Stubaggs. Licensed under the Apache License, Version 2.0 (see `LICENSE`).
