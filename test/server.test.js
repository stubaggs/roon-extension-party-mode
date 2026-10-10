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

// The web server's own answers, against a stand-in for Roon: the playlist and
// its QR code, Party mode Off, and the pages a join link gets.

const assert = require('assert');
const EventEmitter = require('events');
const { createServer } = require('../lib/server');
const { GuestStore, cleanName, MAX_SESSIONS } = require('../lib/guests');
const { DEFAULT_SETTINGS, RoonService } = require('../lib/roon-service');

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
  const cookie = (await get(`/j/${guests.joinCode}`)).headers.get('set-cookie').split(';')[0];
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

  await check('the download works whatever the setting, as a named CSV file', async () => {
    for (const choice of ['qr', 'link', 'off']) {
      set({ playlist_download: choice });
      const res = await get('/Download/playlist.csv');
      assert.strictEqual(res.status, 200, choice);
      assert.match(res.headers.get('content-type'), /^text\/csv/);
      assert.match(res.headers.get('content-disposition'), /attachment; filename="Test Party \d{4}-\d{2}-\d{2}\.csv"/);
      assert.match(await res.text(), /^title,artist,album,/);
    }
  });

  await check('the playlist\'s old /api addresses still work', async () => {
    const res = await get('/api/playlist.csv');
    assert.strictEqual(res.status, 200);
    assert.match(await res.text(), /^title,artist,album,/);
    assert.match(await (await get('/api/playlist-qr.svg')).text(), /^<svg/);
  });

  await check('the playlist QR code is an SVG, and not the join code', async () => {
    const playlist = await (await get('/Download/playlist-qr.svg')).text();
    const join = await (await get('/api/qr.svg')).text();
    assert.match(playlist, /^<svg/);
    assert.notStrictEqual(playlist, join);
    assert.ok(server.playlistUrl().endsWith('/Download/playlist.csv'));
  });

  console.log('\njoining');

  await check('Party mode Off: the join link says requests are closed, in the guest\'s language', async () => {
    set({ enabled: false });
    const res = await get(`/j/${guests.joinCode}`, { 'Accept-Language': 'fr-FR,fr;q=0.9' });
    assert.strictEqual(res.status, 403);
    assert.match(res.headers.get('content-type'), /^text\/html/);
    const html = await res.text();
    assert.match(html, /<html lang="fr" dir="ltr">/);
    assert.match(html, /name="viewport"/);
    assert.match(html, /<h1>Les demandes sont fermées<\/h1>/);
  });

  await check('an old code asks the guest to scan again, in English by default', async () => {
    set({ enabled: true });
    const res = await get('/j/not-the-code');
    assert.strictEqual(res.status, 403);
    const html = await res.text();
    assert.match(html, /<html lang="en" dir="ltr">/);
    assert.match(html, /<h1>Scan the code again<\/h1>/);
    assert.match(html, /That code has expired/);
  });

  await check('the right code starts a session and opens the guest page', async () => {
    set({ enabled: true });
    const res = await get(`/j/${guests.joinCode}`);
    assert.strictEqual(res.status, 302);
    assert.strictEqual(res.headers.get('location'), '/GuestHub');
    assert.match(res.headers.get('set-cookie'), /^party_sid=/);
  });

  await check('the session cookie lasts 12 hours and is renewed whenever it is used', async () => {
    set({ enabled: true });
    const joined = (await get(`/j/${guests.joinCode}`)).headers.get('set-cookie');
    assert.match(joined, /Max-Age=43200/);
    const cookie = joined.split(';')[0];
    const res = await get('/api/party', { Cookie: cookie });
    assert.strictEqual(res.status, 200);
    const renewed = res.headers.get('set-cookie') || '';
    assert.strictEqual(renewed.split(';')[0], cookie, 'the same session');
    assert.match(renewed, /Max-Age=43200/);
  });

  await check('scanning again keeps the session and its name; an unknown one starts afresh', async () => {
    set({ enabled: true });
    const cookie = (await get(`/j/${guests.joinCode}`)).headers.get('set-cookie').split(';')[0];
    await post('/api/name', cookie, { name: 'Rescan Ronnie', confirm: true });
    const again = (await get(`/j/${guests.joinCode}`, { Cookie: cookie })).headers.get('set-cookie').split(';')[0];
    assert.strictEqual(again, cookie, 'the same session');
    const party = await (await get('/api/party', { Cookie: again })).json();
    assert.strictEqual(party.guest_name, 'Rescan Ronnie');
    const stranger = (await get(`/j/${guests.joinCode}`, { Cookie: 'party_sid=not-a-session' })).headers.get('set-cookie').split(';')[0];
    assert.notStrictEqual(stranger, 'party_sid=not-a-session', 'a new session');
    assert.notStrictEqual(stranger, cookie);
  });

  await check('the guest page is at /GuestHub, in any case, and no longer at the root', async () => {
    for (const path of ['/GuestHub', '/guesthub']) assert.strictEqual((await get(path)).status, 200, path);
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

  await check('Party mode Off: the guest API says closed, for "Requests are closed"', async () => {
    const cookie = (await get(`/j/${guests.joinCode}`)).headers.get('set-cookie').split(';')[0];
    set({ enabled: false });
    const res = await get('/api/party', { Cookie: cookie });
    assert.strictEqual(res.status, 403);
    assert.strictEqual((await res.json()).error, 'closed');
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
    const after = (await get(`/j/${guests.joinCode}`, { Cookie: cookie })).headers.get('set-cookie').split(';')[0];
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

  await check('with adding off, play next is off too, whatever its own setting', async () => {
    const cookie = await newGuest();
    try {
      set({ allow_add: false, allow_next: true });
      const party = await (await get('/api/party', { Cookie: cookie })).json();
      assert.deepStrictEqual([party.capabilities.add, party.capabilities.next], [false, false]);
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
      display_name: 'D90',
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
    for (const path of ['/', '/GuestHub', '/api/party', '/j/not-the-code']) {
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
    for (const path of ['/', '/PartyHub', '/api/hub', '/api/qr.svg', '/Download/playlist.csv']) {
      const res = await get(path);
      assert.strictEqual(res.headers.get('cross-origin-resource-policy'), 'same-origin', path);
      // Ignored over plain HTTP, with an error in the console, so not sent.
      assert.strictEqual(res.headers.get('cross-origin-opener-policy'), null, path);
      assert.strictEqual(res.headers.get('cross-origin-embedder-policy'), 'require-corp', path);
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
    const silent = { imageSvc: { get_image() {} } };
    const started = Date.now();
    await assert.rejects(RoonService.prototype.getImage.call(silent, 'unknown', 200, 50), /did not answer/);
    assert.ok(Date.now() - started < 1000);
  });

  await check('the Party Hub can be shown inside a dashboard', async () => {
    const res = await get('/PartyHub');
    assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
    assert.doesNotMatch(res.headers.get('content-security-policy'), /frame-ancestors/);
    assert.strictEqual(res.headers.get('x-frame-options'), null);
  });

  console.log('\nParty Hub');

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
    const cookie = (await fetch(`${at}/j/${store.joinCode}`, { redirect: 'manual' })).headers.get('set-cookie').split(';')[0];
    const search = () => fetch(`${at}/api/search?q=abba`, { headers: { Cookie: cookie } }).then((r) => r.status);
    assert.deepStrictEqual([await search(), await search(), await search()], [200, 200, 429]);
    assert.strictEqual((await fetch(`${at}/api/party`, { headers: { Cookie: cookie } })).status, 200, 'the rest still work');
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

  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
