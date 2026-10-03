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

    const playing = data.now_playing;
    el('current-title').textContent = playing ? playing.title : t('playing.nothing');
    el('current-artist').textContent = playing ? playing.artist : '';
    const who = el('current-who');
    who.hidden = !(playing && playing.kind);
    const radio = !who.hidden && playing.kind === 'radio';
    who.textContent = who.hidden ? '' : window.I18N.requestedBy(playing);
    who.classList.toggle('radio', radio);
    el('current-label').textContent =
      playing && playing.state === 'playing' ? t('playing.now') : t('playing.paused');
    const image = el('current-art');
    if (playing && playing.image_key) image.src = art(playing.image_key, 400);
    else image.removeAttribute('src');

    list.innerHTML = '';
    data.upcoming.slice(0, 2).forEach((item, index) => {
      const li = document.createElement('li');

      const n = document.createElement('span');
      n.className = 'n';
      n.textContent = String(index + 1);

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

      li.append(n, wrap);
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
