# Releases

What's new in each version of Party Mode, newest first. Roon shows the version you're
running in its Extensions list.

## 1.2.0 (in progress)

Not released yet. You can try it on the `experimental` branch.

- The party screen is now the **Party Hub**, at `/PartyHub`. Its browser tab shows the
  party's name, such as "EX5 Test-o-rama Hub". Roon's link and status line point there,
  and old `/roonparty` bookmarks still open it.
- The **Party mode** setting reads **Pause** while the party is on and **Unpause** while
  it's paused, and says when turning it on starts a new party.

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
