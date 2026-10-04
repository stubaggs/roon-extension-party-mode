# Party Mode for Roon

Let your guests pick the music. They scan a QR code with their phone, search your Roon
library and streaming services, and add tracks to the party's queue. No app to install, no
Roon account, and no access to anything else in your Roon setup.

- **Guests add, play next or skip tracks** from their phone, as many as you allow.
- **Fair shares:** limit how many of each a guest gets, with more earned back over time.
- **Names on tracks:** guests can give a nickname, shown next to the tracks they add (or
  "Anon" if they'd rather not).
- **The Party Hub** for a TV or tablet: QR code, what's playing and the whole queue.
- **Up next and Played** lists, so everyone can see what's coming and what's been on.
- **Keep the party's playlist:** download everything that was queued as a spreadsheet
  file, ready to import into a music service.
- **In their language:** the guest pages and the Party Hub follow each phone's or
  screen's language, in 30 languages (see [Languages](#languages)).

What's changed in each version is in [RELEASES.md](RELEASES.md).

## What you need

- A Roon Core.
- A computer on the same network that runs the extension, usually the same machine as the
  [Extension Manager](https://github.com/TheAppgineer/roon-extension-manager): a 64-bit
  PC or NAS, or any Raspberry Pi, including Pi Zero and Pi 1.
- Guests' phones on the same Wi-Fi as that computer.

## Installing

### With the Extension Manager

1. In Roon, open **Settings → Extensions → Extension Manager → Settings**.
2. Pick the **Playback** category, then **Party Mode**, and choose **Install**.
3. Back in **Settings → Extensions**, find **Party Mode** and click **Enable**.

The Extension Manager handles updates from then on.

### With Docker

```bash
touch config.json && sudo chown 1000 config.json && chmod 600 config.json
docker run -d --name party-mode --network host --restart unless-stopped \
  --log-opt max-size=10m --log-opt max-file=3 \
  -v "$PWD/config.json:/usr/src/app/config.json" \
  stubaggs/roon-extension-party-mode:latest
```

Then enable **Party Mode** under **Settings → Extensions** in Roon.

The file `config.json` keeps your settings when the image is updated. It also holds the key Roon
gave Party Mode, so the commands above let only the extension (user 1000) read it. Without
`sudo`, use `chmod 666 config.json` instead, which lets every account on the computer
read and change it. The `--log-opt` settings keep the log from growing without limit.

## Starting a party

1. In Roon, open **Settings → Extensions → Party Mode → Settings** and pick the **Party
   zone**: where the music plays. Give the party a name if you like; otherwise it's
   named after the zone.
2. Click **Party Mode**'s link in the Extensions list to open the **Party Hub**. Put it
   on a TV, a tablet or a laptop where guests can see it.
3. Guests scan the QR code on the Party Hub with their phone camera. That's it.

**Party mode**, at the top of the settings, runs the party:

- **On**: guests can make requests. Switching On from **Off** starts a new party, with a
  new QR code (old links stop working) and a new playlist.
- **Paused**: for a speech or the cake. Playback pauses and guests' requests wait. Choose
  **Unpause** to carry on where you left off.
- **Off**: when you're done taking requests. Playback pauses, guests can't make requests,
  and the playlist is ready to download.

Under **Settings → Extensions**, Roon shows Party Mode's status: its Party mode, the
party's name and the Party Hub's address, for example:

> Paused: House Party<br>
> Party Hub at http://192.0.2.10:8338/PartyHub

## The party's playlist

Once **Party mode** is **Off**, the Party Hub shows the playlist to download (see
**Display playlist download** below). It's always at the address in that setting's hint,
such as `http://192.0.2.10:8338/Download/playlist.csv`, which you can open in any browser on
your network.

It's a CSV file of every track queued in the party zone: title, artist, album, length, who
asked for it and when. Roon can't import it directly, but Soundiiz can: choose **Import
playlist**, then the file, and pick TIDAL, Qobuz or Spotify. Roon then shows it with your
playlists. Excel on Windows can garble accented names when you double-click the file;
Google Sheets, Numbers and Excel's **Data → From Text/CSV** read it correctly.

## Settings

| Setting | What it does |
| --- | --- |
| Party mode | On, Paused or Off (see above). |
| Party zone | Where the music plays. If you pick a speaker that's grouped with others, the whole group plays. |
| Party name | Shown on the Party Hub. Leave blank to use the zone's name. |
| Display playlist download | What the Party Hub shows once **Party mode** is **Off**: a **QR code** guests can scan (the default), a **Link only** to click on the Hub itself, or **Off** for nothing. |
| Roon profile for guest requests | The Roon profile the tracks are played under. To keep party tracks out of your own history and recommendations, create a profile such as "Guests" in Roon first, then choose it here. Leave it alone to play under your own profile. |
| Adding tracks | Whether guests can add tracks, and whether a track already in the queue can be added again (covers, live takes, remasters and the same track on another album count as different tracks). |
| Playing next | Whether guests can put a track straight after the current one. |
| Skipping | Whether guests can skip the current track. Off unless you turn it on. |
| Advanced | **Web port**: the port the guest pages and the Party Hub use (8338). If it's busy when Party Mode starts, it uses the next free one and the status line says so. Only change it if something else on the computer uses 8338.<br>**Browse titles**: Party Mode usually finds them by itself; only fill them in if search or queuing doesn't work on a Core that isn't in English. |

**Adding tracks**, **Playing next** and **Skipping** each set how many a guest gets
(**0 means no limit**) and the minutes until they earn one back (**0 means never**). By
default skipping is disabled, each guest can add 5 tracks, earning one back every 10
minutes, and play next once an hour.

## Good to know

- **Guests can't rearrange the queue.** They can add a track to the end, or play one next
  when they add it, but Roon doesn't yet let anyone move a queued track.
- **A guest's track gets the music going again.** If the party zone is paused, or the
  queue has run out, adding a track presses play. For a speech, set **Party mode** to
  **Paused** instead of pausing in Roon: that holds the requests too.
- **The Played list starts fresh** when the extension restarts or you change the party zone.
- **Tag colours** on the Party Hub and guests' phones show how a track got into the queue: **lavender**
  when a guest added it, **amber** when a guest chose **Play it next**, and **mint** for
  Roon Radio. Tracks with no tag are ones you queued in Roon while Radio was off.
- **"Roon Radio" is a best guess.** With Roon Radio on, any track no guest added is
  labelled Roon Radio, including tracks you queue from the Roon app yourself.
- **The playlist starts fresh** when the extension restarts, you change the party zone, or
  you turn **Party mode** back on from **Off**. Download it before any of those. Pausing
  keeps it.
- **The playlist has guests' names in it.** It lists who asked for each track and when.
  With **Display playlist download** on **QR code**, anyone at the party can scan it and
  keep a copy. If that's not what you want, choose **Link only** or **Off**.
- **The playlist keeps up to 5000 tracks**, about two weeks of non-stop music. Past that,
  the oldest tracks you queued yourself or Roon Radio picked are dropped first; guests'
  requests are kept longest.
- **Keep it at home.** Anyone on your network who has scanned the code can add tracks, and
  the Party Hub needs no code at all. Don't open the port to the internet.

## Languages

The guest pages and the Party Hub come in English, Arabic (including Egyptian), Bulgarian,
Chinese (Simplified and Traditional), Czech, Danish, Dutch, Finnish, French, German,
Greek, Hebrew, Hungarian, Italian, Japanese, Korean, Norwegian, Polish, Portuguese
(Portugal and Brazil), Romanian, Russian, Spanish, Swedish, Thai, Turkish, Ukrainian and
Vietnamese. Guests can pick another with the 🌐 button next to their name at the top of
the page. The translations were generated by AI, so apologies for any errors; corrections
from native speakers are welcome.

## Troubleshooting

**Party Mode doesn't appear in Roon's Extensions list.** The computer running it must be on
the same network as the Roon Core. With Docker, use `--network host`, as above.

**Phones can't open the page after scanning.** Check that the phones are on the same Wi-Fi as
the computer running Party Mode, and that the computer's firewall allows the port shown in
Roon's status line (8338 unless it was busy).

**A guest's page says "Scan the code again".** Their session ended after 12 hours without
using the page, or they opened an old bookmark (from 1.2.0 the guest page is at
`/GuestHub`). Scanning the QR code again lets them back in; they'll need to enter their
name again.

**"That code has expired".** Party mode was switched off and on, which makes a new code.
Scan the code on the Party Hub again.

**Roon says settings can't be saved.** The extension can't write `config.json`. With Docker,
run `sudo chown 1000 config.json && chmod 600 config.json` on the file you mounted, or
`chmod 666 config.json` without `sudo`.

**The status says a port was busy.** Something else on the computer uses that port. Party
Mode picks the next free one and the QR code follows it, so this is fine to leave. To
choose one yourself, change **Web port** under **Advanced** in the settings.

**Search finds nothing, or adding fails, on a Core in another language.** Open the
**Advanced** section of the settings and fill in the titles your Core uses.

**Something else isn't working.** Start the extension with
`ROON_EXTENSION_PARTY_MODE_DEBUG=1` (with Docker, add `-e ROON_EXTENSION_PARTY_MODE_DEBUG=1`)
for a detailed log, including every message to and from Roon, and
include it in an issue. Turn it off again afterwards: it's large and records what guests
search for.

## For developers

How it works, running it from source, tests, translations and publishing:
[DEVELOPER.md](DEVELOPER.md).

## Licence

Copyright 2026 Stubaggs. Licensed under the Apache License, Version 2.0 (see `LICENSE`).
