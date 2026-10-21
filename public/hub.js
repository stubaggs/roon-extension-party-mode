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

  function art(key, size) {
    return key ? `/api/image/${encodeURIComponent(key)}?size=${size}` : '';
  }

  // Beside the playing track, the cover's top is level with the middle of the
  // "Playing now" line (the credit is on it too), and its bottom with the middle
  // of the album line when the track has one. It keeps that size for every
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
    const middle = (line) => {
      const box = line.getBoundingClientRect();
      return (box.top + box.bottom) / 2 - top;
    };
    const from = middle(el('current-label'));
    const size = middle(el('current-album')) - from;
    for (const line of added) {
      line.textContent = '';
      line.hidden = true;
    }
    image.style.marginTop = `${from}px`;
    image.style.width = `${size}px`;
    image.style.height = `${size}px`;
  }

  window.addEventListener('resize', alignArt);

  function render(data) {
    // The host chose another language for the Hub in Roon's settings.
    if (data.language && data.language !== window.I18N.lang) {
      window.location.reload();
      return;
    }
    window.I18N.setHostName(data.host_name);
    const name = data.party_name || t('party.default_name');
    el('party-name').textContent = name;
    // "Garden Party Hub" in the tab, a bookmark or on a tablet's home screen.
    document.title = t('page.hub_title', { name }).replace(/[\u2068\u2069]/g, '');
    if (data.join_url) el('join-link').href = data.join_url;
    // Party Off ends the party: no QR code that no longer works, but
    // the playlist, as a QR code or a link as the host chose, and "Requests
    // are closed" where the playing track was. Paused keeps the code but says so.
    const over = data.party_mode === 'off';
    el('join-open').hidden = over;
    el('join-closed').hidden = !over;
    el('closed').hidden = !over;
    el('current').hidden = over;
    const qr = el('playlist-qr-offer');
    // The playlist's address is secret, new with each playlist: the server
    // sends it only once requests close, and only to offer it.
    const download = data.playlist_url || '';
    const showQr = over && data.playlist === 'qr' && Boolean(download);
    // Loaded each time it appears, so the code follows a change of address or port.
    if (showQr && qr.hidden) el('playlist-qr').src = `/Download/playlist-qr.svg?t=${Date.now()}`;
    qr.hidden = !showQr;
    for (const id of ['playlist-qr-link', 'playlist-link-offer']) {
      if (download) el(id).href = download;
      else el(id).removeAttribute('href');
    }
    el('playlist-link-offer').hidden = !(over && data.playlist === 'link' && download);
    el('join-link').textContent = data.party_mode === 'paused' ? t('allowance.paused') : t('screen.scan');

    const playing = data.now_playing;
    el('current-title').textContent = playing ? playing.title : t('playing.nothing');
    el('current-artist').textContent = playing ? playing.artist : '';
    // Already in what Roon sends; radio streams and some tracks have none.
    const album = el('current-album');
    album.textContent = (playing && playing.album) || '';
    album.hidden = !album.textContent;
    const who = el('current-who');
    who.hidden = !(playing && playing.kind);
    const radio = !who.hidden && playing.kind === 'radio';
    who.textContent = who.hidden ? '' : window.I18N.requestedBy(playing);
    who.classList.toggle('radio', radio);
    who.classList.toggle('next', !who.hidden && playing.kind === 'next');
    who.classList.toggle('host', !who.hidden && playing.kind === 'host');
    el('current-label').textContent =
      !playing || playing.state !== 'playing'
        ? t('playing.paused')
        : playing.station
          ? t('playing.station')
          : t('playing.now');
    // Requests wait while a radio station plays; the room should know. Paused,
    // the caption under the QR code already says requests are on hold.
    el('current-note').hidden = !(playing && playing.station) || data.party_mode === 'paused';
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
  }

  async function refresh() {
    const res = await fetch('/api/hub');
    if (res.ok) render(await res.json());
  }

  refresh();

  const events = new EventSource('/api/events');
  events.addEventListener('queue', refresh);
  events.addEventListener('party', () => {
    el('qr').src = `/api/qr.svg?t=${Date.now()}`;
    refresh();
  });

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
