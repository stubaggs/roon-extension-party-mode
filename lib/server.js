// Copyright (c) 2026 Stubaggs
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
const { rateLimit } = require('express-rate-limit');
const qr = require('./qr');
const { PlayHistory } = require('./history');
const embed = require('./embed');
const { aboutRoutes } = require('./about');
const { PartyPlaylist, playlistFileName, sameCode } = require('./party-playlist');
const { cleanName, nameKey, SESSION_TTL_MS } = require('./guests');
const i18n = require('./i18n');
const { sameRecording, sameRecordingAsQueued, seconds, sharedCredits, trackHash, versionTitle } = require('./track-id');
const { partyMode, playlistDisplay, hubFrame, hubPlaying, isStation, QUEUE_ITEMS } = require('./roon-service');
const { DEFAULT_RATE_LIMIT, DEFAULT_SEARCH_LIMIT } = require('./env');

/** How long to wait for Roon to report the queue insert for a request. */
const CLAIM_TTL_MS = 60 * 1000;

const COOKIE = 'party_sid';

// Live-update streams stay open until the page closes, each taking some memory,
// so they're capped: in all, and per device (address) in step with Flood
// protection, since many phones can share one address on a shared Wi-Fi.
const MAX_STREAMS = 1000;
/**
 * How long a device may take, against one that holds connections open by
 * sending or reading slowly (Node's defaults: 60 s for headers, 300 s for a
 * whole request, no limit on idling or on connections). Generous for a phone
 * on weak Wi-Fi: requests are small. A request's time counts only until it has
 * arrived, so live-update streams aren't cut; an idle socket is one with
 * nothing sent or received, and a stream's heartbeat (every 20 s) keeps it
 * busy. The connection cap leaves room above MAX_STREAMS.
 */
const CONNECTION_LIMITS = { headersTimeout: 10000, requestTimeout: 30000, timeout: 60000, maxConnections: 2000 };
const MIN_STREAMS_PER_DEVICE = 10;
// Seconds after starting when pages coming back aren't counted as reconnects.
const RECONNECT_GRACE_S = 60;

// Longer than any real search; a long one only slows Roon down.
const MAX_QUERY = 200;
// The word "radio" in each language (_reserved_radio_words in public/i18n;
// accents don't count, so "Rádio" is "Radio"). A guest called that would look
// like Roon Radio or a station.
const RADIO_WORDS = i18n.wordLists('_reserved_radio_words');

// Single words for the host, masculine and feminine, that aren't a language's
// credit.host: kept with each language's text (_reserved_host_words in
// public/i18n), since a guest called one would still look like the host.
const HOST_WORDS = i18n.wordLists('_reserved_host_words');

// What the pages call tracks no guest asked for (Host, Roon Radio), a radio
// station, and a guest with no name (Anon), in every language, and the words
// "radio" and (as it was) "host", as nameKey() compares names.
const RESERVED_NAMES = new Set([
  ...RADIO_WORDS.map(nameKey),
  ...HOST_WORDS.map(nameKey),
  ...i18n.languages().flatMap((lang) =>
    ['credit.host', 'credit.radio', 'credit.guest', 'playing.station'].map((key) => nameKey(i18n.t(lang, key)))
  )
]);

/**
 * Every page and file is served from here, with no inline script or style, so
 * the pages allow nothing else. The Party Hub and /embed/ may be shown inside
 * another page (a dashboard on the TV); the guest pages may not.
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

/** Browser features the pages never use, switched off for them and anything they load. */
const PERMISSIONS_POLICY = [
  'accelerometer',
  'browsing-topics',
  'camera',
  'geolocation',
  'gyroscope',
  'magnetometer',
  'microphone',
  'payment',
  'usb'
].map((feature) => `${feature}=()`).join(', ');

// The Party Hub's addresses: /PartyHub shows the view set in Roon (Party Hub
// default view); /PartyHub/Standard, /PartyHub/Roon and /PartyHub/Basic (the
// plain 16:9 page for older TV browsers) choose one for that screen.
const HUB_VIEWS = { standard: 'simple', roon: 'roon', basic: 'basic' };
const HUB_PATH = /^\/partyhub(?:\/(?:standard|roon|basic))?\/?$/;

function securityHeaders(req, res, next) {
  const path = req.path.toLowerCase();
  // Anything under /embed/ is for other people's pages (a dashboard, a screen
  // of their own): framable, and loadable from any site.
  const embed = path.startsWith('/embed/');
  const framable = embed || HUB_PATH.test(path) || path === '/hub.html';
  res.set({
    'Content-Security-Policy': framable ? CSP : `${CSP}; frame-ancestors 'none'`,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': PERMISSIONS_POLICY,
    // Everything the pages load is their own, so these cost nothing: another
    // site can't embed the extension's files (album art, QR codes, the
    // playlist), and the pages can't load anything from elsewhere. Neither
    // applies to the Party Hub shown in a frame, and /embed/ is the exception. No Cross-Origin-Opener-Policy:
    // browsers ignore it over plain HTTP on a LAN address, and log an error
    // on every page saying so.
    'Cross-Origin-Resource-Policy': embed ? 'cross-origin' : 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp'
  });
  if (!framable) res.set('X-Frame-Options', 'DENY');
  next();
}

/**
 * The request's cookies, by name, as req.cookies: the session and the language
 * a guest picked. The first of a name counts, its value URL-decoded (as sent if
 * it isn't valid), quotes around it dropped. No prototype, so a cookie named
 * __proto__ is just a name.
 */
