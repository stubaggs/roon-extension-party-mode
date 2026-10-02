(function () {
  'use strict';

  const el = (id) => document.getElementById(id);
  const app = el('app');
  const locked = el('locked');
  const results = el('results');
  const queueList = el('queue');
  const playedList = el('played');
  const searchInput = el('search');
  const toastEl = el('toast');

  let party = null;
  let started = false;
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

  const { t } = window.I18N;
  const minutes = window.I18N.minutes;

  // Text keys: allowance.<add|next|skip>.<unlimited|left|waiting|used>
  function describeTokens(bucket) {
    const status = party.allowances[bucket];
    const key = (state) => `allowance.${bucket}.${state}`;
    if (status.remaining === null) return t(key('unlimited'));
    if (status.remaining > 0) return t(key('left'), { count: status.remaining });
    if (status.nextIn) return t(key('waiting'), { wait: minutes(status.nextIn) });
    return t(key('used'));
  }

  function renderTokens() {
    if (!party) return;
    const lines = [];
    if (!party.capabilities.add) lines.push(t('allowance.closed'));
    for (const bucket of ['add', 'next', 'skip']) {
      if (party.capabilities[bucket]) lines.push(describeTokens(bucket));
    }
    const tokens = el('tokens');
    tokens.innerHTML = '';
    for (const line of lines) {
      const span = document.createElement('span');
      span.className = 'token-line';
      span.textContent = line;
      tokens.appendChild(span);
    }
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
        p.textContent = t('search.no_results');
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
      if (track.added) state.textContent = t('track.added');
      else if (track.in_queue) state.textContent = t('track.in_queue');

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
          add.textContent = t('track.add');
          add.addEventListener('click', () => request(track, 'add', add));
          actions.appendChild(add);
        }
        if (party.capabilities.next) {
          const next = document.createElement('button');
          next.className = 'pill pill-ghost';
          next.textContent = t('track.next');
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
      if (err.message !== 'no_session') toast(t('search.unavailable'));
    }
  }

  const searchClear = el('search-clear');

  function clearSearch() {
    clearTimeout(searchTimer);
    searchInput.value = '';
    searchClear.hidden = true;
    runSearch('');
    searchInput.focus();
  }

  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const query = searchInput.value;
    searchClear.hidden = !query;
    searchTimer = setTimeout(() => runSearch(query), 350);
  });

  searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && searchInput.value) {
      event.preventDefault();
      clearSearch();
    }
  });

  searchClear.addEventListener('click', clearSearch);

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
      toast(mode === 'next' ? t('toast.queued_next') : t('toast.queued'));
    } catch (err) {
      button.disabled = false;
      const detail = err.body || {};
      if (err.message === 'already_queued') toast(t('toast.already_queued'));
      else if (err.message === 'rate_limited') {
        toast(detail.next_in ? t('toast.nothing_left_wait', { wait: minutes(detail.next_in) }) : t('toast.nothing_left'));
      } else if (err.message === 'disabled') toast(t('toast.disabled'));
      else if (err.message !== 'no_session') toast(t('toast.roon_refused'));
    }
  }

  el('skip').addEventListener('click', async () => {
    try {
      const body = await api('/api/skip', { method: 'POST' });
      party.allowances = body.allowances;
      renderTokens();
      toast(t('toast.skipped'));
    } catch (err) {
      const detail = err.body || {};
      if (err.message === 'rate_limited') {
        toast(detail.next_in ? t('toast.no_skips_wait', { wait: minutes(detail.next_in) }) : t('toast.no_skips'));
      } else if (err.message !== 'no_session') toast(t('toast.failed'));
    }
  });

  // ------------------------------------------------------------------- queue

  function renderQueue(snapshot) {
    const playing = snapshot.now_playing;
    el('playing-title').textContent = playing ? playing.title : t('playing.nothing');
    el('playing-artist').textContent = playing ? playing.artist : '';
    const who = el('playing-who');
    who.hidden = !(playing && playing.kind);
    who.textContent = who.hidden ? '' : creditText(playing);
    who.classList.toggle('radio', !who.hidden && playing.kind === 'radio');
    el('playing-label').textContent =
      playing && playing.state === 'playing' ? t('playing.now') : t('playing.paused');
    setArt(el('playing-art'), playing && playing.image_key, 144);

    renderList(queueList, snapshot.upcoming, t('queue.empty'), (item, index) => {
      const position = document.createElement('span');
      position.className = 'queue-position';
      position.textContent = String(index + 1);
      return [position, ...trackCells(item)];
    });

    renderList(playedList, snapshot.played || [], t('played.empty'), (item) => {
      const time = document.createElement('span');
      time.className = 'played-at';
      time.textContent = window.I18N.time(item.played_at);
      return [...trackCells(item), time];
    });
  }

  function creditText(track) {
    return track.kind === 'radio' ? t('credit.radio') : t('credit.requested_by', { name: window.I18N.credit(track) });
  }

  function renderList(list, items, emptyText, cells) {
    list.innerHTML = '';
    if (!items.length) {
      const p = document.createElement('li');
      p.className = 'empty';
      p.textContent = emptyText;
      list.appendChild(p);
      return;
    }
    items.forEach((item, index) => {
      const li = document.createElement('li');
      li.className = 'row';
      li.append(...cells(item, index));
      list.appendChild(li);
    });
  }

  /** Album art plus title, artist and, under it, who requested it. */
  function trackCells(item) {
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
    const sub = document.createElement('p');
    sub.className = 'row-sub';
    sub.textContent = item.artist;
    text.append(title, sub);
    if (item.kind) {
      const badge = document.createElement('span');
      badge.className = item.kind === 'radio' ? 'badge radio' : 'badge';
      badge.textContent = window.I18N.credit(item);
      text.appendChild(badge);
    }

    return [img, text];
  }

  // --------------------------------------------------------------- nickname

  // Remembered on the phone, so a new scan (which starts a new session) or a
  // later visit doesn't ask again. Storage can be unavailable in private mode.
  const NAME_KEY = 'party_name';
  const remembered = {
    get() {
      try {
        return localStorage.getItem(NAME_KEY);
      } catch (err) {
        return null;
      }
    },
    set(name) {
      try {
        localStorage.setItem(NAME_KEY, name);
      } catch (err) {
        /* private mode */
      }
    }
  };

  const nickname = el('nickname');
  const nicknameInput = el('nickname-input');

  function renderWhoami() {
    const name = party && party.guest_name;
    el('whoami').textContent = name ? t('name.adding_as', { name }) : '';
    el('whoami-change').textContent = name ? t('name.change') : t('name.add');
  }

  async function saveName(name) {
    const body = await api('/api/name', { method: 'POST', body: JSON.stringify({ name }) });
    party.guest_name = body.guest_name;
    renderWhoami();
  }

  let changingName = false;

  /** First visit offers Skip; changing a name later offers Cancel instead. */
  function askName(changing) {
    changingName = changing === true;
    el('nickname-skip').textContent = changingName ? t('name.cancel') : t('name.skip');
    nicknameInput.value = (party && party.guest_name) || remembered.get() || '';
    nickname.hidden = false;
    nicknameInput.focus();
  }

  el('nickname-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = nicknameInput.value.trim();
    // Skipping stores an empty name, so "Skip" isn't asked again on this phone.
    remembered.set(name);
    nickname.hidden = true;
    try {
      await saveName(name);
    } catch (err) {
      if (err.message !== 'no_session') toast(t('toast.name_not_saved'));
    }
  });

  el('nickname-skip').addEventListener('click', () => {
    if (changingName) {
      nickname.hidden = true;
      return;
    }
    nicknameInput.value = '';
    el('nickname-form').requestSubmit();
  });

  el('whoami-change').addEventListener('click', () => askName(true));

  /** First visit asks; a remembered name (or a remembered skip) is applied quietly. */
  async function settleName() {
    if (party.guest_name) return;
    const name = remembered.get();
    if (name === null) return askName();
    if (name) await saveName(name).catch(() => {});
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
    document.title = party.party_name || t('page.title');
    el('skip').hidden = !party.capabilities.skip;
    renderTokens();
    renderWhoami();

    // boot() runs again when the party settings change; set up the rest once.
    if (started) return;
    started = true;
    await settleName();

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
          renderWhoami();
        })
        .catch(() => {});
    }, 30000);
  }

  boot();
})();
