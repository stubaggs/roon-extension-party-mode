# Releases

What's new in each version of Party Mode, newest first. Roon shows the version you're
running in its Extensions list.

## 1.4.0 (in progress)

Not released yet. Its beta is out: you can try it as "Party Mode (beta)" (see
[DEVELOPER.md](DEVELOPER.md#running-the-beta)).

### New

- Guests can pass the party on: tapping the party's name on the guest page shows the QR
  code for a friend to scan. Turn it off with **Invites**, under **Party**.
- The guest page and the Party Hub have their own icon, a jukebox, in the browser tab,
  bookmarks and on a phone's home screen.
- **Detailed log**, under **Advanced**: a detailed log for troubleshooting, turned on and
  off from Roon with no restart. The Extension Manager's **Collect Logs** includes it.
- Install with the Extension Manager before Party Mode is in its list: the README shows
  how to add it to the Manager yourself, and how to remove it again.

### Improvements

- **No setup before installing with Docker:** settings now live in a Docker volume, so a
  new install is just `docker compose up -d` (or `docker run`), with no `config.json` to
  create. Updating keeps your settings; installing afresh with the new instructions
  means enabling and setting up Party Mode in Roon again.
- If Party Mode can't save its settings (a NAS folder it may not write to, say), the
  warning names the folder. Once you fix its permissions, the next save in Roon clears
  the warning and saves Roon's pairing too, with no restart.
- When Roon closes the settings window on a change that can't be saved (a name that's
  too long, say), the status line in Roon says what wasn't saved.
- Simpler settings window: only **Party mode** shows at first; the rest is in groups you
  open: **Party**, **Guest requests** and **Advanced**. **Party** opens by itself, with
  the zone marked in red, until you pick a zone or while it's unavailable. Under
  **Party**, **Party zone**, **Party profile**, **Party name**, **Party host name** and
  **Playlist on the Party Hub** are now **Zone**, **Roon profile**, **Name**, **Host
  name** and **Playlist**.
- **Guest requests** replaces **Adding tracks** and **Skipping**, with settings named
  after the guest page's buttons: **Add to queue**, **Play it next** and **Skip tracks**.
  Adding to the queue and playing next are now separate, so you can allow either or both.
- If the party zone goes away (its device switched off, say) or your Roon Core restarts
  or can't be reached, requests pause by themselves after a few seconds (currently 10),
  so guests see "Requests are paused for a moment" rather than errors. They're back on
  when the zone or Core returns. The status line in Roon and the log say what happened.
- Party Mode's status in Roon has a line each: **Party mode** (On, Paused or Off),
  **Party** (its name), **Party zone** and the Party Hub's address.

### Performance improvements

- Album art loads faster with lots of guests on, especially on a Raspberry Pi: Party Mode
  asks your Core for each cover only once.
- Search results load album art as guests scroll to it, so they show sooner and use less
  data.

### Fixes

- Joining the party is quicker in Firefox, which fetched the playing track's cover three
  times.
- **Host name** shows an error past 24 characters, the most a guest's name may be,
  rather than being cut short on the pages.
- The guest page's dialogs always close with Escape, and Tab stays inside them. In Chrome
  and Safari, Escape stopped working once Tab passed the last button.
- The search box's clear button (×) is round, with the × centred, on older iPhones and
  iPads (iOS 15).
- Screen readers find the Party Hub's main content, and the name prompt as a dialog.
- Simpler error messages: when a request, a skip or saving a name fails, guests see one
  message, "Sorry, that did not work.", rather than two that told them little more.
- When a guest has used up adding, playing next or skipping, the page says "You've used
  them all." and when more come back, if they do. "Nothing left for now." suggested more
  would come even when none did.
- Skip disappears straight away when Roon can't skip (a radio station starts, say) or
  the host turns skips off.

### Security

- **Flood protection**, under **Advanced**: how many page loads and searches each IP
  address may make a minute, so one misbehaving device can't overwhelm Party Mode or your
  Core. The defaults are higher than before: 1,200 page loads (was 600) and 200 searches
  (was 60). If guests still see "Too many requests", choose **Custom** and raise them.
- Party Mode's web server moves from Express 4 to Express 5, the library's current
  version.
- Various security enhancements.

## 1.3.2

Docker image: `stubaggs/roon-extension-party-mode:1.3.2@sha256:d3a801fba58640ee1b856ebeea9b548dc8bccc964df328c011c0359b5160f07c`

### Fixes

- After the Roon Core restarts, **Up next** shows the queue again and keeps up with it.
  Before, it stayed empty until you chose the party zone again.
- Scanning the QR code again no longer gives a guest a fresh set of adds, play-nexts and
  skips: they carry on with what they had left, under the same name.

### Security

- Various security enhancements.

## 1.3.1

Docker image: `stubaggs/roon-extension-party-mode:1.3.1@sha256:4479bb446d6774e3f461510755979c3042320bf9106d39cbd15237da6f87567b`

### Security

- You can check that a Docker image was built from the code here on GitHub: each image
  now carries a signed record of the commit it came from, and a list of everything inside
  it. Each release's image is listed here with its digest, so you can pin that exact
  image instead of `latest`, and a release number on Docker Hub is never replaced.

## 1.3.0

Docker image: `stubaggs/roon-extension-party-mode:1.3.0@sha256:b2a1339e64544fca2265d09190015024eb4a2209a0ddfa39ff7607096c9687bd`

### New

- **Party host name** setting, your name, in place of **Host** on the tracks you queue
  and skip in Roon, and in the playlist download. Left blank, it's "Host" in each guest's language.
- **Party Hub language** setting in Roon: choose the Party Hub's language for every
  screen showing it, handy for a TV whose browser is hard to set. **Automatic** (the
  default) follows the screen's browser, as before. Guests' phones still follow their own.
- **Hide names in downloadable playlist** setting, under **Advanced**: the playlist
  download credits every guest's track to Anon instead of their name. Roon Radio and Host
  stay.

### Improvements
- A radio station playing on the party zone shows "Radio station"
  instead of showing it as a track. Skip is hidden, since Roon can't skip a station.
  Guests' tracks wait in the queue until you start queue from Roon.
- Tracks you queue in Roon get a **Host** tag, in sky blue, on the Party Hub, the guest
  page and in the playlist download. Before, with Roon Radio on, they were labelled Roon
  Radio; Roon Radio's tag now goes only on the tracks it picks.
- A track cut short in Roon shows in Played as **Skipped by Host**.
- The word for **Host** no longer assumes the host is a man: languages that had a
  masculine word now use a neutral one, often "the hosts".
- With **Roon Loop** on, the playlist download no longer lists a track again each time it
  comes round.
- Clearer setting names in Roon: **Display playlist download** is now **Playlist on the
  Party Hub**, the limits are named after the guest page's buttons ("Add to queue",
  "Play it next" and "Skip" per guest).
