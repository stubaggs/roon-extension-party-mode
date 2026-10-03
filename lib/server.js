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

const os = require('os');
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const QRCode = require('qrcode');
const { PlayHistory } = require('./history');
const { PartyPlaylist, playlistFileName } = require('./party-playlist');
const i18n = require('./i18n');
const { sameRecording, sameRecordingAsQueued, seconds, sharedCredits, trackHash } = require('./track-id');
const { partyMode } = require('./roon-service');

/** How long to wait for Roon to report the queue insert for a request. */
const CLAIM_TTL_MS = 60 * 1000;

const COOKIE = 'party_sid';

function lanAddress() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const entry of interfaces[name] || []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return '127.0.0.1';
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

  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));
  app.use(cookieParser());
  // Page text in the language the browser asks for; see lib/i18n.js.
  app.get('/i18n.js', (req, res) => {
    res.type('application/javascript').set({ 'Cache-Control': 'no-cache', Vary: 'Accept-Language' });
    res.send(i18n.script(i18n.pick(req)));
  });
  app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html' }));

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
    return `${baseUrl()}/api/playlist.csv`;
  }

  const playlistDownload = () => settings().playlist_download !== false;

  function roonpartyUrl() {
    return `${baseUrl()}/roonparty`;
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

  app.get('/j/:code', (req, res) => {
    const lang = i18n.pick(req);
    if (mode() === 'off') return res.status(403).type('text/plain').send(i18n.t(lang, 'join.closed'));
    if (req.params.code !== guests.joinCode) {
      return res.status(403).type('text/plain').send(i18n.t(lang, 'join.expired'));
    }
    const session = guests.create();
    res.cookie(COOKIE, session.id, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 8 * 60 * 60 * 1000
    });
    res.redirect('/');
  });

  function requireGuest(req, res, next) {
    // Paused still lets guests in to look around; only requests wait.
    if (mode() === 'off') return res.status(403).json({ error: 'closed' });
    const session = guests.get(req.cookies[COOKIE]);
    if (!session) return res.status(401).json({ error: 'no_session' });
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
    const name = String(req.body.name || '').trim().slice(0, 24);
    req.guest.name = name;
    // Tracks this guest already added (as Anon, or under an old name) follow.
    guests.rename(req.guest);
    history.rename(req.guest.ref, name);
    playlist.rename(req.guest.ref, name);
    broadcast('queue', queueSnapshot());
    res.json({ guest_name: name });
  });

  app.get('/api/search', requireGuest, async (req, res) => {
    const query = String(req.query.q || '').trim();
    if (query.length < 2) return res.json({ results: [] });
    if (!roon.ready) return res.status(503).json({ error: 'not_ready' });

    try {
      const items = await roon.search(req.guest.id, query);
      // A newer search from this guest replaced it before it ran.
      if (items === null) return res.json({ results: [], superseded: true });
      req.guest.lastSearch = { query, items };

      res.json({
        results: items.map((item) => ({
          key: item.item_key,
          title: item.title,
          subtitle: item.subtitle || '',
          image_key: item.image_key || null,
          in_queue: settings().prevent_duplicates && isQueued(item.title, item.subtitle || '', items)
        }))
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

    const status = guests.check(req.guest, bucket, settings());
    if (!status.allowed) {
      return res.status(429).json({ error: status.reason, next_in: status.nextIn });
    }

    const title = String(req.body.title || '');
    const subtitle = String(req.body.subtitle || '');

    const searched = req.guest.lastSearch ? req.guest.lastSearch.items : [];
    if (settings().prevent_duplicates && isQueued(title, subtitle, searched)) {
      return res.status(409).json({ error: 'already_queued' });
    }

    try {
      await performWithRetry(req.guest, req.body.key, mode, title, subtitle);
      guests.consume(req.guest, bucket, settings());
      const entry = guests.attribute(req.guest, { title, artist: subtitle }, mode);
      // Bound to its queue item when Roon reports the insert; see claimInserted.
      claims.push({ entry, title, artist: subtitle, at: Date.now() });
      console.log(`Request (${mode}) from ${req.guest.name || 'Anon'}: "${title}" / "${subtitle}"`);
      res.json({ ok: true, allowances: guests.allowances(req.guest, settings()) });
    } catch (err) {
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
   * duplicate.
   * @param {object[]} [results] - the search the track came from
   */
  function isQueued(title, subtitle, results) {
    const candidate = { title, artist: subtitle };
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
    const status = guests.check(req.guest, 'skip', settings());
    if (!status.allowed) {
      return res.status(429).json({ error: status.reason, next_in: status.nextIn });
    }
    const undo = history.markSkipped(split().playing, req.guest.name, req.guest.ref);
    try {
      await roon.skip();
      guests.consume(req.guest, 'skip', settings());
      res.json({ ok: true, allowances: guests.allowances(req.guest, settings()) });
    } catch (err) {
      undo();
      res.status(502).json({ error: err.message });
    }
  });

  app.get('/api/queue', requireGuest, (req, res) => res.json(queueSnapshot()));

  // ---------------------------------------------------------- host displays

  app.get('/api/roonparty', (req, res) => {
    res.json(
      Object.assign(queueSnapshot(), {
        party_mode: mode(),
        join_url: guestUrl(),
        playlist_url: playlistDownload() ? playlistUrl() : null,
        ready: roon.ready
      })
    );
  });

  // Everything queued during the party, for the host to keep; see lib/party-playlist.js.
  // Only while the Playlist download setting is on.
  app.get('/api/playlist.csv', (req, res) => {
    if (!playlistDownload()) return res.status(404).end();
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

  // The playlist download as a QR code, for the party screen once requests close.
  app.get('/api/playlist-qr.svg', (req, res) => {
    if (!playlistDownload()) return res.status(404).end();
    sendQr(res, playlistUrl());
  });

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

  app.get('/roonparty', (req, res) =>
    res.sendFile(path.join(__dirname, '..', 'public', 'roonparty.html'))
  );

  return {
    app,
    guestUrl,
    roonpartyUrl,
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
