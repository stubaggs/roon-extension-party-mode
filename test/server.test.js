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
const { GuestStore } = require('../lib/guests');
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
const roon = Object.assign(new EventEmitter(), {
  settings: Object.assign({}, DEFAULT_SETTINGS, { port: 0 }),
  queue: [],
  zone: null,
  ready: false,
  partyName: 'Test Party'
});
const guests = new GuestStore();
const server = createServer(roon, guests);

let base;
const get = (path, headers = {}) => fetch(base + path, { headers, redirect: 'manual' });
const set = (values) => Object.assign(roon.settings, values);

(async () => {
  await server.listen(0);
  base = `http://127.0.0.1:${server.port}`;

  console.log('playlist');

  await check('the party screen is told how to offer it: QR code by default', async () => {
    set({ enabled: false, playlist_download: 'qr' });
    assert.strictEqual((await (await get('/api/roonparty')).json()).playlist, 'qr');
  });

  await check('link only and off reach the party screen as they are', async () => {
    set({ playlist_download: 'link' });
    assert.strictEqual((await (await get('/api/roonparty')).json()).playlist, 'link');
    set({ playlist_download: 'off' });
    assert.strictEqual((await (await get('/api/roonparty')).json()).playlist, 'off');
  });

  await check('a yes/no saved before the three choices still reads right', async () => {
    set({ playlist_download: true });
    assert.strictEqual((await (await get('/api/roonparty')).json()).playlist, 'qr');
    set({ playlist_download: false });
    assert.strictEqual((await (await get('/api/roonparty')).json()).playlist, 'off');
  });

  await check('the download works whatever the setting, as a named CSV file', async () => {
    for (const choice of ['qr', 'link', 'off']) {
      set({ playlist_download: choice });
      const res = await get('/api/playlist.csv');
      assert.strictEqual(res.status, 200, choice);
      assert.match(res.headers.get('content-type'), /^text\/csv/);
      assert.match(res.headers.get('content-disposition'), /attachment; filename="Test Party \d{4}-\d{2}-\d{2}\.csv"/);
      assert.match(await res.text(), /^title,artist,album,/);
    }
  });

  await check('the playlist QR code is an SVG, and not the join code', async () => {
    const playlist = await (await get('/api/playlist-qr.svg')).text();
    const join = await (await get('/api/qr.svg')).text();
    assert.match(playlist, /^<svg/);
    assert.notStrictEqual(playlist, join);
    assert.ok(server.playlistUrl().endsWith('/api/playlist.csv'));
  });

  console.log('\njoining');

  await check('Party mode Off: the join link says requests are closed, in the guest\'s language', async () => {
    set({ enabled: false });
    const res = await get(`/j/${guests.joinCode}`, { 'Accept-Language': 'fr-FR,fr;q=0.9' });
    assert.strictEqual(res.status, 403);
    assert.match(res.headers.get('content-type'), /^text\/html/);
    const html = await res.text();
    assert.match(html, /<html lang="fr">/);
    assert.match(html, /name="viewport"/);
    assert.match(html, /<h1>Les demandes sont fermées<\/h1>/);
  });

  await check('an old code asks the guest to scan again, in English by default', async () => {
    set({ enabled: true });
    const res = await get('/j/not-the-code');
    assert.strictEqual(res.status, 403);
    const html = await res.text();
    assert.match(html, /<html lang="en">/);
    assert.match(html, /<h1>Scan the code again<\/h1>/);
    assert.match(html, /That code has expired/);
  });

  await check('the right code starts a session and opens the guest page', async () => {
    set({ enabled: true });
    const res = await get(`/j/${guests.joinCode}`);
    assert.strictEqual(res.status, 302);
    assert.strictEqual(res.headers.get('location'), '/');
    assert.match(res.headers.get('set-cookie'), /^party_sid=/);
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
    const html = await (await get('/')).text();
    assert.match(html, /<main id="app" hidden>/);
    assert.match(html, /<div id="locked" class="locked" hidden>/);
    assert.match(html, /<div id="closed" class="locked" hidden>/);
  });

  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
