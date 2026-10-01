(function () {
  'use strict';

  const el = (id) => document.getElementById(id);
  const app = el('app');
  const locked = el('locked');
  const results = el('results');
  const queueList = el('queue');
  const searchInput = el('search');
  const toastEl = el('toast');

  let party = null;
  let expandedKey = null;
  let searchTimer = null;
  let lastResults = [];

  function toast(message) {
    toastEl.textContent = message;
    toastEl.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => toastEl.classList.remove('show'), 2600);
  }

  async function api(path, options) {
    const res = await fetch(path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, options));
    if (res.status === 401 || res.status === 403) {
      showLocked();
      throw new Error('no_session');
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(body.error || 'error'), { body });
    return body;
  }

  function showLocked() {
    app.hidden = true;
    locked.hidden = false;
  }

  function minutes(ms) {
    const m = Math.ceil(ms / 60000);
    return m <= 1 ? 'a minute' : `${m} minutes`;
  }

  function renderTokens() {
    if (!party) return;
    const add = party.allowances.add;
    const bits = [];
    if (!party.capabilities.add) {
      bits.push('Requests are closed right now.');
    } else if (add.remaining === null) {
      bits.push('Add as many songs as you like.');
    } else if (add.remaining > 0) {
      bits.push(`${add.remaining} song${add.remaining === 1 ? '' : 's'} left to add.`);
    } else if (add.nextIn) {
      bits.push(`You get another go in ${minutes(add.nextIn)}.`);
    } else {
      bits.push('You have used all your songs.');
    }
    el('tokens').textContent = bits.join(' ');
  }

  function artUrl(key, size) {
    return key ? `/api/image/${encodeURIComponent(key)}?size=${size}` : '';
  }

  function setArt(img, key, size) {
    if (key) {
      img.src = artUrl(key, size);
      img.hidden = false;
    } else {
      img.removeAttribute('src');
      img.hidden = false;
    }
  }

  // ------------------------------------------------------------------ search

  function renderResults() {
    results.innerHTML = '';
    if (!lastResults.length) {
      if (searchInput.value.trim().length >= 2) {
        const p = document.createElement('p');
        p.className = 'empty';
        p.textContent = 'No tracks matched. Try the artist name.';
        results.appendChild(p);
      }
      return;
    }

    for (const track of lastResults) {
      const row = document.createElement('button');
      row.className = 'row';
      row.type = 'button';
      row.setAttribute('aria-expanded', String(expandedKey === track.key));

      const img = document.createElement('img');
      img.className = 'art';
      img.alt = '';
      img.width = 48;
      img.height = 48;
      setArt(img, track.image_key, 96);

      const text = document.createElement('div');
      text.className = 'row-text';
      const title = document.createElement('p');
      title.className = 'row-title';
      title.textContent = track.title;
      const sub = document.createElement('p');
      sub.className = 'row-sub';
      sub.textContent = track.subtitle;
      text.append(title, sub);

      const state = document.createElement('span');
      state.className = 'row-state';
      if (track.added) state.textContent = 'Added';
      else if (track.in_queue) state.textContent = 'In the queue';

      row.append(img, text, state);
      results.appendChild(row);

      if (track.in_queue || track.added) continue;

      row.addEventListener('click', () => {
        expandedKey = expandedKey === track.key ? null : track.key;
        renderResults();
      });

      if (expandedKey === track.key) {
        const actions = document.createElement('div');
        actions.className = 'actions';

        if (party.capabilities.add) {
          const add = document.createElement('button');
          add.className = 'pill pill-primary';
          add.textContent = 'Add to queue';
          add.addEventListener('click', () => request(track, 'add', add));
          actions.appendChild(add);
        }
        if (party.capabilities.next) {
          const next = document.createElement('button');
          next.className = 'pill pill-ghost';
          next.textContent = 'Play it next';
          next.addEventListener('click', () => request(track, 'next', next));
          actions.appendChild(next);
        }
        results.appendChild(actions);
      }
    }
  }

  async function runSearch(query) {
    if (query.trim().length < 2) {
      lastResults = [];
      renderResults();
      return;
    }
    try {
      const body = await api(`/api/search?q=${encodeURIComponent(query)}`);
      lastResults = body.results;
      expandedKey = null;
      renderResults();
    } catch (err) {
      if (err.message !== 'no_session') toast('Search is unavailable right now.');
    }
  }

  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const query = searchInput.value;
    searchTimer = setTimeout(() => runSearch(query), 350);
  });

  // ----------------------------------------------------------------- actions

  async function request(track, mode, button) {
    button.disabled = true;
    try {
      const body = await api('/api/request', {
        method: 'POST',
        body: JSON.stringify({
          key: track.key,
          mode,
          title: track.title,
          subtitle: track.subtitle
        })
      });
      party.allowances = body.allowances;
      track.added = true;
      expandedKey = null;
      renderTokens();
      renderResults();
      toast(mode === 'next' ? 'Queued to play next' : 'Added to the queue');
    } catch (err) {
      button.disabled = false;
      const detail = err.body || {};
      if (err.message === 'already_queued') toast('That one is already in the queue.');
      else if (err.message === 'rate_limited') {
        toast(detail.next_in ? `Nothing left for now. Try again in ${minutes(detail.next_in)}.` : 'Nothing left for now.');
      } else if (err.message === 'disabled') toast('The host has turned that off.');
      else if (err.message !== 'no_session') toast('Roon would not take that one.');
    }
  }

  el('skip').addEventListener('click', async () => {
    try {
      const body = await api('/api/skip', { method: 'POST' });
      party.allowances = body.allowances;
      toast('Skipped');
    } catch (err) {
      const detail = err.body || {};
      if (err.message === 'rate_limited') {
        toast(detail.next_in ? `No skips left. Try again in ${minutes(detail.next_in)}.` : 'No skips left.');
      } else if (err.message !== 'no_session') toast('That did not work.');
    }
  });

  // ------------------------------------------------------------------- queue

  function renderQueue(snapshot) {
    const playing = snapshot.now_playing;
    el('playing-title').textContent = playing ? playing.title : 'Nothing playing';
    el('playing-artist').textContent = playing ? playing.artist : '';
    el('playing-label').textContent =
      playing && playing.state === 'playing' ? 'Playing now' : 'Paused';
    setArt(el('playing-art'), playing && playing.image_key, 144);

    queueList.innerHTML = '';
    const upcoming = snapshot.upcoming.slice(1, 16);
    if (!upcoming.length) {
      const p = document.createElement('li');
      p.className = 'empty';
      p.textContent = 'Nothing lined up. Add the first song.';
      queueList.appendChild(p);
      return;
    }

    upcoming.forEach((item, index) => {
      const li = document.createElement('li');
      li.className = 'row';

      const position = document.createElement('span');
      position.className = 'queue-position';
      position.textContent = String(index + 1);

      const img = document.createElement('img');
      img.className = 'art';
      img.alt = '';
      img.width = 40;
      img.height = 40;
      setArt(img, item.image_key, 80);

      const text = document.createElement('div');
      text.className = 'row-text';
      const title = document.createElement('p');
      title.className = 'row-title';
      title.textContent = item.title;
      if (item.requested_by) {
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = item.requested_by;
        title.appendChild(badge);
      }
      const sub = document.createElement('p');
      sub.className = 'row-sub';
      sub.textContent = item.artist;
      text.append(title, sub);

      li.append(position, img, text);
      queueList.appendChild(li);
    });
  }

  // -------------------------------------------------------------- lifecycle

  async function boot() {
    try {
      party = await api('/api/party');
    } catch (err) {
      return;
    }
    app.hidden = false;
    locked.hidden = true;
    document.title = party.party_name || 'Add a song';
    el('skip').hidden = !party.capabilities.skip;
    renderTokens();

    const snapshot = await api('/api/queue').catch(() => null);
    if (snapshot) renderQueue(snapshot);

    const events = new EventSource('/api/events');
    events.addEventListener('queue', (event) => renderQueue(JSON.parse(event.data)));
    events.addEventListener('party', () => boot());

    setInterval(() => {
      api('/api/party')
        .then((body) => {
          party = body;
          renderTokens();
        })
        .catch(() => {});
    }, 30000);
  }

  boot();
})();