- **Roon profile for guest requests** is now **Party profile**, next to **Party zone**. Its
  first choice names the profile guests' tracks play under when you don't choose one,
  normally Roon's **Guest** profile.
- With **Let guests add tracks** on No, guests can't play a track next either, since that
  adds a track too, so the play next settings have moved into **Adding tracks**.
  Skipping still follows its own setting.
- Skip is hidden when there's nothing to skip to, on the last track with Roon Radio off,
  instead of failing when pressed.
- An empty Up next invites guests to add a track, and with Roon Radio on offers it as the
  alternative: "Nothing lined up. Add a track, or leave it to Roon Radio." On the guest
  page and the Party Hub.

### Fixes
- Guests can't call themselves **Host**, **Roon Radio**, **Radio** or **Anon** (in any
  language), so those tags always mean what they say. A guest who picks a name someone
  else at the party already uses is asked whether to use it anyway.
- Changing how many tracks, plays next or skips each guest gets now applies straight away
  to guests already at the party, counting what they've used. Before, raising a limit
  didn't give them any more.
  
### Security
- Various security enhancements.
- The container is now called `roon-extension-party-mode` (it was `party-mode`). When
  updating from an earlier version with `docker run`, remove the old one once with
  `docker rm -f party-mode`.
- Hardened the docker container: the image no longer ships package managers, and the example
  docker-compose.yml runs it read-only with no Linux capabilities or privilege escalation.
  Re-download the new docker-compose to get the changes.
