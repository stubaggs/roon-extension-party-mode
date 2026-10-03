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

/**
 * Page text. The server serves this as /i18n.js, preceded by
 * `window.I18N_DATA = { lang, strings, fallback }` for the language the
 * browser asked for (see lib/i18n.js), so text is ready before page scripts run.
 *
 *   I18N.t('queue.up_next')                          -> "Up next"
 *   I18N.t('credit.requested_by', { name: 'Sam' })   -> "Requested by Sam"
 *   I18N.t('button.left', { count: 2 })              -> "2 left"
 *
 * A key missing from the language falls back to English. An entry that is an
 * object is a plural: { one, other, ... } chosen by the language's own rules.
 * Elements with data-i18n="key" get their text replaced; data-i18n-placeholder,
 * -aria-label, -alt and -title do the same for those attributes.
 */
(function () {
  'use strict';

  const data = window.I18N_DATA || { lang: 'en', dir: 'ltr', strings: {}, fallback: {} };
  const plurals = {};
  const pluralFor = (lang) => plurals[lang] || (plurals[lang] = new Intl.PluralRules(lang));

  function t(key, vars) {
    vars = vars || {};
    let entry = data.strings[key];
    let lang = data.lang;
    if (entry === undefined) {
      entry = data.fallback[key];
      lang = 'en';
    }
    if (entry === undefined) return key;
    if (typeof entry === 'object') {
      entry = entry[pluralFor(lang).select(Number(vars.count))] || entry.other || '';
    }
    return String(entry).replace(/\{(\w+)\}/g, (match, name) => (vars[name] === undefined ? match : vars[name]));
  }

  const ATTRIBUTES = ['placeholder', 'aria-label', 'alt', 'title'];

  function apply(root) {
    root = root || document;
    root.querySelectorAll('[data-i18n]').forEach((el) => {
      el.textContent = t(el.getAttribute('data-i18n'));
    });
    for (const attribute of ATTRIBUTES) {
      root.querySelectorAll(`[data-i18n-${attribute}]`).forEach((el) => {
        el.setAttribute(attribute, t(el.getAttribute(`data-i18n-${attribute}`)));
      });
    }
  }

  /** The name a guest goes by: theirs, or "Anon" (credit.guest) without one. */
  const guestName = (name) => name || t('credit.guest');

  /** The credit line for a track: a guest's name, "Anon", or Roon Radio. */
  function credit(item) {
    if (item.kind === 'radio') return t('credit.radio');
    return guestName(item.requested_by);
  }

  /** The line under the playing track: "Requested by Sam", "Requested by Anon" or "Roon Radio". */
  function requestedBy(item) {
    if (item.kind === 'radio') return t('credit.radio');
    return t('credit.requested_by', { name: guestName(item.requested_by) });
  }

  /** "Skipped by Sam", "Skipped by Anon" or "Skipped in Roon", for a skipped played track. */
  function skippedBy(item) {
    if (item.skipped_in_roon) return t('played.skipped_in_roon');
    return t('played.skipped_by', { name: guestName(item.skipped_by) });
  }

  /** "a minute" / "12 minutes" for a wait in milliseconds. */
  function minutes(ms) {
    const count = Math.max(1, Math.ceil(ms / 60000));
    return t('time.minutes', { count });
  }

  document.documentElement.lang = data.lang;
  // Hebrew and Arabic read right to left; the styles mirror with it.
  document.documentElement.dir = data.dir || 'ltr';
  apply();

  window.I18N = {
    lang: data.lang,
    // Every language by its own name, and whether the guest picked this one.
    languages: data.languages || [],
    chosen: Boolean(data.chosen),
    t,
    apply,
    credit,
    requestedBy,
    skippedBy,
    minutes
  };
})();
