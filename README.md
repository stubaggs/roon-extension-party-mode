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

## Installing it from Roon

Once the image is on Docker Hub and the entry is in the Extension Repository, install it
with the [Extension Manager](https://github.com/TheAppgineer/roon-extension-manager):
Roon → Settings → Extensions → Extension Manager → Settings, pick the category, pick
Party Mode, choose Install. The Manager runs it with host networking (Roon discovery uses
UDP broadcast on port 9003) and bind-mounts `config.json` so settings survive updates.

## Publishing the image

`.github/workflows/docker-publish.yml` builds `linux/amd64`, `linux/arm/v7` and
`linux/arm64` and pushes `stubaggs/roon-extension-party-mode` to Docker Hub on every push
to `main` (as `latest`) and on `v*` tags (as the version). It needs two repository
secrets, under Settings → Secrets and variables → Actions:

| Secret | Value |
| --- | --- |
| `DOCKERHUB_USERNAME` | `stubaggs` |
| `DOCKERHUB_TOKEN` | A Docker Hub access token with Read & Write scope |

The Extension Manager checks Docker Hub for a newer `latest`, so pushing to `main` is
how an update reaches people who have it installed.

To run the image by hand instead:

```bash
docker run -d --name party-mode --network host \
  -v "$PWD/config.json:/usr/src/app/config.json" \
  stubaggs/roon-extension-party-mode:latest
```

`docker-compose.yml` does the same thing. Create `config.json` first (`touch config.json`)
or Docker makes a directory in its place.

## Getting it into the Extension Repository

Fork `TheAppgineer/roon-extension-repository`, add the object from `repository-entry.json`
to the "Playback" category in `repository.json`, bump the `version` at the top of that
file, and open a pull request. Only do this after the image is on Docker Hub: the Manager
installs straight from it.

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
