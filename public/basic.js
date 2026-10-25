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

/**
 * The basic Party Hub (basic.html), for TV browsers years behind: plain ES5,
 * XMLHttpRequest, and live updates where the browser has EventSource (else
 * every 10 seconds). The same /api/hub as the Party Hub; no frame, no menu.
 */
(function () {
  'use strict';

  var I18N = window.I18N;
  var t = I18N.t;
  var ROWS = 6;

  function el(id) {
    return document.getElementById(id);
  }

  // The 1920 by 1080 design (120 by 67.5 rem) as large as the window allows,
  // centred: the root font size scales every size on the page.
  function fit() {
    var width = window.innerWidth || document.documentElement.clientWidth;
    var height = window.innerHeight || document.documentElement.clientHeight;
    var rem = Math.min(width / 120, height / 67.5);
    document.documentElement.style.fontSize = rem + 'px';
    var stage = el('stage');
    stage.style.left = Math.floor((width - 120 * rem) / 2) + 'px';
    stage.style.top = Math.floor((height - 67.5 * rem) / 2) + 'px';
  }
  fit();
  window.addEventListener('resize', fit);

  // A long party name gets smaller until it fits its box (two lines at full
  // size, three at the smallest); longer still, it ends with an ellipsis.
  var NAME_SIZES = [3.4, 3, 2.6, 2.3];
  function fitName() {
    var name = el('party-name');
    name.className = 'party-name';
    for (var i = 0; i < NAME_SIZES.length; i += 1) {
      name.style.fontSize = NAME_SIZES[i] + 'rem';
      if (name.scrollHeight <= name.clientHeight + 1) return;
    }
    name.className = 'party-name clamped';
  }
  window.addEventListener('resize', fitName);

  function art(key, size) {
    return '/api/image/' + encodeURIComponent(key) + '?size=' + size;
  }

  function setText(id, text) {
    el(id).textContent = text || '';
  }

  /** Who asked for a track: a class for its colour, as on the Party Hub. */
  function creditClass(kind) {
    return kind === 'next' || kind === 'radio' || kind === 'host' ? 'who ' + kind : 'who';
  }

  function row(item) {
    var li = document.createElement('li');
    var cover = document.createElement('img');
    cover.className = 'art cover';
    cover.alt = '';
    if (item.image_key) cover.src = art(item.image_key, 120);
    var text = document.createElement('div');
    text.className = 'text';
    var title = document.createElement('div');
    title.className = 't';
    title.textContent = item.title;
    var artist = document.createElement('div');
    artist.className = 'a';
    artist.textContent = item.artist;
    text.appendChild(title);
    text.appendChild(artist);
    li.appendChild(cover);
    li.appendChild(text);
    if (item.kind) {
      var who = document.createElement('p');
      who.className = creditClass(item.kind) + ' line';
      who.textContent = I18N.credit(item);
      li.appendChild(who);
    }
    return li;
  }

  var shownArt = null;
  var playlistShown = false;

  function render(data) {
    // The host chose another language for the Hub in Roon's settings.
    if (data.language && data.language !== I18N.lang) {
      window.location.reload();
      return;
    }
    I18N.setHostName(data.host_name);
    var name = data.party_name || t('party.default_name');
    setText('party-name', name);
    fitName();
    document.title = t('page.hub_title', { name: name }).replace(/[⁨⁩]/g, '');

    // Party Off: the playlist's code (if the host offers it as one) in place of
    // the code to join, and "Requests are closed" in place of the rest.
    var over = data.party_mode === 'off';
    var showQr = over && data.playlist === 'qr';
    el('join-open').hidden = over;
    // Loaded each time it appears, so the code follows a change of address or port.
    if (showQr && !playlistShown) el('playlist-qr').src = '/embed/playlist-qr.svg?t=' + Date.now();
    playlistShown = showQr;
    el('playlist-qr-offer').hidden = !showQr;
    el('current').hidden = over;
    el('upnext').hidden = over;
    el('closed').hidden = !over;
    setText('join-copy', data.party_mode === 'paused' ? t('allowance.paused') : t('screen.scan'));

    var playing = data.now_playing;
    setText('current-label', !playing || playing.state !== 'playing' ? t('playing.paused') : playing.station ? t('playing.station') : t('playing.now'));
    setText('current-title', playing ? playing.title : t('playing.nothing'));
    setText('current-artist', playing && playing.artist);
    setText('current-album', playing && playing.album);
    var who = el('current-who');
    who.hidden = !(playing && playing.kind);
    who.className = (playing && playing.kind ? creditClass(playing.kind) : 'who') + ' line';
    who.textContent = who.hidden ? '' : I18N.requestedBy(playing);
    // Requests wait while a radio station plays; paused, the caption says so already.
    el('current-note').hidden = !(playing && playing.station) || data.party_mode === 'paused';
    var key = playing && playing.image_key;
    var image = el('current-art');
    if (key !== shownArt) {
      if (key) image.src = art(key, 400);
      else image.removeAttribute('src');
      shownArt = key;
    }

    var list = el('list');
    while (list.firstChild) list.removeChild(list.firstChild);
    var upcoming = data.upcoming || [];
    if (!upcoming.length) {
      var empty = document.createElement('li');
      empty.className = 'empty';
      empty.textContent = t(data.empty || 'queue.empty');
      list.appendChild(empty);
    }
    for (var i = 0; i < upcoming.length && i < ROWS; i += 1) list.appendChild(row(upcoming[i]));
    // "499 tracks" when more are queued than show; "500+" at the most Roon sends.
    var count = el('upnext-count');
    count.hidden = upcoming.length <= ROWS;
    var text = count.hidden ? '' : t('queue.count', { count: upcoming.length });
    count.textContent = data.queue_full ? text.replace(String(upcoming.length), upcoming.length + '+') : text;
  }

  // The view this screen's address chose, so /api/hub doesn't look for Roon's page.
  var api = '/api/hub?view=basic';
  var busy = false;
  var again = false;

  // One request at a time; an update meanwhile asks again once it's back.
  function refresh() {
    if (busy) {
      again = true;
      return;
    }
    busy = true;
    var request = new XMLHttpRequest();
    request.open('GET', api);
    request.onreadystatechange = function () {
      if (request.readyState !== 4) return;
      busy = false;
      if (again) {
        again = false;
        refresh();
      }
      if (request.status !== 200) return;
      try {
        render(JSON.parse(request.responseText));
      } catch (err) {
        /* the next update tries again */
      }
    };
    request.send();
  }

  refresh();
  if (window.EventSource) {
    var events = new EventSource('/api/events');
    events.addEventListener('queue', refresh);
    events.addEventListener('party', refresh);
    setInterval(refresh, 30000);
  } else {
    setInterval(refresh, 10000);
  }
})();
