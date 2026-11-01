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

// Startup (lib/startup.js, called by app.js): the web port, then Roon
// discovery, and the links Roon shows, against stand-ins for both.

const assert = require('assert');
const EventEmitter = require('events');
const { start } = require('../lib/startup');
const { FALLBACK_PORTS } = require('../lib/ports');

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

// Only what lib/startup.js uses of the Roon service. The website is what
// went out with the last registration: start() and reconnect() send one.
function fakeRoon(port = 8338, portChosen = false) {
  const roon = new EventEmitter();
  Object.assign(roon, {
    settings: { port },
    portChosen,
    api: { extension_reginfo: { display_name: 'Party Mode', website: 'https://github.com/stubaggs/roon-extension-party-mode' } },
    registered: [],
    started: 0,
    reconnects: 0,
    status: null,
    playlistUrl: undefined,
    refused: null,
    setWebsite(url) {
      this.api.extension_reginfo.website = url;
    },
    setPlaylistUrl(url) {
      this.playlistUrl = url;
    },
    setStatusLine(line, isError = false) {
      this.status = { line, isError };
    },
    refusePort(previous, note) {
      this.refused = { previous, note };
    },
    start() {
      this.started += 1;
      this.registered.push(this.api.extension_reginfo.website);
    },
    reconnect() {
      this.reconnects += 1;
      this.registered.push(this.api.extension_reginfo.website);
    }
  });
  return roon;
}

// The web server: `busy` ports refuse with EADDRINUSE, `denied` with EACCES.
// `address` stands for the network address, 127.0.0.1 before the network is up.
function fakeServer({ busy = [], denied = [], address = '192.0.2.10' } = {}) {
  const server = {
    port: null,
    address,
    tried: [],
    listen(port) {
      this.tried.push(port);
      const code = busy.includes(port) ? 'EADDRINUSE' : denied.includes(port) ? 'EACCES' : null;
      if (code) return Promise.reject(Object.assign(new Error(`listen ${code}`), { code }));
      this.port = port;
      return Promise.resolve();
    },
    base() {
      return `http://${this.address}:${this.port}`;
    },
    aboutUrl() {
      return `${this.base()}/About`;
    },
    hubUrl() {
      return `${this.base()}/PartyHub`;
    },
    guestUrl() {
      return `${this.base()}/GuestHub`;
    },
    playlistUrl() {
      return `${this.base()}/p/CODE`;
    }
  };
  return server;
}

// startup logs where it listens; the tests keep the output to their own lines.
const quiet = async (fn) => {
  const log = console.log;
  const error = console.error;
  const lines = [];
  console.log = (line) => lines.push(line);
  console.error = (line) => lines.push(line);
  try {
    await fn();
  } finally {
    console.log = log;
    console.error = error;
  }
  return lines;
};
// The settings handler moves the server asynchronously.
const settle = () => new Promise((resolve) => setImmediate(resolve));

