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

(function () {
  'use strict';

  const el = (id) => document.getElementById(id);
  const { t } = window.I18N;
  const list = el('list');

  function art(key, size) {
    return key ? `/api/image/${encodeURIComponent(key)}?size=${size}` : '';
  }

  function render(data) {
    el('party-name').textContent = data.party_name || t('party.default_name');
    if (data.join_url) el('join-link').href = data.join_url;
    // Party mode off ends the party: no QR code that no longer works, but
    // the playlist, as a QR code or a link as the host chose, and "Requests
    // are closed" where the playing track was. Paused keeps the code but says so.
    const over = data.party_mode === 'off';
    el('join-open').hidden = over;
    el('join-closed').hidden = !over;
    el('closed').hidden = !over;
    el('current').hidden = over;
    const qr = el('playlist-qr-offer');
    const showQr = over && data.playlist === 'qr';
    // Loaded each time it appears, so the code follows a change of address or port.
    if (showQr && qr.hidden) el('playlist-qr').src = `/api/playlist-qr.svg?t=${Date.now()}`;
    qr.hidden = !showQr;
    el('playlist-link-offer').hidden = !(over && data.playlist === 'link');
    el('join-link').textContent = data.party_mode === 'paused' ? t('allowance.paused') : t('screen.scan');

    const playing = data.now_playing;
    el('current-title').textContent = playing ? playing.title : t('playing.nothing');
    el('current-artist').textContent = playing ? playing.artist : '';
    const who = el('current-who');
    who.hidden = !(playing && playing.kind);
    const radio = !who.hidden && playing.kind === 'radio';
    who.textContent = who.hidden ? '' : window.I18N.requestedBy(playing);
    who.classList.toggle('radio', radio);
    who.classList.toggle('next', !who.hidden && playing.kind === 'next');
    el('current-label').textContent =
      playing && playing.state === 'playing' ? t('playing.now') : t('playing.paused');
    const image = el('current-art');
    if (playing && playing.image_key) image.src = art(playing.image_key, 400);
    else image.removeAttribute('src');

    list.innerHTML = '';
    if (!data.upcoming.length) {
      const empty = document.createElement('li');
      empty.className = 'empty muted';
      empty.textContent = t('queue.empty');
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
        who.className = item.kind === 'next' || item.kind === 'radio' ? `who ${item.kind}` : 'who';
        who.textContent = window.I18N.credit(item);
        wrap.appendChild(who);
      }

      li.append(n, cover, wrap);
      list.appendChild(li);
    });
  }

  async function refresh() {
    const res = await fetch('/api/roonparty');
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
})();
