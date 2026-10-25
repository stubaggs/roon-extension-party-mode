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

// The web server's own answers, against a stand-in for Roon: the playlist and
// its QR code, Party Off, and the pages a join link gets.

const assert = require('assert');
const EventEmitter = require('events');
const qr = require('../lib/qr');
const http = require('http');
const { createServer, lanAddress, CONNECTION_LIMITS } = require('../lib/server');
const { GuestStore, cleanName, MAX_SESSIONS, OFFERED_SEARCHES } = require('../lib/guests');
const { DEFAULT_SETTINGS, RoonService } = require('../lib/roon-service');
const { ArtCache, KnownKeys } = require('../lib/art-cache');
const i18n = require('../lib/i18n');

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

// Only what lib/server.js reads from the Roon service; no Core, no zone.
// Searches answer with `results`; actions and skips are recorded, take a
// moment (so requests sent together overlap), and fail when told to.
const results = [
  { item_key: '10:0', title: 'Waterloo', subtitle: 'ABBA', hint: 'action_list' },
  { item_key: '10:1', title: 'SOS', subtitle: 'ABBA', hint: 'action_list' }
];
const roon = Object.assign(new EventEmitter(), {
  settings: Object.assign({}, DEFAULT_SETTINGS, { port: 0 }),
  queue: [],
  zone: null,
  ready: false,
  pageName: 'Test Party',
  searches: [],
  actions: [],
  skips: 0,
  failing: false,
  radioPicks: new Set(),
  isRadioPick(id) {
    return this.radioPicks.has(id);
  },
  async search(session, query) {
    this.searches.push(query);
    return results;
  },
  async performAction(session, key, mode) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    if (this.failing) throw new Error('roon_refused');
    this.actions.push({ key, mode });
  },
  async skip() {
    await new Promise((resolve) => setTimeout(resolve, 20));
    if (this.failing) throw new Error('roon_refused');
    this.skips += 1;
  }
});
const guests = new GuestStore();
// No rate limits here, so the checks below can't run into them; they're
// checked on a server of their own.
const server = createServer(roon, guests, { limits: { all: 0, search: 0 } });

let base;
const get = (path, headers = {}) => fetch(base + path, { headers, redirect: 'manual' });
const post = (path, cookie, body) =>
  fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(body)
  });

/** A new guest, joined and with Waterloo and SOS in their search results. */
async function newGuest() {
  const cookie = (await get('/GuestHub')).headers.get('set-cookie').split(';')[0];
  await get('/api/search?q=abba', { Cookie: cookie });
  return cookie;
}
const set = (values) => Object.assign(roon.settings, values);

