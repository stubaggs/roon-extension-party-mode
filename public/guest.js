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
  const app = el('app');
  const locked = el('locked');
  const results = el('results');
  const resultsStatus = el('results-status');
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
    const body = await res.json().catch(() => ({}));
    if (res.status === 401 || res.status === 403) {
      // Party mode Off answers "closed": requests are over, not the guest's link.
      showLocked(body.error === 'closed' ? 'closed' : 'locked');
      throw new Error('no_session');
    }
    if (!res.ok) throw Object.assign(new Error(body.error || 'error'), { body });
    return body;
  }

  /** In place of the page: 'locked' (scan again) or 'closed' (requests are over). */
  function showLocked(which) {
    app.hidden = true;
    el('nickname').hidden = true;
    locked.hidden = which !== 'locked';
    el('closed').hidden = which !== 'closed';
  }

  const { t } = window.I18N;
  const minutes = window.I18N.minutes;

  /**
   * A guest's allowance lives on the button it limits: "Add to queue · 3 left",
   * "Skip · in 5 min". Each such button carries data-bucket (add, next, skip)
   * and data-label (its text key), so it can be relabelled in place when the
   * counts change, without rebuilding the list around it. A button with
   * data-quiet (Skip) says nothing while it can be used, only when it can't.
   */
  function allowanceNote(bucket) {
    const status = party.allowances[bucket];
    if (party.party_mode === 'paused') return { text: t('button.paused'), usable: false };
    if (status.remaining === null) return { text: '', usable: true };
    if (status.remaining > 0) return { text: t('button.left', { count: status.remaining }), usable: true };
    if (status.nextIn) {
      const wait = t('time.short', { count: Math.max(1, Math.ceil(status.nextIn / 60000)) });
      return { text: t('button.wait', { wait }), usable: false };
    }
    return { text: t('button.used'), usable: false };
  }

  function labelButton(button) {
    const note = allowanceNote(button.dataset.bucket);
    button.textContent = t(button.dataset.label);
    if (note.text && !(note.usable && 'quiet' in button.dataset)) {
      const dot = document.createElement('span');
      dot.className = 'note-dot';
      dot.setAttribute('aria-hidden', 'true');
      dot.textContent = ' · ';
      const count = document.createElement('span');
      count.className = 'note';
      count.textContent = note.text;
      button.append(dot, count);
    }
    // Used up, the button stays focusable so a screen reader still hears
    // "Skip, in 5 min"; pressing it explains instead (spentMessage).
    button.setAttribute('aria-disabled', String(!note.usable));
  }

  const isSpent = (button) => button.getAttribute('aria-disabled') === 'true';

  /** What to say when a used-up button is pressed. */
  function spentMessage(bucket) {
    if (party.party_mode === 'paused') return t('allowance.paused');
    const wait = party.allowances[bucket].nextIn;
    if (bucket === 'skip') return wait ? t('toast.no_skips_wait', { wait: minutes(wait) }) : t('toast.no_skips');
    return wait ? t('toast.nothing_left_wait', { wait: minutes(wait) }) : t('toast.nothing_left');
  }

  let refillTimer = null;

  function renderAllowances() {
    if (!party) return;
    // A line under the search box only when there is nothing to press.
    const notice = el('notice');
    if (party.party_mode === 'paused') notice.textContent = t('allowance.paused');
    else if (!party.capabilities.add && !party.capabilities.next) notice.textContent = t('allowance.closed');
    else notice.textContent = '';
    notice.hidden = !notice.textContent;

    document.querySelectorAll('[data-bucket]').forEach(labelButton);

    // Fetch again when a used-up button is due back, so it comes back on time.
    clearTimeout(refillTimer);
    const waits = ['add', 'next', 'skip'].map((b) => party.allowances[b].nextIn).filter(Boolean);
    if (waits.length) refillTimer = setTimeout(refreshParty, Math.min(...waits) + 1000);
  }

  async function refreshParty() {
    try {
      party = await api('/api/party');
      renderAllowances();
      renderNameChip();
    } catch (err) {
      /* the next refresh will try again */
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

  /**
   * Redraw the results. The list is rebuilt, which would drop keyboard and
   * screen reader focus, so focus goes back to the row for focusKey: the
   * result just opened or requested.
   */
  function renderResults(focusKey) {
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
      row.dataset.key = track.key;

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

      // Already queued: still in the list, and reachable, but not a working button.
      if (track.in_queue || track.added) {
        row.setAttribute('aria-disabled', 'true');
        continue;
      }

      row.setAttribute('aria-expanded', String(expandedKey === track.key));
      row.addEventListener('click', () => {
        expandedKey = expandedKey === track.key ? null : track.key;
        renderResults(track.key);
      });

      if (expandedKey === track.key) {
        const actions = document.createElement('div');
        actions.className = 'actions';

        if (party.capabilities.add) {
          const add = document.createElement('button');
          add.className = 'pill pill-primary';
          Object.assign(add.dataset, { bucket: 'add', label: 'track.add' });
          labelButton(add);
          add.addEventListener('click', () => request(track, 'add', add));
          actions.appendChild(add);
        }
        if (party.capabilities.next) {
          const next = document.createElement('button');
          next.className = 'pill pill-ghost';
          Object.assign(next.dataset, { bucket: 'next', label: 'track.next' });
          labelButton(next);
          next.addEventListener('click', () => request(track, 'next', next));
          actions.appendChild(next);
        }
        results.appendChild(actions);
      }
    }

    if (focusKey) {
      const row = [...results.querySelectorAll('.row')].find((r) => r.dataset.key === focusKey);
      if (row) row.focus();
    }
  }

  function announceResults(query) {
    if (query.trim().length < 2) resultsStatus.textContent = '';
    else if (!lastResults.length) resultsStatus.textContent = t('search.no_results');
    else resultsStatus.textContent = t('search.results', { count: lastResults.length });
  }

  // Only the latest search's answer is shown: an earlier one may come back last.
  let searchSeq = 0;

  async function runSearch(query) {
    const mine = ++searchSeq;
    if (query.trim().length < 2) {
      lastResults = [];
      renderResults();
      announceResults(query);
      return;
    }
    try {
      const body = await api(`/api/search?q=${encodeURIComponent(query)}`);
      if (mine !== searchSeq || body.superseded) return;
      lastResults = body.results;
      expandedKey = null;
      renderResults();
      announceResults(query);
    } catch (err) {
      if (mine === searchSeq && err.message !== 'no_session') toast(t('search.unavailable'));
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
    if (isSpent(button)) return toast(spentMessage(mode));
    button.disabled = true;
    try {
      const body = await api('/api/request', {
        method: 'POST',
        // The server knows the track by its key, from the results it sent.
        body: JSON.stringify({ key: track.key, mode })
      });
      party.allowances = body.allowances;
      track.added = true;
      expandedKey = null;
      renderAllowances();
      renderResults(track.key);
      toast(mode === 'next' ? t('toast.queued_next') : t('toast.queued'));
    } catch (err) {
      button.disabled = false;
      const detail = err.body || {};
      if (err.message === 'already_queued') toast(t('toast.already_queued'));
      else if (err.message === 'paused') toast(t('allowance.paused'));
      else if (err.message === 'rate_limited') {
        refreshParty(); // the counts were out of date; grey the button out
        toast(detail.next_in ? t('toast.nothing_left_wait', { wait: minutes(detail.next_in) }) : t('toast.nothing_left'));
      } else if (err.message === 'disabled') toast(t('toast.disabled'));
      else if (err.message !== 'no_session') toast(t('toast.roon_refused'));
    }
  }

  el('skip').addEventListener('click', async () => {
    if (isSpent(el('skip'))) return toast(spentMessage('skip'));
    try {
      const body = await api('/api/skip', { method: 'POST' });
      party.allowances = body.allowances;
      renderAllowances();
      toast(t('toast.skipped'));
    } catch (err) {
      const detail = err.body || {};
      if (err.message === 'paused') toast(t('allowance.paused'));
      else if (err.message === 'rate_limited') {
        refreshParty();
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
    who.classList.toggle('next', !who.hidden && playing.kind === 'next');
    el('playing-label').textContent =
      playing && playing.state === 'playing' ? t('playing.now') : t('playing.paused');
    setArt(el('playing-art'), playing && playing.image_key, 144);

    renderList(queueList, snapshot.upcoming, t('queue.empty'), (item, index) => {
      const position = document.createElement('span');
      position.className = 'queue-position';
      position.textContent = String(index + 1);
      // The list is numbered already; don't read the number twice.
      position.setAttribute('aria-hidden', 'true');
      return [position, ...trackCells(item)];
    });

    renderList(playedList, snapshot.played || [], t('played.empty'), (item) => {
      const cells = trackCells(item);
      if (item.skipped) {
        const tag = document.createElement('span');
        tag.className = 'badge skipped';
        tag.textContent = window.I18N.skippedBy(item);
        cells[1].appendChild(tag);
      }
      return cells;
    });
  }

  function creditText(track) {
    return window.I18N.requestedBy(track);
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
      badge.className = item.kind === 'next' || item.kind === 'radio' ? `badge ${item.kind}` : 'badge';
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

  /** The name tag at the top: "✎ Stu", or "Add your name" before there is one. */
  function renderNameChip() {
    const name = party && party.guest_name;
    const chip = el('name-chip');
    chip.textContent = name || t('name.add');
    chip.classList.toggle('named', Boolean(name));
    // Said in full to a screen reader: "Adding as Stu. Change".
    chip.setAttribute('aria-label', name ? `${t('name.adding_as', { name })}. ${t('name.change')}` : t('name.add'));
  }

  async function saveName(name) {
    const body = await api('/api/name', { method: 'POST', body: JSON.stringify({ name }) });
    party.guest_name = body.guest_name;
    renderNameChip();
  }

  let changingName = false;
  let nicknameOpener = null;

  /**
   * First visit offers Skip; changing a name later offers Cancel instead.
   * While it is open the page behind is inert, so focus stays in the dialog.
   */
  function askName(changing) {
    changingName = changing === true;
    el('nickname-skip').textContent = changingName ? t('name.cancel') : t('name.skip');
    nicknameInput.value = (party && party.guest_name) || remembered.get() || '';
    nicknameOpener = document.activeElement;
    app.inert = true;
    nickname.hidden = false;
    nicknameInput.focus();
  }

  /**
   * Back to the button that opened it. On a first visit nothing did, and
   * focusing the search box would pop up a phone's keyboard unasked.
   */
  function closeName() {
    nickname.hidden = true;
    app.inert = false;
    if (nicknameOpener && nicknameOpener !== document.body) nicknameOpener.focus();
    nicknameOpener = null;
  }

  el('nickname-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = nicknameInput.value.trim();
    // Skipping stores an empty name, so "Skip" isn't asked again on this phone.
    remembered.set(name);
    closeName();
    try {
      await saveName(name);
    } catch (err) {
      if (err.message !== 'no_session') toast(t('toast.name_not_saved'));
    }
  });

  function skipName() {
    if (changingName) {
      closeName();
      return;
    }
    nicknameInput.value = '';
    el('nickname-form').requestSubmit();
  }

  el('nickname-skip').addEventListener('click', skipName);

  // Escape does what the second button says: Cancel, or Skip on a first visit.
  nickname.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      skipName();
    }
  });

  el('name-chip').addEventListener('click', () => askName(true));

  // ---------------------------------------------------------------- language

  // The guest's choice is a cookie the server reads when it sends the page's
  // text (lib/i18n.js), so the page reloads to switch. A year, like a setting.
  const LANG_COOKIE = 'party_lang';
  const languageDialog = el('language');
  let languageOpener = null;

  function renderLanguageChip() {
    const chip = el('lang-chip');
    const name = t('_language');
    chip.textContent = name;
    chip.setAttribute('aria-label', t('lang.change', { language: name }));
  }

  function chooseLanguage(code) {
    document.cookie = code
      ? `${LANG_COOKIE}=${encodeURIComponent(code)}; path=/; max-age=31536000; samesite=lax`
      : `${LANG_COOKIE}=; path=/; max-age=0; samesite=lax`;
    location.reload();
  }

  /** "Automatic" (the phone's language), then every language by its own name. */
  function openLanguages() {
    const list = el('language-list');
    list.innerHTML = '';
    const option = (label, code, current, lang) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      // Each name is read in its own language, and written in its own direction.
      if (lang) button.lang = lang;
      button.dir = 'auto';
      if (current) button.setAttribute('aria-current', 'true');
      button.addEventListener('click', () => (current ? closeLanguages() : chooseLanguage(code)));
      list.appendChild(button);
      return button;
    };
    const automatic = option(t('lang.automatic'), null, !window.I18N.chosen);
    let current = automatic;
    for (const language of window.I18N.languages) {
      const isCurrent = window.I18N.chosen && language.code === window.I18N.lang;
      const button = option(language.name, language.code, isCurrent, language.code);
      if (isCurrent) current = button;
    }
    languageOpener = document.activeElement;
    app.inert = true;
    languageDialog.hidden = false;
    current.focus();
  }

  function closeLanguages() {
    languageDialog.hidden = true;
    app.inert = false;
    if (languageOpener && languageOpener !== document.body) languageOpener.focus();
    languageOpener = null;
  }

  el('lang-chip').addEventListener('click', openLanguages);
  el('language-cancel').addEventListener('click', closeLanguages);
  languageDialog.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeLanguages();
    }
  });

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
    el('closed').hidden = true;
    document.title = party.party_name || t('page.title');
    const skip = el('skip');
    skip.hidden = !party.capabilities.skip;
    if (party.capabilities.skip) Object.assign(skip.dataset, { bucket: 'skip', label: 'skip.button', quiet: '' });
    else delete skip.dataset.bucket;
    renderAllowances();
    renderNameChip();
    renderLanguageChip();

    // boot() runs again when the party settings change; set up the rest once.
    if (started) return;
    started = true;
    await settleName();

    const snapshot = await api('/api/queue').catch(() => null);
    if (snapshot) renderQueue(snapshot);

    const events = new EventSource('/api/events');
    events.addEventListener('queue', (event) => renderQueue(JSON.parse(event.data)));
    events.addEventListener('party', () => boot());

    setInterval(refreshParty, 30000);
  }

  boot();
})();
