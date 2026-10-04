// Copyright 2026 Stubaggs
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const QRCode = require('qrcode');
const { PlayHistory } = require('./history');
const { PartyPlaylist, playlistFileName } = require('./party-playlist');
const { cleanName, SESSION_TTL_MS } = require('./guests');
const i18n = require('./i18n');
const { sameRecording, sameRecordingAsQueued, seconds, sharedCredits, trackHash } = require('./track-id');
const { partyMode, playlistDisplay, isStation } = require('./roon-service');

/** How long to wait for Roon to report the queue insert for a request. */
const CLAIM_TTL_MS = 60 * 1000;

const COOKIE = 'party_sid';

// Longer than any real search; a long one only slows Roon down.
const MAX_QUERY = 200;

/**
 * Every page and file is served from here, with no inline script or style, so
 * the pages allow nothing else. The Party Hub may be shown inside another
 * page (a dashboard on the TV); the guest pages may not.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'"
].join('; ');

function securityHeaders(req, res, next) {
  const framable = ['/partyhub', '/hub.html'].includes(req.path.toLowerCase());
  res.set({
    'Content-Security-Policy': framable ? CSP : `${CSP}; frame-ancestors 'none'`,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer'
  });
  if (!framable) res.set('X-Frame-Options', 'DENY');
  next();
}

function lanAddress() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const entry of interfaces[name] || []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return '127.0.0.1';
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function queueItem(item) {
  const lines = item.three_line || item.two_line || item.one_line || {};
  return {
    id: item.queue_item_id,
    title: lines.line1 || '',
    artist: lines.line2 || '',
    album: lines.line3 || '',
    length: seconds(item.length),
    image_key: item.image_key || null
  };
}

function nowPlaying(zone) {
  if (!zone || !zone.now_playing) return null;
  const lines = zone.now_playing.three_line || zone.now_playing.two_line || {};
  // A live radio station: its name is the title, and it isn't a track.
  if (isStation(zone)) {
    return {
      title: lines.line1 || '',
      artist: lines.line2 || '',
      album: '',
      image_key: zone.now_playing.image_key || null,
      length: null,
      seek_position: 0,
      state: zone.state,
      station: true
    };
  }
  return {
    title: lines.line1 || '',
    artist: lines.line2 || '',
    album: lines.line3 || '',
    image_key: zone.now_playing.image_key || null,
    length: seconds(zone.now_playing.length),
    seek_position: zone.now_playing.seek_position || 0,
    state: zone.state
  };
}

function createServer(roon, guests) {
  const app = express();
  const clients = new Set();
  guests.onDrop = (id) => {
    if (roon.forgetSession) roon.forgetSession(id);
  };

  app.disable('x-powered-by');
  app.use(securityHeaders);
  app.use(express.json({ limit: '16kb' }));
  app.use(cookieParser());
  // Page text in the language the browser asks for; see lib/i18n.js.
  app.get('/i18n.js', (req, res) => {
    res.type('application/javascript').set({ 'Cache-Control': 'no-cache', Vary: 'Accept-Language, Cookie' });
    const lang = i18n.pick(req);
    res.send(i18n.script(lang, req.cookies[i18n.LANG_COOKIE] === lang));
  });
  // No index: the guest page is at /GuestHub, not the root.
  app.use(express.static(path.join(__dirname, '..', 'public'), { index: false }));
  // Express routes ignore case, so /guesthub works too.
  app.get('/GuestHub', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

  const settings = () => roon.settings;
  const mode = () => partyMode(settings());

  let httpServer = null;
  let listeningPort = null;

  function baseUrl() {
    return `http://${lanAddress()}:${listeningPort || settings().port}`;
  }

  function guestUrl() {
    return `${baseUrl()}/j/${guests.joinCode}`;
  }

  function playlistUrl() {
    return `${baseUrl()}/Download/playlist.csv`;
  }

  function hubUrl() {
    return `${baseUrl()}/PartyHub`;
  }

  function broadcast(event, payload) {
    const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const res of clients) res.write(frame);
  }

  const history = new PlayHistory();
  const playlist = new PartyPlaylist();

  /**
   * Who a track is credited to: the guest who asked for it, or, when Roon Radio
   * is on for the zone, Roon Radio for anything no guest added. Roon doesn't say
   * where a track came from, so with Radio on, tracks the host queues in Roon
   * are credited to Radio too.
   */
  function requester(track) {
    // Nobody asked for a radio station through Party Mode, and it isn't Roon Radio.
    if (track && track.station) return null;
    const attribution = guests.lookup(track);
    // requested_by is the guest's name, or null; the pages say "Anon" or
    // "Roon Radio" in their own language from the kind.
    if (attribution) return { requested_by: attribution.name || null, kind: attribution.kind };
    const zone = roon.zone;
    if (zone && zone.settings && zone.settings.auto_radio) {
      return { requested_by: null, kind: 'radio' };
    }
    return null;
  }

  /**
   * The credit plus the requesting guest's ref, for the records that keep a
   * copy of the name (Played, the playlist), so renaming can find them. Only
   * for those records: the pages get requester(), which has no ref.
   */
  function creditWithGuest(track) {
    const credit = requester(track);
    const attribution = credit && credit.kind !== 'radio' ? guests.lookup(track) : null;
    return attribution && attribution.guest ? Object.assign({}, credit, { guest: attribution.guest }) : credit;
  }

  function withRequester(track) {
    const credit = track && requester(track);
    return credit ? Object.assign({}, track, credit) : track;
  }

  /**
   * Split the queue into the playing track and what is still to come.
   *
   * Roon's queue starts with the playing track when it came from the queue, but
   * not when Roon Radio is playing, so the first item is dropped only when it is
   * the playing track. When it is, its queue item id is carried onto the playing
   * track, which lets the playing track be credited by id rather than by title.
   */
  function split() {
    const playing = nowPlaying(roon.zone);
    const items = roon.queue.map(queueItem);
    const first = items[0];
    const firstIsPlaying = Boolean(playing && first && sameRecording(first, playing));
    return {
      playing: firstIsPlaying ? Object.assign({}, playing, { id: first.id }) : playing,
      upcoming: firstIsPlaying ? items.slice(1) : items
    };
  }

  let loggedTrack = null;

  function creditForLog(credit) {
    if (!credit) return 'nobody';
    if (credit.kind === 'radio') return 'Roon Radio';
    return credit.requested_by || 'Anon';
  }

  function recordHistory(ended) {
    const { playing } = split();
    const credit = playing && creditWithGuest(playing);
    history.update(roon.zone ? roon.zone.zone_id : null, playing, credit, ended);

    // One line per track, to compare with the request lines when a credit looks
    // wrong. The hash is what attribution matches on once a length is known.
    const key = playing && `${playing.id || ''}|${trackHash(playing) || playing.title}`;
    if (key && key !== loggedTrack) {
      loggedTrack = key;
      const fingerprint = trackHash(playing) || 'no length';
      console.log(
        `Playing: "${playing.title}" / "${playing.artist}" [${fingerprint}] -> ${creditForLog(credit)}`
      );
    }
  }

  function queueSnapshot() {
    const { playing, upcoming } = split();
    return {
      zone: roon.zone ? roon.zone.display_name : null,
      party_name: roon.partyName,
      now_playing: withRequester(playing),
      played: history.list(),
      upcoming: upcoming.map(withRequester)
    };
  }

  /**
   * Requests waiting for Roon to report the queue item it created for them.
   *
   * A browse item carries no length and its item_key has no queue counterpart,
   * so this is the only way to learn which queue entry a request became. Claims
   * are matched oldest first, so two guests asking for the same track in quick
   * succession are credited in the order they asked.
   */
  const claims = [];

  function claimInserted(items) {
    for (const raw of items) {
      const track = queueItem(raw);
      const index = claims.findIndex((claim) =>
        sameRecording({ title: claim.title, artist: claim.artist, length: null }, track)
      );
      if (index < 0) continue;
      const [claim] = claims.splice(index, 1);
      guests.bind(claim.entry, track);
      console.log(
        `Queued: "${track.title}" / "${track.artist}" ${track.length || '?'}s [${trackHash(track) || 'no length'}]` +
          ` -> ${claim.entry.name || 'Anon'}`
      );
    }
  }

  function sweepClaims() {
    const cutoff = Date.now() - CLAIM_TTL_MS;
    for (let i = claims.length - 1; i >= 0; i -= 1) {
      if (claims[i].at < cutoff) claims.splice(i, 1);
    }
  }
  setInterval(sweepClaims, 30 * 1000).unref();

  roon.on('queue_inserted', claimInserted);

  function recordPlaylist() {
    const zone = settings().zone && settings().zone.output_id;
    playlist.update(roon.zone ? zone : null, roon.queue.map(queueItem), creditWithGuest);
  }

  roon.on('queue_changed', () => {
    // After queue_inserted, so a request is already credited to its guest.
    recordPlaylist();
    broadcast('queue', queueSnapshot());
  });
  roon.on('now_playing_changed', (ended) => {
    recordHistory(ended);
    broadcast('queue', queueSnapshot());
  });
  roon.on('settings_changed', () => broadcast('party', { party_mode: mode() }));
  roon.on('party_mode_changed', (now, previous) => {
    if (now === 'off') {
      guests.clear();
    } else if (previous === 'off') {
      guests.rotateJoinCode();
      // Coming back from off starts a new party, and a new playlist. Paused
      // and back is the same party.
      playlist.reset();
      recordPlaylist();
    }
    broadcast('party', { party_mode: now });
  });

  // ------------------------------------------------------------ guest entry

  /**
   * A page that only says why the guest can't join, in their language: phones
   * show plain text tiny, and without a language a screen reader may misread it.
   */
  function messagePage(res, lang, titleKey, textKey) {
    const text = (key) => escapeHtml(i18n.t(lang, key));
    res.status(403).set('Cache-Control', 'no-store').type('html').send(
      `<!doctype html><html lang="${escapeHtml(lang)}" dir="${i18n.dir(lang)}"><head><meta charset="utf-8" />` +
        '<meta name="viewport" content="width=device-width, initial-scale=1" />' +
        `<title>${text(titleKey)}</title>` +
        '<link rel="stylesheet" href="/party.css" /><link rel="stylesheet" href="/guest.css" /></head>' +
        `<body><main class="locked"><h1>${text(titleKey)}</h1><p class="muted">${text(textKey)}</p></main></body></html>`
    );
  }

  // The root isn't the guest page any more (that's /GuestHub): an old bookmark
  // gets "Scan the code again".
  app.get('/', (req, res) => messagePage(res, i18n.pick(req), 'locked.title', 'locked.text'));

  app.get('/j/:code', (req, res) => {
    const lang = i18n.pick(req);
    if (mode() === 'off') return messagePage(res, lang, 'screen.closed_title', 'screen.closed_text');
    if (req.params.code !== guests.joinCode) return messagePage(res, lang, 'locked.title', 'join.expired');
    setSessionCookie(res, guests.create());
    res.redirect('/GuestHub');
  });

  /** The session cookie lasts as long as the session would idle, from now. */
  function setSessionCookie(res, session) {
    res.cookie(COOKIE, session.id, { httpOnly: true, sameSite: 'lax', maxAge: SESSION_TTL_MS });
  }

  function requireGuest(req, res, next) {
    // Paused still lets guests in to look around; only requests wait.
    if (mode() === 'off') return res.status(403).json({ error: 'closed' });
    const session = guests.get(req.cookies[COOKIE]);
    if (!session) return res.status(401).json({ error: 'no_session' });
    // Renewed on every use, so a guest who keeps using the page stays in.
    setSessionCookie(res, session);
    req.guest = session;
    next();
  }

  // -------------------------------------------------------------- guest API

  app.get('/api/party', requireGuest, (req, res) => {
    res.json({
      party_name: roon.partyName,
      zone: roon.zone ? roon.zone.display_name : null,
      ready: roon.ready,
      guest_name: req.guest.name,
      party_mode: mode(),
      allowances: guests.allowances(req.guest, settings()),
      capabilities: {
        add: settings().allow_add,
        next: settings().allow_next,
        skip: settings().allow_skip
      }
    });
  });

  app.post('/api/name', requireGuest, (req, res) => {
    const name = cleanName(req.body.name);
    req.guest.name = name;
    // Tracks this guest already added (as Anon, or under an old name) follow.
    guests.rename(req.guest);
    history.rename(req.guest.ref, name);
    playlist.rename(req.guest.ref, name);
    broadcast('queue', queueSnapshot());
    res.json({ guest_name: name });
  });

  app.get('/api/search', requireGuest, async (req, res) => {
    const query = String(req.query.q || '').replace(/\p{Cc}/gu, ' ').trim().slice(0, MAX_QUERY);
    if (query.length < 2) return res.json({ results: [] });
    if (!roon.ready) return res.status(503).json({ error: 'not_ready' });

    try {
      const items = await roon.search(req.guest.id, query);
      // A newer search from this guest replaced it before it ran.
      if (items === null) return res.json({ results: [], superseded: true });
      req.guest.lastSearch = { query, items };
      guests.offer(req.guest, items);

      // A queued track is always marked, so guests can see it's coming; it can
      // only be requested again when the host doesn't block duplicates.
      const blockDuplicates = settings().prevent_duplicates;
      res.json({
        results: items.map((item) => {
          const inQueue = isQueued(item.title, item.subtitle || '', item.image_key, items);
          return {
            key: item.item_key,
            title: item.title,
            subtitle: item.subtitle || '',
            image_key: item.image_key || null,
            in_queue: inQueue,
            blocked: inQueue && blockDuplicates
          };
        })
      });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  app.post('/api/request', requireGuest, async (req, res) => {
    const mode = req.body.mode === 'next' ? 'next' : 'add';
    const bucket = mode;
    if (partyMode(settings()) === 'paused') return res.status(409).json({ error: 'paused' });
    if (!roon.ready) return res.status(503).json({ error: 'not_ready' });

    // Only a track this guest was sent in their search results, as it was sent.
    const offered = guests.offered(req.guest, req.body.key);
    if (!offered) return res.status(400).json({ error: 'unknown_track' });
    const { title, subtitle, image_key: imageKey } = offered;

    const status = guests.check(req.guest, bucket, settings());
    if (!status.allowed) {
      return res.status(429).json({ error: status.reason, next_in: status.nextIn });
    }

    const searched = req.guest.lastSearch ? req.guest.lastSearch.items : [];
    if (settings().prevent_duplicates && isQueued(title, subtitle, imageKey, searched)) {
      return res.status(409).json({ error: 'already_queued' });
    }

    // Taken now, before Roon is asked, and handed back if Roon refuses.
    guests.consume(req.guest, bucket, settings());
    try {
      await performWithRetry(req.guest, req.body.key, mode, title, subtitle);
      const entry = guests.attribute(req.guest, { title, artist: subtitle }, mode);
      // Bound to its queue item when Roon reports the insert; see claimInserted.
      claims.push({ entry, title, artist: subtitle, at: Date.now() });
      console.log(`Request (${mode}) from ${req.guest.name || 'Anon'}: "${title}" / "${subtitle}"`);
      res.json({ ok: true, allowances: guests.allowances(req.guest, settings()) });
    } catch (err) {
      guests.refund(req.guest, bucket, settings());
      res.status(502).json({ error: err.message });
    }
  });

  /**
   * Whether the same recording is already queued.
   *
   * Version-sensitive on purpose: a remaster or a live take is a fair request
   * even when the original is queued, and so is a cover. A search result
   * credits writers too, so the other results the guest saw are used to tell
   * writers from performers (sharedCredits). A search result has no length, so
   * where two recordings share a title and performer and differ only in
   * length they cannot be told apart here and the second is treated as a
   * duplicate. The artwork tells albums apart when both sides have it; see
   * sameRecordingAsQueued.
   * @param {string|null} imageKey - the result's artwork
   * @param {object[]} [results] - the search the track came from
   */
  function isQueued(title, subtitle, imageKey, results) {
    const candidate = { title, artist: subtitle, image_key: imageKey || null };
    const writers = sharedCredits(results, title);
    return roon.queue.map(queueItem).some((item) => sameRecordingAsQueued(item, candidate, writers));
  }

  /**
   * Browse item keys expire when the guest's browse session moves on. If the
   * action fails, the search is replayed once and the track matched by title.
   */
  async function performWithRetry(session, itemKey, mode, title, subtitle) {
    try {
      return await roon.performAction(session.id, itemKey, mode);
    } catch (err) {
      const last = session.lastSearch;
      if (!last) throw err;
      const items = (await roon.search(session.id, last.query)) || [];
      session.lastSearch = { query: last.query, items };
      guests.offer(session, items);
      const match = items.find(
        (item) =>
          (item.title || '').toLowerCase() === title.toLowerCase() &&
          (item.subtitle || '').toLowerCase() === subtitle.toLowerCase()
      );
      if (!match) throw err;
      return roon.performAction(session.id, match.item_key, mode);
    }
  }

  app.post('/api/skip', requireGuest, async (req, res) => {
    if (mode() === 'paused') return res.status(409).json({ error: 'paused' });
    // Roon can't skip a radio station; a request takes over from it instead.
    if (isStation(roon.zone)) return res.status(409).json({ error: 'station' });
    const status = guests.check(req.guest, 'skip', settings());
    if (!status.allowed) {
      return res.status(429).json({ error: status.reason, next_in: status.nextIn });
    }
    const undo = history.markSkipped(split().playing, req.guest.name, req.guest.ref);
    // Taken before Roon is asked, as for requests, and handed back on failure.
    guests.consume(req.guest, 'skip', settings());
    try {
      await roon.skip();
      res.json({ ok: true, allowances: guests.allowances(req.guest, settings()) });
    } catch (err) {
      undo();
      guests.refund(req.guest, 'skip', settings());
      res.status(502).json({ error: err.message });
    }
  });

  app.get('/api/queue', requireGuest, (req, res) => res.json(queueSnapshot()));

  // ---------------------------------------------------------- host displays

  // /api/roonparty is its name before the Party Hub: a screen left open across
  // the upgrade keeps working until it reloads.
  app.get(['/api/hub', '/api/roonparty'], (req, res) => {
    res.json(
      Object.assign(queueSnapshot(), {
        party_mode: mode(),
        join_url: guestUrl(),
        // How the screen offers the playlist once requests close: 'qr', 'link' or 'off'.
        playlist: playlistDisplay(settings()),
        ready: roon.ready
      })
    );
  });

  // Everything queued during the party, for the host to keep; see lib/party-playlist.js.
  // The setting only decides what the screen shows: the address always works.
  // /api/playlist.csv is its address before 1.2.0, kept for links already shared.
  app.get(['/Download/playlist.csv', '/api/playlist.csv'], (req, res) => {
    res.attachment(playlistFileName(roon.partyName));
    res.type('text/csv; charset=utf-8').set('Cache-Control', 'no-store').send(playlist.toCsv(requester));
  });

  async function sendQr(res, url) {
    try {
      const svg = await QRCode.toString(url, {
        type: 'svg',
        margin: 1,
        errorCorrectionLevel: 'M',
        color: { dark: '#160E24', light: '#FFFFFF' }
      });
      res.type('image/svg+xml').set('Cache-Control', 'no-store').send(svg);
    } catch (err) {
      res.status(500).end();
    }
  }

  app.get('/api/qr.svg', (req, res) => sendQr(res, guestUrl()));

  // The playlist download as a QR code, for the Party Hub once requests close.
  // /api/playlist-qr.svg is its address before 1.2.0, for a Hub left open across an update.
  app.get(['/Download/playlist-qr.svg', '/api/playlist-qr.svg'], (req, res) => sendQr(res, playlistUrl()));

  app.get('/api/image/:key', async (req, res) => {
    const size = Math.min(1024, Math.max(48, parseInt(req.query.size, 10) || 200));
    try {
      const { contentType, body } = await roon.getImage(req.params.key, size);
      res.type(contentType || 'image/jpeg').set('Cache-Control', 'public, max-age=86400').send(body);
    } catch (err) {
      res.status(404).end();
    }
  });

  app.get('/api/events', (req, res) => {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });
    res.flushHeaders();
    res.write(`event: queue\ndata: ${JSON.stringify(queueSnapshot())}\n\n`);
    clients.add(res);

    const heartbeat = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => {
      clearInterval(heartbeat);
      clients.delete(res);
      res.end();
    });
  });

  /**
   * The Hub with its title already in it ("EX5 Test-o-rama Hub", in the
   * browser's language): Safari, bookmarks and home-screen icons can take the
   * title before the page's script sets it. The script still updates it when
   * the party is renamed.
   */
  const hubPage = fs.readFileSync(path.join(__dirname, '..', 'public', 'hub.html'), 'utf8');

  // Routes match without regard to case, so /partyhub works too.
  app.get('/PartyHub', (req, res) => {
    const lang = i18n.pick(req);
    const name = roon.partyName || i18n.t(lang, 'party.default_name');
    const title = escapeHtml(i18n.t(lang, 'page.hub_title', { name }));
    res.set({ 'Cache-Control': 'no-cache', Vary: 'Accept-Language' }).type('html').send(
      hubPage
        // Functions, so a "$&" in a party name is not read as a replacement pattern.
        .replace('<html lang="en">', () => `<html lang="${escapeHtml(lang)}" dir="${i18n.dir(lang)}">`)
        .replace('<title>Party Hub</title>', () => `<title>${title}</title>`)
    );
  });
  // Its address before it was the Party Hub, for bookmarks and screens set up then.
  app.get(['/roonparty', '/roonparty.html'], (req, res) => res.redirect(301, '/PartyHub'));

  return {
    app,
    guestUrl,
    playlistUrl,
    hubUrl,
    get port() {
      return listeningPort;
    },
    /**
     * Listen on `port`. If already listening elsewhere, the new port is opened
     * first and the old one closed only once that worked, so a port that is in
     * use leaves the server where it was.
     */
    listen(port) {
      return new Promise((resolve, reject) => {
        const next = app.listen(port, '0.0.0.0');
        next.once('error', reject);
        next.once('listening', () => {
          const previous = httpServer;
          httpServer = next;
          listeningPort = next.address().port;
          if (previous) {
            previous.close();
            // Server-sent event streams never end on their own.
            if (previous.closeAllConnections) previous.closeAllConnections();
          }
          resolve(next);
        });
      });
    }
  };
}

module.exports = { createServer, lanAddress };