(async () => {
  await server.listen(0);
  base = `http://127.0.0.1:${server.port}`;

  console.log('playlist');

  await check('the Party Hub is told how to offer it: QR code by default', async () => {
    set({ enabled: false, playlist_download: 'qr' });
    assert.strictEqual((await (await get('/api/hub')).json()).playlist, 'qr');
  });

  await check('link only and off reach the Party Hub as they are', async () => {
    set({ playlist_download: 'link' });
    assert.strictEqual((await (await get('/api/hub')).json()).playlist, 'link');
    set({ playlist_download: 'off' });
    assert.strictEqual((await (await get('/api/hub')).json()).playlist, 'off');
  });

  await check('a yes/no saved before the three choices still reads right', async () => {
    set({ playlist_download: true });
    assert.strictEqual((await (await get('/api/hub')).json()).playlist, 'qr');
    set({ playlist_download: false });
    assert.strictEqual((await (await get('/api/hub')).json()).playlist, 'off');
  });

  const playlistPath = () => new URL(server.playlistUrl()).pathname;

  await check('the playlist is at a secret address, which the Hub is never given', async () => {
    assert.match(playlistPath(), /^\/p\/[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    for (const [enabled, choice] of [[true, 'qr'], ['paused', 'qr'], [false, 'qr'], [false, 'link'], [false, 'off']]) {
      set({ enabled, playlist_download: choice });
      const hub = await (await get('/api/hub')).text();
      assert.ok(!hub.includes(playlistPath().slice(3)), `${enabled} ${choice}`);
      assert.ok(!hub.includes('playlist_url') && !hub.includes('join_url'), `${enabled} ${choice}`);
    }
  });

  await check('/Playlist: the same file, only while the Hub offers it', async () => {
    for (const enabled of [true, 'paused']) {
      set({ enabled, playlist_download: 'qr' });
      assert.strictEqual((await get('/Playlist')).status, 404, String(enabled));
    }
    for (const choice of ['qr', 'link']) {
      set({ enabled: false, playlist_download: choice });
      const res = await get('/Playlist');
      assert.strictEqual(res.status, 200, choice);
      assert.match(res.headers.get('content-disposition'), /attachment; filename="Test Party \d{4}-\d{2}-\d{2}\.csv"/);
      assert.strictEqual(await res.text(), await (await get(playlistPath())).text(), choice);
      assert.strictEqual(res.headers.get('access-control-allow-origin'), null, 'no other site reads it');
    }
    assert.strictEqual((await get('/playlist')).status, 200, 'as it may be typed');
    set({ playlist_download: 'off' });
    assert.strictEqual((await get('/Playlist')).status, 404, 'Playlist Off');
    set({ enabled: true, playlist_download: 'qr' });
  });

  await check('the download works at its address whatever the setting, as a named CSV file', async () => {
    for (const [enabled, choice] of [[false, 'qr'], [false, 'link'], [false, 'off'], [true, 'qr']]) {
      set({ enabled, playlist_download: choice });
      const res = await get(playlistPath());
      assert.strictEqual(res.status, 200, choice);
      assert.match(res.headers.get('content-type'), /^text\/csv/);
      assert.match(res.headers.get('content-disposition'), /attachment; filename="Test Party \d{4}-\d{2}-\d{2}\.csv"/);
      const bytes = Buffer.from(await res.arrayBuffer());
      assert.ok(bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), 'byte order mark');
      assert.match(bytes.toString('utf8', 3), /^index,title,artist,album,/);
    }
  });

  await check('not at any other address: the fixed ones before 1.4.0, or a guessed code', async () => {
    set({ enabled: false, playlist_download: 'qr' });
    for (const path of ['/Download/playlist.csv', '/api/playlist.csv', `/Download${playlistPath().slice(2)}`, '/p/0000-0000', `${playlistPath()}x`]) {
      assert.strictEqual((await get(path)).status, 404, path);
    }
  });

  await check('the address works as it may be typed: lower case, no hyphen', async () => {
    set({ enabled: false });
    const code = playlistPath().slice(3);
    for (const path of [`/P/${code.toLowerCase()}`, `/p/${code.replace('-', '')}`]) {
      assert.strictEqual((await get(path)).status, 200, path);
    }
  });

  await check('a new party has a new playlist at a new address; the old one stops working', async () => {
    set({ enabled: false });
    const old = playlistPath();
    let refreshed = 0;
    roon.refreshStatus = () => (refreshed += 1);
    set({ enabled: true });
    roon.emit('party_mode_changed', 'on', 'off');
    delete roon.refreshStatus;
    assert.notStrictEqual(playlistPath(), old);
    assert.strictEqual(refreshed, 1, "Roon's status sent again, with the new address");
    assert.strictEqual((await get(old)).status, 404);
    assert.strictEqual((await get(playlistPath())).status, 200);
  });

  await check('the playlist QR code: only once requests close, with QR code chosen; not the join code', async () => {
    set({ enabled: true, playlist_download: 'qr' });
    assert.strictEqual((await get('/embed/playlist-qr.svg')).status, 404, 'during the party');
    set({ enabled: false, playlist_download: 'link' });
    assert.strictEqual((await get('/embed/playlist-qr.svg')).status, 404, 'link only');
    set({ playlist_download: 'off' });
    assert.strictEqual((await get('/embed/playlist-qr.svg')).status, 404, 'off');
    set({ playlist_download: 'qr' });
    const playlist = await (await get('/embed/playlist-qr.svg')).text();
    assert.match(playlist, /^<svg/);
    assert.notStrictEqual(playlist, await (await get('/embed/join-qr.svg')).text());
    // The addresses before 1.4.0 are gone.
    for (const path of ['/api/qr.svg', '/Download/playlist-qr.svg', '/api/playlist-qr.svg']) {
      assert.strictEqual((await get(path)).status, 404, path);
    }
    set({ enabled: true });
  });

  console.log('\njoining');

  await check('the root asks the guest to scan the code, in their language', async () => {
    const res = await get('/', { 'Accept-Language': 'fr-FR,fr;q=0.9' });
    assert.match(res.headers.get('content-type'), /^text\/html/);
    const html = await res.text();
    assert.match(html, /<html lang="fr" dir="ltr">/);
    assert.match(html, /name="viewport"/);
    assert.ok(html.includes(`<h1>${i18n.t('fr', 'locked.title')}</h1>`));
  });

  await check('the join links before 1.4.0 (/j/<code>) are gone', async () => {
    set({ enabled: true });
    assert.strictEqual((await get('/j/AAAAAAAAAAAA')).status, 404);
  });

  await check('the session cookie lasts 12 hours and is renewed whenever it is used', async () => {
    set({ enabled: true });
    const joined = (await get('/GuestHub')).headers.get('set-cookie');
    assert.match(joined, /Max-Age=43200/);
    const cookie = joined.split(';')[0];
    const res = await get('/api/party', { Cookie: cookie });
    assert.strictEqual(res.status, 200);
    const renewed = res.headers.get('set-cookie') || '';
    assert.strictEqual(renewed.split(';')[0], cookie, 'the same session');
    assert.match(renewed, /Max-Age=43200/);
  });

  await check("the session is read among a browser's other cookies, however they're written", async () => {
    set({ enabled: true });
    const cookie = (await get('/GuestHub')).headers.get('set-cookie').split(';')[0];
    await post('/api/name', cookie, { name: 'Cookie Carla', confirm: true });
    const id = cookie.split('=')[1];
    const nameWith = async (header) => (await (await get('/api/party', { Cookie: header })).json()).guest_name;
    assert.strictEqual(await nameWith(`a=1; junk; =x; __proto__=y; bad=%E0%A4%A; party_sid=${id}; other=2`), 'Cookie Carla');
    assert.strictEqual(await nameWith(`party_sid="${id}"`), 'Cookie Carla', 'quoted');
    assert.strictEqual(await nameWith(`party_sid=${encodeURIComponent(id)}`), 'Cookie Carla', 'encoded');
    assert.strictEqual(await nameWith(`party_sid=${id}; party_sid=someone-else`), 'Cookie Carla', 'the first counts');
    assert.notStrictEqual(await nameWith(`party_sid=someone-else; party_sid=${id}`), 'Cookie Carla');
  });

  await check('scanning again keeps the session and its name; an unknown one starts afresh', async () => {
    set({ enabled: true });
    const cookie = (await get('/GuestHub')).headers.get('set-cookie').split(';')[0];
    await post('/api/name', cookie, { name: 'Rescan Ronnie', confirm: true });
    const again = (await get('/GuestHub', { Cookie: cookie })).headers.get('set-cookie').split(';')[0];
    assert.strictEqual(again, cookie, 'the same session');
    const party = await (await get('/api/party', { Cookie: again })).json();
    assert.strictEqual(party.guest_name, 'Rescan Ronnie');
    const stranger = (await get('/GuestHub', { Cookie: 'party_sid=not-a-session' })).headers.get('set-cookie').split(';')[0];
    assert.notStrictEqual(stranger, 'party_sid=not-a-session', 'a new session');
    assert.notStrictEqual(stranger, cookie);
  });

  await check('the guest page is at /GuestHub, in any case, and no longer at the root', async () => {
    for (const path of ['/GuestHub', '/guesthub']) {
      const res = await get(path);
      assert.strictEqual(res.status, 200, path);
      // Never from a cache: opening it again is how a page rejoins a party.
      assert.strictEqual(res.headers.get('cache-control'), 'no-store', path);
    }
    const html = await (await get('/', { 'Accept-Language': 'fr' })).text();
    assert.match(html, /<html lang="fr"/);
    assert.match(html, /<h1>Scannez à nouveau le code<\/h1>/);
    assert.doesNotMatch(html, /id="app"/, 'not the guest page');
  });

  console.log('\nguest page');

  await check('with no session the guest API says so, for "Scan the code again"', async () => {
    set({ enabled: true });
    const res = await get('/api/party');
    assert.strictEqual(res.status, 401);
    assert.strictEqual((await res.json()).error, 'no_session');
  });

  await check('the guest page offers the join code unless the host turned it off', async () => {
    const cookie = await newGuest();
    const party = async () => (await get('/api/party', { Cookie: cookie })).json();
    try {
      assert.strictEqual((await party()).invite, true);
      set({ guest_invite: false });
      assert.strictEqual((await party()).invite, false);
    } finally {
      set({ guest_invite: true });
    }
    const page = await (await get('/GuestHub')).text();
    assert.match(page, /id="party-chip"/);
    assert.match(page, /id="party-label"/);
    assert.match(page, /id="invite-qr"/);
  });

  await check('Party Off: the guest API says closed, for "Requests are closed", and whether the playlist is offered', async () => {
    const cookie = (await get('/GuestHub')).headers.get('set-cookie').split(';')[0];
    set({ enabled: false, playlist_download: 'qr' });
    const res = await get('/api/party', { Cookie: cookie });
    assert.strictEqual(res.status, 403);
    assert.deepStrictEqual(await res.json(), { error: 'closed', playlist: true });
    set({ playlist_download: 'link' });
    assert.strictEqual((await (await get('/api/party', { Cookie: cookie })).json()).playlist, true);
    set({ playlist_download: 'off' });
    assert.strictEqual((await (await get('/api/party', { Cookie: cookie })).json()).playlist, false);
    set({ playlist_download: 'qr' });
    const html = await (await get('/GuestHub')).text();
    assert.match(html, /<a id="closed-playlist"[^>]* href="\/Playlist" download hidden/);
  });

  await check('while the party has paused itself (its zone gone), guests are told paused', async () => {
    set({ enabled: true });
    const cookie = await newGuest();
    roon.currentMode = 'paused';
    try {
      assert.strictEqual((await (await get('/api/party', { Cookie: cookie })).json()).party_mode, 'paused');
      assert.strictEqual((await (await get('/api/hub')).json()).party_mode, 'paused');
      const res = await post('/api/request', cookie, { key: '10:0' });
      assert.strictEqual(res.status, 409);
      assert.strictEqual((await res.json()).error, 'paused');
    } finally {
      delete roon.currentMode;
    }
  });

  await check('a change of Party sends the pages the queue too, so a gone track goes', async () => {
    const controller = new AbortController();
    const res = await fetch(`${base}/api/events`, { signal: controller.signal });
    const reader = res.body.getReader();
    let text = '';
    const until = async (pattern) => {
      while (!pattern.test(text)) text += new TextDecoder().decode((await reader.read()).value);
    };
    try {
      await until(/event: queue/); // the snapshot sent on connecting
      text = '';
      roon.emit('party_mode_changed', 'paused', 'on');
      await until(/event: party[\s\S]*event: queue/);
      assert.match(text, /"party_mode":"paused"/);
      assert.match(text, /"now_playing":null/);
    } finally {
      controller.abort();
    }
  });

  await check("the first update carries an id, so a browser's own reconnect says so", async () => {
    const controller = new AbortController();
    const res = await fetch(`${base}/api/events`, { signal: controller.signal });
    const reader = res.body.getReader();
    let text = '';
    try {
      while (!/event: queue/.test(text)) text += new TextDecoder().decode((await reader.read()).value);
      assert.match(text, /^id: 1\nevent: queue\n/);
    } finally {
      controller.abort();
    }
  });

  await check('the guest page shows nothing until it knows which message is right', async () => {
    const html = await (await get('/GuestHub')).text();
    assert.match(html, /<main id="app" hidden>/);
    assert.match(html, /<div id="locked" class="locked" hidden>/);
    assert.match(html, /<div id="closed" class="locked" hidden>/);
  });

  console.log('\nrequests');

  set({ enabled: true, prevent_duplicates: true, allow_add: true, add_limit: 10, allow_skip: true, skip_limit: 1 });
  roon.ready = true;

  await check('search marks a queued track, and blocks it only when duplicates are blocked', async () => {
    const cookie = await newGuest();
    roon.queue = [{ queue_item_id: 1, two_line: { line1: 'Waterloo', line2: 'ABBA' } }];
    const search = async () => (await (await get('/api/search?q=abba', { Cookie: cookie })).json()).results;
    try {
      let [waterloo, sos] = await search();
      assert.deepStrictEqual([waterloo.in_queue, waterloo.blocked], [true, true]);
      assert.deepStrictEqual([sos.in_queue, sos.blocked], [false, false]);
      set({ prevent_duplicates: false });
      [waterloo] = await search();
      assert.deepStrictEqual([waterloo.in_queue, waterloo.blocked], [true, false]);
    } finally {
      roon.queue = [];
      set({ prevent_duplicates: true });
    }
  });

  await check('another album\'s version of a queued track isn\'t blocked, the same one is', async () => {
    results[0].image_key = 'arrival';
    roon.queue = [{ queue_item_id: 1, two_line: { line1: 'Waterloo', line2: 'ABBA' }, image_key: 'gold' }];
    try {
      let cookie = await newGuest();
      const [waterloo] = (await (await get('/api/search?q=abba', { Cookie: cookie })).json()).results;
      assert.deepStrictEqual([waterloo.in_queue, waterloo.blocked], [false, false]);
      roon.queue[0].image_key = 'arrival';
      cookie = await newGuest();
      const res = await post('/api/request', cookie, { key: '10:0', mode: 'add' });
      assert.strictEqual(res.status, 409);
      assert.strictEqual((await res.json()).error, 'already_queued');
    } finally {
      delete results[0].image_key;
      roon.queue = [];
    }
  });

  await check('a key the guest was never sent is refused, and Roon is not asked', async () => {
    const cookie = await newGuest();
    roon.actions = [];
    for (const key of ['10:7', '9:0', '', null, { toString: () => '10:0' }]) {
      const res = await post('/api/request', cookie, { key, mode: 'add' });
      assert.strictEqual(res.status, 400, JSON.stringify(key));
      assert.strictEqual((await res.json()).error, 'unknown_track');
    }
    assert.deepStrictEqual(roon.actions, []);
  });

  await check("Roon not answering a request: no second try (it may still add it), and the guest's allowance is given back", async () => {
    const cookie = await newGuest();
    const before = (await (await get('/api/party', { Cookie: cookie })).json()).allowances;
    const searches = roon.searches.length;
    const real = roon.performAction;
    let asked = 0;
    roon.performAction = async () => {
      asked += 1;
      throw new Error('Roon did not answer');
    };
    try {
      const res = await post('/api/request', cookie, { key: '10:0', mode: 'add' });
      assert.strictEqual(res.status, 502);
      assert.strictEqual((await res.json()).error, 'Roon did not answer');
      assert.strictEqual(asked, 1, 'asked once');
      assert.strictEqual(roon.searches.length, searches, 'the search was not replayed');
    } finally {
      roon.performAction = real;
    }
    assert.deepStrictEqual((await (await get('/api/party', { Cookie: cookie })).json()).allowances, before);
  });

  await check('the results of the last two searches are remembered: on screen, and on their way', () => {
    assert.strictEqual(OFFERED_SEARCHES, 2);
    const store = new GuestStore();
    const guest = store.create();
    const search = (n) => Array.from({ length: 40 }, (_, i) => ({ item_key: `${n}:${i}`, title: `Track ${n}.${i}` }));
    store.offer(guest, search(1));
    store.offer(guest, search(2));
    // A tap on the first search's results while the second is on its way.
    assert.strictEqual(store.offered(guest, '1:39').title, 'Track 1.39');
    store.offer(guest, search(3));
    assert.strictEqual(store.offered(guest, '1:0'), null);
    assert.strictEqual(store.offered(guest, '2:0').title, 'Track 2.0');
    assert.strictEqual(store.offered(guest, '3:0').title, 'Track 3.0');
  });

  await check('a rerun of the search on screen adds to it, replacing any earlier rerun', () => {
    const store = new GuestStore();
    const guest = store.create();
    store.offer(guest, [{ item_key: 'a1', title: 'On screen' }]);
    store.offer(guest, [{ item_key: 'b1', title: 'Latest' }]);
    store.offer(guest, [{ item_key: 'b2', title: 'Rerun' }], { rerun: true });
    store.offer(guest, [{ item_key: 'b3', title: 'Rerun again' }], { rerun: true });
    // Still two searches: the rerun didn't push the one before out.
    assert.deepStrictEqual(['a1', 'b1', 'b2', 'b3'].map((key) => (store.offered(guest, key) || {}).title),
      ['On screen', 'Latest', undefined, 'Rerun again']);
  });

  await check('a request is credited with the title the server sent, not what the phone says', async () => {
    const cookie = await newGuest();
    roon.actions = [];
    const res = await post('/api/request', cookie, { key: '10:1', mode: 'add', title: 'Something else', subtitle: 'Nobody' });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(roon.actions, [{ key: '10:1', mode: 'add' }]);
    const entry = guests.attributions[guests.attributions.length - 1];
    assert.strictEqual(entry.title, 'SOS');
    assert.strictEqual(entry.artist, 'ABBA');
  });

  await check('requests sent all at once get no more than the allowance', async () => {
    set({ add_limit: 2, add_refill: 0 });
    const cookie = await newGuest();
    roon.actions = [];
    const answers = await Promise.all(
      Array.from({ length: 6 }, () => post('/api/request', cookie, { key: '10:0', mode: 'add' }))
    );
    const codes = answers.map((res) => res.status).sort();
    assert.deepStrictEqual(codes, [200, 200, 429, 429, 429, 429]);
    assert.strictEqual(roon.actions.length, 2);
    set({ add_limit: 10 });
  });

  await check('scanning again does not give back allowances already used', async () => {
    set({ add_limit: 2, add_refill: 0 });
    const cookie = await newGuest();
    assert.strictEqual((await post('/api/request', cookie, { key: '10:0', mode: 'add' })).status, 200);
    // The phone takes whichever cookie the scan sets.
    const after = (await get('/GuestHub', { Cookie: cookie })).headers.get('set-cookie').split(';')[0];
    const party = await (await get('/api/party', { Cookie: after })).json();
    assert.strictEqual(party.allowances.add.remaining, 1);
    set({ add_limit: 10 });
  });

  await check('a request Roon refuses gives the allowance back', async () => {
    set({ add_limit: 2, add_refill: 0 });
    const cookie = await newGuest();
    roon.failing = true;
    const res = await post('/api/request', cookie, { key: '10:0', mode: 'add' });
    roon.failing = false;
    assert.strictEqual(res.status, 502);
    const party = await (await get('/api/party', { Cookie: cookie })).json();
    assert.strictEqual(party.allowances.add.remaining, 2);
    set({ add_limit: 10 });
  });

  await check('skips sent all at once get no more than the allowance, and a refused one comes back', async () => {
    const cookie = await newGuest();
    roon.skips = 0;
    const answers = await Promise.all(Array.from({ length: 4 }, () => post('/api/skip', cookie, {})));
    assert.deepStrictEqual(answers.map((res) => res.status).sort(), [200, 429, 429, 429]);
    assert.strictEqual(roon.skips, 1);

    const other = await newGuest();
    roon.failing = true;
    assert.strictEqual((await post('/api/skip', other, {})).status, 502);
    roon.failing = false;
    assert.strictEqual((await post('/api/skip', other, {})).status, 200);
  });

  await check('queued tracks no guest asked for are the host\'s, except Roon Radio\'s picks', async () => {
    roon.queue = [
      { queue_item_id: 21, length: 200, two_line: { line1: 'Seasons', line2: 'Bebe Rexha' } },
      { queue_item_id: 22, length: 200, two_line: { line1: 'Fernando', line2: 'ABBA' } }
    ];
    roon.radioPicks.add(21);
    try {
      const hub = await (await get('/api/hub')).json();
      assert.deepStrictEqual(hub.upcoming.map((t) => t.kind), ['radio', 'host']);
    } finally {
      roon.queue = [];
      roon.radioPicks.clear();
    }
  });

  await check('an empty Up next invites guests to add a track, and says when Roon Radio picks one', async () => {
    const zone = (state, extra) =>
      Object.assign(
        { zone_id: 'z1', state, is_seek_allowed: true, settings: { auto_radio: true }, now_playing: { length: 200, two_line: { line1: 'Seasons', line2: 'Bebe Rexha' } } },
        extra
      );
    const empty = async () => (await (await get('/api/hub')).json()).empty;
    try {
      roon.zone = zone('playing');
      assert.strictEqual(await empty(), 'queue.empty_add_radio');
      roon.zone = zone('paused');
      assert.strictEqual(await empty(), 'queue.empty_add', 'Roon Radio does not start a stopped zone');
      roon.zone = zone('playing', { settings: { auto_radio: false } });
      assert.strictEqual(await empty(), 'queue.empty_add', 'Roon Radio off');
      roon.zone = zone('playing', { is_seek_allowed: false, now_playing: { two_line: { line1: 'ABC Triple J Shift' } } });
      assert.strictEqual(await empty(), 'queue.empty_add', 'a radio station');
      roon.zone = zone('playing');
      set({ allow_add: false });
      assert.strictEqual(await empty(), 'queue.empty_add_radio', 'guests can still play a track next');
      set({ allow_add: false, allow_next: false });
      assert.strictEqual(await empty(), 'queue.empty_radio', 'guests can\'t add');
      roon.zone = zone('paused');
      assert.strictEqual(await empty(), 'queue.empty');
      set({ allow_add: true, allow_next: true, enabled: 'paused' });
      roon.zone = zone('playing');
      assert.strictEqual(await empty(), 'queue.empty', 'party paused');
    } finally {
      roon.zone = null;
      set({ allow_add: true, allow_next: true, enabled: true });
    }
  });

  await check('adding and playing next are separate choices: with adding off, play next still works', async () => {
    const cookie = await newGuest();
    try {
      set({ allow_add: false, allow_next: true });
      const party = await (await get('/api/party', { Cookie: cookie })).json();
      assert.deepStrictEqual([party.capabilities.add, party.capabilities.next], [false, true]);
      set({ allow_add: true, allow_next: false });
      const other = await (await get('/api/party', { Cookie: cookie })).json();
      assert.deepStrictEqual([other.capabilities.add, other.capabilities.next], [true, false]);
      await get('/api/search?q=abba', { Cookie: cookie });
      roon.actions = [];
      const res = await post('/api/request', cookie, { key: '10:0', mode: 'next' });
      assert.strictEqual((await res.json()).error, 'disabled');
      assert.deepStrictEqual(roon.actions, [], 'nothing reached Roon');
    } finally {
      set({ allow_add: true, allow_next: true });
    }
  });

  await check('Skip is offered only when Roon will skip: not on the last track with Roon Radio off', async () => {
    const cookie = await newGuest();
    const zone = (next) => ({ zone_id: 'z1', state: 'playing', is_seek_allowed: true, is_next_allowed: next, settings: { auto_radio: false }, now_playing: { length: 200, two_line: { line1: 'The Green Manalishi', line2: 'Fleetwood Mac' } } });
    try {
      roon.zone = zone(true);
      assert.strictEqual((await (await get('/api/hub')).json()).can_skip, true);
      roon.zone = zone(false);
      assert.strictEqual((await (await get('/api/hub')).json()).can_skip, false);
      roon.skips = 0;
      const res = await post('/api/skip', cookie, {});
      assert.strictEqual(res.status, 409);
      assert.strictEqual((await res.json()).error, 'cant_skip');
      assert.strictEqual(roon.skips, 0);
      const party = await (await get('/api/party', { Cookie: cookie })).json();
      assert.strictEqual(party.allowances.skip.remaining, 1, 'the skip is not used up');
    } finally {
      roon.zone = null;
    }
  });

  await check('a radio station shows as a station, credited to nobody, and can\'t be skipped', async () => {
    const cookie = await newGuest();
    roon.zone = {
      zone_id: 'z1',
      display_name: 'Lounge',
      state: 'playing',
      is_seek_allowed: false,
      is_next_allowed: false,
      settings: { auto_radio: true },
      now_playing: { two_line: { line1: 'ABC Triple J Shift', line2: '' }, image_key: 'jj', seek_position: 59 }
    };
    try {
      const hub = await (await get('/api/hub')).json();
      assert.strictEqual(hub.now_playing.station, true);
      assert.strictEqual(hub.now_playing.title, 'ABC Triple J Shift');
      assert.strictEqual(hub.now_playing.kind, undefined, 'not labelled Roon Radio');
      roon.skips = 0;
      const res = await post('/api/skip', cookie, {});
      assert.strictEqual(res.status, 409);
      assert.strictEqual((await res.json()).error, 'cant_skip');
      assert.strictEqual(roon.skips, 0);
      const party = await (await get('/api/party', { Cookie: cookie })).json();
      assert.strictEqual(party.allowances.skip.remaining, 1, 'the skip is not used up');
    } finally {
      roon.zone = null;
    }
  });

  await check('while the party zone is gone, its last track stays, paused, until another zone is chosen', async () => {
    const before = roon.settings.zone;
    roon.settings.zone = { output_id: 'o1', name: 'Lounge' };
    roon.zone = {
      zone_id: 'z1',
      display_name: 'Lounge',
      state: 'playing',
      settings: { auto_radio: false },
      now_playing: { length: 200, two_line: { line1: 'Seasons', line2: 'Bebe Rexha' }, image_key: 'seasons' }
    };
    try {
      assert.strictEqual((await (await get('/api/hub')).json()).now_playing.state, 'playing');
      roon.zone = null; // the device switched off
      const held = (await (await get('/api/hub')).json()).now_playing;
      assert.strictEqual(held.title, 'Seasons');
      assert.strictEqual(held.image_key, 'seasons', 'the album art stays');
      assert.strictEqual(held.state, 'paused');
      roon.settings.zone = { output_id: 'o2', name: 'Kitchen' }; // the host picks another zone
      assert.strictEqual((await (await get('/api/hub')).json()).now_playing, null);
    } finally {
      roon.zone = null;
      roon.settings.zone = before;
    }
  });

  await check('while the Core is gone, Up next stays too; with only the zone away, it is as Roon has it', async () => {
    const before = roon.settings.zone;
    const entry = (id, title) => ({ queue_item_id: id, length: 200, two_line: { line1: title, line2: 'ABBA' } });
    roon.settings.zone = { output_id: 'o1', name: 'Lounge' };
    roon.zone = { zone_id: 'z1', display_name: 'Lounge', state: 'playing', settings: {}, now_playing: entry(1, 'Waterloo') };
    roon.queue = [entry(1, 'Waterloo'), entry(2, 'SOS'), entry(3, 'Fernando')];
    roon.core = {};
    try {
      const titles = async () => (await (await get('/api/hub')).json()).upcoming.map((u) => u.title);
      assert.deepStrictEqual(await titles(), ['SOS', 'Fernando']);
      roon.zone = null; // the device switched off: Roon keeps the queue
      roon.queue = [entry(2, 'SOS')];
      assert.deepStrictEqual(await titles(), ['SOS'], "Roon's queue, as it is");
      roon.queue = [];
      assert.deepStrictEqual(await titles(), [], 'emptied in Roon: empty');
      roon.core = null; // the Core gone: no queue at all
      assert.deepStrictEqual(await titles(), ['SOS', 'Fernando'], 'the last one seen with the zone');
      roon.settings.zone = { output_id: 'o2', name: 'Kitchen' }; // the host picks another zone
      assert.deepStrictEqual(await titles(), []);
    } finally {
      roon.zone = null;
      roon.queue = [];
      delete roon.core;
      roon.settings.zone = before;
    }
  });

  await check('a very long search is cut short before it reaches Roon', async () => {
    const cookie = await newGuest();
    roon.searches = [];
    await get(`/api/search?q=${'a'.repeat(5000)}`, { Cookie: cookie });
    assert.strictEqual(roon.searches[0].length, 200);
  });

  console.log('\nnames');

  await check('line breaks and direction overrides are taken out of a name', async () => {
    const cookie = await newGuest();
    const res = await post('/api/name', cookie, { name: 'Sam\nRequest (add) from Jo' });
    assert.strictEqual((await res.json()).guest_name, 'Sam Request (add) from J');
    assert.strictEqual(cleanName('\u202Eevil\u202C Sam'), 'evil Sam');
    assert.strictEqual(cleanName('  Jo \t Bloggs '), 'Jo Bloggs');
  });

  await check('names stop at 24 characters without cutting an emoji in half', async () => {
    assert.strictEqual(cleanName(`${'a'.repeat(23)}😀😀`), `${'a'.repeat(23)}😀`);
    assert.strictEqual(cleanName(null), '');
  });

  console.log('\nsessions and headers');

  await check('sessions stop at a limit, dropping the longest idle', async () => {
    const store = new GuestStore();
    const first = store.create();
    first.seen = 0;
    for (let i = 0; i < MAX_SESSIONS + 5; i += 1) store.create();
    assert.strictEqual(store.sessions.size, MAX_SESSIONS);
    assert.strictEqual(store.get(first.id), null);
  });

  await check('pages allow only their own scripts and styles, and guest pages cannot be framed', async () => {
    for (const path of ['/', '/GuestHub', '/api/party']) {
      const res = await get(path);
      assert.match(res.headers.get('content-security-policy'), /script-src 'self'.*frame-ancestors 'none'/, path);
      assert.strictEqual(res.headers.get('x-frame-options'), 'DENY', path);
      assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff', path);
      assert.strictEqual(res.headers.get('referrer-policy'), 'no-referrer', path);
    }
  });

  await check('every page switches off camera, microphone, location and the like', async () => {
    for (const path of ['/', '/PartyHub', '/api/hub']) {
      const policy = (await get(path)).headers.get('permissions-policy');
      for (const feature of ['camera=()', 'microphone=()', 'geolocation=()']) assert.ok(policy.includes(feature), `${path}: ${policy}`);
    }
  });

  await check('other sites cannot embed the files, and the pages load only their own', async () => {
    for (const path of ['/', '/PartyHub', '/GuestHub', '/api/hub', playlistPath()]) {
      const res = await get(path);
      assert.strictEqual(res.headers.get('cross-origin-resource-policy'), 'same-origin', path);
      // Ignored over plain HTTP, with an error in the console, so not sent.
      assert.strictEqual(res.headers.get('cross-origin-opener-policy'), null, path);
      assert.strictEqual(res.headers.get('cross-origin-embedder-policy'), 'require-corp', path);
    }
  });

  await check('slow devices: limits on headers, whole requests, idle sockets and connections', async () => {
    const other = createServer(roon, new GuestStore(), { limits: { all: 0, search: 0 } });
    const listening = await other.listen(0);
    try {
      assert.strictEqual(listening.headersTimeout, 10000);
      assert.strictEqual(listening.requestTimeout, 30000);
      assert.strictEqual(listening.timeout, 60000);
      assert.strictEqual(listening.maxConnections, 2000);
      assert.deepStrictEqual(CONNECTION_LIMITS, { headersTimeout: 10000, requestTimeout: 30000, timeout: 60000, maxConnections: 2000 });
      // Headers within the request's time; streams stay inside the cap.
      assert.ok(CONNECTION_LIMITS.headersTimeout <= CONNECTION_LIMITS.requestTimeout);
      assert.ok(CONNECTION_LIMITS.maxConnections > 1000);
      // A stream's heartbeat comes well inside the idle limit.
      assert.ok(20000 * 2 < CONNECTION_LIMITS.timeout);
    } finally {
      listening.close();
    }
  });

  await check('an unknown address gets a plain 404 that keeps the security headers', async () => {
    for (const path of ['/nope', '/robots.txt', '/api/nope']) {
      const res = await get(path);
      assert.strictEqual(res.status, 404, path);
      assert.strictEqual(await res.text(), 'Not found', path);
      assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/, path);
      assert.ok(res.headers.get('permissions-policy'), path);
    }
  });

  await check('a malformed request body gets a plain 400 that names nothing', async () => {
    const cookie = await newGuest();
    const res = await fetch(`${base}/api/name`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: '{not json'
    });
    assert.strictEqual(res.status, 400);
    const text = await res.text();
    assert.strictEqual(text, 'Bad request');
    assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
  });

  await check('a POST without a body is answered as one with an empty body', async () => {
    const cookie = await newGuest();
    for (const path of ['/api/name', '/api/request']) {
      const bare = await fetch(base + path, { method: 'POST', headers: { Cookie: cookie } });
      const empty = await post(path, cookie, {});
      assert.notStrictEqual(bare.status, 500, path);
      assert.strictEqual(bare.status, empty.status, path);
      assert.deepStrictEqual(await bare.json(), await empty.json(), path);
    }
  });

  await check("Party Mode's own labels can't be a guest's name, in any language or spelling", async () => {
    const cookie = await newGuest();
    for (const name of ['Host', ' roon  RADIO ', 'anon!', 'Gastgeber', 'Hote', 'Ev sahibi', '主人', 'Radio', 'radio station', 'Radiosender', 'Rádio', 'Радио', 'ラジオ', '라디오', 'Gastgebende', 'Хозяева', 'Хозяин', '主催者', 'ホスト', 'Hostess', 'Gastgeberin', 'Hôtesse', 'Хозяйка', 'المضيفة']) {
      const res = await post('/api/name', cookie, { name, confirm: true });
      assert.strictEqual(res.status, 400, name);
      assert.strictEqual((await res.json()).error, 'name_reserved', name);
    }
    assert.strictEqual((await get('/api/party', { Cookie: cookie }).then((r) => r.json())).guest_name, '');
    // A name that only contains one is fine.
    assert.strictEqual((await post('/api/name', cookie, { name: 'Hostess Jo' })).status, 200);
    assert.strictEqual((await post('/api/name', cookie, { name: 'Radio Ga Ga' })).status, 200);
  });

  await check("the host's name reaches the pages, and guests can't take it", async () => {
    assert.strictEqual((await (await get('/api/hub')).json()).host_name, null, 'unset');
    set({ host_name: '  DJ  Stu ' });
    assert.strictEqual((await (await get('/api/hub')).json()).host_name, 'DJ Stu');
    const cookie = await newGuest();
    assert.strictEqual((await (await get('/api/queue', { Cookie: cookie })).json()).host_name, 'DJ Stu');
    for (const name of ['DJ Stu', 'dj stu!']) {
      const res = await post('/api/name', cookie, { name, confirm: true });
      assert.strictEqual(res.status, 400, name);
    }
    set({ host_name: '' });
    assert.strictEqual((await post('/api/name', cookie, { name: 'DJ Stu', confirm: true })).status, 200, 'free again once unset');
    await post('/api/name', cookie, { name: '' });
  });

  await check('a name another guest uses is asked about first, then allowed', async () => {
    const sam = await newGuest();
    const other = await newGuest();
    assert.strictEqual((await post('/api/name', sam, { name: 'Sam' })).status, 200);
    for (const name of ['Sam', 'sam.', 'S A M']) {
      const res = await post('/api/name', other, { name });
      assert.strictEqual(res.status, 409, name);
      assert.deepStrictEqual(await res.json(), { error: 'name_taken', name }, name);
    }
    assert.strictEqual((await get('/api/party', { Cookie: other }).then((r) => r.json())).guest_name, '', 'not taken yet');
    const res = await post('/api/name', other, { name: 'Sam', confirm: true });
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await res.json()).guest_name, 'Sam');
    // Saving your own name again isn't a clash, and nor is having none.
    assert.strictEqual((await post('/api/name', sam, { name: 'Sam' })).status, 409, 'two Sams now: the first is asked too');
    assert.strictEqual((await post('/api/name', sam, { name: '' })).status, 200);
    assert.strictEqual((await post('/api/name', sam, { name: 'Sam', confirm: true })).status, 200);
  });

  await check('a guest action sent from another site is refused, before anything happens', async () => {
    const cookie = await newGuest();
    const send = (origin) =>
      fetch(`${base}/api/name`, {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json', Cookie: cookie }, origin && { Origin: origin }),
        body: JSON.stringify({ name: 'Mallory' })
      });
    for (const origin of ['http://192.0.2.66:8338', 'null', 'not a url']) {
      const res = await send(origin);
      assert.strictEqual(res.status, 403, origin);
      assert.deepStrictEqual(await res.json(), { error: 'cross_origin' }, origin);
    }
    assert.strictEqual((await get('/api/party', { Cookie: cookie }).then((r) => r.json())).guest_name, '', 'name unchanged');
    // The page's own origin, and no Origin at all (not a browser), still work.
    assert.strictEqual((await send(base)).status, 200);
    assert.strictEqual((await send(null)).status, 200);
  });

  await check('album art Roon never answers for gives up instead of hanging', async () => {
    let asked = 0;
    const silent = { imageSvc: { get_image() { asked++; } }, artCache: new ArtCache(), artKeys: new KnownKeys() };
    silent.artKeys.note([{ image_key: 'unknown' }]);
    const started = Date.now();
    await assert.rejects(RoonService.prototype.getImage.call(silent, 'unknown', 200, 50), /did not answer/);
    assert.ok(Date.now() - started < 1000);
    // Not kept: the next request asks the Core again.
    await assert.rejects(RoonService.prototype.getImage.call(silent, 'unknown', 200, 50), /did not answer/);
    assert.strictEqual(asked, 2);
  });

  await check('album art comes from the Core once per image and size, then from memory', async () => {
    const asked = [];
    const core = {
      imageSvc: { get_image: (key, opts, cb) => { asked.push(`${key}@${opts.width}`); setTimeout(() => cb(false, 'image/jpeg', Buffer.from(key)), 10); } },
      artCache: new ArtCache(),
      artKeys: new KnownKeys()
    };
    core.artKeys.note([{ image_key: 'cover' }]);
    const get = (key, size) => RoonService.prototype.getImage.call(core, key, size);
    // Phones asking at the same moment share one fetch.
    const together = await Promise.all([get('cover', 200), get('cover', 200), get('cover', 200)]);
    assert.ok(together.every((image) => image.body.toString() === 'cover'));
    await get('cover', 200);
    await get('cover', 400);
    assert.deepStrictEqual(asked, ['cover@200', 'cover@400']);
  });

  await check('album art is fetched only for image keys the Core has sent', async () => {
    let asked = 0;
    const core = Object.assign(Object.create(RoonService.prototype), {
      core: { services: { RoonApiImage: { get_image: (key, opts, cb) => { asked++; cb(false, 'image/jpeg', Buffer.from(key)); } } } },
      artCache: new ArtCache(),
      artKeys: new KnownKeys(),
      _inSession: (sessionKey, fn) => Promise.resolve().then(fn),
      _search: async () => [{ item_key: 'k1', title: 'Waterloo', image_key: 'found' }]
    });
    // A made-up key is refused at once, without asking the Core, which would
    // never answer it.
    await assert.rejects(core.getImage('made-up', 200), /unknown_image/);
    assert.strictEqual(asked, 0);
    // A search result's art is fetched once the results have gone to the page.
    await core.search('guest', 'waterloo');
    assert.strictEqual((await core.getImage('found', 200)).body.toString(), 'found');
    assert.strictEqual(asked, 1);
  });

  await check("the pages' own files, after the routes, still come with the security headers", async () => {
    for (const [file, type] of [['/guest.js', /javascript/], ['/party.css', /css/], ['/i18n/de.json', /json/], ['/hub.html', /html/]]) {
      const res = await get(file);
      assert.strictEqual(res.status, 200, file);
      assert.match(res.headers.get('content-type'), type, file);
      assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff', file);
    }
    // Routes still answer first, and anything else is Not found.
    assert.strictEqual((await get('/api/hub')).status, 200);
    assert.strictEqual((await get('/GuestHub')).status, 200);
    const missing = await get('/no-such-file.js');
    assert.strictEqual(missing.status, 404);
    assert.strictEqual(await missing.text(), 'Not found');
  });

  await check('every page has the icon, for tabs, bookmarks and home screens', async () => {
    for (const page of ['/GuestHub', '/PartyHub', '/']) {
      const html = await (await get(page)).text();
      for (const link of ['rel="icon" href="/favicon.ico"', 'rel="icon" href="/icon.svg"',
        'rel="apple-touch-icon" href="/apple-touch-icon.png"', 'rel="manifest" href="/manifest.webmanifest"']) {
        assert.ok(html.includes(link), `${page}: ${link}`);
      }
    }
    for (const [file, type] of [['/favicon.ico', /icon/], ['/icon.svg', /svg/], ['/apple-touch-icon.png', /png/],
      ['/icon-192.png', /png/], ['/icon-512.png', /png/], ['/manifest.webmanifest', /manifest\+json/]]) {
      const res = await get(file);
      assert.strictEqual(res.status, 200, file);
      assert.match(res.headers.get('content-type'), type, file);
    }
    const manifest = await (await get('/manifest.webmanifest')).json();
    for (const icon of manifest.icons) assert.strictEqual((await get(icon.src)).status, 200, icon.src);
  });

  await check('the QR codes under /embed/ can be shown on any site, in a frame or as an image', async () => {
    set({ enabled: false, playlist_download: 'qr' });
    // The codes carry /GuestHub and /Playlist, never the secret addresses.
    const qrOf = (url) => qr.svg(url);
    const origin = new URL(server.guestUrl()).origin;
    assert.strictEqual(server.guestUrl(), `${origin}/GuestHub`);
    assert.strictEqual(await (await get('/embed/join-qr.svg')).text(), await qrOf(`${origin}/GuestHub`));
    assert.strictEqual(await (await get('/embed/playlist-qr.svg')).text(), await qrOf(`${origin}/Playlist`));
    for (const path of ['/embed/join-qr.svg', '/Embed/Join-QR.svg', '/embed/playlist-qr.svg']) {
      const res = await get(path);
      assert.strictEqual(res.status, 200, path);
      assert.match(res.headers.get('content-type'), /image\/svg\+xml/, path);
      assert.strictEqual(res.headers.get('cache-control'), 'no-store', path);
      assert.strictEqual(res.headers.get('cross-origin-resource-policy'), 'cross-origin', path);
      assert.doesNotMatch(res.headers.get('content-security-policy'), /frame-ancestors/, path);
      assert.strictEqual(res.headers.get('x-frame-options'), null, path);
    }
    set({ enabled: true });
  });

  await check('/GuestHub lets a guest in when opened, during the party', async () => {
    set({ enabled: true });
    const open = { 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate' };
    const cookieOf = (res) => (res.headers.get('set-cookie') || '').split(';')[0];
    let res = await get('/GuestHub', open);
    assert.strictEqual(res.status, 200);
    const cookie = cookieOf(res);
    assert.match(cookie, /^party_sid=/);
    // Opening it again keeps the session; so does a browser that sends no Sec-Fetch-Dest.
    assert.strictEqual(cookieOf(await get('/GuestHub', Object.assign({ Cookie: cookie }, open))), cookie);
    assert.match(cookieOf(await get('/GuestHub')), /^party_sid=/);
    // One that ran out, or from an earlier party, gets a new one.
    assert.notStrictEqual(cookieOf(await get('/GuestHub', Object.assign({ Cookie: 'party_sid=gone' }, open))), cookie);
    // Another site's image, frame or fetch makes none.
    const before = guests.sessions.size;
    for (const dest of ['image', 'iframe', 'empty', 'script']) {
      res = await get('/GuestHub', { 'Sec-Fetch-Dest': dest });
      assert.strictEqual(res.headers.get('set-cookie'), null, dest);
    }
    assert.strictEqual(guests.sessions.size, before);
    // Paused lets guests in to look around; Off makes no session.
    set({ enabled: 'paused' });
    assert.match(cookieOf(await get('/GuestHub', open)), /^party_sid=/);
    set({ enabled: false });
    res = await get('/GuestHub', open);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('set-cookie'), null, 'Off');
    set({ enabled: true });
  });

  await check('/embed/join and /embed/playlist are gone: /GuestHub and /Playlist instead', async () => {
    set({ enabled: false, playlist_download: 'link' });
    for (const path of ['/embed/join', '/embed/playlist']) assert.strictEqual((await get(path)).status, 404, path);
    set({ enabled: true, playlist_download: 'qr' });
  });

  await check('a QR code is made once per address, and a new address gets a new one', async () => {
    const calls = [];
    const original = qr.svg;
    qr.svg = (...args) => { calls.push(args[0]); return original(...args); };
    try {
      const first = await (await get('/embed/join-qr.svg')).text();
      assert.match(first, /^<svg/);
      for (let i = 0; i < 5; i += 1) assert.strictEqual(await (await get('/embed/join-qr.svg')).text(), first);
      assert.ok(calls.length <= 1, `made ${calls.length} times`);
      set({ enabled: false, playlist_download: 'qr' });
      assert.notStrictEqual(await (await get('/embed/playlist-qr.svg')).text(), first);
      set({ enabled: true });
    } finally {
      qr.svg = original;
    }
  });

  await check("/embed/status.json: any site may read the party's state, and nothing more", async () => {
    for (const [values, party] of [[{ enabled: true }, 'on'], [{ enabled: false }, 'off']]) {
      set(values);
      const res = await get('/embed/status.json');
      assert.strictEqual(res.headers.get('access-control-allow-origin'), '*');
      assert.strictEqual(res.headers.get('access-control-allow-credentials'), null);
      assert.strictEqual(res.headers.get('cache-control'), 'no-store');
      assert.strictEqual(res.headers.get('cross-origin-resource-policy'), 'cross-origin');
      const status = await res.json();
      assert.deepStrictEqual(Object.keys(status), ['party', 'party_name', 'host_name', 'ready', 'playlist', 'language', 'roon_radio']);
      assert.strictEqual(status.roon_radio, false, 'no zone');
      assert.strictEqual(status.party, party);
      assert.strictEqual(status.party_name, 'Test Party');
      // How the playlist is offered only once the party's over, and never its address.
      assert.strictEqual(status.playlist, party === 'off' ? 'qr' : null);
    }
    roon.currentMode = 'paused';
    assert.strictEqual((await (await get('/embed/status.json')).json()).party, 'paused');
    delete roon.currentMode;
    set({ enabled: true });
    // The extension's own addresses stay unreadable to other sites.
    assert.strictEqual((await get('/api/hub')).headers.get('access-control-allow-origin'), null);
  });

  await check('/embed/: playing now, up next and played, with credits and covers, and no address', async () => {
    roon.zone = {
      zone_id: 'z1', state: 'playing', is_seek_allowed: true, settings: { auto_radio: true },
      now_playing: { length: 200, seek_position: 42, image_key: 'cover-now', three_line: { line1: 'Seasons', line2: 'Bebe Rexha', line3: 'Better Mistakes' } }
    };
    roon.queue = [
      { queue_item_id: 21, length: 180, image_key: 'cover-21', two_line: { line1: 'Fernando', line2: 'ABBA' } },
      { queue_item_id: 22, length: 240, two_line: { line1: 'Chiquitita', line2: 'ABBA' } }
    ];
    roon.radioPicks.add(21);
    set({ host_name: 'Sam' });
    try {
      const before = Date.now();
      const playing = await (await get('/embed/now-playing.json')).json();
      assert.deepStrictEqual(Object.keys(playing), ['track']);
      assert.deepStrictEqual(Object.keys(playing.track),
        ['title', 'artist', 'album', 'length', 'art', 'credit', 'queued_at', 'state', 'station', 'seek_position', 'at']);
      assert.deepStrictEqual([playing.track.title, playing.track.album, playing.track.state, playing.track.seek_position],
        ['Seasons', 'Better Mistakes', 'playing', 42]);
      assert.strictEqual(playing.track.art, '/embed/art/cover-now');
      assert.ok(playing.track.at >= before && playing.track.at <= Date.now());
      assert.deepStrictEqual(playing.track.credit, { kind: 'host', name: 'Sam', how: null });
      // Roon Radio on in the party zone.
      assert.strictEqual((await (await get('/embed/status.json')).json()).roon_radio, true);

      const next = await (await get('/embed/up-next.json')).json();
      assert.deepStrictEqual(Object.keys(next), ['tracks', 'empty']);
      assert.deepStrictEqual(next.tracks.map((t) => [t.title, t.credit]),
        [['Fernando', { kind: 'radio', name: null, how: null }], ['Chiquitita', { kind: 'host', name: 'Sam', how: null }]]);
      assert.deepStrictEqual(Object.keys(next.tracks[0]), ['title', 'artist', 'album', 'length', 'art', 'credit', 'queued_at']);
      assert.strictEqual(next.tracks[1].art, null);

      const played = await (await get('/embed/played.json')).json();
      assert.deepStrictEqual(Object.keys(played), ['tracks']);

      // Nothing any site could use to join, find the playlist or the speaker.
      for (const path of ['/embed/status.json', '/embed/now-playing.json', '/embed/up-next.json', '/embed/played.json']) {
        const text = await (await get(path)).text();
        assert.ok(!/\/j\/|\/p\/|http|z1|queue_item|guest"/.test(text), `${path}: ${text}`);
      }

      roon.queue = [];
      assert.strictEqual((await (await get('/embed/up-next.json')).json()).empty, 'add_radio');
      // The zone gone: the last track stays, paused, as on the Hub.
      roon.zone = null;
      const held = (await (await get('/embed/now-playing.json')).json()).track;
      assert.deepStrictEqual([held.title, held.state], ['Seasons', 'paused']);
    } finally {
      roon.zone = null;
      roon.queue = [];
      roon.radioPicks.clear();
      set({ host_name: '' });
    }
  });

  await check("/embed/: a guest's track is credited by the name they gave, or none", async () => {
    const { credit } = require('../lib/embed');
    assert.deepStrictEqual(credit({ kind: 'add', requested_by: 'Alex' }), { kind: 'guest', name: 'Alex', how: 'add' });
    assert.deepStrictEqual(credit({ kind: 'next', requested_by: null }), { kind: 'guest', name: null, how: 'next' });
    assert.deepStrictEqual(credit({ kind: 'host' }, ''), { kind: 'host', name: null, how: null });
    assert.strictEqual(credit({ kind: 'add', station: true }), null);
    assert.strictEqual(credit(null), null);
    // Internal references never go out.
    assert.deepStrictEqual(Object.keys(credit({ kind: 'add', requested_by: 'Alex', guest: 'g1' })), ['kind', 'name', 'how']);
    // Who skipped a played track: a guest by name (or none), or the host in Roon.
    const { skippedBy, played } = require('../lib/embed');
    assert.strictEqual(skippedBy({ skipped: false }), null);
    assert.deepStrictEqual(skippedBy({ skipped: true, skipped_by: 'Alex' }), { kind: 'guest', name: 'Alex' });
    assert.deepStrictEqual(skippedBy({ skipped: true, skipped_by: null }), { kind: 'guest', name: null });
    assert.deepStrictEqual(skippedBy({ skipped: true, skipped_by: null, skipped_by_host: true }, 'Sam'), { kind: 'host', name: 'Sam' });
    const [one] = played([{ title: 'SOS', length: 200, queued_at: 1, played_at: 2, skipped: true, skipped_by: 'Alex',
      skipped_guest: 'g1', requested_guest: 'g2', kind: 'add', requested_by: 'Bo' }]).tracks;
    assert.deepStrictEqual(Object.keys(one),
      ['title', 'artist', 'album', 'length', 'art', 'credit', 'queued_at', 'played_at', 'skipped', 'skipped_by']);
    assert.deepStrictEqual([one.queued_at, one.played_at, one.credit.name], [1, 2, 'Bo']);
  });

  await check('/embed/art: covers at the kept sizes only, from any site', async () => {
    const asked = [];
    roon.getImage = async (key, size) => {
      asked.push(size);
      if (key !== 'known') throw new Error('unknown_image');
      return { contentType: 'image/jpeg', body: Buffer.from('jpeg') };
    };
    try {
      const res = await get('/embed/art/known?size=120');
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.headers.get('cross-origin-resource-policy'), 'cross-origin');
      await get('/embed/art/known?size=777');
      await get('/embed/art/known');
      await get('/embed/art/known?size=800');
      assert.deepStrictEqual(asked, [120, 400, 400, 800]);
      assert.strictEqual((await get('/embed/art/unknown')).status, 404);
    } finally {
      delete roon.getImage;
    }
  });

  await check('/embed/events: the four views at once, then what changes; from any site', async () => {
    const controller = new AbortController();
    const res = await fetch(`${base}/embed/events`, { signal: controller.signal });
    assert.strictEqual(res.headers.get('access-control-allow-origin'), '*');
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const until = async (pattern) => {
      const stop = Date.now() + 2000;
      while (!pattern.test(text) && Date.now() < stop) {
        const { value, done } = await Promise.race([reader.read(), new Promise((r) => setTimeout(() => r({}), 200))]);
        if (done) break;
        if (value) text += decoder.decode(value);
      }
      return pattern.test(text);
    };
    try {
      assert.ok(await until(/event: played\n/), text);
      for (const event of ['status', 'now-playing', 'up-next', 'played']) assert.ok(text.includes(`event: ${event}\n`), event);
      assert.ok(!text.includes('/j/'));
      // A change: only the view that changed is sent.
      text = '';
      roon.queue = [{ queue_item_id: 31, length: 200, two_line: { line1: 'Waterloo', line2: 'ABBA' } }];
      roon.emit('queue_changed');
      assert.ok(await until(/event: up-next\n.*Waterloo/s), text);
      assert.ok(!text.includes('event: status'), 'status unchanged, not sent');
      const about = await (await get('/About')).text();
      assert.match(about, /<th scope="row">Custom Party Hub pages<\/th><td>1 open<\/td>/);
    } finally {
      controller.abort();
      roon.queue = [];
    }
  });

  await check('the Party Hub can be shown inside a dashboard', async () => {
    const res = await get('/PartyHub');
    assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
    assert.doesNotMatch(res.headers.get('content-security-policy'), /frame-ancestors/);
    assert.strictEqual(res.headers.get('x-frame-options'), null);
  });

  await check("with Roon Display, the Hub may frame Roon's site alone, without require-corp", async () => {
    set({ hub_playing: 'roon' });
    roon.coreAddress = { host: '192.0.2.10', port: 9330 };
    try {
      const hub = await get('/PartyHub');
      assert.match(hub.headers.get('content-security-policy'), /; frame-src http:\/\/192\.0\.2\.10:9330$/);
      assert.strictEqual(hub.headers.get('cross-origin-embedder-policy'), null);
      assert.strictEqual((await (await get('/api/hub')).json()).frame_url, 'http://192.0.2.10:9330/display/');
      // Every other page is as it was.
      const guest = await get('/GuestHub');
      assert.doesNotMatch(guest.headers.get('content-security-policy'), /frame-src/);
      assert.strictEqual(guest.headers.get('cross-origin-embedder-policy'), 'require-corp');
      set({ hub_playing: 'simple' });
      assert.doesNotMatch((await get('/PartyHub')).headers.get('content-security-policy'), /frame-src/);
      assert.strictEqual((await (await get('/api/hub')).json()).frame_url, null);
    } finally {
      delete roon.coreAddress;
      set({ hub_playing: 'simple' });
    }
  });

  await check('a screen can choose its view in the address, whatever the setting', async () => {
    roon.coreAddress = { host: '192.0.2.10', port: 9330 };
    const frameOf = async (query) => (await (await get(`/api/hub${query}`)).json()).frame_url;
    try {
      for (const setting of ['simple', 'roon']) {
        set({ hub_playing: setting });
        // /PartyHub/Roon frames Roon's page; /PartyHub/Standard never does.
        for (const path of ['/PartyHub/Roon', '/partyhub/roon', '/PartyHub/Roon/']) {
          const res = await get(path);
          assert.strictEqual(res.status, 200, path);
          assert.match(res.headers.get('content-security-policy'), /; frame-src http:\/\/192\.0\.2\.10:9330$/, path);
          assert.doesNotMatch(res.headers.get('content-security-policy'), /frame-ancestors/, `${path} can be framed`);
          assert.strictEqual(res.headers.get('cross-origin-embedder-policy'), null, path);
          assert.match(await res.text(), /<html lang="[^"]+" dir="(ltr|rtl)" data-view="roon">/, path);
        }
        const standard = await get('/PartyHub/Standard');
        assert.strictEqual(standard.status, 200);
        assert.doesNotMatch(standard.headers.get('content-security-policy'), /frame-src|frame-ancestors/);
        assert.match(await standard.text(), /data-view="standard"/);
        assert.strictEqual(await frameOf('?view=roon'), 'http://192.0.2.10:9330/display/', setting);
        assert.strictEqual(await frameOf('?view=standard'), null, setting);
        // No view, or one it doesn't know: the setting's.
        for (const query of ['', '?view=nope']) {
          assert.strictEqual(await frameOf(query), setting === 'roon' ? 'http://192.0.2.10:9330/display/' : null, `${setting} ${query}`);
        }
        assert.doesNotMatch(await (await get('/PartyHub')).text(), /data-view/);
      }
      // Only those views: anything else under /PartyHub isn't a page.
      for (const path of ['/PartyHub/nope', '/PartyHub/Roon/x', '/PartyHub/simple']) assert.strictEqual((await get(path)).status, 404, path);
    } finally {
      delete roon.coreAddress;
      set({ hub_playing: 'simple' });
    }
  });

  await check('the basic Party Hub: at /PartyHub/Basic, and at /PartyHub with the Basic view', async () => {
    roon.coreAddress = { host: '192.0.2.10', port: 9330 };
    try {
      for (const setting of ['simple', 'roon', 'basic']) {
        set({ hub_playing: setting });
        for (const path of ['/PartyHub/Basic', '/partyhub/basic']) {
          const res = await get(path);
          assert.strictEqual(res.status, 200, path);
          const html = await res.text();
          assert.match(html, /<script src="\/basic\.js"><\/script>/, path);
          assert.match(html, /<html lang="[^"]+" dir="(ltr|rtl)" data-view="basic">/, path);
          assert.doesNotMatch(res.headers.get('content-security-policy'), /frame-src|frame-ancestors/, `${path} frames nothing, and can be framed`);
        }
        assert.strictEqual((await (await get('/api/hub?view=basic')).json()).frame_url, null, setting);
        // Plain /PartyHub: the basic page with the Basic view, else the Party Hub.
        const plain = await (await get('/PartyHub')).text();
        assert.strictEqual(plain.includes('/basic.js'), setting === 'basic', setting);
      }
      assert.strictEqual((await (await get('/api/hub')).json()).frame_url, null, 'Basic frames nothing');
      // The Party Hub sends a browser too old for it there, before anything else loads.
      const hub = await (await get('/PartyHub/Standard')).text();
      assert.ok(hub.indexOf('<script src="/hub-check.js"></script>') < hub.indexOf('<link rel="stylesheet"'));
      assert.match(await (await get('/hub-check.js')).text(), /location\.replace\('\/PartyHub\/Basic'\)/);
    } finally {
      delete roon.coreAddress;
      set({ hub_playing: 'simple' });
    }
  });

  await check('the Hub is told when Roon sent all the queue it would: there may be more', async () => {
    const before = roon.queue;
    try {
      const { QUEUE_ITEMS } = require('../lib/roon-service');
      const item = (i) => ({ queue_item_id: i, length: 200, image_key: null, one_line: { line1: `T${i}` }, two_line: { line1: `T${i}`, line2: 'A' }, three_line: { line1: `T${i}`, line2: 'A', line3: 'B' } });
      roon.queue = Array.from({ length: 3 }, (v, i) => item(i));
      assert.strictEqual((await (await get('/api/hub')).json()).queue_full, false);
      roon.queue = Array.from({ length: QUEUE_ITEMS }, (v, i) => item(i));
      const hub = await (await get('/api/hub')).json();
      assert.strictEqual(hub.queue_full, true);
      assert.ok(hub.upcoming.length >= QUEUE_ITEMS - 1);
    } finally {
      roon.queue = before;
    }
  });

  await check('the scripts old TV browsers run are plain ES5', async () => {
    const fs = require('fs');
    const path = require('path');
    for (const file of ['basic.js', 'hub-check.js', 'i18n-runtime.js']) {
      const code = fs.readFileSync(path.join(__dirname, '..', 'public', file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').replace(/'(?:[^'\\\n]|\\.)*'/g, "''");
      for (const [feature, pattern] of [['arrow functions', /=>/], ['let or const', /\b(let|const)\s/], ['template strings', /`/],
        ['classes', /\bclass\s+\w/], ['async', /\basync\s/], ['for...of', /\bfor\s*\([^)]*\bof\b/], ['spread', /\.\.\./]]) {
        assert.doesNotMatch(code, pattern, `${file}: ${feature}`);
      }
    }
  });

  await check("Roon's display page is checked while a screen shows it by its address, whatever the setting", async () => {
    const page = http.createServer((req, res) => res.end('ok'));
    await new Promise((resolve) => page.listen(0, '127.0.0.1', resolve));
    const frameOk = async () => (await (await get('/api/hub?view=roon')).json()).frame_ok;
    try {
      set({ hub_playing: 'simple' });
      roon.coreAddress = { host: '127.0.0.1', port: page.address().port };
      roon.emit('core_paired');
      let ok = await frameOk();
      for (let i = 0; i < 50 && ok !== true; i += 1) {
        await new Promise((r) => setTimeout(r, 20));
        ok = await frameOk();
      }
      assert.strictEqual(ok, true);
    } finally {
      await new Promise((resolve) => page.close(resolve));
      delete roon.coreAddress;
      set({ hub_playing: 'simple' });
      roon.emit('settings_changed');
    }
  });

  await check("Roon's display page is at the Core's address; a Core on this computer at this one's", async () => {
    set({ hub_playing: 'roon' });
    try {
      assert.strictEqual((await (await get('/api/hub')).json()).frame_url, null, 'no Core found yet');
      roon.coreAddress = { host: '127.0.0.1', port: 9330 };
      assert.strictEqual(server.roonDisplayUrl(), `http://${lanAddress()}:9330/display/`, 'for the Hub');
      assert.strictEqual(server.roonDisplayUrl(false), 'http://127.0.0.1:9330/display/', 'for Party Mode');
    } finally {
      delete roon.coreAddress;
      set({ hub_playing: 'simple' });
    }
  });

  await check("the Hub is told whether Roon's display page answers", async () => {
    const page = http.createServer((req, res) => res.end('ok'));
    await new Promise((resolve) => page.listen(0, '127.0.0.1', resolve));
    const frameOk = async () => (await (await get('/api/hub')).json()).frame_ok;
    const settled = async (want) => {
      for (let i = 0; i < 50 && (await frameOk()) !== want; i += 1) await new Promise((r) => setTimeout(r, 20));
      return frameOk();
    };
    try {
      set({ hub_playing: 'roon' });
      // A Core on this computer: Party Mode checks it at 127.0.0.1.
      roon.coreAddress = { host: '127.0.0.1', port: page.address().port };
      roon.emit('core_paired');
      assert.strictEqual(await settled(true), true);
      await new Promise((resolve) => page.close(resolve));
      roon.emit('settings_changed');
      assert.strictEqual(await settled(false), false, 'nothing answers');
    } finally {
      delete roon.coreAddress;
      set({ hub_playing: 'simple' });
      roon.emit('settings_changed');
    }
    assert.strictEqual(await frameOk(), null);
  });

  console.log('\nParty Hub');

  await check("the Party Hub's menu links to the About page, in a new tab", async () => {
    const html = await (await get('/PartyHub')).text();
    assert.ok(html.includes('<a href="/About" target="_blank" rel="noopener" lang="en" dir="ltr">About Party Mode</a>'));
  });

  await check('the Party Hub is at /PartyHub, in any case', async () => {
    for (const path of ['/PartyHub', '/partyhub']) {
      const res = await get(path);
      assert.strictEqual(res.status, 200, path);
      assert.match(await res.text(), /<script src="\/hub\.js"><\/script>/, path);
    }
    assert.ok(server.hubUrl().endsWith('/PartyHub'));
  });

  await check('the Party Hub language setting wins over the browser, and only for the Hub', async () => {
    const french = { 'Accept-Language': 'fr' };
    try {
      set({ hub_language: 'de' });
      assert.match(await (await get('/PartyHub', french)).text(), /<html lang="de"/);
      assert.match(await (await get('/i18n.js?for=hub', french)).text(), /"lang":"de"/);
      assert.strictEqual((await (await get('/api/hub', french)).json()).language, 'de');
      assert.match(await (await get('/i18n.js', french)).text(), /"lang":"fr"/, 'guest pages follow the phone');
      set({ hub_language: '' });
      assert.match(await (await get('/PartyHub', french)).text(), /<html lang="fr"/, 'Automatic follows the browser');
      assert.strictEqual((await (await get('/api/hub', french)).json()).language, 'fr');
    } finally {
      set({ hub_language: '' });
    }
  });

  await check("the Hub's title is the party's name, before any script runs", async () => {
    roon.pageName = 'Kate & Sam <3 $& Co';
    const en = await (await get('/PartyHub')).text();
    assert.match(en, /<title>Kate &#38; Sam &#60;3 \$&#38; Co Hub<\/title>/);
    const fr = await (await get('/partyhub', { 'Accept-Language': 'fr' })).text();
    assert.match(fr, /<html lang="fr" dir="ltr">/);
    const he = await (await get('/PartyHub', { 'Accept-Language': 'he-IL' })).text();
    assert.match(he, /<html lang="he" dir="rtl">/);
    roon.pageName = '';
    const unnamed = await (await get('/PartyHub', { 'Accept-Language': 'nl' })).text();
    assert.match(unnamed, /<title>Feest Hub<\/title>/);
    roon.pageName = 'Test Party';
  });

  await check("the page's text follows a language the guest chose", async () => {
    const chosen = await (await get('/i18n.js', { 'Accept-Language': 'fr', Cookie: 'party_lang=ko' })).text();
    assert.match(chosen, /"lang":"ko"/);
    assert.match(chosen, /"chosen":true/);
    const browser = await (await get('/i18n.js', { 'Accept-Language': 'fr' })).text();
    assert.match(browser, /"lang":"fr"/);
    assert.match(browser, /"chosen":false/);
  });

  await check('the old RoonParty address and its data still work', async () => {
    for (const path of ['/roonparty', '/roonparty.html']) {
      const res = await get(path);
      assert.strictEqual(res.status, 301, path);
      assert.strictEqual(res.headers.get('location'), '/PartyHub', path);
    }
    const old = await get('/api/roonparty');
    assert.strictEqual(old.status, 200);
    assert.ok('party_mode' in (await old.json()));
  });

  console.log('\nrate limits');

  await check('one device past the per-minute limit is told to wait, with the usual headers', async () => {
    const limited = createServer(roon, new GuestStore(), { limits: { all: 5, search: 0 } });
    await limited.listen(0);
    const url = `http://127.0.0.1:${limited.port}/api/hub`;
    const codes = [];
    for (let i = 0; i < 7; i += 1) codes.push((await fetch(url)).status);
    assert.deepStrictEqual(codes, [200, 200, 200, 200, 200, 429, 429]);
    const res = await fetch(url);
    assert.deepStrictEqual(await res.json(), { error: 'too_many_requests' });
    assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
    assert.ok(res.headers.get('retry-after'), 'says when to try again');
  });

  await check('searches have a lower limit of their own', async () => {
    const store = new GuestStore();
    const limited = createServer(roon, store, { limits: { all: 0, search: 2 } });
    await limited.listen(0);
    const at = `http://127.0.0.1:${limited.port}`;
    const cookie = (await fetch(`${at}/GuestHub`, { redirect: 'manual' })).headers.get('set-cookie').split(';')[0];
    const search = () => fetch(`${at}/api/search?q=abba`, { headers: { Cookie: cookie } }).then((r) => r.status);
    assert.deepStrictEqual([await search(), await search(), await search()], [200, 200, 429]);
    assert.strictEqual((await fetch(`${at}/api/party`, { headers: { Cookie: cookie } })).status, 200, 'the rest still work');
  });

  await check('live-update streams are capped per device, in step with Flood protection', async () => {
    const open = async (at, n) => {
      const streams = [];
      for (let i = 0; i < n; i += 1) {
        const controller = new AbortController();
        const res = await fetch(`${at}/api/events`, { signal: controller.signal });
        streams.push({ status: res.status, res, close: () => controller.abort() });
      }
      return streams;
    };
    const closeAll = (streams) => streams.forEach((s) => s.close());

    // 600 a minute: 10 per device; the next is refused, not an older one closed.
    const normal = createServer(roon, new GuestStore(), { limits: { all: 600, search: 0 } });
    await normal.listen(0);
    const at = `http://127.0.0.1:${normal.port}`;
    const streams = await open(at, 11);
    assert.deepStrictEqual(streams.map((s) => s.status), [...Array(10).fill(200), 429]);
    assert.deepStrictEqual(await streams[10].res.json(), { error: 'too_many_streams' });
    // One closes: there's room for another.
    streams[0].close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const [again] = await open(at, 1);
    assert.strictEqual(again.status, 200);
    closeAll([...streams, again]);

    // No limit (0): no cap per device.
    const off = createServer(roon, new GuestStore(), { limits: { all: 0, search: 0 } });
    await off.listen(0);
    const many = await open(`http://127.0.0.1:${off.port}`, 15);
    assert.ok(many.every((s) => s.status === 200));
    closeAll(many);
  });

  await check('the Request limits setting applies at once, and 0 is no limit', async () => {
    // No limits passed in, so the server follows the setting (roon.requestLimits).
    const settingRoon = Object.create(roon);
    settingRoon.requestLimits = { all: 3, search: 0 };
    const limited = createServer(settingRoon, new GuestStore());
    await limited.listen(0);
    const url = `http://127.0.0.1:${limited.port}/api/hub`;
    const codes = [];
    for (let i = 0; i < 4; i += 1) codes.push((await fetch(url)).status);
    assert.deepStrictEqual(codes, [200, 200, 200, 429]);
    // Raised in Roon: the same device gets through straight away.
    settingRoon.requestLimits = { all: 10, search: 0 };
    assert.strictEqual((await fetch(url)).status, 200);
    // Off: no limit at all.
    settingRoon.requestLimits = { all: 0, search: 0 };
    const more = [];
    for (let i = 0; i < 15; i += 1) more.push((await fetch(url)).status);
    assert.ok(more.every((code) => code === 200), more.join(','));
  });

  console.log('about');

  await check('the About page offers the Party Hub only once connected to Roon, and says how to enable it', async () => {
    const top = async () => {
      const html = await (await get('/About')).text();
      return {
        note: (html.match(/<p class="not-connected" role="status">([^<]*)<\/p>/) || [])[1] || null,
        button: html.includes('<a class="pill pill-primary open-hub" href="/PartyHub">Open the Party Hub</a>')
      };
    };
    try {
      assert.deepStrictEqual(await top(), {
        note: 'Not connected to Roon, or not enabled yet. With Roon running on the same network as Party Mode, open Settings → Extensions in Roon and enable Party Mode, then refresh this page.',
        button: false
      });
      roon.core = {};
      assert.deepStrictEqual(await top(), { note: null, button: true });
      // Copy Party Hub address copies the address Roon's status shows; the script shows it.
      const html = await (await get('/About')).text();
      assert.ok(html.includes(`<button type="button" class="copy-button" id="copy-hub" data-url="${server.hubUrl()}" aria-label="Copy Party Hub address" hidden>`));
      // In a labelled box with the address itself, to read off when typing it on a TV.
      assert.ok(html.includes('<span class="hub-label" id="hub-label">Party Hub address</span>'));
      assert.ok(html.includes(`<span class="hub-address">${server.hubUrl().replace('/PartyHub', '<wbr />/PartyHub')}</span>`));
    } finally {
      roon.core = null;
    }
  });

  await check('the About page shows the version, this copy and the libraries', async () => {
    const res = await get('/About');
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.strictEqual(res.headers.get('x-frame-options'), 'DENY');
    const html = await res.text();
    assert.ok(html.includes(`Version ${require('../package.json').version}.`));
    assert.ok(html.includes('Copyright © 2026 Stubaggs.'));
    // The forum first: it's where people go for help.
    assert.ok(html.indexOf('>Roon forum</a>') < html.indexOf('>Instructions and releases</a>'));
    assert.ok(!html.includes("What's new"));
    assert.ok(html.includes('<a href="https://github.com/stubaggs/roon-extension-party-mode/blob/main/README.md" target="_blank" rel="noopener">Instructions and releases</a>'));
    assert.ok(html.includes('/325638" target="_blank" rel="noopener">Roon forum</a>'));
    assert.ok(server.aboutUrl().endsWith('/About'));
    assert.ok(html.includes('Not connected'));
    assert.match(html, /<span class="lib"><a [^>]+>express<\/a> <span class="ver">\d/);
    assert.ok(html.includes('href="/About/license/party-mode"'));
    // Thanked though not included: the Extension Manager, which installs Party Mode,
    // then the security tools. Licences link to their repositories; not with the libraries.
    const thanks = html.slice(html.indexOf('<h3>Installed and tested with</h3>'), html.indexOf('<h3>Open-source licences</h3>'));
    assert.ok(thanks.includes('<span class="lib"><a href="https://github.com/TheAppgineer/roon-extension-manager" target="_blank" rel="noopener">roon-extension-manager</a> <span class="ver"></span></span>' +
      '<span class="lic"><a href="https://github.com/TheAppgineer/roon-extension-manager" target="_blank" rel="noopener">Apache-2.0</a></span>' +
      '<span class="who">By TheAppgineer</span>'));
    assert.ok(thanks.indexOf('roon-extension-manager') < thanks.indexOf('>Docker Engine<'));
    assert.ok(thanks.indexOf('>Docker Engine<') < thanks.indexOf('>autocannon<'));
    for (const tool of ['ZAP', 'Trivy', 'Nuclei', 'Schemathesis']) assert.ok(thanks.includes(`>${tool}</a>`), tool);
    assert.ok(!html.slice(html.indexOf('<h3>Open-source licences</h3>')).includes('roon-extension-manager'));
    assert.ok(html.includes('<h2>Installation</h2>'));
    assert.ok(html.includes('<button type="button" class="copy-button" id="copy-details" aria-label="Copy details" hidden>'));
    assert.ok(html.includes('<script src="/about.js"></script>'));
    assert.strictEqual((await get('/about.js')).status, 200);
  });

  await check("the About page says the Core is connected, never its name", async () => {
    roon.core = { display_name: 'Home Core' };
    try {
      const html = await (await get('/About')).text();
      assert.ok(html.includes('<td>Connected for '));
      assert.ok(!html.includes('Home Core'));
    } finally {
      delete roon.core;
    }
  });

  await check('About: the base image, and how the container is hardened', async () => {
    const fs = require('fs');
    const os = require('os');
    const { baseImage, lockdown, memoryLimit } = require('../lib/about');
    const dir = fs.mkdtempSync(require('path').join(os.tmpdir(), 'about-'));
    const file = (name, text) => {
      const p = require('path').join(dir, name);
      fs.writeFileSync(p, text);
      return p;
    };
    try {
      assert.strictEqual(baseImage(file('base', 'node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402\n')),
        'node:22-alpine (sha256:0a7108bf6c7b)');
      assert.strictEqual(baseImage(require('path').join(dir, 'missing')), '');

      const root = (opts) => file('mountinfo', `20 1 0:30 / / ${opts} - overlay overlay rw\n21 20 0:31 / /data rw - ext4 /dev/sda1 rw\n`);
      const status = (cap, nnp) => file('status', `Name:\tnode\nNoNewPrivs:\t${nnp}\nCapEff:\t0000000000000000\nCapBnd:\t${cap}\n`);
      assert.strictEqual(lockdown(root('ro,relatime'), status('0000000000000000', 1), true), 'read-only, no capabilities, no new privileges');
      assert.strictEqual(lockdown(root('rw,relatime'), status('00000000a80425fb', 0), true), "None (the container's defaults)");
      assert.strictEqual(lockdown(root('ro'), status('0', 1), false), '');

      assert.strictEqual(memoryLimit(file('max', 'max\n')), 'None');
      assert.strictEqual(memoryLimit(file('limit', '268435456\n')), '256 MB');
      // cgroup v1 (older kernels), inside a container only.
      const none = require('path').join(dir, 'missing');
      const gb2 = 2 * 1024 ** 3;
      assert.strictEqual(memoryLimit(none, file('v1', '536870912\n'), true, gb2), '512 MB');
      assert.strictEqual(memoryLimit(none, file('v1max', '9223372036854771712\n'), true, gb2), 'None');
      assert.strictEqual(memoryLimit(none, file('v1max64k', '9223372036854710272\n'), true, gb2), 'None');
      assert.strictEqual(memoryLimit(none, file('v1', '536870912\n'), false, gb2), '');
      assert.strictEqual(memoryLimit(none, none, true, gb2), '');
      assert.strictEqual(memoryLimit(file('limit', '268435456\n'), file('v1', '536870912\n'), true, gb2), '256 MB');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await check("licence texts: Party Mode's and each library's, nothing else", async () => {
    const own = await get('/About/license/party-mode');
    assert.strictEqual(own.status, 200);
    const ownText = await own.text();
    assert.match(ownText, /Apache License\s+Version 2\.0/);
    // The NOTICE, the copyright notice, comes above the licence.
    const notice = ownText.indexOf('Copyright (c) 2026 Stubaggs');
    assert.ok(notice !== -1 && notice < ownText.indexOf('Apache License'));
    const express = require('express/package.json');
    const lib = await get(`/About/license/${encodeURIComponent(`express@${express.version}`)}`);
    assert.strictEqual(lib.status, 200);
    assert.match(lib.headers.get('content-type'), /text\/html/);
    const text = await lib.text();
    assert.match(text, /Permission is hereby granted/);
    // The text is escaped: the licence's "<tj@vision-media.ca>" is no tag.
    assert.ok(!text.includes('<tj@') && text.includes('&#60;tj@'));
    for (const id of ['express@0.0.0', 'nothing', '..%2F..%2Fpackage.json', '%2E%2E%2Fconfig.json']) {
      assert.strictEqual((await get(`/About/license/${id}`)).status, 404, id);
    }
  });

  await check("About: never the party zone's name; the pause it took by itself, explained", async () => {
    roon.zone = { display_name: 'Kitchen AirPlay' };
    roon.currentMode = 'paused';
    roon.zoneHold = true;
    try {
      const html = await (await get('/About')).text();
      assert.ok(!html.includes('Kitchen AirPlay'));
      assert.ok(html.includes('Paused by itself: the party zone isn&#39;t available'));
    } finally {
      roon.zone = null;
      delete roon.currentMode;
      delete roon.zoneHold;
    }
  });

  await check("the Party Hub's and guest page's data never name the party zone", async () => {
    set({ enabled: true });
    roon.zone = { zone_id: 'z1', display_name: 'Kitchen AirPlay', state: 'stopped', settings: {} };
    try {
      const cookie = (await get('/GuestHub')).headers.get('set-cookie').split(';')[0];
      for (const [path, headers] of [['/api/hub', {}], ['/api/party', { Cookie: cookie }]]) {
        const text = await (await get(path, headers)).text();
        assert.ok(text.includes('Test Party'), path);
        assert.ok(!text.includes('Kitchen AirPlay'), path);
        assert.ok(!('zone' in JSON.parse(text)), path);
      }
    } finally {
      roon.zone = null;
    }
  });

  await check('About: the party zone, by its state and never its name; failures counted', async () => {
    const { runtime, loopTime, cpuUse } = require('../lib/about');
    const rows = (ctx) => Object.fromEntries(runtime(ctx).flatMap(([, r]) => r));
    const fake = {
      core: { display_name: 'Home Core', display_version: '2.0 (build 1500) production' },
      settings: { zone: { output_id: 'o1' } },
      queue: [{}, {}, {}],
      queueState: 'subscribed',
      zone: {
        display_name: 'Kitchen AirPlay',
        state: 'playing',
        outputs: [{}, {}],
        settings: { auto_radio: true, shuffle: false, loop: 'loop_one' },
        now_playing: { length: 200 },
        is_next_allowed: true
      }
    };
    const shown = rows({ roon: fake, stats: { searches: 9, searchesFailed: 2, requestsFailed: 1, skips: 0, skipsFailed: 0 } });
    assert.ok(!JSON.stringify(shown).includes('Kitchen'));
    assert.ok(!JSON.stringify(shown).includes('Home Core'));
    assert.strictEqual(shown['Roon Core version'], '2.0 (build 1500) production');
    assert.strictEqual(shown['Party zone'], 'Available, 2 grouped outputs');
    assert.strictEqual(shown.Playback, 'Playing');
    assert.strictEqual(shown.Queue, '3 tracks in the queue');
    assert.strictEqual(shown['Roon Radio'], 'On');
    assert.strictEqual(shown.Repeat, 'One track');
    assert.strictEqual(shown.Searches, '9, 2 failed');
    assert.strictEqual(shown['Tracks requested'], "0, and 1 Roon couldn't add");
    assert.strictEqual(shown.Skips, '0');
    assert.strictEqual(shown['Roon skip'], 'Yes');

    // The zone with Roon's side, the guests and their settings with the party's.
    const sections = Object.fromEntries(runtime({ roon: fake }).map(([title, r]) => [title, r.map(([label]) => label)]));
    assert.deepStrictEqual(Object.keys(sections), ['Installation', 'Roon', 'Party', 'Health']);
    assert.strictEqual(rows({ roon: fake })['Code version'], require('../package.json').version, 'in what Copy copies');
    assert.ok(sections.Roon.includes('Queue'));
    assert.ok(sections.Party.includes('Play it next'));

    const requests = rows({ roon: Object.assign({}, fake, { settings: {
      zone: { output_id: 'o1' }, prevent_duplicates: true,
      allow_add: true, add_limit: 5, add_refill: 10,
      allow_next: true, next_limit: 1, next_refill: 0,
      allow_skip: false, skip_limit: 1, skip_refill: 60,
      rate_limit: 123, search_limit: 45
    } }) });
    assert.strictEqual(requests['Block duplicates'], 'Yes');
    assert.strictEqual(requests['Add to queue'], 'On, 5 per guest, 10 minutes refresh');
    assert.strictEqual(requests['Play it next'], 'On, 1 per guest, no refresh');
    assert.strictEqual(requests['Skip tracks'], 'Off');
    const requestLines = ['Block duplicates', 'Add to queue', 'Play it next', 'Skip tracks'].map((label) => requests[label]);
    assert.ok(!requestLines.some((value) => /123|45/.test(value)), 'never the Flood protection numbers');
    assert.strictEqual(rows({ roon: Object.assign({}, fake, { settings: { allow_add: true, add_limit: 0 } }) })['Add to queue'], 'On, no limit');
    assert.strictEqual(rows({ roon: Object.assign({}, fake, { settings: { allow_add: true, add_limit: 2, add_refill: 1 } }) })['Add to queue'],
      'On, 2 per guest, 1 minute refresh');
    const artCache = { images: new Map([['a', {}], ['b', {}]]), bytes: 2048, maxBytes: 8 << 20, hits: 3, misses: 1, failed: 1 };
    assert.strictEqual(rows({ roon: Object.assign({}, fake, { artCache }) })['Album art cache'], '2 covers, 75% hit rate, 1 failed');

    const health = rows({ roon: Object.assign({}, fake, { searchTimes: [400, 300, 3200], searchSlowest: 3200, searchesMost: 9, searchLoad: { area: 14000, busyMs: 10000 }, actionTimes: [700, 500, 900], actionSlowest: 3100, timedOut: 2 }) });
    assert.strictEqual(health['Search time'], '0.4 s typical, 3.2 s slowest');
    assert.strictEqual(health['Concurrent searches'], '1 typical, 9 at most');
    assert.strictEqual(rows({ roon: fake })['Concurrent searches'], 'No searches yet');
    assert.strictEqual(health['Guest actions'], '0.7 s typical, 3.1 s slowest, 2 timed out');
    assert.strictEqual(rows({ roon: fake })['Guest actions'], 'None yet');
    assert.strictEqual(rows({ roon: Object.assign({}, fake, { timedOut: 1 }) })['Guest actions'], '1 timed out');
    assert.match(health['Memory in use'], /^\d+ MB now, \d+ MB at most$/);
    assert.strictEqual(rows({ roon: fake })['Search time'], 'No searches yet');
    assert.strictEqual(loopTime({ count: 3, percentile: () => 21e6, max: 60e6 }), '1 ms typical, 40 ms slowest');
    assert.strictEqual(loopTime({ count: 0 }), '');
    assert.strictEqual(cpuUse({ now: 3, most: 40 }), '3% now, 40% at most');
    assert.strictEqual(cpuUse({ now: null, most: 0 }), '', 'nothing until the first sample');

    const counted = rows({
      roon: Object.assign({}, fake, { settings: { prevent_duplicates: true } }),
      stats: { tooMany: 0, usedUp: { add: 3, next: 0, skip: 1 }, duplicates: 4, reconnects: 2 }
    });
    assert.strictEqual(counted['Block duplicates'], 'Yes, 4 blocked');
    assert.strictEqual(counted['Allowances used up'], 'Add to queue 3, play next 0, skip 1');
    assert.strictEqual(counted['Live update reconnects'], '2 since Party Mode started');
    assert.match(counted['Warnings logged'], /^\d+ since Party Mode started$/);

    const hour = 3600 * 1000;
    const lost = (lastOutage) => rows({ roon: Object.assign({}, fake, { lastOutage }) })['Last lost'];
    assert.strictEqual(lost({ at: Date.now() - 2 * hour, back: Date.now() - 2 * hour + 5 * 60000 }), '2 hours ago, for 5 minutes');
    assert.strictEqual(lost({ at: Date.now() - 3 * 60000, back: null }), '3 minutes ago, not back yet');
    assert.strictEqual(lost(null), undefined);

    const open = rows({ roon: fake, guests: { sessions: new Map([['a', {}], ['b', {}], ['c', {}]]) },
      streams: new Set([{ guestId: 'a' }, { guestId: 'a' }, { guestId: 'b' }, { guestId: null }]) });
    assert.strictEqual(open.Guests, '3 joined, 2 on the page now');
    assert.strictEqual(open['Party Hub'], '1 open, Standard by default');
    // The Party Hub default view setting, as chosen in Roon.
    const roonDisplay = rows({ roon: Object.assign({}, fake, { settings: Object.assign({}, fake.settings, { hub_playing: 'roon' }) }) });
    assert.match(roonDisplay['Party Hub'], /^\d+ open, Roon Display by default$/);
    assert.strictEqual(rows({ roon: Object.assign({}, fake, { zone: null }) })['Party zone'],
      'Not available in Roon (switched off, unplugged or removed?)');
    assert.strictEqual(rows({ roon: Object.assign({}, fake, { settings: {} }) })['Party zone'], 'Not chosen yet');
  });

  await check("About: each library's name links to its repository, in any form npm accepts", async () => {
    const { repositoryUrl } = require('../lib/about');
    const github = 'https://github.com/user/repo';
    for (const repository of ['user/repo', 'github:user/repo', 'git+https://github.com/user/repo.git',
      'git://github.com/user/repo.git', 'git@github.com:user/repo', 'git+ssh://git@github.com/user/repo.git',
      'http://github.com/user/repo', { type: 'git', url: 'git+https://github.com/user/repo.git' },
      'git+ssh://git@github.com/user/repo.git#055dae6c']) {
      assert.strictEqual(repositoryUrl({ repository }), github, JSON.stringify(repository));
    }
    assert.strictEqual(repositoryUrl({ repository: 'gitlab:user/repo' }), 'https://gitlab.com/user/repo');
    assert.strictEqual(repositoryUrl({ homepage: 'https://example.org/lib#readme' }), 'https://example.org/lib#readme');
    // Nothing usable: no link, rather than a wrong or unsafe one.
    assert.strictEqual(repositoryUrl({ repository: 'javascript:alert(1)' }), '');
    assert.strictEqual(repositoryUrl({ repository: '^5.0.0' }), '');
    assert.strictEqual(repositoryUrl({}), '');

    const html = await (await get('/About')).text();
    assert.ok(html.includes('<a href="https://github.com/roonlabs/node-roon-api" target="_blank" rel="noopener">node-roon-api</a>'));
    assert.ok(html.includes('<a href="https://github.com/expressjs/express" target="_blank" rel="noopener">express</a>'));
  });

  await check("About: Roon's menu names, each with where it came from", async () => {
    const { menuNames } = require('../lib/about');
    const english = { title_tracks: 'Tracks', title_add: 'Queue', title_next: 'Add Next', title_profile: 'Profile' };
    assert.deepStrictEqual(menuNames(english, {}), [['Roon menu names', 'English']]);
    // Typed with different case or spaces is still English.
    assert.deepStrictEqual(menuNames({ title_tracks: ' tracks ' }, {}), [['Roon menu names', 'English']]);
    assert.deepStrictEqual(menuNames(english, { tracks: 'Titel', profile: 'Profil' }), [
      ['Roon menu "Tracks"', '"Titel", found'],
      ['Roon menu "Profile"', '"Profil", found']
    ]);
    assert.deepStrictEqual(menuNames(Object.assign({}, english, { title_add: 'Zur Warteschlange hinzufügen', title_tracks: 'Titl' }), { tracks: 'Titel' }), [
      ['Roon menu "Tracks"', '"Titel", found\n(set as "Titl")'],
      ['Roon menu "Queue"', '"Zur Warteschlange hinzufügen", set']
    ]);
    // Typed and found the same: found, with nothing beside it.
    assert.deepStrictEqual(menuNames(Object.assign({}, english, { title_next: 'Als Nächstes' }), { next: 'als nächstes' }),
      [['Roon menu "Add Next"', '"als nächstes", found']]);
  });

  await check('About: the code fingerprint, the same for the same code, wherever it is, Windows too', async () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const { fingerprint } = require('../lib/about');
    const copy = (files) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-'));
      for (const [name, text] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
        fs.writeFileSync(path.join(dir, name), text);
      }
      return dir;
    };
    const code = { 'app.js': 'a', NOTICE: 'n', 'lib/server.js': 'b', 'public/hub.js': 'c', 'test/x.js': 'not counted' };
    code['lib/server.js'] = 'b\nc\n';
    code['public/icon.png'] = Buffer.from([1, 13, 10, 2]);
    const dirs = [copy(code), copy(Object.assign({}, code, { 'test/x.js': 'changed', 'base-image': 'node' })),
      copy(Object.assign({}, code, { 'lib/server.js': 'b!\nc\n' })),
      // Checked out by Git on Windows: CRLF in text files, images untouched.
      copy(Object.assign({}, code, { 'lib/server.js': 'b\r\nc\r\n' })),
      copy(Object.assign({}, code, { 'lib/server.js': 'b \nc\n' })),
      copy(Object.assign({}, code, { 'public/icon.png': Buffer.from([1, 10, 2]) })),
      copy(Object.assign({}, code, { NOTICE: 'n!' }))];
    try {
      const [one, same, changed, windows, space, image, notice] = dirs.map((dir) => fingerprint(dir));
      assert.match(one, /^[0-9a-f]{12}$/);
      assert.strictEqual(same, one);
      assert.notStrictEqual(changed, one);
      assert.strictEqual(windows, one);
      assert.notStrictEqual(space, one);
      assert.notStrictEqual(image, one);
      assert.notStrictEqual(notice, one);
    } finally {
      for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await check('About: the image build stamp, and how it was installed', async () => {
    const fs = require('fs');
    const os = require('os');
    const { installKind, imageBuilt } = require('../lib/about');
    // Published: the workflow's stamp. A custom build: just that, no date.
    // Not in a container: no line at all.
    assert.strictEqual(imageBuilt('2026-10-16 abc1234', true), '2026-10-16 abc1234');
    assert.strictEqual(imageBuilt('', true), 'Custom build');
    assert.strictEqual(imageBuilt('2026-10-16 abc1234', false), '');
    const mounts = (points) => {
      const file = require('path').join(os.tmpdir(), `mountinfo-${process.pid}`);
      fs.writeFileSync(file, points.map((p, i) => `${i} 1 0:1 / ${p} rw - ext4 x rw`).join('\n'));
      return file;
    };
    assert.strictEqual(installKind(mounts(['/']), false), 'Node.js');
    assert.match(installKind(mounts(['/', '/data']), true), /volume or folder/);
    assert.match(installKind(mounts(['/', '/data/config.json']), true), /Extension Manager/);
    assert.match(installKind(mounts(['/']), true), /inside the container/);
  });

  await check('copyright lines: the holders, not the licence wording', async () => {
    const { copyrightOf, duration } = require('../lib/about');
    assert.strictEqual(copyrightOf('MIT\n\nCopyright (c) 2020 A Person\n\nThe above copyright notice', {}), 'Copyright (c) 2020 A Person');
    assert.strictEqual(copyrightOf('(c) You must retain\nCopyright [yyyy] [name of copyright owner]', { author: 'Roon Labs, LLC' }), 'Copyright Roon Labs, LLC');
    // A year alone: the holder is on the next line (dijkstrajs).
    assert.strictEqual(copyrightOf('```\nCopyright (C) 2008\n  A Person <a@example.org>\n```', {}), 'Copyright (C) 2008 A Person <a@example.org>');
    assert.strictEqual(duration(59), 'less than a minute');
    assert.strictEqual(duration(3 * 86400 + 4 * 3600 + 5 * 60), '3 days, 4 hours');
  });

  await check("libraries: a Readme's licence when there's no file; notes on those only a tool installs", async () => {
    const { readPackages, readmeLicense, sourceLicense } = require('../lib/about');
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    assert.strictEqual(readmeLicense('# lib\n\nUse it.\n\n## License \n\n(The MIT License)\n\nCopyright (c) 2012 A &lt;a@example.org&gt;\n\n### Terms\n\nFree.\n\n## Thanks\n\nYou.'),
      '(The MIT License)\n\nCopyright (c) 2012 A <a@example.org>\n\n### Terms\n\nFree.');
    assert.strictEqual(readmeLicense('# lib\n\nNo licence here.'), '');
    assert.strictEqual(sourceLicense('//----\n//\n// Lib\n//\n// Copyright (c) 2009 A\n// Licensed under the MIT license\n//----\n\nvar x;'),
      'Lib\n\nCopyright (c) 2009 A\nLicensed under the MIT license');
    assert.strictEqual(sourceLicense('/*!\n * Lib\n * MIT License\n */\nx();'), 'Lib\nMIT License');
    assert.strictEqual(sourceLicense('// Just code.\nvar x;'), '');

    // app needs lib, a package with a command-line tool needing cli-lib,
    // which needs cli-dep; lib's licence is in its Readme.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'libs-'));
    const pkg = (dir, json, files = {}) => {
      const full = path.join(root, dir);
      fs.mkdirSync(full, { recursive: true });
      fs.writeFileSync(path.join(full, 'package.json'), JSON.stringify(json));
      for (const [name, text] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(full, name)), { recursive: true });
        fs.writeFileSync(path.join(full, name), text);
      }
    };
    try {
      pkg('.', { name: 'app', dependencies: { tool: '1' } });
      pkg('node_modules/tool', { name: 'tool', version: '1.0.0', bin: { tool: './bin/tool' }, dependencies: { lib: '1', 'cli-lib': '1' } },
        { 'index.js': "require('lib/x')", 'bin/tool': "require('cli-lib')", LICENSE: 'MIT\nCopyright (c) 2020 Tool' });
      pkg('node_modules/lib', { name: 'lib', version: '1.0.0', license: 'MIT' }, { 'README.md': '# lib\n\n## License\n\nCopyright (c) 2021 Lib\n' });
      pkg('node_modules/cli-lib', { name: 'cli-lib', version: '1.0.0', dependencies: { 'cli-dep': '1' } }, { LICENSE: 'Copyright (c) 2022 Cli' });
      pkg('node_modules/cli-lib/node_modules/cli-dep', { name: 'cli-dep', version: '1.0.0' }, { LICENSE: 'Copyright (c) 2023 Dep' });
      const found = Object.fromEntries(readPackages(path.join(root, 'node_modules')).map((p) => [p.name, p]));
      assert.deepStrictEqual(Object.keys(found).sort(), ['cli-dep', 'cli-lib', 'lib', 'tool']);
      assert.strictEqual(found.tool.note, undefined);
      assert.strictEqual(found.lib.note, undefined);
      assert.strictEqual(found['cli-lib'].note, 'Installed with tool package');
      assert.strictEqual(found['cli-dep'].note, found['cli-lib'].note);
      assert.ok(found.lib.fromReadme && found.lib.file.endsWith('README.md'));
      assert.strictEqual(found.lib.copyright, 'Copyright (c) 2021 Lib');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }

    // Party Mode's own: every library has a licence, its text and a holder,
    // and none this test has loaded is marked as unused.
    const packages = readPackages();
    for (const p of packages) {
      assert.ok(p.license && p.file && p.copyright, `${p.id}: licence ${p.license}, file ${p.file}, copyright ${p.copyright}`);
    }
    const loaded = new Set(Object.keys(require.cache).map((f) => (f.match(/node_modules\/((?:@[^/]+\/)?[^/]+)\/(?!.*node_modules)/) || [])[1]));
    for (const p of packages) assert.ok(!(p.note && loaded.has(p.name)), `${p.id} is loaded, yet noted as unused`);
    // qrcode-generator ships its licence only as its code's opening comment.
    const generator = packages.find((p) => p.name === 'qrcode-generator');
    assert.ok(generator.fromSource && generator.license === 'MIT' && generator.copyright === 'Copyright (c) 2009 Kazuhiko Arase');
    assert.match(await (await get(`/About/license/${encodeURIComponent(generator.id)}`)).text(), /Licensed under the MIT license/);

    // A Readme's licence is served as the section alone, with the note on the page.
    const fromReadme = packages.find((p) => p.fromReadme);
    if (fromReadme) {
      const text = await (await get(`/About/license/${encodeURIComponent(fromReadme.id)}`)).text();
      assert.match(text, /Permission is hereby granted/);
      assert.ok(!text.includes('## License'));
    }
  });

  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
