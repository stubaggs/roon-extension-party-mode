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

// The page scripts (public/*.js) in jsdom: each page as the web server sends
// it, its scripts run, its fetches and live updates (/api/events) going to
// that server, which reads a stand-in for Roon. jsdom has no layout, so sizes
// are made up where a script measures (marquee.js), and no navigation, which
// is counted instead. Real browsers: test/browsers.js.
//
// jsdom is a development dependency: skipped without it, as in the Docker
// build (npm ci --omit=dev).

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const vm = require('vm');

let jsdom;
try {
  jsdom = require('jsdom');
} catch (err) {
  console.log('pages\n  skipped: jsdom is not installed (npm ci without --omit=dev)\n\nall passing');
  process.exit(0);
}
const { JSDOM, VirtualConsole, CookieJar, requestInterceptor } = jsdom;
const { createServer } = require('../lib/server');
const { GuestStore } = require('../lib/guests');
const { QUEUE_ITEMS } = require('../lib/roon-service');
const { partyRoon } = require('./party-roon');

const PUBLIC = path.join(__dirname, '..', 'public');

let failures = 0;
async function check(name, fn) {
  // Each test starts with a new party, nothing playing (see reset below).
  if (base) reset();
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${name}\n       ${err.message.split('\n').slice(0, 14).join('\n       ')}`);
  }
}

/** Waits for fn() to be true (or to stop throwing), up to `ms`. */
async function until(fn, what = 'the page to update', ms = 3000) {
  const end = Date.now() + ms;
  let last;
  for (;;) {
    try {
      if (fn()) return;
    } catch (err) {
      last = err;
    }
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ''}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- Roon, as the web server reads it ---

const { roon, searchResults, track, play, set, reset } = partyRoon();

const guests = new GuestStore();
// Requests a minute per device: none here, until a test sets one (read on each request).
const limits = { all: 0, search: 0 };
const server = createServer(roon, guests, { limits });
let base;

// --- A browser, as far as the pages need one ---

/**
 * Opens `pathname` as a browser would: the page from the server, then its
 * scripts. `window` options: wide (matchMedia's min-width), reducedMotion,
 * storage (localStorage entries, or null for none), lang (the party_lang
 * cookie). Returns the window, what went wrong on the page, the navigations
 * it tried (jsdom can't follow them) and close().
 */
async function open(pathname, options = {}) {
  const errors = [];
  const navigations = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (err) => {
    if (/navigation to another Document/.test(err.message)) navigations.push(err.message);
    else errors.push(err.message + (err.detail ? `: ${err.detail.stack || err.detail}` : ''));
  });
  virtualConsole.on('error', (...args) => errors.push(args.join(' ')));
  const cookieJar = new CookieJar();
  if (options.lang) cookieJar.setCookieSync(`party_lang=${options.lang}; Path=/`, base);
  const streams = [];

  // Only scripts and the page itself: styles and images get an empty answer,
  // and frames (Roon's display page) none, so a test says when one has loaded.
  const scriptsOnly = requestInterceptor((request, { element }) => {
    if (!element || element.localName === 'script') return undefined;
    if (element.localName === 'iframe') return new Promise(() => {});
    return new Response('', { headers: { 'Content-Type': element.localName === 'link' ? 'text/css' : 'image/svg+xml' } });
  });

  const dom = await JSDOM.fromURL(base + pathname, {
    runScripts: 'dangerously',
    resources: { interceptors: [scriptsOnly] },
    pretendToBeVisual: true,
    cookieJar,
    virtualConsole,
    beforeParse(window) {
      const cookie = () => cookieJar.getCookieStringSync(base);
      // fetch, with the session cookie, as the page's own would send it.
      window.fetch = (input, init = {}) =>
        fetch(new URL(input, window.location.href), Object.assign({}, init, { headers: Object.assign({}, init.headers, { Cookie: cookie() }) })).then((res) => {
          for (const set of res.headers.getSetCookie()) cookieJar.setCookieSync(set, base);
          return res;
        });
      // EventSource on /api/events, read as it arrives.
      window.EventSource = class {
        constructor(url) {
          this.listeners = {};
          this.received = 0;
          this.controller = new AbortController();
          streams.push(this);
          fetch(new URL(url, window.location.href), { headers: { Cookie: cookie() }, signal: this.controller.signal })
            .then(async (res) => {
              let text = '';
              const decoder = new TextDecoder();
              for await (const chunk of res.body) {
                text += decoder.decode(chunk, { stream: true });
                let end;
                while ((end = text.indexOf('\n\n')) >= 0) {
                  const frame = text.slice(0, end);
                  text = text.slice(end + 2);
                  const type = (frame.match(/^event: (.*)$/m) || [])[1] || 'message';
                  const data = frame.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
                  this.received += 1;
                  for (const fn of this.listeners[type] || []) fn(new window.MessageEvent(type, { data }));
                }
              }
            })
            .catch(() => {});
        }
        addEventListener(type, fn) {
          (this.listeners[type] = this.listeners[type] || []).push(fn);
        }
        close() {
          this.controller.abort();
        }
      };
      const wide = options.wide !== false;
      window.matchMedia = (query) => ({
        media: query,
        matches: /prefers-reduced-motion/.test(query) ? Boolean(options.reducedMotion) : /min-width/.test(query) ? wide : false,
        addEventListener() {},
        removeEventListener() {}
      });
      window.CSS.supports = () => true;
      // jsdom has no innerText: text, with a line for each <br>.
      Object.defineProperty(window.HTMLElement.prototype, 'innerText', {
        configurable: true,
        get() {
          const copy = this.cloneNode(true);
          copy.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
          return copy.textContent;
        }
      });
      window.copied = [];
      window.document.execCommand = (command) => {
        const box = window.document.querySelector('textarea');
        window.copied.push(command === 'copy' && box ? box.value : null);
        return options.copyWorks !== false;
      };
      if (options.storage === null) {
        Object.defineProperty(window, 'localStorage', { get() { throw new Error('SecurityError'); } });
        Object.defineProperty(window, 'sessionStorage', { get() { throw new Error('SecurityError'); } });
      } else {
        for (const [key, value] of Object.entries(options.storage || {})) window.localStorage.setItem(key, value);
      }
      if (options.before) options.before(window);
    }
  });
  const { window } = dom;
  await new Promise((resolve) => (window.document.readyState === 'complete' ? resolve() : window.addEventListener('load', resolve)));
  return {
    window,
    document: window.document,
    $: (id) => window.document.getElementById(id),
    errors,
    /** The page's cookies, the guest session among them, for asking the server as this guest. */
    cookie: () => cookieJar.getCookieStringSync(base),
    navigations,
    streams,
    /** Waits until the live updates are connected: the server sends the queue first. */
    async live() {
      await until(() => streams.length > 0 && streams[0].received > 0, 'the live updates');
      await sleep(20);
    },
    /** The page's own text for a key, in its language. */
    t: (key, vars) => window.I18N.t(key, vars),
    close() {
      for (const stream of streams) stream.close();
      window.close();
    }
  };
}

const visible = (node) => !node.hidden;
const texts = (nodes) => [...nodes].map((node) => node.textContent);

// --- Fixtures ---

const waterloo = track(1, 'Waterloo', 'ABBA', 'Waterloo');
const sos = track(2, 'SOS', 'ABBA', 'ABBA');
const fernando = track(3, 'Fernando', 'ABBA');

// A stand-in for Roon's display page, for the Roon Display view.
const display = http.createServer((req, res) => res.end('<!doctype html><title>Roon</title>'));

(async () => {
  await server.listen(0);
  base = `http://127.0.0.1:${server.port}`;
  await new Promise((resolve) => display.listen(0, '127.0.0.1', resolve));
  reset();

  console.log('pages: hub-check.js');

  // Plain ES5 with no page of its own: run in a sandbox where location.replace is seen.
  const hubCheck = fs.readFileSync(path.join(PUBLIC, 'hub-check.js'), 'utf8');
  function runHubCheck(window) {
    const went = [];
    window.location = { replace: (url) => went.push(url) };
    window.window = window;
    vm.runInNewContext(hubCheck, window);
    return went;
  }
  const media = { addEventListener() {} };

  await check('a browser with clamp() and MediaQueryList events stays on the Party Hub', () => {
    assert.deepStrictEqual(runHubCheck({ CSS: { supports: () => true }, matchMedia: () => media }), []);
  });

  await check('without clamp(), MediaQueryList events, CSS.supports or matchMedia: the basic Party Hub', () => {
    const cases = [
      { CSS: { supports: () => false }, matchMedia: () => media },
      { CSS: { supports: () => true }, matchMedia: () => ({ addListener() {} }) },
      { CSS: {}, matchMedia: () => media },
      { CSS: { supports: () => true } },
      { matchMedia: () => media },
      { CSS: { supports: () => { throw new Error('old'); } }, matchMedia: () => media }
    ];
    for (const window of cases) assert.deepStrictEqual(runHubCheck(window), ['/PartyHub/Basic']);
  });

  console.log('\npages: the Party Hub (hub.js)');

  await check('shows the party, what is playing, who asked, and Up next', async () => {
    play(waterloo, [sos, fernando]);
    const page = await open('/PartyHub');
    try {
      await until(() => page.$('current-title').textContent === 'Waterloo');
      assert.strictEqual(page.$('party-name').textContent, 'Garden Party');
      assert.strictEqual(page.document.title, 'Garden Party Hub');
      assert.strictEqual(page.$('current-artist').textContent, 'ABBA');
      assert.strictEqual(page.$('current-album').textContent, 'Waterloo');
      assert.strictEqual(page.$('current-label').textContent, 'Playing now');
      assert.strictEqual(page.$('current-art').getAttribute('src'), '/api/image/art-1?size=400');
      assert.deepStrictEqual(texts(page.document.querySelectorAll('#list .t')), ['SOS', 'Fernando']);
      assert.deepStrictEqual(texts(page.document.querySelectorAll('#list .who')), ['Host', 'Host']);
      assert.strictEqual(page.document.querySelector('#list img').getAttribute('src'), '/api/image/art-2?size=120');
      assert.ok(visible(page.$('join-open')) && !visible(page.$('join-closed')));
      assert.strictEqual(page.$('join-link').textContent, 'Scan to add a track');
      assert.ok(!visible(page.$('upnext-count')), 'all of Up next shows');
      assert.deepStrictEqual(page.errors, []);
    } finally {
      page.close();
    }
  });

  await check('follows Roon live: the next track, the queue emptying', async () => {
    play(waterloo, [sos]);
    const page = await open('/PartyHub');
    try {
      await page.live();
      play(sos, []);
      await until(() => page.$('current-title').textContent === 'SOS');
      await until(() => page.document.querySelector('#list .empty'), 'an empty Up next');
      assert.strictEqual(page.document.querySelector('#list .empty').textContent, page.t('queue.empty_add'));
      assert.ok(!visible(page.$('current-album')) || page.$('current-album').textContent === 'ABBA');
    } finally {
      page.close();
    }
  });

  await check('nothing playing; paused; a radio station with its note', async () => {
    const page = await open('/PartyHub');
    try {
      await until(() => page.$('current-title').textContent === 'Nothing playing');
      assert.ok(!page.$('current-art').hasAttribute('src'));
      assert.ok(!visible(page.$('current-who')));
      await page.live();
      play(waterloo, [], { state: 'paused' });
      await until(() => page.$('current-label').textContent === 'Paused');
      // A live station: Roon's queue doesn't have it, and its name is the title.
      roon.zone = { zone_id: 'z1', state: 'playing', is_next_allowed: false, is_seek_allowed: false, now_playing: { three_line: { line1: 'Radio Paradise', line2: 'Eclectic', line3: '' }, image_key: 'rp' } };
      roon.queue = [];
      roon.emit('queue_changed');
      await until(() => page.$('current-title').textContent === 'Radio Paradise');
      assert.strictEqual(page.$('current-label').textContent, page.t('playing.station'));
      assert.ok(visible(page.$('current-note')), 'requests wait for the host');
    } finally {
      page.close();
    }
  });

  await check('Up next counts the tracks only when there are more than it shows; 500+ at the most Roon sends', async () => {
    const many = Array.from({ length: 12 }, (_, i) => track(10 + i, `Track ${i}`, 'Band'));
    play(waterloo, many);
    const page = await open('/PartyHub');
    try {
      await until(() => page.document.querySelectorAll('#list li').length === 12);
      // jsdom lays nothing out, so every row "fits": no count.
      assert.ok(!visible(page.$('upnext-count')));
      // As on a small screen: rows past the list's bottom are hidden and counted.
      const list = page.$('list');
      list.getBoundingClientRect = () => ({ top: 0, bottom: 100 });
      [...list.children].forEach((row, i) => (row.getBoundingClientRect = () => ({ top: i * 40, bottom: (i + 1) * 40 })));
      page.window.dispatchEvent(new page.window.Event('resize'));
      assert.strictEqual([...list.children].filter(visible).length, 2);
      assert.ok(visible(page.$('upnext-count')));
      assert.strictEqual(page.$('upnext-count').textContent, '12 tracks');
    } finally {
      page.close();
    }
    // As much of the queue as Party Mode asks Roon for: there may be more.
    play(waterloo, Array.from({ length: QUEUE_ITEMS - 1 }, (_, i) => track(100 + i, `Track ${i}`, 'Band')));
    const full = await open('/PartyHub');
    try {
      await until(() => full.document.querySelectorAll('#list li').length === QUEUE_ITEMS - 1, 'the whole queue');
      const list = full.$('list');
      list.getBoundingClientRect = () => ({ top: 0, bottom: 100 });
      [...list.children].forEach((row, i) => (row.getBoundingClientRect = () => ({ top: i * 40, bottom: (i + 1) * 40 })));
      full.window.dispatchEvent(new full.window.Event('resize'));
      assert.strictEqual(full.$('upnext-count').textContent, `${QUEUE_ITEMS - 1}+ tracks`);
    } finally {
      full.close();
    }
  });

  await check('Party Off: the playlist code in place of the join code, and "Requests are closed"', async () => {
    play(waterloo, [sos]);
    const page = await open('/PartyHub');
    try {
      await page.live();
      set({ enabled: false, playlist_download: 'qr' });
      roon.emit('party_mode_changed', 'off', 'on');
      await until(() => visible(page.$('closed')), 'Requests are closed');
      assert.ok(!visible(page.$('join-open')) && visible(page.$('join-closed')));
      assert.ok(visible(page.$('playlist-qr-offer')) && !visible(page.$('playlist-link-offer')));
      assert.match(page.$('playlist-qr').getAttribute('src'), /^\/embed\/playlist-qr\.svg\?t=\d+$/);
      assert.ok(!visible(page.$('current')) && !visible(page.document.querySelector('.upnext')));
      set({ playlist_download: 'link' });
      await until(() => visible(page.$('playlist-link-offer')), 'the playlist link');
      assert.ok(!visible(page.$('playlist-qr-offer')));
      set({ playlist_download: 'off' });
      await until(() => !visible(page.$('playlist-link-offer')), 'no playlist');
    } finally {
      page.close();
      reset();
    }
  });

  await check('paused: the caption under the code says requests are on hold', async () => {
    roon.currentMode = 'paused';
    const page = await open('/PartyHub');
    try {
      await until(() => page.$('join-link').textContent === page.t('allowance.paused'));
    } finally {
      page.close();
      reset();
    }
  });

  await check("the host's name stands in for Host", async () => {
    Object.assign(roon.settings, { host_name: 'Stu' });
    play(waterloo, [sos]);
    const page = await open('/PartyHub');
    try {
      await until(() => page.document.querySelector('#list .who'));
      assert.strictEqual(page.document.querySelector('#list .who').textContent, 'Stu');
      assert.strictEqual(page.$('current-who').textContent, 'Stu');
    } finally {
      page.close();
      reset();
    }
  });

  await check('a phone-sized screen: no Roon display frame, even when set', async () => {
    roon.coreAddress = { host: '127.0.0.1', port: display.address().port };
    // As the Roon service says when the Core connects: the server checks the page again.
    roon.emit('core_paired');
    set({ hub_playing: 'roon' });
    await sleep(100);
    const page = await open('/PartyHub', { wide: false });
    try {
      await until(() => page.$('current-title').textContent === 'Nothing playing');
      assert.strictEqual(page.$('frame-box').children.length, 0);
      assert.ok(visible(page.$('current')));
    } finally {
      page.close();
      delete roon.coreAddress;
      reset();
    }
  });

  await check("Roon Display: Roon's page in a sandboxed frame once it has loaded, Playing now until then", async () => {
    roon.coreAddress = { host: '127.0.0.1', port: display.address().port };
    // As the Roon service says when the Core connects: the server checks the page again.
    roon.emit('core_paired');
    play(waterloo);
    const page = await open('/PartyHub/Roon');
    try {
      await until(() => page.$('frame-box').firstChild, 'the frame');
      const frame = page.$('frame-box').firstChild;
      // Roon's address as a TV reaches it: this computer's network address, not 127.0.0.1.
      assert.match(frame.getAttribute('src'), new RegExp(`^http://[^/]+:${display.address().port}/display/$`));
      assert.strictEqual(frame.getAttribute('sandbox'), 'allow-scripts allow-same-origin');
      assert.strictEqual(frame.referrerPolicy, 'no-referrer');
      assert.ok(visible(page.$('current')) && !visible(page.$('frame-slot')), 'Playing now until it loads');
      frame.dispatchEvent(new page.window.Event('load'));
      await until(() => visible(page.$('frame-slot')), 'the frame shown');
      assert.ok(!visible(page.$('current')));
      assert.strictEqual(page.$('frame-label').textContent, 'Playing now');
      assert.strictEqual(page.$('frame-who').textContent, 'Host');
    } finally {
      page.close();
      delete roon.coreAddress;
      reset();
    }
  });

  await check('another language chosen for the Hub in Roon: the page reloads', async () => {
    const page = await open('/PartyHub');
    try {
      await page.live();
      set({ hub_language: 'fr' });
      // Each update asks again: a browser would have left the page at the first.
      await until(() => page.navigations.length >= 1, 'a reload');
    } finally {
      page.close();
      reset();
    }
  });

  await check('the corner menu: opens, closes with Escape or a click elsewhere', async () => {
    const page = await open('/PartyHub');
    try {
      const button = page.$('menu-button');
      const { window } = page;
      button.click();
      assert.ok(visible(page.$('menu')));
      assert.strictEqual(button.getAttribute('aria-expanded'), 'true');
      page.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
      assert.ok(!visible(page.$('menu')));
      assert.strictEqual(page.document.activeElement, button);
      button.click();
      page.$('party-name').click();
      assert.ok(!visible(page.$('menu')));
      assert.strictEqual(button.getAttribute('aria-expanded'), 'false');
    } finally {
      page.close();
    }
  });

  await check('in French, as the setting says', async () => {
    Object.assign(roon.settings, { hub_language: 'fr' });
    const page = await open('/PartyHub');
    try {
      await until(() => page.$('current-title').textContent === 'Rien en lecture');
      assert.strictEqual(page.document.documentElement.lang, 'fr');
      assert.deepStrictEqual(page.errors, []);
      assert.deepStrictEqual(page.navigations, []);
    } finally {
      page.close();
      reset();
    }
  });

  await check('a long party name leaves less room: the QR code gives way, down to 10rem', async () => {
    const page = await open('/PartyHub');
    try {
      await until(() => page.$('party-name').textContent === 'Garden Party');
      const { window } = page;
      const join = page.document.querySelector('.join');
      const code = page.$('qr');
      // The name and the code take 500 px of the 300 the side has; the code is 400 px wide.
      Object.defineProperty(join, 'clientHeight', { configurable: true, value: 300 });
      page.$('party-name').getBoundingClientRect = () => ({ top: 0, bottom: 150 });
      page.$('join-open').getBoundingClientRect = () => ({ top: 150, bottom: 500 });
      Object.defineProperty(code, 'offsetParent', { configurable: true, value: join });
      Object.defineProperty(code, 'offsetWidth', { configurable: true, value: 400 });
      window.getComputedStyle = ((original) => (el) => (el === page.document.documentElement ? { fontSize: '16px' } : original(el)))(window.getComputedStyle);
      window.dispatchEvent(new window.Event('resize'));
      assert.strictEqual(code.style.width, '200px');
      // Far too little room: never smaller than 10rem.
      Object.defineProperty(join, 'clientHeight', { configurable: true, value: 100 });
      window.dispatchEvent(new window.Event('resize'));
      assert.strictEqual(code.style.width, '160px');
      // Room enough again: its own size.
      Object.defineProperty(join, 'clientHeight', { configurable: true, value: 600 });
      window.dispatchEvent(new window.Event('resize'));
      assert.strictEqual(code.style.width, '');
    } finally {
      page.close();
    }
  });

  console.log('\npages: the basic Party Hub (basic.js)');

  await check('shows the party, what is playing and at most six of Up next, with the count', async () => {
    const many = Array.from({ length: 8 }, (_, i) => track(10 + i, `Track ${i}`, 'Band'));
    play(waterloo, many);
    const page = await open('/PartyHub/Basic');
    try {
      await until(() => page.$('current-title').textContent === 'Waterloo');
      assert.strictEqual(page.$('party-name').textContent, 'Garden Party');
      assert.strictEqual(page.$('current-artist').textContent, 'ABBA');
      assert.strictEqual(page.$('current-who').textContent, 'Host');
      assert.strictEqual(page.$('current-art').getAttribute('src'), '/api/image/art-1?size=400');
      assert.strictEqual(page.document.querySelectorAll('#list li').length, 6);
      assert.ok(visible(page.$('upnext-count')));
      assert.strictEqual(page.$('upnext-count').textContent, '8 tracks');
      assert.deepStrictEqual(page.errors, []);
    } finally {
      page.close();
    }
  });

  await check('follows Roon live, and Party Off closes it', async () => {
    play(waterloo, [sos]);
    const page = await open('/PartyHub/Basic');
    try {
      await page.live();
      play(sos);
      await until(() => page.$('current-title').textContent === 'SOS');
      await until(() => page.document.querySelector('#list .empty'));
      set({ enabled: false, playlist_download: 'qr' });
      roon.emit('party_mode_changed', 'off', 'on');
      await until(() => visible(page.$('closed')));
      assert.ok(!visible(page.$('join-open')) && visible(page.$('playlist-qr-offer')));
      assert.ok(!visible(page.$('current')) && !visible(page.$('upnext')));
    } finally {
      page.close();
      reset();
    }
  });

  await check('without EventSource: asks every 10 seconds instead', async () => {
    let intervals = [];
    const page = await open('/PartyHub/Basic', {
      before(window) {
        delete window.EventSource;
        const setInterval = window.setInterval.bind(window);
        window.setInterval = (fn, ms) => {
          intervals.push(ms);
          return setInterval(fn, ms);
        };
      }
    });
    try {
      await until(() => intervals.length);
      assert.deepStrictEqual(intervals, [10000]);
      assert.strictEqual(page.streams.length, 0);
    } finally {
      page.close();
    }
  });

  await check('a long party name gets smaller until it fits, then is cut short', async () => {
    roon.pageName = 'A party with a name far too long for the box it has';
    const page = await open('/PartyHub/Basic', {
      before(window) {
        // As if every size were too big: three lines at the smallest, then the ellipsis.
        Object.defineProperty(window.HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => 300 });
        Object.defineProperty(window.HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 100 });
      }
    });
    try {
      await until(() => page.$('party-name').textContent === roon.pageName);
      assert.strictEqual(page.$('party-name').style.fontSize, '2.3rem');
      assert.strictEqual(page.$('party-name').className, 'party-name clamped');
    } finally {
      page.close();
      roon.pageName = 'Garden Party';
    }
  });

  console.log('\npages: the guest page (guest.js)');

  /** A guest's page: joined at /GuestHub, as from the code. */
  const guestPage = (options) => open('/GuestHub', options);
  // A guest who has given a name before (or skipped), so the page doesn't ask.
  const named = { storage: { party_name: '' } };

  await check('a first visit asks for a name; Skip remembers that, so it isn\'t asked again', async () => {
    const page = await guestPage();
    try {
      await until(() => visible(page.$('app')), 'the page');
      assert.ok(visible(page.$('nickname')));
      assert.strictEqual(page.$('nickname-skip').textContent, 'Skip');
      page.$('nickname-skip').click();
      await until(() => !visible(page.$('nickname')), 'the dialog to close');
      assert.strictEqual(page.window.localStorage.getItem('party_name'), '');
      assert.strictEqual(page.$('name-chip').textContent, 'Add your name');
    } finally {
      page.close();
    }
  });

  await check("a name: saved, shown on the chip, and remembered on the phone", async () => {
    const page = await guestPage();
    try {
      await until(() => visible(page.$('nickname')));
      page.$('nickname-input').value = 'Sam';
      page.$('nickname-form').requestSubmit();
      await until(() => !visible(page.$('nickname')));
      assert.strictEqual(page.$('name-chip').textContent, 'Sam');
      assert.strictEqual(page.$('name-chip').getAttribute('aria-label'), 'Adding as Sam. Change');
      assert.strictEqual(page.window.localStorage.getItem('party_name'), 'Sam');
    } finally {
      page.close();
    }
  });

  await check('a name someone else uses: asks first, and a second Go uses it anyway', async () => {
    const first = await guestPage();
    try {
      await until(() => visible(first.$('nickname')));
      first.$('nickname-input').value = 'Robin';
      first.$('nickname-form').requestSubmit();
      await until(() => !visible(first.$('nickname')));
    } finally {
      first.close();
    }
    const page = await guestPage();
    try {
      await until(() => visible(page.$('nickname')));
      page.$('nickname-input').value = 'Robin';
      page.$('nickname-form').requestSubmit();
      await until(() => visible(page.$('nickname-note')), 'the note');
      assert.match(page.$('nickname-note').textContent, /Robin/);
      assert.strictEqual(page.$('nickname-go').textContent, 'Use it anyway');
      page.$('nickname-form').requestSubmit();
      await until(() => !visible(page.$('nickname')));
      assert.strictEqual(page.$('name-chip').textContent, 'Robin');
    } finally {
      page.close();
    }
  });

  await check('a remembered name is used without asking; the chip changes it, with Cancel', async () => {
    const page = await guestPage({ storage: { party_name: 'Alex' } });
    try {
      await until(() => page.$('name-chip').textContent === 'Alex', 'the name');
      assert.ok(!visible(page.$('nickname')));
      page.$('name-chip').click();
      assert.ok(visible(page.$('nickname')));
      assert.strictEqual(page.$('nickname-input').value, 'Alex');
      assert.strictEqual(page.$('nickname-skip').textContent, 'Cancel');
      page.document.dispatchEvent(new page.window.KeyboardEvent('keydown', { key: 'Escape' }));
      assert.ok(!visible(page.$('nickname')));
      assert.strictEqual(page.$('name-chip').textContent, 'Alex');
    } finally {
      page.close();
    }
  });

  await check('without storage (private browsing), the page still works', async () => {
    const page = await guestPage({ storage: null });
    try {
      await until(() => visible(page.$('nickname')));
      page.$('nickname-skip').click();
      await until(() => !visible(page.$('nickname')));
      assert.deepStrictEqual(page.errors, []);
    } finally {
      page.close();
    }
  });

  await check('what is playing, Up next and Played, live', async () => {
    play(waterloo, [sos]);
    const page = await guestPage(named);
    try {
      await until(() => page.$('playing-title').textContent === 'Waterloo');
      assert.strictEqual(page.$('playing-art').getAttribute('src'), '/api/image/art-1?size=144');
      assert.deepStrictEqual(texts(page.document.querySelectorAll('#queue .row-title')), ['SOS']);
      assert.strictEqual(page.document.querySelector('#queue .queue-position').textContent, '1');
      assert.strictEqual(page.$('upnext-count').textContent, '1 track');
      assert.strictEqual(page.document.querySelector('#played .empty').textContent, 'Nothing played yet.');
      await page.live();
      play(sos, []);
      roon.emit('now_playing_changed', true);
      await until(() => page.$('playing-title').textContent === 'SOS');
      await until(() => texts(page.document.querySelectorAll('#played .row-title')).includes('Waterloo'), 'Played');
      assert.ok(!visible(page.$('upnext-count')));
      assert.deepStrictEqual(page.errors, []);
    } finally {
      page.close();
      reset();
    }
  });

  await check('search: results after a pause in typing, opened to add; then marked Added', async () => {
    const page = await guestPage(named);
    try {
      await until(() => visible(page.$('app')));
      const input = page.$('search');
      input.value = 'ab';
      input.dispatchEvent(new page.window.Event('input'));
      assert.ok(visible(page.$('search-clear')));
      await until(() => page.document.querySelectorAll('#results .row').length === 2, 'the results');
      assert.strictEqual(page.$('results-status').textContent, page.t('search.results', { count: 2 }));
      const row = page.document.querySelector('#results .row');
      assert.strictEqual(row.getAttribute('aria-expanded'), 'false');
      row.click();
      const add = page.document.querySelector('#results .actions .pill-primary');
      assert.strictEqual(add.textContent, page.t('track.add'));
      assert.strictEqual(page.document.querySelector('#results .actions .pill-ghost').textContent, page.t('track.next'));
      add.click();
      await until(() => roon.actions.length === 1, 'the request');
      assert.deepStrictEqual(roon.actions, [{ key: '10:0', mode: 'add' }]);
      await until(() => page.document.querySelector('#results .row-state').textContent === 'Added');
      assert.strictEqual(page.document.querySelector('#results .row').getAttribute('aria-disabled'), 'true');
      assert.strictEqual(page.$('toast').textContent, page.t('toast.queued'));
      // Escape clears the search.
      input.dispatchEvent(new page.window.KeyboardEvent('keydown', { key: 'Escape' }));
      assert.strictEqual(input.value, '');
      assert.strictEqual(page.document.querySelectorAll('#results .row').length, 0);
    } finally {
      page.close();
      reset();
    }
  });

  await check('search: "Searching…" in place of the old results until Roon answers', async () => {
    const search = roon.search;
    let answer;
    const page = await guestPage(named);
    try {
      await until(() => visible(page.$('app')));
      const input = page.$('search');
      input.value = 'ab';
      input.dispatchEvent(new page.window.Event('input'));
      await until(() => page.document.querySelectorAll('#results .row').length === 2, 'the results');
      // Roon is slow with the next one.
      roon.search = () => new Promise((resolve) => { answer = resolve; });
      input.value = 'abba';
      input.dispatchEvent(new page.window.Event('input'));
      await until(() => answer, 'the search to reach Roon');
      assert.strictEqual(page.document.querySelectorAll('#results .row').length, 0, 'the old results go');
      assert.strictEqual(page.document.querySelector('#results .empty').textContent, page.t('search.searching'));
      answer(searchResults.slice(0, 1));
      await until(() => page.document.querySelectorAll('#results .row').length === 1, 'the answer');
      assert.strictEqual(page.document.querySelector('#results .empty'), null);
      assert.deepStrictEqual(page.errors, []);
    } finally {
      roon.search = search;
      page.close();
      reset();
    }
  });

  await check('allowances on the buttons: "1 left", then used up: greyed, and pressing it explains', async () => {
    Object.assign(roon.settings, { add_limit: 1, allow_next: false });
    const page = await guestPage(named);
    try {
      await until(() => visible(page.$('app')));
      page.$('search').value = 'abba';
      page.$('search').dispatchEvent(new page.window.Event('input'));
      await until(() => page.document.querySelectorAll('#results .row').length === 2);
      page.document.querySelector('#results .row').click();
      const add = page.document.querySelector('#results .actions .pill-primary');
      assert.strictEqual(add.textContent, 'Add to queue · 1 left');
      assert.strictEqual(page.document.querySelectorAll('#results .actions button').length, 1, 'no Play next');
      add.click();
      await until(() => /Added to the queue/.test(page.$('toast').textContent));
      page.document.querySelectorAll('#results .row')[1].click();
      const spent = page.document.querySelector('#results .actions .pill-primary');
      assert.strictEqual(spent.getAttribute('aria-disabled'), 'true');
      spent.click();
      // A limit refills over time (lib/guests.js): it says when, as the button does.
      assert.match(spent.textContent, new RegExp(`^${page.t('track.add')} · ${page.t('button.wait', { wait: '\\d+ min' })}$`));
      assert.match(page.$('toast').textContent, new RegExp(`^${page.t('toast.none_left_wait', { wait: '(an? |\\d+ )minutes?' })}$`.replace('.', '\\.')));
      assert.strictEqual(roon.actions.length, 1, 'not sent');
    } finally {
      page.close();
      reset();
    }
  });

  /** Searches on the page and opens result `index`: its main button. */
  async function openResult(page, index = 0) {
    page.$('search').value = 'abba';
    page.$('search').dispatchEvent(new page.window.Event('input'));
    await until(() => page.document.querySelectorAll('#results .row').length >= 2, 'the results');
    page.document.querySelectorAll('#results .row')[index].click();
    return page.document.querySelector('#results .actions .pill-primary');
  }
  /** Presses `button` and waits for the toast to say `text`. */
  async function pressFor(page, button, text) {
    page.$('toast').textContent = '';
    button.click();
    await until(() => page.$('toast').textContent === text, `"${text}"`);
  }
  /** As this page's guest, from elsewhere (another tab): the server, directly. */
  const asGuest = (page, pathname, body) =>
    fetch(base + pathname, body === undefined ? { headers: { Cookie: page.cookie() } } : { method: 'POST', headers: { Cookie: page.cookie(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  await check('a refused request says why, and its button can be pressed again', async () => {
    Object.assign(roon.settings, { prevent_duplicates: true });
    const page = await guestPage(named);
    try {
      await until(() => visible(page.$('app')));
      const add = await openResult(page);
      // Each refusal comes after the page last heard, as when the host or Roon changes something.
      roon.currentMode = 'paused';
      await pressFor(page, add, page.t('allowance.paused'));
      assert.strictEqual(add.disabled, false);
      delete roon.currentMode;
      roon.settings.allow_add = false;
      await pressFor(page, add, page.t('toast.disabled'));
      roon.settings.allow_add = true;
      roon.failing = true;
      await pressFor(page, add, page.t('toast.failed'));
      roon.failing = false;
      play(waterloo);
      await pressFor(page, add, page.t('toast.already_queued'));
      assert.strictEqual(add.disabled, false);
      assert.deepStrictEqual(roon.actions, [], 'nothing reached Roon');
      play(null);
      await pressFor(page, add, page.t('toast.queued'));
      assert.deepStrictEqual(roon.actions, [{ key: '10:0', mode: 'add' }]);
      assert.deepStrictEqual(page.errors, []);
    } finally {
      page.close();
    }
  });

  await check('a request after the allowance was used elsewhere: says when more come, and greys the button', async () => {
    Object.assign(roon.settings, { add_limit: 1, add_period: 60 });
    const page = await guestPage(named);
    try {
      await until(() => visible(page.$('app')));
      const add = await openResult(page);
      assert.strictEqual(add.getAttribute('aria-disabled'), 'false');
      // Used from another tab: this page still says "1 left".
      assert.strictEqual((await asGuest(page, '/api/request', { key: '10:1', mode: 'add' })).status, 200);
      add.click();
      await until(() => /^You've used them all\. More in /.test(page.$('toast').textContent), 'the wait');
      assert.match(page.$('toast').textContent, new RegExp(`^${page.t('toast.none_left_wait', { wait: '(an? |\\d+ )minutes?' }).replace('.', '\\.')}$`));
      // The counts fetched again, so the button shows it's used up.
      await until(() => page.document.querySelector('#results .actions .pill-primary').getAttribute('aria-disabled') === 'true', 'the button greyed');
    } finally {
      page.close();
    }
  });

  await check('too many requests a minute: one note, not a second about the search', async () => {
    const page = await guestPage(named);
    try {
      await until(() => visible(page.$('app')));
      limits.search = 1;
      await openResult(page);
      page.$('toast').textContent = '';
      page.$('search').value = 'sos';
      page.$('search').dispatchEvent(new page.window.Event('input'));
      await until(() => page.$('toast').textContent === page.t('toast.too_many_requests'), 'the note');
      await sleep(100);
      assert.strictEqual(page.$('toast').textContent, page.t('toast.too_many_requests'));
    } finally {
      limits.search = 0;
      page.close();
    }
  });

  await check('a refused skip says why; one Roon will no longer do hides Skip', async () => {
    play(waterloo, [sos]);
    const page = await guestPage(named);
    try {
      await until(() => visible(page.$('skip')), 'Skip');
      const skip = page.$('skip');
      roon.currentMode = 'paused';
      await pressFor(page, skip, page.t('allowance.paused'));
      delete roon.currentMode;
      roon.failing = true;
      await pressFor(page, skip, page.t('toast.failed'));
      roon.failing = false;
      assert.strictEqual(roon.skips, 0);
      // Roon won't skip now (the last track, Roon Radio off), and the page hadn't heard.
      roon.zone = Object.assign({}, roon.zone, { is_next_allowed: false });
      await pressFor(page, skip, page.t('toast.failed'));
      await until(() => !visible(skip), 'Skip hidden, caught up');
    } finally {
      page.close();
    }
  });

  await check('a skip after the allowance was used elsewhere: says when more come', async () => {
    Object.assign(roon.settings, { skip_limit: 1, skip_period: 60 });
    play(waterloo, [sos, fernando]);
    const page = await guestPage(named);
    try {
      await until(() => visible(page.$('skip')), 'Skip');
      assert.strictEqual((await asGuest(page, '/api/skip', {})).status, 200);
      // Roon moves on: Skip now is for the next song.
      play(sos, [fernando]);
      await until(() => page.$('playing-title').textContent === 'SOS', 'the next song');
      page.$('skip').click();
      await until(() => /^You've used them all\. More in /.test(page.$('toast').textContent), 'the wait');
      assert.strictEqual(roon.skips, 1, 'only the other tab skipped');
    } finally {
      page.close();
    }
  });

  await check('every 30 seconds the page catches up: a name set in another tab shows', async () => {
    const timers = [];
    const page = await guestPage(Object.assign({}, named, {
      before(window) {
        const setInterval = window.setInterval.bind(window);
        window.setInterval = (fn, ms) => (timers.push({ fn, ms }), setInterval(fn, ms));
      }
    }));
    try {
      await until(() => timers.some((timer) => timer.ms === 30000), 'the 30-second refresh');
      await (await asGuest(page, '/api/name', { name: 'Elsewhere', confirm: true })).json();
      assert.strictEqual(page.$('name-chip').textContent, 'Add your name');
      timers.find((timer) => timer.ms === 30000).fn();
      await until(() => page.$('name-chip').textContent === 'Elsewhere', 'the new name');
    } finally {
      page.close();
    }
  });

  await check('Skip: only when the host allows it and Roon will skip; skips', async () => {
    play(waterloo, [sos]);
    const page = await guestPage(named);
    try {
      await until(() => visible(page.$('skip')), 'Skip');
      page.$('skip').click();
      await until(() => roon.skips === 1, 'the skip');
      await until(() => page.$('toast').textContent === 'Skipped');
      await page.live();
      play(waterloo, [sos], { is_next_allowed: false });
      await until(() => !visible(page.$('skip')), 'Skip hidden');
    } finally {
      page.close();
      reset();
    }
  });

  await check('Party Off: "Requests are closed", with the playlist while it is offered', async () => {
    const page = await guestPage(named);
    try {
      await until(() => visible(page.$('app')));
      await page.live();
      set({ enabled: false, playlist_download: 'link' });
      roon.emit('party_mode_changed', 'off', 'on');
      await until(() => visible(page.$('closed')), 'closed');
      assert.ok(!visible(page.$('app')));
      assert.ok(visible(page.$('closed-playlist')));
    } finally {
      page.close();
      reset();
    }
  });

  await check("Party Off keeps the party's name as the title, also when the page is opened again", async () => {
    const page = await guestPage(named);
    try {
      await until(() => visible(page.$('app')));
      assert.strictEqual(page.document.title, 'Garden Party');
      await page.live();
      set({ enabled: false, playlist_download: 'link' });
      roon.emit('party_mode_changed', 'off', 'on');
      await until(() => visible(page.$('closed')), 'closed');
      assert.strictEqual(page.document.title, 'Garden Party');
    } finally {
      page.close();
    }
    const again = await guestPage(named);
    try {
      await until(() => visible(again.$('closed')), 'closed');
      assert.strictEqual(again.document.title, 'Garden Party');
      assert.ok(visible(again.$('closed-playlist')));
    } finally {
      again.close();
    }
    // A party with no name: the guest page's own title, as during the party.
    roon.pageName = '';
    const unnamed = await guestPage(named);
    try {
      await until(() => visible(unnamed.$('closed')), 'closed');
      assert.strictEqual(unnamed.document.title, unnamed.t('page.title'));
    } finally {
      unnamed.close();
      roon.pageName = 'Garden Party';
    }
  });

  await check('paused: a note under the search box says so', async () => {
    const page = await guestPage(named);
    try {
      await until(() => visible(page.$('app')));
      await page.live();
      roon.currentMode = 'paused';
      roon.emit('party_mode_changed', 'paused', 'on');
      await until(() => visible(page.$('notice')), 'the note');
      assert.strictEqual(page.$('notice').textContent, page.t('allowance.paused'));
    } finally {
      page.close();
      reset();
    }
  });

  await check('without a session (a link shared, not scanned): tries once more, then "Scan the code again"', async () => {
    // jsdom ignores a move to the address it is on, so the link carries a little more.
    const page = await open('/GuestHub?shared', Object.assign({}, named, {
      before(window) {
        // As if the session cookie had gone.
        window.fetch = (input) => globalThis.fetch(new URL(input, window.location.href));
      }
    }));
    try {
      await until(() => page.navigations.length === 1, 'opening /GuestHub again');
      assert.ok(page.window.sessionStorage.getItem('partyMode.rejoined'));
    } finally {
      page.close();
    }
    const again = await open('/GuestHub?shared', Object.assign({}, named, {
      before(window) {
        window.sessionStorage.setItem('partyMode.rejoined', String(Date.now()));
        window.fetch = (input) => globalThis.fetch(new URL(input, window.location.href));
      }
    }));
    try {
      await until(() => visible(again.$('locked')), 'Scan the code again');
      assert.deepStrictEqual(again.navigations, []);
      assert.strictEqual(again.document.title, again.t('locked.title'));
      assert.ok(!visible(again.$('app')));
    } finally {
      again.close();
    }
  });

  await check('invites: the party name shows the join code; off, it is just the name', async () => {
    let page = await guestPage(named);
    try {
      await until(() => visible(page.$('party-chip')), 'the party chip');
      assert.strictEqual(page.$('party-chip-name').textContent, 'Garden Party');
      page.$('party-chip').click();
      assert.ok(visible(page.$('invite')));
      assert.match(page.$('invite-qr').getAttribute('src'), /^\/embed\/join-qr\.svg\?t=\d+$/);
      assert.strictEqual(page.document.activeElement, page.$('invite-close'));
      page.$('invite-close').click();
      assert.ok(!visible(page.$('invite')));
    } finally {
      page.close();
    }
    Object.assign(roon.settings, { guest_invite: false });
    page = await guestPage(named);
    try {
      await until(() => visible(page.$('party-label')), 'the name alone');
      assert.ok(!visible(page.$('party-chip')));
      assert.strictEqual(page.$('party-label-name').textContent, 'Garden Party');
    } finally {
      page.close();
      reset();
    }
  });

  await check('languages: Automatic, then each by its own name; choosing one sets the cookie and reloads', async () => {
    const page = await guestPage(named);
    try {
      await until(() => visible(page.$('app')));
      page.$('lang-chip').click();
      assert.ok(visible(page.$('language')));
      const buttons = [...page.document.querySelectorAll('#language-list button')];
      assert.strictEqual(buttons[0].textContent, 'Automatic');
      assert.strictEqual(buttons[0].getAttribute('aria-current'), 'true');
      const french = buttons.find((b) => b.lang === 'fr');
      assert.strictEqual(french.textContent, 'Français');
      french.click();
      assert.match(page.document.cookie, /party_lang=fr/);
      assert.strictEqual(page.navigations.length, 1);
    } finally {
      page.close();
    }
  });

  await check('the language dialog: Cancel, Escape or the current language close it, back on the globe', async () => {
    const page = await guestPage(named);
    try {
      await until(() => visible(page.$('app')));
      const chip = page.$('lang-chip');
      chip.focus();
      chip.click();
      page.$('language-cancel').click();
      assert.ok(!visible(page.$('language')));
      assert.strictEqual(page.document.activeElement, chip);
      chip.click();
      page.document.dispatchEvent(new page.window.KeyboardEvent('keydown', { key: 'Escape' }));
      assert.ok(!visible(page.$('language')));
      chip.click();
      page.document.querySelector('#language-list [aria-current]').click();
      assert.ok(!visible(page.$('language')));
      assert.deepStrictEqual(page.navigations, [], 'no reload for the language already in use');
    } finally {
      page.close();
    }
  });

  await check('Tab and Shift+Tab stay inside an open dialog', async () => {
    const page = await guestPage({
      // jsdom lays nothing out: every element shown counts as on screen.
      before(window) {
        window.Element.prototype.getClientRects = function () {
          return this.closest('[hidden]') ? [] : [{}];
        };
      }
    });
    try {
      await until(() => visible(page.$('nickname')), 'the name dialog');
      const { document, window } = page;
      const tab = (shiftKey = false) => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', shiftKey, cancelable: true }));
      const first = page.$('nickname-input');
      const last = page.$('nickname-skip');
      last.focus();
      tab();
      assert.strictEqual(document.activeElement, first, 'from the last, Tab goes to the first');
      tab(true);
      assert.strictEqual(document.activeElement, last, 'from the first, Shift+Tab goes to the last');
      page.$('search').focus();
      tab();
      assert.strictEqual(document.activeElement, first, 'from outside, back in');
      page.$('nickname-go').focus();
      tab();
      assert.strictEqual(document.activeElement, page.$('nickname-go'), 'in between, the browser moves on as usual');
    } finally {
      page.close();
    }
  });

  await check('in the language chosen: the page text, and the language marked current', async () => {
    const page = await guestPage(Object.assign({ lang: 'de' }, named));
    try {
      await until(() => visible(page.$('app')));
      assert.strictEqual(page.document.documentElement.lang, 'de');
      assert.strictEqual(page.$('search').getAttribute('placeholder'), JSON.parse(fs.readFileSync(path.join(PUBLIC, 'i18n', 'de.json'), 'utf8'))['search.placeholder']);
      page.$('lang-chip').click();
      const current = page.document.querySelector('#language-list [aria-current]');
      assert.strictEqual(current.lang, 'de');
      assert.strictEqual(page.document.activeElement, current);
    } finally {
      page.close();
    }
  });

  console.log('\npages: marquee.js');

  // Text that doesn't fit: 10 px a character in a 100 px space.
  const measured = (window) => {
    Object.defineProperty(window.HTMLElement.prototype, 'scrollWidth', { configurable: true, get() { return this.textContent.length * 10; } });
    Object.defineProperty(window.HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 100 });
  };
  const long = track(9, 'A track with a very long title indeed', 'ABBA');

  await check('a name that does not fit scrolls, once wrapped; one that fits is left alone', async () => {
    play(long, [sos]);
    const page = await open('/PartyHub', { before: measured });
    try {
      await until(() => page.document.querySelector('.current-title .marquee-inner'), 'the long title to scroll');
      const title = page.$('current-title');
      assert.ok(title.classList.contains('marquee-on'));
      const inner = title.querySelector('.marquee-inner');
      assert.strictEqual(inner.textContent, long.three_line.line1);
      assert.strictEqual(inner.style.getPropertyValue('--marquee-shift'), `${-(long.three_line.line1.length * 10 - 100)}px`);
      assert.match(inner.style.getPropertyValue('--marquee-time'), /^\d+\.\d\ds$/);
      assert.ok(!page.$('current-artist').querySelector('.marquee-inner'), 'ABBA fits');
      // Its turn over, it stops with the "…" back.
      inner.dispatchEvent(new page.window.Event('animationend'));
      assert.ok(!title.querySelector('.marquee-inner'));
      assert.strictEqual(title.textContent, long.three_line.line1);
      assert.ok(!title.classList.contains('marquee-on'));
    } finally {
      page.close();
      reset();
    }
  });

  await check('with reduced motion, nothing scrolls', async () => {
    play(long);
    const page = await open('/PartyHub', { before: measured, reducedMotion: true });
    try {
      await until(() => page.$('current-title').textContent === long.three_line.line1);
      await sleep(100);
      assert.ok(!page.document.querySelector('.marquee-inner'));
    } finally {
      page.close();
      reset();
    }
  });

  await check('on the guest page, a long track name in the results scrolls too', async () => {
    searchResults.push({ item_key: '10:2', title: long.three_line.line1, subtitle: 'ABBA', hint: 'action_list' });
    const page = await guestPage(Object.assign({ before: measured }, named));
    try {
      await until(() => visible(page.$('app')));
      page.$('search').value = 'abba';
      page.$('search').dispatchEvent(new page.window.Event('input'));
      await until(() => page.document.querySelector('#results .row-title .marquee-inner'), 'the long result to scroll');
    } finally {
      page.close();
      searchResults.pop();
    }
  });

  console.log('\npages: the About page (about.js)');

  // Connected to a Core, so the page has the Party Hub's address to copy.
  roon.core = {};

  await check('Copy details: the sections as plain text, ready to paste', async () => {
    const page = await open('/About');
    try {
      const button = page.$('copy-details');
      assert.ok(visible(button));
      button.click();
      assert.strictEqual(page.window.copied.length, 1);
      const text = page.window.copied[0];
      const details = page.document.querySelector('.details');
      assert.ok(text.startsWith(`${details.dataset.title}\n\n`), text.slice(0, 80));
      const first = details.querySelector('section');
      assert.ok(text.includes(`\n${first.querySelector('h2').textContent}\n`));
      const row = first.querySelector('tr');
      assert.ok(text.includes(`${row.cells[0].textContent}: `));
      assert.strictEqual(page.$('copied').textContent, 'Copied');
      assert.ok(!page.document.querySelector('textarea'), 'the hidden box is removed');
      assert.deepStrictEqual(page.errors, []);
    } finally {
      page.close();
    }
  });

  await check("Copy the Party Hub's address; when copying fails, says to copy it by hand", async () => {
    let page = await open('/About');
    try {
      const hub = page.$('copy-hub');
      assert.ok(visible(hub));
      hub.click();
      assert.deepStrictEqual(page.window.copied, [hub.dataset.url]);
      assert.match(hub.dataset.url, /\/PartyHub$/);
      assert.strictEqual(page.$('hub-copied').textContent, 'Copied');
    } finally {
      page.close();
    }
    page = await open('/About', { copyWorks: false });
    try {
      page.$('copy-hub').click();
      assert.strictEqual(page.$('hub-copied').textContent, "Couldn't copy: select the address and copy it yourself");
      page.$('copy-details').click();
      assert.strictEqual(page.$('copied').textContent, "Couldn't copy: select the details and copy them yourself");
    } finally {
      page.close();
    }
  });

  await check('over https (a secure context), the clipboard is used', async () => {
    const written = [];
    const page = await open('/About', {
      before(window) {
        Object.defineProperty(window, 'isSecureContext', { value: true });
        Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: (text) => (written.push(text), Promise.resolve()) } });
      }
    });
    try {
      page.$('copy-hub').click();
      await until(() => page.$('hub-copied').textContent === 'Copied');
      assert.deepStrictEqual(written, [page.$('copy-hub').dataset.url]);
      assert.deepStrictEqual(page.window.copied, [], 'not the fallback');
    } finally {
      page.close();
    }
  });

  server.close && server.close();
  display.close();
  if (failures) {
    console.log(`\n${failures} failing`);
    process.exit(1);
  }
  console.log('\nall passing');
  process.exit(0);
})();
