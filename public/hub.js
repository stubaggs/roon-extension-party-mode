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

(function () {
  'use strict';

  const el = (id) => document.getElementById(id);
  const { t } = window.I18N;
  const list = el('list');

  // 1% of the height the page really has, for hub.css's --vh: an iPad's Safari
  // counts its tab and address bars in 100vh, which cut the Hub off.
  function measureHeight() {
    document.documentElement.style.setProperty('--vh', `${window.innerHeight / 100}px`);
  }
  measureHeight();
  window.addEventListener('resize', measureHeight);

  function art(key, size) {
    return key ? `/api/image/${encodeURIComponent(key)}?size=${size}` : '';
  }

  // Beside the playing track, the cover's top is level with the top of the
  // "Playing now" line, and its bottom with the bottom of the album line when
  // the track has one. It keeps that size for every
  // track; without an album, the space below stays empty. Phones lay it out
  // their own way.
  const wide = window.matchMedia('(min-width: 721px)');
  function alignArt() {
    const image = el('current-art');
    image.style.width = '';
    image.style.height = '';
    image.style.marginTop = '';
    if (!wide.matches || el('current').hidden) return;
    // Measured with an album line, put in for the moment if the track has
    // none: it's taken out again before the page is drawn.
    const added = [el('current-album')].filter((line) => line.hidden);
    for (const line of added) {
      line.textContent = '\u00a0';
      line.hidden = false;
    }
    const top = document.querySelector('.current-text').getBoundingClientRect().top;
    const from = el('current-label').getBoundingClientRect().top - top;
    const size = el('current-album').getBoundingClientRect().bottom - top - from;
    for (const line of added) {
      line.textContent = '';
      line.hidden = true;
    }
    image.style.marginTop = `${from}px`;
    image.style.width = `${size}px`;
    image.style.height = `${size}px`;
  }

  window.addEventListener('resize', alignArt);

  // The QR code is up to 60% of the screen's height (hub.css). A long party
  // name, over two or three lines, can leave less room than that down the left:
  // then the code gives way, so the name, the code and its caption still fit.
  const join = document.querySelector('.join');
  function fitQr() {
    const codes = [...join.querySelectorAll('.qr')];
    for (const code of codes) code.style.width = '';
    if (!wide.matches) return;
    const parts = [...join.children].filter((part) => !part.hidden);
    const used = parts[parts.length - 1].getBoundingClientRect().bottom - parts[0].getBoundingClientRect().top;
    const over = used - join.clientHeight;
    if (over <= 0) return;
    // Never smaller than 10rem: from there, the name gives way instead.
    const least = 10 * parseFloat(getComputedStyle(document.documentElement).fontSize);
    for (const code of codes) {
      if (code.offsetParent) code.style.width = `${Math.max(code.offsetWidth - over, least)}px`;
    }
  }
  // Again whenever the room changes: the window, or the name's lines.
  if ('ResizeObserver' in window) {
    const watch = new ResizeObserver(fitQr);
    watch.observe(join);
    watch.observe(el('party-name'));
  } else window.addEventListener('resize', fitQr);

  // Up next shows as many whole tracks as fit, never part of one: a screen
  // can't be scrolled. Phones scroll the page instead, and show them all.
  // The room a track didn't fit in is shared above and below the right-hand
  // side (hub.css, --shift), so it sits in the middle, as the code does.
  const stage = document.querySelector('.stage');
  function fitRows() {
    const rows = [...list.children];
    for (const row of rows) row.hidden = false;
    stage.style.setProperty('--shift', '0px');
    if (!wide.matches) return;
    const bottom = list.getBoundingClientRect().bottom;
    for (const row of rows) row.hidden = row.getBoundingClientRect().bottom > bottom + 0.5;
    const shown = rows.filter((row) => !row.hidden);
    if (shown.length < rows.length && shown.length) {
      const left = bottom - shown[shown.length - 1].getBoundingClientRect().bottom;
      stage.style.setProperty('--shift', `${Math.floor(left / 2)}px`);
    }
  }

  // Again whenever the list's room changes: the window, or what's above it.
  if ('ResizeObserver' in window) new ResizeObserver(fitRows).observe(list);
  else window.addEventListener('resize', fitRows);

  // And once the page has loaded: an iPad's Safari can report its height
  // before its bars settle, leaving the right-hand side too high.
  function relayout() {
    measureHeight();
    alignArt();
    fitRows();
    fitQr();
  }
  window.addEventListener('load', () => {
    relayout();
    setTimeout(relayout, 500);
  });
  window.addEventListener('pageshow', relayout);

  // Turning a tablet, or resizing a window, past a phone's width.
  wide.addEventListener('change', () => arrange());

  // Roon Display (Party Hub now playing): Roon's display page in place of
  // what's playing. Sandboxed: the page runs its scripts and keeps its own
  // storage (Roon's remembers its zone), but can't open windows or move the
  // Hub away. Added once, so it isn't reloaded with every update.
  let frameLoaded = false;
  function showFrame(url) {
    const box = el('frame-box');
    if (!url || box.firstChild) return;
    const frame = document.createElement('iframe');
    frame.className = 'frame';
    frame.title = t('playing.now');
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
    frame.referrerPolicy = 'no-referrer';
    frame.addEventListener('load', () => {
      frameLoaded = true;
      arrange();
    });
    frame.src = url;
    box.appendChild(frame);
  }

  // The frame's address the Hub loaded with: its security policy lets it frame
  // that page's site only, so another address reloads the Hub.
  let frameUrl;

  /**
   * The frame or Playing now, and "Requests are closed" in their place with
   * Party Off, in the middle of the space Up next leaves: the party is over. Playing now stands in for the frame until its page has loaded,
   * and while Party Mode finds that it doesn't answer (frame_ok). A phone
   * always has Playing now: the frame's page is too small to read there, and
   * isn't loaded until the screen is wide enough, so a phone doesn't appear in
   * Roon's Displays.
   */
  let latest = null;
  function arrange() {
    if (!latest) return;
    const over = latest.party_mode === 'off';
    if (wide.matches) showFrame(frameUrl);
    const framed = wide.matches && Boolean(frameUrl) && latest.frame_ok === true && frameLoaded;
    el('closed').hidden = !over;
    el('frame-slot').hidden = over || !framed;
    el('current').hidden = over || framed;
    document.querySelector('.upnext').hidden = over;
    stage.classList.toggle('over', over);
    stage.classList.toggle('framed', !over && framed);
    alignArt();
    fitQr();
  }

  /** Who asked for the playing track, and the note while a station plays. */
  function showCredit(who, note, playing, paused) {
    who.hidden = !(playing && playing.kind);
    who.textContent = who.hidden ? '' : window.I18N.requestedBy(playing);
    who.classList.toggle('radio', !who.hidden && playing.kind === 'radio');
    who.classList.toggle('next', !who.hidden && playing.kind === 'next');
    who.classList.toggle('host', !who.hidden && playing.kind === 'host');
    // Requests wait while a radio station plays; the room should know. Paused,
    // the caption under the QR code already says requests are on hold.
    note.hidden = !(playing && playing.station) || paused;
  }

  function render(data) {
    // The host chose another language for the Hub in Roon's settings.
    if (data.language && data.language !== window.I18N.lang) {
      window.location.reload();
      return;
    }
    // The host changed Party Hub now playing, or the Core's address changed.
    const frame = data.frame_url || '';
    if (frameUrl !== undefined && frame !== frameUrl) {
      window.location.reload();
      return;
    }
    frameUrl = frame;
    latest = data;
    window.I18N.setHostName(data.host_name);
    const name = data.party_name || t('party.default_name');
    el('party-name').textContent = name;
    // "Garden Party Hub" in the tab, a bookmark or on a tablet's home screen.
    document.title = t('page.hub_title', { name }).replace(/[\u2068\u2069]/g, '');
    // Party Off ends the party: no QR code that no longer works, but
    // the playlist, as a QR code or a link as the host chose, and "Requests
    // are closed" where the playing track was. Paused keeps the code but says so.
    const over = data.party_mode === 'off';
    el('join-open').hidden = over;
    el('join-closed').hidden = !over;
    arrange();
    const qr = el('playlist-qr-offer');
    // The playlist, at /Playlist, which works only while it's offered.
    const showQr = over && data.playlist === 'qr';
    // Loaded each time it appears, so the code follows a change of address or port.
    if (showQr && qr.hidden) el('playlist-qr').src = `/embed/playlist-qr.svg?t=${Date.now()}`;
    qr.hidden = !showQr;
    el('playlist-link-offer').hidden = !(over && data.playlist === 'link');
    el('join-link').textContent = data.party_mode === 'paused' ? t('allowance.paused') : t('screen.scan');

    const playing = data.now_playing;
    el('current-title').textContent = playing ? playing.title : t('playing.nothing');
    el('current-artist').textContent = playing ? playing.artist : '';
    // Already in what Roon sends; radio streams and some tracks have none.
    const album = el('current-album');
    album.textContent = (playing && playing.album) || '';
    album.hidden = !album.textContent;
    const paused = data.party_mode === 'paused';
    showCredit(el('current-who'), el('current-note'), playing, paused);
    showCredit(el('frame-who'), el('frame-note'), playing, paused);
    el('current-label').textContent = el('frame-label').textContent =
      !playing || playing.state !== 'playing'
        ? t('playing.paused')
        : playing.station
          ? t('playing.station')
          : t('playing.now');
    const image = el('current-art');
    alignArt();
    // 400 pixels is sharp up to a 4K screen; only a cover drawn bigger than
    // that (an 8K one) asks for 800, which is four times the bytes.
    const drawn = image.getBoundingClientRect().width * (window.devicePixelRatio || 1);
    if (playing && playing.image_key) image.src = art(playing.image_key, drawn > 400 ? 800 : 400);
    else image.removeAttribute('src');

    list.innerHTML = '';
    if (!data.upcoming.length) {
      const empty = document.createElement('li');
      empty.className = 'empty muted';
      empty.textContent = t(data.empty || 'queue.empty');
      list.appendChild(empty);
    }
    data.upcoming.forEach((item, index) => {
      const li = document.createElement('li');

      const n = document.createElement('span');
      n.className = 'n';
      n.textContent = String(index + 1);
      // The list is numbered already; don't read the number twice.
      n.setAttribute('aria-hidden', 'true');

      // A blank tile when Roon has no cover, so the titles stay in line.
      const cover = document.createElement('img');
      cover.className = 'art cover';
      cover.alt = '';
      cover.loading = 'lazy';
      if (item.image_key) cover.src = art(item.image_key, 120);

      const wrap = document.createElement('div');
      const title = document.createElement('div');
      title.className = 't';
      title.textContent = item.title;
      const a = document.createElement('div');
      a.className = 'a';
      a.textContent = item.artist;
      wrap.append(title, a);
      if (item.kind) {
        const who = document.createElement('span');
        who.className = ['next', 'radio', 'host'].includes(item.kind) ? `who ${item.kind}` : 'who';
        who.textContent = window.I18N.credit(item);
        wrap.appendChild(who);
      }

      li.append(n, cover, wrap);
      list.appendChild(li);
    });
    fitRows();
    // The join code or the playlist's, as the party's state says.
    fitQr();
  }

  async function refresh() {
    const res = await fetch('/api/hub');
    if (res.ok) render(await res.json());
  }

  refresh();

  const events = new EventSource('/api/events');
  events.addEventListener('queue', refresh);
  // The join code is the same for every party (/GuestHub), so it stays as loaded.
  events.addEventListener('party', refresh);

  setInterval(refresh, 30000);

  // The corner menu: opened by its button, closed by Escape, a click elsewhere
  // or choosing an item.
  const menuButton = el('menu-button');
  const menu = el('menu');
  function showMenu(open) {
    menu.hidden = !open;
    menuButton.setAttribute('aria-expanded', String(open));
  }
  menuButton.addEventListener('click', () => showMenu(menu.hidden));
  menu.addEventListener('click', (event) => {
    if (event.target.closest('a')) showMenu(false);
  });
  document.addEventListener('click', (event) => {
    if (!menu.hidden && !event.target.closest('.hub-menu')) showMenu(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !menu.hidden) {
      showMenu(false);
      menuButton.focus();
    }
  });
})();
