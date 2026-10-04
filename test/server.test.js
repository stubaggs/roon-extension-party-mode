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
const { DEFAULT_SETTINGS } = require('../lib/roon-service');

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
  partyName: 'Test Party',
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
const server = createServer(roon, guests);

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
      assert.strictEqual((await res.json()).error, 'station');
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
    roon.partyName = 'Kate & Sam <3 $& Co';
    const en = await (await get('/PartyHub')).text();
    assert.match(en, /<title>Kate &#38; Sam &#60;3 \$&#38; Co Hub<\/title>/);
    const fr = await (await get('/partyhub', { 'Accept-Language': 'fr' })).text();
    assert.match(fr, /<html lang="fr" dir="ltr">/);
    const he = await (await get('/PartyHub', { 'Accept-Language': 'he-IL' })).text();
    assert.match(he, /<html lang="he" dir="rtl">/);
    roon.partyName = '';
    const unnamed = await (await get('/PartyHub', { 'Accept-Language': 'nl' })).text();
    assert.match(unnamed, /<title>Feest Hub<\/title>/);
    roon.partyName = 'Test Party';
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

  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
