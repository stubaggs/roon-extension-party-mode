# Party Mode for Roon

Let your guests pick the music. They scan a QR code with their phone, search your Roon
library and streaming services, and add songs to the party's queue. No app to install, no
Roon account, and no access to anything else in your Roon setup.

- **Guests add songs** from their phone, or jump one to play next, if you allow it.
- **Skipping** the current song is an option you can turn on.
- **Fair shares:** each guest gets a number of songs, earning more back over time.
- **Names on songs:** guests can give a nickname, shown next to the songs they add.
- **A party screen** for a TV or tablet: QR code, what's playing and what's next.
- **Up next and Played** lists, so everyone can see what's coming and what's been on.
- **Roon Radio** songs are labelled, so guests know what the radio picked.
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
  -v "$PWD/config.json:/usr/src/app/config.json" \
  stubaggs/roon-extension-party-mode:latest
```

`config.json` keeps your settings when the image is updated. Then enable **Party Mode**
under **Settings → Extensions** in Roon.

## Starting a party

1. In Roon, open **Settings → Extensions → Party Mode → Settings** and pick the **Party
   zone**: where the music plays. Give the party a name if you like; otherwise it's
   named after the zone.
2. Click **Party Mode**'s link in the Extensions list to open the **party screen**. Put it
   on a TV, a tablet or a laptop where guests can see it.
3. Guests scan the QR code on the party screen with their phone camera. That's it.

To stop guests adding songs, set **Guest access** to **Off**. Turning it back on makes a
new QR code, so old links stop working.

## Settings

| Setting | What it does |
| --- | --- |
| Party zone | Where the music plays. If you pick a speaker that's grouped with others, the whole group plays. |
| Party name | Shown on the party screen. Leave blank to use the zone's name. |
| Roon profile for guest requests | The Roon profile the songs are played under. Choose a "Guests" profile to keep party songs out of your own history and recommendations. |
| Guest access | On or off for everyone. |
| Web port | The port the guest pages use (8338). Only change it if something else on the computer uses 8338. |
| Adding tracks | Whether guests can add songs, whether a song already in the queue can be added again, how many each guest gets, and how many minutes until they get another. |
| Playing next | The same, for putting a song straight after the current one. |
| Skipping | The same, for skipping the current song. Off unless you turn it on. |
| Advanced | Only needed if search or queueing doesn't work on a Core that isn't in English. Usually it sorts itself out. |

In the per-guest numbers, **0 means no limit**. For "Minutes to earn one back", **0 means
never**.

## Good to know

- **Guests can't rearrange the queue.** They can add a song to the end, or play one next
  when they add it, but Roon doesn't let anyone move a song that's already queued.
- **Played starts fresh** when the extension restarts or you change the party zone.
- **"Roon Radio" is a best guess.** With Roon Radio on, any song no guest added is
  labelled Roon Radio, including songs you queue from the Roon app yourself.
- **Keep it at home.** Anyone on your network who has scanned the code can add songs, and
  the party screen needs no code at all. Don't open the port to the internet.

## Troubleshooting

**Party Mode doesn't appear in Roon's Extensions list.** The computer running it must be on
the same network as the Roon Core. With Docker, use `--network host`, as above.

**Phones can't open the page after scanning.** Check that the phones are on the same Wi-Fi as
the computer running Party Mode, and that the computer's firewall allows port 8338.

**"That code has expired".** Guest access was switched off and on, which makes a new code.
Scan the code on the party screen again.

**Roon says settings can't be saved.** The extension can't write `config.json`. With Docker,
run `chmod 666 config.json` on the file you mounted.

**The status says a port was busy.** Something else on the computer uses that port. Party
Mode picks the next free one and the QR code follows it. To choose one yourself, change
**Web port** in the settings.

**Search finds nothing, or adding fails, on a Core in another language.** Open the
**Advanced** section of the settings and fill in the titles your Core uses.

**The wrong name is on a song.** Names are matched to songs as Roon queues them, so this is
rare. If it keeps happening, open an issue with the extension's log (`docker logs
party-mode`, or the log in the Extension Manager), which records each request and each
song that starts.

## For developers

How it works, running it from source, tests, translations and publishing:
[Developer.md](Developer.md).

## Licence

Copyright 2026 Stubaggs. Licensed under the Apache License, Version 2.0 (see `LICENSE`).