- Rate limiting for requests.

## 1.2.0

Docker image: `stubaggs/roon-extension-party-mode:1.2.0@sha256:082b9c61ad9e05a462c39e05a524b8cf0ab7cdb05614bcc943cc2a1245ab2e4d`

### Party Hub

- The party screen is now the **Party Hub**, at `/PartyHub`. Its browser tab shows the
  party's name, such as "House Party Hub". Roon's link and status line point there,
  and old `/roonparty` bookmarks still open it.
- The playing track shows its album, on the Party Hub and the guest page.

### Guest page

- The guest page is now at `/GuestHub`. The QR code takes guests there as before, but a
  bookmark or home-screen shortcut to the old address needs a fresh scan.
- 25 more languages for the guest pages and the Party Hub, 30 in all: Arabic (including
  Egyptian), Bulgarian, Chinese (Simplified and Traditional), Czech, Danish, Finnish,
  Greek, Hebrew, Hungarian, Italian, Japanese, Korean, Norwegian, Polish, Portuguese
  (Portugal and Brazil), Romanian, Russian, Swedish, Thai, Turkish, Ukrainian and
  Vietnamese. Hebrew and Arabic pages read right to left. The translations were generated
  by AI, so apologies for any errors; corrections from native speakers are welcome.
- Guests can choose their page's language with a 🌐 button beside their name tag;
  otherwise it follows the phone's.
- Long translations fit narrow phones: buttons wrap instead of running off the screen,
  and messages use the screen's width. Names in another script (a Hebrew name on an
  English page, say) stay in the right order.
- After adding a track, playing one next or skipping, the message shows what's left, as
  the button does: "Added to the queue · 3 left", "Skipped · in 5 min".
- Guests stay in as long as they keep using the page. Before, everyone had to scan the
  code again 8 hours after joining. Now that only happens after 12 hours without using it.

### Settings

- The **Party mode** setting reads **Pause** while the party is on and **Unpause** while
  it's paused, and says when turning it on starts a new party.
- Roon's status line always shows the party's state and name, with the Party Hub's
  address below, for example "Paused: House Party".
- **Web port** has moved under **Advanced** in Roon's settings, with a hint saying what
  it's for.
- The **Display playlist download** hint in Roon gives the playlist's address on a line
  of its own; it always works, whatever the setting.
- New defaults for guests: each guest can add 5 tracks to start, earning one back every
  10 minutes (was 10, every 2 minutes), and play next once an hour (was every 20
  minutes). Settings you've already saved in Roon stay as they are.

### Search and the playlist

- Search marks tracks already in the queue as **In the queue** even when **Block tracks
  already in the queue** is off, without stopping guests adding them.
- Search tells a band's versions of a track on different albums apart. Before, queueing
  one marked them all as in the queue, and could miss the one actually queued.
- The playlist download is now at `/Download/playlist.csv`.
- The party's playlist holds up to 5000 tracks, up from 2000. At a party that runs for
  weeks, your own and Roon Radio's oldest tracks make room first, before any guest's
  request.

### Running it

- Run more than one Party Mode against one Core: give each extra copy a name with
  `ROON_EXTENSION_PARTY_MODE_INSTANCE`, and it shows in Roon as its own extension, such
  as "Party Mode (Garden)", with its own settings and party zone.
- The experimental version shows in Roon as "Party Mode (experimental)", a separate
  extension, so it can run alongside the released one. Give it its own party zone.

## 1.1.1

- No changes to the extension itself. These release notes are corrected: the environment
  variable names came with 1.0.2, not 1.0.3.

## 1.1.0

### End the party, keep the playlist

- **Party mode** is the first setting, with three choices:
  - **On**: guests add tracks.
  - **Paused**: for a speech or the cake. The music pauses, guests' requests wait, and
    the QR code stays up. Back to **On**, the music carries on where it was.
  - **Off**: when you're done taking requests. The music pauses and the party screen says
    "Requests are closed". Turning it back on starts a new party, with a new QR code
    (old links stop working) and a new playlist.