function readCookies(req, res, next) {
  req.cookies = Object.create(null);
  for (const pair of String(req.headers.cookie || '').split(';')) {
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    const name = pair.slice(0, eq).trim();
    if (!name || name in req.cookies) continue;
    let value = pair.slice(eq + 1).trim();
    if (value.length > 1 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    try {
      value = decodeURIComponent(value);
    } catch (err) {
      /* as sent */
    }
    req.cookies[name] = value;
  }
  next();
}

/**
 * Whether a request comes from the extension's own pages. Browsers send Origin
 * with every POST, so one naming another site, or "null", is refused. No Origin
 * at all (not a browser) passes: the guest API still needs the session cookie.
 */
function sameOrigin(req) {
  const origin = req.get('origin');
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === req.get('host');
  } catch (err) {
    return false;
  }
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

// The icon (a jukebox) for tabs, bookmarks and home screens; the pages have
// the same lines.
const ICON_LINKS =
  '<link rel="icon" href="/favicon.ico" sizes="32x32" />' +
  '<link rel="icon" href="/icon.svg" type="image/svg+xml" />' +
  '<link rel="apple-touch-icon" href="/apple-touch-icon.png" />' +
  '<link rel="manifest" href="/manifest.webmanifest" />';

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

/**
 * At most `limit` requests a minute from one device (by IP address), or no
 * limit at all for 0. Past it, 429 `too_many_requests` until the minute is up.
 * `limit` may be a function, read on each request, so a change to the Request
 * limits setting applies at once. `rate_limited` is taken: it means a guest's
 * allowance is used up.
 */
function perMinute(limit, onLimited = () => {}) {
  const current = typeof limit === 'function' ? limit : () => limit;
  const limiter = rateLimit({
    windowMs: 60 * 1000,
    // express-rate-limit blocks everything at 0, so 0 skips the check below.
    limit: () => current() || 1,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    // A client can send X-Forwarded-For; it would only fill the log with warnings.
    validate: { xForwardedForHeader: false },
    handler: (req, res) => {
      onLimited();
      res.status(429).json({ error: 'too_many_requests' });
    }
  });
  return (req, res, next) => (current() ? limiter(req, res, next) : next());
}

/**
 * @param {object} [options]
 * @param {{all: number, search: number}} [options.limits] - requests a minute per
 *   device; else the Flood protection setting (roon.requestLimits), else its
 *   Default (lib/env.js)
 */
function createServer(roon, guests, { limits } = {}) {
  const fallback = { all: DEFAULT_RATE_LIMIT, search: DEFAULT_SEARCH_LIMIT };
  const currentLimits = () => limits || roon.requestLimits || fallback;
  const app = express();
  const clients = new Set();
  // For the About page: how often a device was told "Too many requests",
  // guests' searches and skips, the searches, requests and skips Roon couldn't
  // do, how often a guest's allowance was used up (by kind) and a duplicate
  // was blocked, and how often a page's live updates reconnected.
  const stats = {
    tooMany: 0, searches: 0, searchesFailed: 0, requestsFailed: 0, skips: 0, skipsFailed: 0,
    usedUp: { add: 0, next: 0, skip: 0 }, duplicates: 0, reconnects: 0
  };
  const limited = () => {
    stats.tooMany += 1;
  };
  guests.onDrop = (id) => {
    if (roon.forgetSession) roon.forgetSession(id);
  };
  guests.queuedIds = () => new Set(roon.queue.map((item) => item.queue_item_id));

  app.disable('x-powered-by');
  app.use(securityHeaders);
  // A misbehaving or rogue device can't swamp the extension, a Pi Zero's one
  // core, or (through searches) the Roon Core. After the headers, so a 429
  // carries them too.
  app.use(perMinute(() => currentLimits().all, limited));
  // Guests' actions (name, request, skip) are POSTs. Another site can't make a
  // guest's phone send one: the session cookie is SameSite=lax, and this is a
  // second lock, checked before the body is read.
  app.use((req, res, next) => {
    if (req.method !== 'POST' || sameOrigin(req)) return next();
    res.status(403).json({ error: 'cross_origin' });
  });
  app.use(express.json({ limit: '16kb' }));
  // Express 5 leaves req.body undefined when there's no JSON body; the guest
  // API reads fields from it, so a bare POST gets the same answer as `{}`.
  app.use((req, res, next) => {
    if (req.body === undefined) req.body = {};
    next();
  });
  app.use(readCookies);
  // Page text in the language the browser asks for; see lib/i18n.js.
  // The Party Hub asks for its own (?for=hub): the host may have set its language.
  app.get('/i18n.js', (req, res) => {
    res.type('application/javascript').set({ 'Cache-Control': 'no-cache', Vary: 'Accept-Language, Cookie' });
    const lang = req.query.for === 'hub' ? hubLanguage(req) : i18n.pick(req);
    res.send(i18n.script(lang, req.cookies[i18n.LANG_COOKIE] === lang));
  });
  // The guest page, and the way in: the address the join codes carry. Opened
  // while the party's on, it lets the guest in, keeping their session or
  // starting one (a guest from an earlier party, or whose session ran out, is
  // simply let in again: their phone remembers their nickname), so a bookmark
  // or a printed code keeps working. Only for a page someone opens (opened()):
  // another site's image or frame can't make sessions. Express routes ignore
  // case, so /guesthub works too. Never cached: the page opens it again to
  // rejoin when the party comes back on (guest.js), and a browser that used
  // its copy (older Safari) never got the new session.
  app.get('/GuestHub', (req, res) => {
    if (mode() !== 'off' && opened(req)) setSessionCookie(res, guests.get(req.cookies[COOKIE]) || guests.create());
    res.set('Cache-Control', 'no-store');
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'), { cacheControl: false });
  });

  const settings = () => roon.settings;
  /** The host's name from the settings, tidied like a guest's, or '' for "Host". */
  const hostName = () => cleanName(settings().host_name);
  // The mode in force: the host's choice, or paused while the party zone is gone.
  const mode = () => (typeof roon.currentMode === 'string' ? roon.currentMode : partyMode(settings()));

  /** The Party Hub's language: the host's choice in the settings, or as for any page. */
  function hubLanguage(req) {
    const chosen = settings().hub_language;
    return chosen && i18n.languages().includes(chosen) ? chosen : i18n.pick(req);
  }

  let httpServer = null;
  let listeningPort = null;

  function baseUrl() {
    return `http://${lanAddress()}:${listeningPort || settings().port}`;
  }

  function guestUrl() {
    return `${baseUrl()}/GuestHub`;
  }

  // The playlist's own address, secret like the join link's: see the download below.
  function playlistPath() {
    return `/p/${playlist.code}`;
  }

  function playlistUrl() {
    return `${baseUrl()}${playlistPath()}`;
  }

  // The playlist's address for screens and their codes: it works only while
  // the playlist is offered, so it can be the same every time.
  function offeredPlaylistUrl() {
    return `${baseUrl()}/Playlist`;
  }

  function hubUrl() {
    return `${baseUrl()}/PartyHub`;
  }

  function aboutUrl() {
    return `${baseUrl()}/About`;
  }

  function broadcast(event, payload) {
    const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const res of clients) res.write(frame);
    // Other people's screens (/embed/events) hear of the same changes.
    embedBroadcast();
  }

  const history = new PlayHistory();
  const playlist = new PartyPlaylist();
  // Roon's status has the address: it shows the new one straight away.
  playlist.onReset = () => {
    if (roon.refreshStatus) roon.refreshStatus();
  };

  /**
   * Who a track is credited to: the guest who asked for it ('add' or 'next'),
   * Roon Radio for an entry it added (recognised as it arrived; see
   * RoonService._noteRadioPick), or else the host ('host'): Roon doesn't say
   * where a track came from, and anything else was queued in Roon.
   */
  function requester(track) {
    if (!track) return null;
    // Nobody asked for a radio station; it's labelled as one instead.
    if (track.station) return null;
    const attribution = guests.lookup(track);
    // requested_by is the guest's name, or null; the pages say "Anon", "Roon
    // Radio" or "Host" in their own language from the kind.
    if (attribution) return { requested_by: attribution.name || null, kind: attribution.kind };
    if (track.id && roon.isRadioPick && roon.isRadioPick(track.id)) return { requested_by: null, kind: 'radio' };
    return { requested_by: null, kind: 'host' };
  }

  /**
   * The credit plus the requesting guest's ref, for the records that keep a
   * copy of the name (Played, the playlist), so renaming can find them. Only
   * for those records: the pages get requester(), which has no ref.
   */
  function creditWithGuest(track) {
    const credit = requester(track);
    const fromGuest = credit && (credit.kind === 'add' || credit.kind === 'next');
    const attribution = fromGuest ? guests.lookup(track) : null;
    return attribution && attribution.guest ? Object.assign({}, credit, { guest: attribution.guest }) : credit;
  }

  function withRequester(track) {
    const credit = track && requester(track);
    return credit ? Object.assign({}, track, credit) : track;
  }

  /**
   * Split the queue into the playing track and what is still to come.
   *
   * Roon's queue starts with the playing track when it came from the queue,
   * Roon Radio's picks included, but not when a radio station is playing, so the
   * first item is dropped only when it is the playing track. When it is, its queue item id is carried onto the playing
   * track, which lets the playing track be credited by id rather than by title.
   */
  // The party zone's track when the zone last reported, for while it's gone.
  let lastPlaying = null;
  const partyOutput = () => (settings().zone && settings().zone.output_id) || null;

  function split() {
    const playing = nowPlaying(roon.zone);
    const items = roon.queue.map(queueItem);
    const first = items[0];
    const firstIsPlaying = Boolean(playing && first && sameRecording(first, playing));
    const shown = firstIsPlaying ? Object.assign({}, playing, { id: first.id }) : playing;
    const upcoming = firstIsPlaying ? items.slice(1) : items;
    if (roon.zone) lastPlaying = { output: partyOutput(), track: shown, upcoming };
    return { playing: shown, upcoming };
  }

  /**
   * While the party zone is missing (its device switched off, or the Core
   * restarting), the pages keep its last track, paused, with its art and
   * requester, rather than going blank until it's back. Not once the host picks
   * another zone.
   */
  function held() {
    return roon.zone || !lastPlaying || lastPlaying.output !== partyOutput() ? null : lastPlaying;
  }

  function heldPlaying() {
    const last = held();
    return last && last.track ? Object.assign({}, last.track, { state: 'paused' }) : null;
  }

  /**
   * Up next, held the same way. Roon keeps the queue while only the zone's
   * device is away, so it's shown as Roon has it; with the Core gone there's
   * none, so the last one stays.
   */
  function heldUpcoming(upcoming) {
    const last = held();
    return !roon.core && last && !upcoming.length ? last.upcoming : upcoming;
  }

  let loggedTrack = null;

  function creditForLog(credit) {
    if (!credit) return 'nobody';
    if (credit.kind === 'radio') return 'Roon Radio';
    if (credit.kind === 'host') return hostName() || 'Host';
    return credit.requested_by || 'Anon';
  }

  function recordHistory(ended) {
    const { playing } = split();
    const credit = playing && creditWithGuest(playing);
    // When it was queued, kept for Played (other people's screens show it).
    const track = playing && Object.assign({}, playing, { queued_at: playlist.queuedAt(playing.id) });
    history.update(roon.zone ? roon.zone.zone_id : null, track, credit, ended);

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
    const zone = roon.zone;
    // Never the party zone's name: a guest could find that speaker in Roon and
    // play to it directly, going round the party (as on the About page).
    return {
      party_name: roon.pageName,
      // Set, it stands in for "Host" on the host's tracks and skips.
      host_name: hostName() || null,
      now_playing: withRequester(playing || heldPlaying()),
      played: history.list(),
      upcoming: heldUpcoming(upcoming).map(withRequester),
      // Whether Roon allows a skip now: not on a radio station, or on the last
      // track with Roon Radio off. The guest page shows Skip only then.
      can_skip: Boolean(zone && zone.is_next_allowed),
      // What an empty Up next says, the same on every page (see emptyMessage).
      empty: emptyMessage(zone, playing)
    };
  }

  /**
   * What an empty Up next says: an invitation to add a track while guests can,
   * and that Roon Radio picks what's next when it will. Roon Radio adds its next
   * pick only as a playing track ends, so it doesn't count for a stopped zone or
   * a radio station. Paused, requests are on hold, so it just says it's empty.
   */
  function emptyMessage(zone, playing) {
    if (mode() === 'paused') return 'queue.empty';
    const radio = Boolean(
      zone && zone.settings && zone.settings.auto_radio && playing && playing.state === 'playing' && !playing.station
    );
    // Either way of adding is an invitation to add a track.
    if (!settings().allow_add && !settings().allow_next) return radio ? 'queue.empty_radio' : 'queue.empty';
    return radio ? 'queue.empty_add_radio' : 'queue.empty_add';
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
  roon.on('settings_changed', () => {
    broadcast('party', { party_mode: mode() });
    // Settings change what an empty Up next says (emptyMessage).
    broadcast('queue', queueSnapshot());
  });
  /**
   * Roon's display page, at the address and port Party Mode reaches the Core
   * on, so it follows the Core; null until the Core has been found. Roon's API
   * reaches a Core on this computer at 127.0.0.1, which a TV's browser can't
   * use, so the Hub (forBrowser) gets this computer's network address instead.
   */
  function roonDisplayUrl(forBrowser = true) {
    const core = roon.coreAddress;
    if (!core) return null;
    const host = forBrowser && core.host === '127.0.0.1' ? lanAddress() : core.host;
    return `http://${host}:${core.port}/display/`;
  }

  /**
   * The view a screen asked for (/PartyHub/Standard, /Roon or /Basic, or
   * ?view= from its page): 'simple', 'roon', 'basic', or undefined for the setting's.
   */
  function hubView(name) {
    const key = String(name || '').toLowerCase();
    // Its own names only: not constructor or __proto__ from Object's prototype.
    return Object.hasOwn(HUB_VIEWS, key) ? HUB_VIEWS[key] : undefined;
  }

  // When a screen last asked for Roon's display page by its address: the page
  // is checked while one does, whatever the setting.
  let roonViewSeen = 0;

  /** The page the Party Hub frames for the playing track, or null for its own. */
  function currentFrame(view) {
    const chosen = view ? Object.assign({}, settings(), { hub_playing: view }) : settings();
    return hubFrame(chosen, roonDisplayUrl());
  }

  /** Roon's display page, while the setting or a screen shows it; else null. */
  function checkedFrame() {
    if (Date.now() - roonViewSeen < 3 * 60 * 1000) return currentFrame('roon');
    return currentFrame();
  }

  /**
   * Whether Roon's display page answers, reached as Party Mode reaches the
   * Core: a browser can't tell a frame that failed from one that loaded (it
   * shows its own error page, and fires load for that too), so the Hub asks
   * here, and shows its own Playing now while the page doesn't answer. Checked
   * when the settings change, when the Core connects and every minute; only
   * the status is read.
   */
  const frameCheck = { href: null, ok: null };
  async function checkFrame() {
    const frame = checkedFrame();
    const href = frame ? frame.href : null;
    let ok = null;
    if (href) {
      try {
        const res = await fetch(roonDisplayUrl(false), { redirect: 'manual', signal: AbortSignal.timeout(5000) });
        ok = res.status < 400;
        if (res.body) await res.body.cancel();
      } catch {
        ok = false;
      }
      // The setting or the Core changed meanwhile: that starts a check of its own.
      const now = checkedFrame();
      if (!now || now.href !== href) return;
    }
    const changed = frameCheck.href !== href || frameCheck.ok !== ok;
    Object.assign(frameCheck, { href, ok });
    if (changed) broadcast('queue', queueSnapshot());
  }
  roon.on('settings_changed', checkFrame);

  /** A screen shows Roon's display page by its address: check it, if not already. */
  function seeRoonView() {
    const first = Date.now() - roonViewSeen >= 3 * 60 * 1000;
    roonViewSeen = Date.now();
    if (first) checkFrame();
  }
  // Roon's display page moves with the Core.
  roon.on('core_paired', checkFrame);
  checkFrame();
  setInterval(checkFrame, 60 * 1000).unref();

  roon.on('party_mode_changed', (now, previous) => {
    if (now === 'off') {
      guests.clear();
    } else if (previous === 'off') {
      // Coming back from off starts a new party, and a new playlist. Paused
      // and back is the same party.
      playlist.reset();
      recordPlaylist();
    }
    broadcast('party', { party_mode: now });
    // What's playing too: when the party pauses itself because its zone has gone,
    // the track the pages show has gone with it.
    broadcast('queue', queueSnapshot());
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
        ICON_LINKS +
        '<link rel="stylesheet" href="/party.css" /><link rel="stylesheet" href="/guest.css" /></head>' +
        `<body><main class="locked"><h1>${text(titleKey)}</h1><p class="muted">${text(textKey)}</p></main></body></html>`
    );
  }

  // The root isn't the guest page any more (that's /GuestHub): an old bookmark
  // gets "Scan the code again".
  app.get('/', (req, res) => messagePage(res, i18n.pick(req), 'locked.title', 'locked.text'));

  /** The session cookie lasts as long as the session would idle, from now. */
  function setSessionCookie(res, session) {
    res.cookie(COOKIE, session.id, { httpOnly: true, sameSite: 'lax', maxAge: SESSION_TTL_MS });
  }

  function requireGuest(req, res, next) {
    // Paused still lets guests in to look around; only requests wait. Off,
    // the page says requests are closed, with the playlist when it's offered.
    if (mode() === 'off') return res.status(403).json({ error: 'closed', playlist: playlistOffered() });
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
      party_name: roon.pageName,
      ready: roon.ready,
      guest_name: req.guest.name,
      party_mode: mode(),
      // The party name button shows the join code (the Invites setting).
      invite: settings().guest_invite !== false,
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
    // The labels the pages give tracks no guest asked for, in any language,
    // can't be a guest's name: "Requested by Host" would mislead.
    const key = nameKey(name);
    if (RESERVED_NAMES.has(key) || (key && key === nameKey(hostName()))) {
      return res.status(400).json({ error: 'name_reserved', name });
    }
    // Another guest goes by it: allowed, once the guest has seen that and said so.
    if (req.body.confirm !== true && guests.nameInUse(name, req.guest)) {
      return res.status(409).json({ error: 'name_taken', name });
    }
    req.guest.name = name;
    // Tracks this guest already added (as Anon, or under an old name) follow.
    guests.rename(req.guest);
    history.rename(req.guest.ref, name);
    playlist.rename(req.guest.ref, name);
    broadcast('queue', queueSnapshot());
    res.json({ guest_name: name });
  });

  app.get('/api/search', perMinute(() => currentLimits().search, limited), requireGuest, async (req, res) => {
    const query = String(req.query.q || '').replace(/\p{Cc}/gu, ' ').trim().slice(0, MAX_QUERY);
    if (query.length < 2) return res.json({ results: [] });
    if (!roon.ready) return res.status(503).json({ error: 'not_ready' });

    stats.searches += 1;
    try {
      const items = await roon.search(req.guest.id, query);
      // A newer search from this guest replaced it: the page shows only the
      // newest one's results.
      if (items === null) return res.json({ results: [], superseded: true });
      req.guest.lastSearch = { query, items };
      guests.offer(req.guest, items);

      // A queued track is always marked, so guests can see it's coming; it can
      // only be requested again when the host doesn't block duplicates.
      const blockDuplicates = settings().prevent_duplicates;
      const queued = queuedByTitle();
      res.json({
        results: items.map((item) => {
          const inQueue = isQueued(item.title, item.subtitle || '', item.image_key, items, queued);
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
      stats.searchesFailed += 1;
      res.status(502).json({ error: err.message });
    }
  });

  app.post('/api/request', requireGuest, async (req, res) => {
    const action = req.body.mode === 'next' ? 'next' : 'add';
    const bucket = action;
    if (mode() === 'paused') return res.status(409).json({ error: 'paused' });
    if (!roon.ready) return res.status(503).json({ error: 'not_ready' });

    // Only a track this guest was sent in their search results, as it was sent.
    const offered = guests.offered(req.guest, req.body.key);
    if (!offered) return res.status(400).json({ error: 'unknown_track' });
    const { title, subtitle, image_key: imageKey } = offered;

    const status = guests.check(req.guest, bucket, settings());
    if (!status.allowed) {
      if (status.reason === 'rate_limited') stats.usedUp[bucket] += 1;
      return res.status(429).json({ error: status.reason, next_in: status.nextIn });
    }

    const searched = req.guest.lastSearch ? req.guest.lastSearch.items : [];
    if (settings().prevent_duplicates && isQueued(title, subtitle, imageKey, searched)) {
      stats.duplicates += 1;
      return res.status(409).json({ error: 'already_queued' });
    }

    // Taken now, before Roon is asked, and handed back if Roon refuses.
    guests.consume(req.guest, bucket, settings());
    try {
      await performWithRetry(req.guest, req.body.key, action, title, subtitle);
      const entry = guests.attribute(req.guest, { title, artist: subtitle }, action);
      // Bound to its queue item when Roon reports the insert; see claimInserted.
      claims.push({ entry, title, artist: subtitle, at: Date.now() });
      console.log(`Request (${action}) from ${req.guest.name || 'Anon'}: "${title}" / "${subtitle}"`);
      res.json({ ok: true, allowances: guests.allowances(req.guest, settings()) });
    } catch (err) {
      stats.requestsFailed += 1;
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
   * @param {Map} [queued] - queuedByTitle(), once for a whole search
   */
  function isQueued(title, subtitle, imageKey, results, queued = queuedByTitle()) {
    const candidate = { title, artist: subtitle, image_key: imageKey || null };
    const writers = sharedCredits(results, title);
    return (queued.get(versionTitle(title)) || []).some((item) => sameRecordingAsQueued(item, candidate, writers));
  }

  /** The queue by version-sensitive title: a duplicate has the same one. */
  function queuedByTitle() {
    const queued = new Map();
    for (const item of roon.queue.map(queueItem)) {
      const key = versionTitle(item.title);
      if (!queued.has(key)) queued.set(key, []);
      queued.get(key).push(item);
    }
    return queued;
  }

  /**
   * Browse item keys expire when the guest's browse session moves on. If the
   * action fails, the search is replayed once and the track matched by title.
   * Not when Roon didn't answer: it may still add the track, and asking again
   * could add it twice.
   */
  async function performWithRetry(session, itemKey, mode, title, subtitle) {
    try {
      return await roon.performAction(session.id, itemKey, mode);
    } catch (err) {
      const last = session.lastSearch;
      if (!last || err.message === 'Roon did not answer') throw err;
      const items = (await roon.search(session.id, last.query)) || [];
      session.lastSearch = { query: last.query, items };
      guests.offer(session, items, { rerun: true });
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
    // Roon won't skip now (a radio station, or the last track with Roon Radio
    // off): refused before the guest's skip is used.
    if (roon.zone && !roon.zone.is_next_allowed) return res.status(409).json({ error: 'cant_skip' });
    const status = guests.check(req.guest, 'skip', settings());
    if (!status.allowed) {
      if (status.reason === 'rate_limited') stats.usedUp.skip += 1;
      return res.status(429).json({ error: status.reason, next_in: status.nextIn });
    }
    const undo = history.markSkipped(split().playing, req.guest.name, req.guest.ref);
    // Taken before Roon is asked, as for requests, and handed back on failure.
    guests.consume(req.guest, 'skip', settings());
    stats.skips += 1;
    try {
      await roon.skip();
      res.json({ ok: true, allowances: guests.allowances(req.guest, settings()) });
    } catch (err) {
      stats.skipsFailed += 1;
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
    const view = hubView(req.query.view);
    if (view === 'roon') seeRoonView();
    const frame = currentFrame(view);
    res.json(
      Object.assign(queueSnapshot(), {
        party_mode: mode(),
        // A Hub in another language reloads, when the host changes the setting.
        language: hubLanguage(req),
        // How the screen offers the playlist once requests close: 'qr', 'link' or 'off'.
        playlist: playlistDisplay(settings()),
        // Roon's display page, with Roon Display (Party Hub default view, or the
        // screen's own), or null.
        frame_url: frame ? frame.href : null,
        // Whether it answered when last checked; null until then.
        frame_ok: frame && frameCheck.href === frame.href ? frameCheck.ok : null,
        // Roon sent as much of the queue as Party Mode asks for: there may be more.
        queue_full: roon.queue.length >= QUEUE_ITEMS,
        ready: roon.ready
      })
    );
  });

  // Whether the Party Hub offers the playlist now: once requests close, unless
  // the host chose Off.
  function playlistOffered() {
    return mode() === 'off' && playlistDisplay(settings()) !== 'off';
  }

  // The playlist as a QR code, for the Party Hub and other people's screens once
  // requests close, and only when the host chose a QR code. It carries
  // /Playlist, not the secret address.
  app.get('/embed/playlist-qr.svg', (req, res) => {
    if (mode() !== 'off' || playlistDisplay(settings()) !== 'qr') return res.status(404).end();
    sendQr(res, offeredPlaylistUrl());
  });

  // Everything queued during the party, for the host to keep; see lib/party-playlist.js.
  // At an address with a code of its own, new with each new playlist, like the
  // join link: the file has guests' names (unless Hide names in downloadable
  // playlist), so only those given the address can fetch it. The Party Hub shows it
  // once requests close (as the Playlist setting says), and the setting's hint in
  // Roon always has it, for the host. The code is short, to type from Roon's
  // status, and matched as it may be typed (sameCode). The fixed addresses before
  // 1.4.0 (/Download/playlist.csv, /api/playlist.csv) are gone: anyone could fetch those.
  app.get('/p/:code', (req, res) => {
    if (!sameCode(req.params.code, playlist.code)) return res.status(404).type('text').send('Not found');
    sendPlaylist(res);
  });

  // The same file, while the Party Hub offers it (once requests close, as a QR
  // code or a link): the address its codes and links carry, easy to type, and
  // the same for every party. Express routes ignore case, so /playlist works too.
  app.get('/Playlist', (req, res) => {
    if (!playlistOffered()) return res.status(404).type('text').send('Not found');
    sendPlaylist(res);
  });

  function sendPlaylist(res) {
    res.attachment(playlistFileName(roon.pageName));
    res.type('text/csv; charset=utf-8').set('Cache-Control', 'no-store').send(
      playlist.toCsv(requester, { hideNames: settings().playlist_hide_names === true, hostName: hostName() })
    );
  }

  // The last code made for each address: the join and playlist addresses change
  // only with a new party or playlist, so a page reloading them (or another
  // site's, from /embed/) costs a lookup. A new address simply doesn't match;
  // the oldest are dropped, so it stays small.
  const qrCache = new Map();

  function sendQr(res, url) {
    try {
      let svg = qrCache.get(url);
      if (!svg) {
        svg = qr.svg(url);
        qrCache.set(url, svg);
        if (qrCache.size > 4) qrCache.delete(qrCache.keys().next().value);
      }
      res.type('image/svg+xml').set('Cache-Control', 'no-store').send(svg);
    } catch (err) {
      res.status(500).end();
    }
  }

  // The join code, for the Party Hub, the guest page's invite and other people's
  // screens: it carries /GuestHub, the same for every party.
  app.get('/embed/join-qr.svg', (req, res) => sendQr(res, guestUrl()));

  /**
   * Whether a request is someone opening the address (a tap on a link, a
   * scanned code), not another site's page loading it as an image, a frame or
   * a fetch, as browsers say in Sec-Fetch-Dest. Older ones (Safari before 16.4)
   * send none, and pass. Opening /GuestHub makes a session, so otherwise any
   * site could make a visitor's browser fill the sessions up from an image in
   * a loop, dropping idle guests'.
   */
  function opened(req) {
    const dest = req.get('sec-fetch-dest');
    return dest === undefined || dest === 'document';
  }

  // ------------------------------------------------- other people's screens

  // What /embed/ shows, read-only, for a screen of someone's own: any site may
  // read it (CORS), so it's built field by field in lib/embed.js, never with an
  // address. The same four as files and as a live stream.
  function embedViews() {
    const snapshot = queueSnapshot();
    const host = snapshot.host_name;
    const queued = (t) => t && Object.assign({}, t, { queued_at: playlist.queuedAt(t.id) });
    const zone = roon.zone;
    return {
      status: embed.status({
        party: mode(),
        partyName: snapshot.party_name,
        hostName: host,
        ready: roon.ready,
        playlist: playlistDisplay(settings()),
        language: settings().hub_language,
        roonRadio: Boolean(zone && zone.settings && zone.settings.auto_radio)
      }),
      'now-playing': embed.nowPlaying(queued(snapshot.now_playing), host),
      'up-next': embed.upNext(snapshot.upcoming.map(queued), snapshot.empty, host),
      played: embed.played(snapshot.played, host)
    };
  }

  const embedHeaders = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
  for (const view of ['status', 'now-playing', 'up-next', 'played']) {
    app.get(`/embed/${view}.json`, (req, res) => res.set(embedHeaders).json(embedViews()[view]));
  }

  // Covers, for other sites' pages: only the sizes the cache keeps and one
  // large, so they can't make it fetch others; only covers Party Mode has sent.
  app.get('/embed/art/:key', async (req, res) => {
    const asked = parseInt(req.query.size, 10);
    const size = embed.ART_SIZES.includes(asked) ? asked : embed.ART_SIZE;
    try {
      const { contentType, body } = await roon.getImage(req.params.key, size);
      res.type(contentType || 'image/jpeg').set('Cache-Control', 'public, max-age=86400').send(body);
    } catch (err) {
      res.status(404).end();
    }
  });

  // The same as a live stream: each view when it changes, all four on connecting.
  const embedClients = new Set();
  // What each stream last had, to send only what changed. The playing track's
  // time moves on its own, so only a change of anything else is news.
  let embedSent = {};
  const embedKey = (event, data) =>
    JSON.stringify(event === 'now-playing' && data.track ? Object.assign({}, data.track, { at: 0, seek_position: 0 }) : data);
  const embedFrame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

  // Now and then too, for what changes without an event (connecting to Roon).
  setInterval(() => embedBroadcast(), 15000).unref();

  function embedBroadcast() {
    if (!embedClients.size) return;
    for (const [event, data] of Object.entries(embedViews())) {
      const key = embedKey(event, data);
      if (embedSent[event] === key) continue;
      embedSent[event] = key;
      const frame = embedFrame(event, data);
      for (const res of embedClients) res.write(frame);
    }
  }

  app.get('/api/image/:key', async (req, res) => {
    const size = Math.min(1024, Math.max(48, parseInt(req.query.size, 10) || 200));
    try {
      const { contentType, body } = await roon.getImage(req.params.key, size);
      res.type(contentType || 'image/jpeg').set('Cache-Control', 'public, max-age=86400').send(body);
    } catch (err) {
      res.status(404).end();
    }
  });

  // Open live-update streams per device address.
  const streamsByDevice = new Map();
  // A sixtieth of the per-minute limit, at least 10: Default Flood protection (1200)
  // allows 20, a shared Wi-Fi's 6000 allows 100, and no limit (0) any number.
  const streamsPerDevice = () => {
    const all = currentLimits().all;
    return all ? Math.max(MIN_STREAMS_PER_DEVICE, Math.ceil(all / 60)) : Infinity;
  };

  /**
   * Open a live-update stream, or refuse it: at most streamsPerDevice() per
   * device and MAX_STREAMS in all, the Party Mode pages' and other screens'
   * together. Refused rather than closing older ones: a page reconnects a
   * closed stream at once, so two would take turns. Returns a function to call
   * when it closes, or null when refused (already answered).
   */
  function openStream(req, res, headers = {}) {
    const device = req.ip;
    const open = streamsByDevice.get(device) || 0;
    if (open >= streamsPerDevice()) {
      res.status(429).set(headers).json({ error: 'too_many_streams' });
      return null;
    }
    if (clients.size + embedClients.size >= MAX_STREAMS) {
      res.status(503).set(headers).json({ error: 'too_many_streams' });
      return null;
    }
    streamsByDevice.set(device, open + 1);
    res.set(Object.assign({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' }, headers));
    res.flushHeaders();
    return () => {
      const left = streamsByDevice.get(device) - 1;
      if (left > 0) streamsByDevice.set(device, left);
      else streamsByDevice.delete(device);
    };
  }

  app.get('/api/events', (req, res) => {
    // A refused page still updates every 30 s.
    const closed = openStream(req, res);
    if (!closed) return;
    // The id is only so a browser's own reconnect says so (Last-Event-ID): weak
    // Wi-Fi drops pages' streams. Not in the first minute, when pages left open
    // across a restart all come back.
    if (req.get('Last-Event-ID') && process.uptime() > RECONNECT_GRACE_S) stats.reconnects += 1;
    res.write(`id: 1\nevent: queue\ndata: ${JSON.stringify(queueSnapshot())}\n\n`);
    // A guest's page or a Party Hub, for the About page's counts. Looked up
    // without renewing the guest's session.
    const cookie = req.cookies[COOKIE];
    res.guestId = cookie && guests.sessions.has(cookie) ? cookie : null;
    clients.add(res);

    const heartbeat = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => {
      clearInterval(heartbeat);
      clients.delete(res);
      closed();
      res.end();
    });
  });

  // Other people's screens: /embed/'s four views as they change, readable by
  // any site (EventSource across sites works without cookies). No guest is
  // looked up, and the About page counts these apart from Party Hubs.
  app.get('/embed/events', (req, res) => {
    const closed = openStream(req, res, { 'Access-Control-Allow-Origin': '*' });
    if (!closed) return;
    const views = embedViews();
    for (const [event, data] of Object.entries(views)) res.write(embedFrame(event, data));
    // What's sent from here on is measured against what this one has.
    for (const [event, data] of Object.entries(views)) embedSent[event] = embedKey(event, data);
    embedClients.add(res);
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => {
      clearInterval(heartbeat);
      embedClients.delete(res);
      closed();
      res.end();
    });
  });

  /**
   * The Hub with its title already in it ("Garden Party Hub", in the
   * browser's language): Safari, bookmarks and home-screen icons can take the
   * title before the page's script sets it. The script still updates it when
   * the party is renamed.
   */
  const hubPage = fs.readFileSync(path.join(__dirname, '..', 'public', 'hub.html'), 'utf8');
  const basicPage = fs.readFileSync(path.join(__dirname, '..', 'public', 'basic.html'), 'utf8');

  // Routes match without regard to case, so /partyhub works too. A view in
  // the address (/PartyHub/Roon) is that screen's, whatever the setting.
  app.get(['/PartyHub', '/PartyHub/:view'], (req, res, next) => {
    const view = req.params.view === undefined ? undefined : hubView(req.params.view);
    if (req.params.view !== undefined && !view) return next();
    if (view === 'roon') seeRoonView();
    const basic = (view || hubPlaying(settings())) === 'basic';
    const lang = hubLanguage(req);
    const name = roon.pageName || i18n.t(lang, 'party.default_name');
    const title = escapeHtml(i18n.t(lang, 'page.hub_title', { name }));
    // With Roon Display (the setting's, or the screen's), the Hub may frame Roon's
    // display page (its site, not the whole web), and stops asking for
    // require-corp: Roon's page doesn't opt in to it, so browsers would refuse
    // to show it. The Hub reloads when the address changes, to get these again.
    const frame = currentFrame(view);
    if (frame) {
      res.set('Content-Security-Policy', `${CSP}; frame-src ${frame.origin}`);
      res.removeHeader('Cross-Origin-Embedder-Policy');
    }
    res.set({ 'Cache-Control': 'no-cache', Vary: 'Accept-Language' }).type('html').send(
      (basic ? basicPage : hubPage)
        // Functions, so a "$&" in a party name is not read as a replacement pattern.
        .replace('<html lang="en">', () =>
          `<html lang="${escapeHtml(lang)}" dir="${i18n.dir(lang)}"${view ? ` data-view="${req.params.view.toLowerCase()}"` : ''}>`)
        .replace('<title>Party Hub</title>', () => `<title>${title}</title>`)
    );
  });
  // Its address before it was the Party Hub, for bookmarks and screens set up then.
  app.get(['/roonparty', '/roonparty.html'], (req, res) => res.redirect(301, '/PartyHub'));
  // Version, licences and the libraries Party Mode runs on; see lib/about.js.
  aboutRoutes(app, { roon, guests, playlist, stats, streams: clients, screens: embedClients, hubUrl });

  // The pages' own files, after the routes: looking for a file costs a system
  // call even when there's none, and every API request used to pay it first
  // (about a fifth of what album art took on a Raspberry Pi 1). No index: the
  // guest page is at /GuestHub, not the root.
  app.use(express.static(path.join(__dirname, '..', 'public'), { index: false }));

  // Anything else, and any error, gets a plain answer with the security headers
  // above, rather than Express's own page, which names Express and drops them.
  app.use((req, res) => res.status(404).type('text').send('Not found'));
  // Express knows an error handler by its four arguments, so `next` stays.
  app.use((err, req, res, next) => {
    const status = err.status >= 400 && err.status < 500 ? err.status : 500;
    if (status === 500) console.error(err);
    res.status(status).type('text').send(status === 500 ? 'Something went wrong' : 'Bad request');
  });

  return {
    app,
    guestUrl,
    playlistUrl,
    hubUrl,
    aboutUrl,
    roonDisplayUrl,
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
        Object.assign(next, CONNECTION_LIMITS);
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

module.exports = { createServer, lanAddress, CONNECTION_LIMITS };
