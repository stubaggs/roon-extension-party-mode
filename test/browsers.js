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

// The pages in real browsers: Chromium, WebKit and Firefox, through
// Playwright, against the web server and a stand-in for Roon
// (test/party-roon.js). What jsdom (test/pages.test.js) can't show: the pages'
// security policy enforced, real layout (Up next showing whole tracks only, a
// long name scrolling), Roon's display page in its frame, and no errors in the
// console. Not part of npm test: run it in Playwright's image (DEVELOPER.md).

const assert = require('assert');
const http = require('http');

let playwright;
try {
  playwright = require('playwright');
} catch (err) {
  console.log('Needs Playwright: see "Testing" in DEVELOPER.md.');
  process.exit(1);
}
const { createServer } = require('../lib/server');
const { GuestStore } = require('../lib/guests');
const { partyRoon } = require('./party-roon');

const { roon, track, play, set, reset } = partyRoon();
// No album art: the stand-in has no image service to answer for it.
const song = (id, title, artist = 'ABBA') => track(id, title, artist, 'Arrival', { image_key: null });
const waterloo = song(1, 'Waterloo');
const sos = song(2, 'SOS');
const long = song(3, 'A track with a title far too long to fit in the space it has on the Party Hub, even on a large screen');
const queue = Array.from({ length: 30 }, (_, i) => song(10 + i, `Track ${i + 1}`, 'Band'));

