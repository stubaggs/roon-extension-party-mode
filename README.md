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
                        RoonApiStatus     "Guests join at http://…"
                        RoonApiTransport  zone state, queue subscription, skip
                        RoonApiBrowse     search + "Queue" / "Add Next" actions
                        RoonApiImage      album art proxy
                                                        │
                                              Express on port 8080
                                                        │
                                     /            guest page (phones)
                                     /dashboard    QR code + queue (TV)
```

| File | What it does |
| --- | --- |
| `app.js` | Wires the Roon service to the web server |
| `lib/roon-service.js` | Pairing, settings layout, search, queue actions, queue subscription |
| `lib/guests.js` | Guest sessions, token-bucket limits, request attribution |
| `lib/server.js` | REST API, server-sent events, QR code, image proxy |
| `public/` | Guest page and host dashboard, no build step |

## Before you publish it

Change these in `lib/roon-service.js`, they identify the extension to Roon:

```js
extension_id:    'com.example.party-mode',   // reverse-DNS, must be unique
display_name:    'Party Mode',
publisher:       'Your Name',
email:           'you@example.com',
website:         'https://github.com/you/roon-extension-party-mode'
```

## Running it during development

```bash
npm install
node app.js
```

Then open Roon → Settings → Extensions and enable Party Mode. Open its settings, pick a
party zone, and the console prints the guest link and dashboard URL. The extension writes
`config.json` next to `app.js`.

## Host settings (in Roon)

Party zone, party name, guest access on/off, web port, and a guest address override for
when the machine has several network interfaces. Per-action allowances follow the token
bucket model: each guest starts with N goes and earns one back every M minutes, with
separate budgets for adding, playing next, and skipping. Adding and playing next are on
by default, skipping is off.

The last group of settings is the one to check if your Core is not in English. Roon
localises browse titles, so the extension matches on the strings `Tracks`, `Queue` and
`Add Next`. Put your Core's equivalents there.

## Building and publishing the image

```bash
docker buildx build --platform linux/amd64,linux/arm/v7,linux/arm64 \
  -t yourname/roon-extension-party-mode:latest --push .
```

Run it with host networking. Roon discovery uses UDP broadcast on port 9003 and will not
find the Core from a bridge network:

```bash
docker run -d --name party-mode --network host \
  -v "$PWD/config.json:/usr/src/app/config.json" \
  yourname/roon-extension-party-mode:latest
```

`docker-compose.yml` does the same thing.

## Getting it into the Extension Manager

Fork `TheAppgineer/roon-extension-repository`, add the object from `repository-entry.json`
to a category in `repository.json`, and open a pull request. The `binds` entry is what
keeps settings across image updates, and the `HostConfig.NetworkMode: host` in `config`
is what makes discovery work.

## Known limitations

**No queue reordering.** Roon's API can add a track to the end of the queue or directly
after the current one, and it can skip. It cannot move an item that is already in the
queue. So a guest can ask for a track to play next when they add it, but nobody can
promote a track that is already waiting. If you have seen Music Assistant's "boost an
upcoming song", that part does not have a Roon equivalent.

**Attribution is best-effort.** Roon queue items carry no "who added this" field, so
requests are matched back to guests by title and artist afterwards. Two guests adding the
same track will confuse the badge.

**Browse sessions are stateful.** Item keys are only valid until that guest's browse
session moves on. The server replays the search and retries once when a key has gone
stale, which covers the usual case of a guest searching again before tapping.

**Access control is a shared join code, not a login.** Anyone who can reach the port and
has scanned the code can add tracks. The dashboard endpoints need no session at all.
Do not expose this to the internet.

**The queue subscription is per zone.** Changing the party zone starts a new subscription;
the old one is ignored rather than torn down, since the API has no convenient unsubscribe.

## Ideas worth adding

- A short "who are you" prompt so the dashboard badges show real names
- Blocking explicit tracks, or a genre allowlist, using the browse hierarchy
- Persisting token buckets against a device fingerprint so a page refresh does not matter
  (they are already server-side, but a new scan gets a fresh session)
- A veto: three guests tap skip on the same track before it goes

## Licence

Apache-2.0, matching the other extensions in the Appgineer repository.
