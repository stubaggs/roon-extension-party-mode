# Party Mode for Roon

Let your guests pick the music. They scan a QR code with their phone, search your Roon
library and streaming services, and add tracks to the party's queue. No app to install, no
Roon account, and no access to anything else in your Roon setup.

- **Guests add, play next or skip tracks** from their phone.
- **Fair shares:** limit how many of each a guest gets, with more earned back over time.
- **Names on tracks:** guests can give a nickname, shown next to the tracks they add (or
  "Anon" if they'd rather not).
- **The Party Hub** for a TV or tablet: QR code, what's playing and the whole queue.
- **Up next and Played** lists, so everyone can see what's coming and what's been on.
- **Keep the party's playlist:** download everything that was queued as a spreadsheet
  file, ready to import into a music service.
- **In their language:** the guest pages and the Party Hub follow each phone's or
  screen's language, or one you choose for the Hub in the settings, in 30 languages
  (see [Languages](#languages)).

What's changed in each version is in [RELEASES.md](RELEASES.md).

## What you need

- A Roon Core.
- A computer on the same network to run the extension, usually the same machine as the
  [Extension Manager](https://github.com/TheAppgineer/roon-extension-manager): a 64-bit
  PC or NAS, or any Raspberry Pi, including Pi Zero and Pi 1.
- Guests' phones on the same Wi-Fi as that computer.

## Installing

### With the Extension Manager

*This method is awaiting inclusion in the Extension Manager repository. Until then, please
use one of the other install options.*

Install **Party Mode** with the
[Extension Manager](https://github.com/TheAppgineer/roon-extension-manager), then enable it
under **Settings → Extensions** in Roon. The Extension Manager handles updates from then
on.

### With Docker

```bash
mkdir roon-extension-party-mode && cd roon-extension-party-mode
touch config.json && sudo chown 1000 config.json && chmod 600 config.json
docker run -d --name roon-extension-party-mode --network host --restart unless-stopped \
  --log-opt max-size=10m --log-opt max-file=3 \
  --read-only --cap-drop ALL --security-opt no-new-privileges \
  -v "$PWD/config.json:/usr/src/app/config.json" \
  stubaggs/roon-extension-party-mode:latest
```

Then enable **Party Mode** under **Settings → Extensions** in Roon.

To update to a new version, run this in the same folder, then the `docker run` command
above again:

```bash
docker pull stubaggs/roon-extension-party-mode:latest
docker rm -f roon-extension-party-mode
```

Your settings and Roon's pairing stay in `config.json`. If you started Party Mode before
1.3.0, its container is called `party-mode`: use `docker rm -f party-mode` instead, once.

To stop Party Mode, run `docker stop roon-extension-party-mode`. It stays stopped, even
after a restart of the computer, until you run `docker start roon-extension-party-mode`.

#### With Docker Compose

The repository includes a `docker-compose.yml` file that does the same as the `docker run`
command above. Put it in a folder of its own, next to the `config.json` it saves to:

```bash
mkdir roon-extension-party-mode && cd roon-extension-party-mode
curl -O https://raw.githubusercontent.com/stubaggs/roon-extension-party-mode/main/docker-compose.yml
touch config.json && sudo chown 1000 config.json && chmod 600 config.json
docker compose up -d
```

Then enable **Party Mode** under **Settings → Extensions** in Roon.

To update to a new version, run this in the same folder:

```bash
docker compose pull && docker compose up -d
```

Your settings and Roon's pairing stay in `config.json`. To stop Party Mode, run
`docker compose down`.

To change the first port or turn on the detailed log, edit the `environment` lines in
`docker-compose.yml`, then run `docker compose up -d` again.

## Starting a party

1. In Roon, open **Settings → Extensions → Party Mode → Settings** and pick the **Party
   zone**: where the music plays. Give the party a name if you like; otherwise it's
   named after the zone. Choose a **Party profile** if you want a record of the party,
   and a **Party Hub language** if the Hub's screen is hard to set.
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
**Playlist on the Party Hub** below). It's always at the address in that setting's hint,
such as `http://192.0.2.10:8338/Download/playlist.csv`, which you can open in any browser on
your network.

It's a CSV file of every track queued in the party zone: title, artist, album, length, who
asked for it and when. To leave guests' names out, turn on **Hide names in downloadable
playlist** under **Advanced**. Roon can't import it directly, but Soundiiz can: choose
**Import playlist**, then the file, and pick TIDAL, Qobuz or Spotify. Roon then shows it
with your playlists. Excel on Windows can garble accented names when you double-click the
file; Google Sheets, Numbers and Excel's **Data → From Text/CSV** read it correctly.

## Settings

| Setting | What it does |
| --- | --- |
| Party mode | On, Paused or Off (see above). |
| Party zone | Where the music plays. If you pick a speaker that's grouped with others, the whole group plays. |
| Party profile | The Roon profile guests' tracks play under, so they count toward its play history and recommendations. Unless you choose one, that's Roon's default profile (normally **Guest**). To keep a record of the party, create a profile such as "Party" in Roon first, then choose it here. |
| Party name | Shown on the Party Hub. Leave blank to use the zone's name. |
| Party Hub language | The language of the Party Hub, for every screen showing it. Automatic (the default) follows the screen's browser. Guests' phones always follow their own. |
| Playlist on the Party Hub | What the Party Hub shows once **Party mode** is **Off**: a **QR code** guests can scan (the default), a **Link only** to click on the Hub itself, or **Off** for nothing. |
| Adding tracks | Whether guests can add tracks, and whether a track already in the queue can be added again (covers, live takes, remasters and the same track on another album count as different tracks). **Also let guests play a track next** lets them put a track straight after the current one (only while adding is on). |
| Skipping | Whether guests can skip the currently playing track. Off unless you turn it on. |
| Advanced | **Hide names in downloadable playlist**: the playlist download says **Anon** instead of each guest's name. Tracks Roon Radio picked or you queued still say **Roon Radio** or **Host**. Off by default.<br>**Web port**: the port the guest pages and the Party Hub use (8338). If it's busy when Party Mode starts, it uses the next free one and the status line says so. Only change it if something else on the computer uses 8338.<br>**Browse titles**: Party Mode usually finds them by itself; only fill them in if search or queuing doesn't work on a Core that isn't in English. |

**"Add to queue" per guest**, **"Play it next" per guest** and **"Skip" per guest** set
how many of each a guest gets (**0 means no limit**), and **Minutes to earn one back**
how long until they get another (**0 means never**). By default, skipping is off; each
guest can add 5 tracks, earning one back every 10 minutes, and play next once an hour.

## Good to know

- **Guests can't rearrange the queue.** They can add a track to the end, or play one next
  when they add it, but Roon doesn't yet let anyone move a queued track.
- **A guest's track gets the music going again** (except over a radio station). If the
  party zone is paused, or the queue has run out, adding a track presses play. For a
  speech, set **Party mode** to **Paused** instead of pausing in Roon: that holds the
  requests too.
- **A radio station waits for you.** While a live radio station plays on the party zone,
  guests can still add tracks, but they won't play until you switch over. In Roon, open
  the party zone's queue and choose **Play from here** on the track to start with, so you
  choose how the party begins. Guests can't skip a station.
- **Tag colours** on the Party Hub and guests' phones show how a track got into the
  queue: **lavender** when a guest added it, **amber** when a guest chose **Play it
  next**, **mint** for Roon Radio, and **sky blue** for **Host**, anything you queued in
  Roon.
- **The Roon Radio tag is a good guess.** A track you add just as the last one ends may
  be tagged Roon Radio, and after a restart, Roon Radio's picks already queued show as
  Host.
- **Played and the playlist start fresh** when the extension restarts or you change the
  party zone; the playlist also clears when you turn **Party mode** back on from **Off**.
  Download it before any of those.
- **The playlist has guests' names in it.** It lists who asked for each track and when.
  With **Playlist on the Party Hub** set to **QR code**, anyone at the party can scan it and
  keep a copy. If that's not what you want, turn on **Hide names in downloadable
  playlist** under **Advanced**, or choose **Link only** or **Off**.
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

**There's no Skip button.** Skipping is off in the settings, a radio station is playing, or
it's the last track with Roon Radio off, so there's nothing to skip to.

**Party Mode doesn't appear in Roon's Extensions list.** The computer running it must be on
the same network as the Roon Core. With Docker, use `--network host`, as above.

**Phones can't open the page after scanning.** Check that the phones are on the same Wi-Fi as
the computer running Party Mode, and that the computer's firewall allows the port shown in
Roon's status line (8338 unless it was busy).

**A guest's page says "Scan the code again".** Their session ended after 12 hours without
using the page, or they opened an old bookmark (from 1.2.0 the guest page is at
`/GuestHub`). Scanning the QR code again lets them back in; they'll need to enter their
name again.

**"That code has expired".** Party mode was set to Off and back to On, which makes a new
code. Scan the code on the Party Hub again.

**Roon says settings can't be saved.** The extension can't write `config.json`. With Docker,
run `sudo chown 1000 config.json && chmod 600 config.json` on the file you mounted, or
`chmod 666 config.json` without `sudo`.

**The status says a port was busy.** Something else on the computer uses that port. Party
Mode picks the next free one and the QR code follows it, so this is fine to leave. To
choose one yourself, change **Web port** under **Advanced** in the settings.

**Search finds nothing, or adding fails, on a Core in another language.** Open the
**Advanced** section of the settings and fill in the titles your Core uses.

**Something else isn't working.** Start the extension with
`ROON_EXTENSION_PARTY_MODE_DEBUG=1` (with Docker, add
`-e ROON_EXTENSION_PARTY_MODE_DEBUG=1`; with Docker Compose, remove the `#` in front of
that line in `docker-compose.yml` and run `docker compose up -d`) for a detailed log,
including every message to and from Roon, and include it in an issue. See it with
`docker logs roon-extension-party-mode`, or `docker compose logs` in its folder. Turn it
off again afterwards: it's large and records what guests search for.

## Running more than one party

Most people need only one copy. To hold parties in different rooms on one Roon Core, run
another copy of Party Mode with a name of its own. Give it its own folder, so it has its
own `config.json`, and its own container name. For example, a second copy named Garden
(replace Garden with whatever you choose):

**With Docker**

```bash
mkdir roon-extension-party-mode-garden && cd roon-extension-party-mode-garden
touch config.json && sudo chown 1000 config.json && chmod 600 config.json
docker run -d --name roon-extension-party-mode-garden --network host --restart unless-stopped \
  --log-opt max-size=10m --log-opt max-file=3 \
  --read-only --cap-drop ALL --security-opt no-new-privileges \
  -e ROON_EXTENSION_PARTY_MODE_INSTANCE=Garden \
  -v "$PWD/config.json:/usr/src/app/config.json" \
  stubaggs/roon-extension-party-mode:latest
```

**With Docker Compose**

Set up a new folder as in [With Docker Compose](#with-docker-compose). In its
`docker-compose.yml`, change `container_name` and uncomment the
`ROON_EXTENSION_PARTY_MODE_INSTANCE` line, with your name in it. Leave the other lines as
they are:

```yaml
    container_name: roon-extension-party-mode-garden
    environment:
      - ROON_EXTENSION_PARTY_MODE_INSTANCE=Garden
```

It shows in Roon as **Party Mode (Garden)**, a separate extension. Enable it and choose
its own party zone. With the first copy on port 8338, it takes the next free port by
itself.

## Uninstalling

**With the Extension Manager:** uninstall it with the
[Extension Manager](https://github.com/TheAppgineer/roon-extension-manager).

**With Docker:** remove the container and the image, then delete the folder you made for
it, which removes `config.json` and with it your settings and Roon's pairing:

```bash
docker rm -f roon-extension-party-mode
docker rmi stubaggs/roon-extension-party-mode:latest
```

**With Docker Compose:** in its folder, run `docker compose down --rmi all`, then delete
the folder.

A **Party profile** you created stays in Roon until you delete it. For a second copy, such
as Garden, do the same with its own container name and folder.

## For developers

How it works, running it from source, tests, translations and publishing:
[DEVELOPER.md](DEVELOPER.md).

## Licence

Copyright 2026 Stubaggs. Licensed under the Apache License, Version 2.0 (see `LICENSE`).