(async () => {
  console.log('startup');

  await check('opens the web port, then registers with the About page as the website', async () => {
    const roon = fakeRoon();
    const server = fakeServer();
    const lines = await quiet(() => start(roon, server));
    assert.strictEqual(server.port, 8338);
    assert.strictEqual(roon.started, 1);
    assert.deepStrictEqual(roon.registered, ['http://192.0.2.10:8338/About']);
    assert.deepStrictEqual(roon.status, { line: 'Hub: http://192.0.2.10:8338/PartyHub', isError: false });
    assert.strictEqual(roon.playlistUrl(), 'http://192.0.2.10:8338/p/CODE');
    assert.ok(lines.includes('[PartyMode] Party Hub:  http://192.0.2.10:8338/PartyHub'), lines.join('\n'));
  });

  await check('started before the network was up: registers again with the address once the Core pairs', async () => {
    const roon = fakeRoon();
    const server = fakeServer({ address: '127.0.0.1' });
    await quiet(() => start(roon, server));
    assert.deepStrictEqual(roon.registered, ['http://127.0.0.1:8338/About']);
    server.address = '192.0.2.10';
    roon.emit('core_paired');
    assert.strictEqual(roon.reconnects, 1);
    assert.deepStrictEqual(roon.registered, ['http://127.0.0.1:8338/About', 'http://192.0.2.10:8338/About']);
    assert.strictEqual(roon.status.line, 'Hub: http://192.0.2.10:8338/PartyHub');
  });

  await check('pairing with the link unchanged does not reconnect (no loop)', async () => {
    const roon = fakeRoon();
    const server = fakeServer({ address: '127.0.0.1' });
    await quiet(() => start(roon, server));
    server.address = '192.0.2.10';
    roon.emit('core_paired');
    roon.emit('core_paired');
    roon.emit('core_paired');
    assert.strictEqual(roon.reconnects, 1);
  });

  await check('a Core on this computer pairs before the network is up: registers again when the party zone arrives', async () => {
    const roon = fakeRoon();
    const server = fakeServer({ address: '127.0.0.1' });
    await quiet(() => start(roon, server));
    roon.emit('core_paired');
    assert.strictEqual(roon.reconnects, 0, 'still no address at pairing');
    server.address = '192.0.2.10';
    roon.emit('zone_arrived');
    assert.strictEqual(roon.reconnects, 1);
    assert.deepStrictEqual(roon.registered, ['http://127.0.0.1:8338/About', 'http://192.0.2.10:8338/About']);
    assert.strictEqual(roon.status.line, 'Hub: http://192.0.2.10:8338/PartyHub');
    // The reconnect pairs again and the zone arrives again: the link is the same now.
    roon.emit('core_paired');
    roon.emit('zone_arrived');
    assert.strictEqual(roon.reconnects, 1);
  });

  await check('the party zone arriving with the link unchanged does not reconnect', async () => {
    const roon = fakeRoon();
    const server = fakeServer();
    await quiet(() => start(roon, server));
    roon.emit('core_paired');
    roon.emit('zone_arrived');
    assert.strictEqual(roon.reconnects, 0);
  });

  await check('8338 taken and no port chosen: the next free port, kept in the settings', async () => {
    const roon = fakeRoon(8338, false);
    const server = fakeServer({ busy: [8338, 8339] });
    const lines = await quiet(() => start(roon, server));
    assert.strictEqual(server.port, 8340);
    assert.strictEqual(roon.settings.port, 8340);
    assert.ok(lines.includes('[PartyMode] Port 8338 is in use, using 8340 instead'), lines.join('\n'));
    assert.deepStrictEqual(roon.registered, ['http://192.0.2.10:8340/About']);
  });

  await check('a chosen port that is taken: no other port, Roon still started, the status says why in red', async () => {
    const roon = fakeRoon(8338, true);
    const server = fakeServer({ busy: [8338] });
    await quiet(() => start(roon, server));
    assert.deepStrictEqual(server.tried, [8338]);
    assert.strictEqual(server.port, null);
    assert.strictEqual(roon.started, 1);
    assert.strictEqual(roon.playlistUrl, null);
    assert.deepStrictEqual(roon.status, { line: 'Port 8338 is in use. Pick another web port in the settings.', isError: true });
  });

  await check('every fallback port taken: says which ones', async () => {
    const roon = fakeRoon(8338, false);
    const busy = [];
    for (let p = 8338; p <= 8338 + FALLBACK_PORTS; p += 1) busy.push(p);
    await quiet(() => start(roon, fakeServer({ busy })));
    assert.strictEqual(roon.status.line, `Ports 8338-${8338 + FALLBACK_PORTS} are all in use. Pick another web port in the settings.`);
    assert.strictEqual(roon.started, 1);
  });

  await check('a port that cannot be opened for another reason: says why, without trying others', async () => {
    const roon = fakeRoon(80, false);
    const server = fakeServer({ denied: [80] });
    await quiet(() => start(roon, server));
    assert.deepStrictEqual(server.tried, [80]);
    assert.strictEqual(roon.status.line, 'Could not open port 80 (EACCES). Pick another web port in the settings.');
  });

  await check('a new web port in the settings: moves there and registers again with the new link', async () => {
    const roon = fakeRoon(8338, true);
    const server = fakeServer();
    await quiet(() => start(roon, server));
    await quiet(async () => {
      roon.emit('settings_changed', { port: 8400 });
      await settle();
    });
    assert.strictEqual(server.port, 8400);
    assert.strictEqual(roon.reconnects, 1);
    assert.deepStrictEqual(roon.registered, ['http://192.0.2.10:8338/About', 'http://192.0.2.10:8400/About']);
  });

  await check('saving other settings on the same port changes nothing', async () => {
    const roon = fakeRoon(8338, true);
    const server = fakeServer();
    await quiet(() => start(roon, server));
    roon.emit('settings_changed', { port: 8338 });
    await settle();
    assert.deepStrictEqual(server.tried, [8338]);
    assert.strictEqual(roon.reconnects, 0);
  });

  await check('on a fallback port, saving other settings does not retry the port asked for', async () => {
    const roon = fakeRoon(8338, false);
    const server = fakeServer({ busy: [8338] });
    await quiet(() => start(roon, server));
    roon.emit('settings_changed', { port: 8339 });
    await settle();
    assert.deepStrictEqual(server.tried, [8338, 8339]);
    assert.strictEqual(roon.reconnects, 0);
  });

  await check('a new port that is taken is refused: the port in use goes back into the settings', async () => {
    const roon = fakeRoon(8338, true);
    const server = fakeServer({ busy: [8400] });
    await quiet(() => start(roon, server));
    await quiet(async () => {
      roon.emit('settings_changed', { port: 8400 });
      await settle();
    });
    assert.strictEqual(server.port, 8338);
    assert.deepStrictEqual(roon.refused, { previous: 8338, note: 'Web port not changed: 8400 is in use, still on 8338' });
    assert.strictEqual(roon.reconnects, 0);
  });

  await check('no web server since startup: a port that opens fixes it, one that does not says why', async () => {
    const roon = fakeRoon(8338, true);
    const server = fakeServer({ busy: [8338, 8401] });
    await quiet(() => start(roon, server));
    await quiet(async () => {
      roon.emit('settings_changed', { port: 8401 });
      await settle();
    });
    assert.strictEqual(roon.refused, null);
    assert.deepStrictEqual(roon.status, { line: 'Port 8401 is in use. Pick another web port in the settings.', isError: true });
    // Saving the same port again tries it again, since nothing is listening.
    await quiet(async () => {
      roon.emit('settings_changed', { port: 8401 });
      await settle();
    });
    assert.deepStrictEqual(server.tried, [8338, 8401, 8401]);
    await quiet(async () => {
      roon.emit('settings_changed', { port: 8402 });
      await settle();
    });
    assert.strictEqual(server.port, 8402);
    assert.deepStrictEqual(roon.status, { line: 'Hub: http://192.0.2.10:8402/PartyHub', isError: false });
    assert.strictEqual(roon.reconnects, 1);
  });

  if (failures) {
    console.log(`\n${failures} failing`);
    process.exit(1);
  }
  console.log('\nall passing');
})();