- **Download the party's playlist**: every track queued during the party, with who asked
  for it and when, as a spreadsheet file. It's in the format Soundiiz imports, so you can
  turn it into a TIDAL, Qobuz or Spotify playlist that Roon then shows with your others.
- With Party mode **Off**, the party screen says "Requests are closed" where the playing
  track was, and guests' phones say so too, instead of asking them to scan the code again.
- **Display playlist download** setting: once Party mode is **Off**, the party screen shows
  a QR code guests can scan to get the playlist, just a link, or nothing. The setting's
  hint gives the download address, which works whichever you pick.

### Party screen

- The whole queue, under everything else, with album covers.
- "Scan to add a track" is itself the guest link, so you can click it to open the guest page.
- Name tags are coloured by how the track was added: lavender for the end of the queue,
  amber for Play it next, mint for Roon Radio, on the party screen and guests' phones alike.
- On a narrow screen, "Playing now" sits at the left edge under the QR code.
- "Nothing lined up." when the queue is empty.

### Guest page

- Allowances show on the buttons themselves. Skip only shows a count once skips run out.
- Buttons that are used up stay readable and can still be reached with a keyboard or
  screen reader.
- A guest's name shows as a tag. Guests who don't give a name show as "Anon".
- A name given later also goes on the tracks that guest added earlier.
- **Played** says who skipped a track, or "Skipped in Roon" for a track cut short in Roon.
  It no longer shows the time.

### Security

- Various security enhancements.
- The Docker instructions now keep `config.json`, which holds Roon's key for Party Mode,
  readable only by the extension.

### Fixes

- Searching while another search was still running could show categories such as
  "Artists" or "TIDAL" as if they were tracks.
- **Block tracks already in the queue** no longer blocks a cover of a queued track.
- Pages open in English when the browser names no language.
- Long scrolling names no longer appear enlarged on phones.
- Accessibility fixes for the guest page and party screen.
- Screen readers hear what the party screen's QR codes are, instead of their caption twice.
- The guest page no longer flashes "Scan the code again" while it loads.
- An old or closed join link shows a readable page in the guest's language, instead of a
  line of tiny English text.
- Pages, settings and docs say **tracks** rather than songs, since a track may be a poem or
  a speech.

## 1.0.3

- A guest's track gets the music going again: if the party zone is paused, or the queue has
  run out, adding a track presses play.
- The party zone is found as soon as you choose it, instead of when Roon next reports a
  change.

## 1.0.2

- Guest requests count toward the chosen **Roon profile for guest requests**, so party
  tracks stay out of your own history and recommendations.
- Quieter logs. Set `ROON_EXTENSION_PARTY_MODE_DEBUG` for the detail.
- Settings from the environment (for Docker) are named `ROON_EXTENSION_PARTY_MODE_<SETTING>`.
  The old names still work.
- The README is now a guide for running a party, with developer notes in their own file.

## 1.0.1

The first release.

- **Guests pick the music**: they scan a QR code, search your Roon library and streaming
  services, and add tracks to the party zone's queue from their phone.
- **Party screen** for a TV or tablet: the QR code, what's playing, who asked for it, and
  what's up next. Roon's Extensions list links to it.
- **Guest page**: search with a clear button, the queue, the tracks already played, and a
  name for their requests.
- **Allowances**: how many tracks each guest can add, play next or skip, and how many
  minutes until they get another. Skipping is off unless you turn it on.
- **Block tracks already in the queue**, so the same recording isn't added twice.
- **Roon Radio** labels on tracks no guest added while Radio is on.
- **Roon profile for guest requests**, to keep party tracks off your own profile.
- **Party name**, which defaults to the zone's name. The zone picker says when a speaker
  is part of a group.
- Long track and artist names scroll when they don't fit.
- Pages in English, French, German, Spanish and Dutch, following the browser's language.
- Works on a Roon Core in another language: Roon's menus are found automatically, with
  overrides under **Advanced** if needed.
- Runs on port 8338, and picks the next free port if that one is busy. Changing the port
  in the settings takes effect without a restart.
- Docker image for PCs, NAS boxes and every Raspberry Pi, including the Pi Zero and Pi 1,
  running as an ordinary user.