let failures = 0;
async function check(name, fn) {
  reset();
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${name}\n       ${String(err.message).split('\n').slice(0, 12).join('\n       ')}`);
  }
}

// Whether an image loaded, once it has finished either way: a code shown
// just now may still be on its way.
const loaded = (locator) => locator.evaluate((img) => (img.complete && img.src
  ? img.naturalWidth > 0
  : new Promise((done) => {
    img.addEventListener('load', () => done(img.naturalWidth > 0), { once: true });
    img.addEventListener('error', () => done(false), { once: true });
  })));

/**
 * A new page, with what goes wrong on it collected: console errors (a script
 * or a security policy refusing something), uncaught errors and failed
 * requests.
 */
async function newPage(browser, options) {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  const problems = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') problems.push(`console: ${msg.text()}`);
  });
  page.on('pageerror', (err) => problems.push(`error: ${err.message}`));
  page.on('requestfailed', (request) => {
    // Live updates end when the page closes.
    if (!request.url().endsWith('/api/events')) problems.push(`request failed: ${request.url()} ${request.failure().errorText}`);
  });
  return {
    page,
    problems,
    async close() {
      await context.close();
    }
  };
}

const TV = { viewport: { width: 1920, height: 1080 } };
// Firefox has no phone emulation: a phone's screen and touch are enough here.
const phone = (name) => (name === 'firefox' ? { viewport: { width: 390, height: 664 }, deviceScaleFactor: 3 } : { viewport: { width: 390, height: 664 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });

(async () => {
  const guests = new GuestStore();
  const server = createServer(roon, guests, { limits: { all: 0, search: 0 } });
  await server.listen(0);
  const base = `http://127.0.0.1:${server.port}`;
  // Roon's display page, for the Roon Display view.
  const display = http.createServer((req, res) => res.end('<!doctype html><title>Roon</title><p id="roon">Roon display</p>'));
  await new Promise((resolve) => display.listen(0, resolve));

  for (const name of ['chromium', 'webkit', 'firefox']) {
    console.log(`${name}`);
    const browser = await playwright[name].launch();
    try {
      await check('the Party Hub: stays on it (not the basic one), shows the party, follows Roon live', async () => {
        play(waterloo, [sos]);
        const { page, problems, close } = await newPage(browser, TV);
        try {
          await page.goto(`${base}/PartyHub`);
          await page.locator('#current-title', { hasText: 'Waterloo' }).waitFor();
          assert.strictEqual(new URL(page.url()).pathname, '/PartyHub');
          assert.strictEqual(await page.textContent('#party-name'), 'Garden Party');
          assert.ok(await loaded(page.locator('#qr')), 'the join code loaded');
          play(sos, []);
          await page.locator('#current-title', { hasText: 'SOS' }).waitFor();
          assert.deepStrictEqual(problems, []);
        } finally {
          await close();
        }
      });

      await check('the Party Hub: Up next shows whole tracks only, and counts them all', async () => {
        play(waterloo, queue);
        const { page, problems, close } = await newPage(browser, TV);
        try {
          await page.goto(`${base}/PartyHub`);
          await page.locator('#upnext-count:not([hidden])').waitFor();
          const layout = await page.evaluate(() => {
            const list = document.getElementById('list').getBoundingClientRect();
            const rows = [...document.querySelectorAll('#list li')].filter((li) => !li.hidden);
            return { shown: rows.length, inside: rows.every((li) => li.getBoundingClientRect().bottom <= list.bottom + 0.5) };
          });
          assert.ok(layout.shown > 0 && layout.shown < queue.length, `${layout.shown} shown`);
          assert.ok(layout.inside, 'no track cut off');
          assert.strictEqual(await page.textContent('#upnext-count'), `${queue.length} tracks`);
          assert.deepStrictEqual(problems, []);
        } finally {
          await close();
        }
      });

      await check('the Party Hub: a name too long for its space scrolls', async () => {
        play(long, [sos]);
        const { page, problems, close } = await newPage(browser, TV);
        try {
          await page.goto(`${base}/PartyHub`);
          await page.locator('#current-title .marquee-inner').waitFor();
          assert.strictEqual(await page.locator('.list .t .marquee-inner').count(), 0, 'SOS fits');
          assert.deepStrictEqual(problems, []);
        } finally {
          await close();
        }
      });

      await check("Roon Display: Roon's page in its frame, allowed by the security policy", async () => {
        roon.coreAddress = { host: '127.0.0.1', port: display.address().port };
        // As the Roon service says when the Core connects: the server checks the page again.
        roon.emit('core_paired');
        play(waterloo);
        const { page, problems, close } = await newPage(browser, TV);
        try {
          await page.goto(`${base}/PartyHub/Roon`);
          await page.locator('#frame-slot:not([hidden])').waitFor();
          const frame = page.frameLocator('#frame-box iframe');
          await frame.locator('#roon').waitFor();
          assert.ok(await page.locator('#current').isHidden());
          assert.deepStrictEqual(problems, []);
        } finally {
          await close();
          delete roon.coreAddress;
        }
      });

      await check('the basic Party Hub', async () => {
        play(waterloo, [sos]);
        const { page, problems, close } = await newPage(browser, TV);
        try {
          await page.goto(`${base}/PartyHub/Basic`);
          await page.locator('#current-title', { hasText: 'Waterloo' }).waitFor();
          assert.strictEqual(await page.locator('#list li').count(), 1);
          set({ enabled: false, playlist_download: 'qr' });
          roon.emit('party_mode_changed', 'off', 'on');
          await page.locator('#closed:not([hidden])').waitFor();
          assert.ok(await loaded(page.locator('#playlist-qr')), 'the playlist code loaded');
          assert.deepStrictEqual(problems, []);
        } finally {
          await close();
        }
      });

      await check('the guest page on a phone: a name, a search, a track added', async () => {
        // Not Waterloo: it would be a duplicate, which can't be added.
        play(sos);
        const { page, problems, close } = await newPage(browser, phone(name));
        try {
          await page.goto(`${base}/GuestHub`);
          await page.locator('#nickname:not([hidden])').waitFor();
          await page.fill('#nickname-input', 'Sam');
          await page.click('#nickname-go');
          await page.locator('#name-chip', { hasText: 'Sam' }).waitFor();
          assert.strictEqual(await page.textContent('#playing-title'), 'SOS');
          await page.fill('#search', 'abba');
          await page.locator('#results .row').first().waitFor();
          await page.locator('#results .row').first().click();
          await page.locator('#results .actions .pill-primary').click();
          await page.locator('#results .row-state', { hasText: 'Added' }).waitFor();
          assert.deepStrictEqual(roon.actions, [{ key: '10:0', mode: 'add' }]);
          // The join code, to pass the party on.
          await page.click('#party-chip');
          await page.locator('#invite:not([hidden])').waitFor();
          assert.ok(await loaded(page.locator('#invite-qr')), 'the join code loaded');
          assert.deepStrictEqual(problems, []);
        } finally {
          await close();
        }
      });

      await check('the About page: its script runs (the Copy buttons show)', async () => {
        roon.core = {};
        const { page, problems, close } = await newPage(browser, TV);
        try {
          await page.goto(`${base}/About`);
          await page.locator('#copy-details:not([hidden])').waitFor();
          await page.locator('#copy-hub:not([hidden])').waitFor();
          await page.click('#copy-hub');
          await page.locator('#hub-copied', { hasText: /Copied|Couldn't copy/ }).waitFor();
          assert.deepStrictEqual(problems, []);
        } finally {
          await close();
          delete roon.core;
        }
      });
    } finally {
      await browser.close();
    }
  }

  display.close();
  if (failures) {
    console.log(`\n${failures} failing`);
    process.exit(1);
  }
  console.log('\nall passing');
  process.exit(0);
})();
