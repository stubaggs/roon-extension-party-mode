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
 *
 * Plain ES5, unlike the other page scripts: the basic Party Hub (basic.js) is
 * for TV browsers years behind, and loads it too.
 */
(function () {
  'use strict';

  var data = window.I18N_DATA || { lang: 'en', dir: 'ltr', strings: {}, fallback: {} };
  var plurals = {};
  // The language's own plural rules; a browser without them (before Chrome 63
  // or Safari 13) gets English's: one for 1, other for everything else.
  function pluralFor(lang) {
    if (!plurals[lang]) {
      plurals[lang] =
        typeof Intl !== 'undefined' && Intl.PluralRules
          ? new Intl.PluralRules(lang)
          : { select: function (n) { return n === 1 ? 'one' : 'other'; } };
    }
    return plurals[lang];
  }

  // Names guests type, and language names, can be in another script from the
  // page ("Requested by יוסי", "דולגה על ידי Sam"). Wrapped in first-strong
  // isolates, they keep their place in the sentence. Only when it matters: a
  // right-to-left page, or right-to-left text, so other pages stay plain text.
  var ISOLATE = ['name', 'language'];
  var RTL_TEXT = /[֐-ࣿיִ-﷿ﹰ-﻿]/;
  function isolate(value) {
    var text = String(value);
    return data.dir === 'rtl' || RTL_TEXT.test(text) ? '⁨' + text + '⁩' : text;
  }

  function t(key, vars) {
    vars = vars || {};
    var entry = data.strings[key];
    var lang = data.lang;
    if (entry === undefined) {
      entry = data.fallback[key];
      lang = 'en';
    }
    if (entry === undefined) return key;
    if (typeof entry === 'object') {
      entry = entry[pluralFor(lang).select(Number(vars.count))] || entry.other || '';
    }
    return String(entry).replace(/\{(\w+)\}/g, function (match, name) {
      if (vars[name] === undefined) return match;
      return ISOLATE.indexOf(name) >= 0 ? isolate(vars[name]) : vars[name];
    });
  }

  var ATTRIBUTES = ['placeholder', 'aria-label', 'alt', 'title'];

  function each(root, selector, fn) {
    Array.prototype.forEach.call(root.querySelectorAll(selector), fn);
  }

  function apply(root) {
    root = root || document;
    each(root, '[data-i18n]', function (el) {
      el.textContent = t(el.getAttribute('data-i18n'));
    });
    ATTRIBUTES.forEach(function (attribute) {
      each(root, '[data-i18n-' + attribute + ']', function (el) {
        el.setAttribute(attribute, t(el.getAttribute('data-i18n-' + attribute)));
      });
    });
  }

  /** The name a guest goes by: theirs, or "Anon" (credit.guest) without one. */
  function guestName(name) {
    return name || t('credit.guest');
  }

  // The host's name from the settings, set from each queue update; null shows
  // "Host" in the page's language.
  var hostName = null;
  function setHostName(name) {
    hostName = name || null;
  }
  function hostLabel() {
    return hostName || t('credit.host');
  }

  /** The credit line for a track: a guest's name, "Anon", Roon Radio or Host. */
  function credit(item) {
    if (item.kind === 'radio') return t('credit.radio');
    if (item.kind === 'host') return hostLabel();
    return guestName(item.requested_by);
  }

  /** The line under the playing track: "Requested by Sam", "Requested by Anon", "Roon Radio" or "Host". */
  function requestedBy(item) {
    if (item.kind === 'radio') return t('credit.radio');
    if (item.kind === 'host') return hostLabel();
    return t('credit.requested_by', { name: guestName(item.requested_by) });
  }

  /** "Skipped by Sam", "Skipped by Anon" or "Skipped by Host", for a skipped played track. */
  function skippedBy(item) {
    // A name the host set is a name like a guest's; "Host" has its own wording.
    if (item.skipped_by_host) return hostName ? t('played.skipped_by', { name: hostName }) : t('played.skipped_by_host');
    return t('played.skipped_by', { name: guestName(item.skipped_by) });
  }

  /** "a minute" / "12 minutes" for a wait in milliseconds. */
  function minutes(ms) {
    var count = Math.max(1, Math.ceil(ms / 60000));
    return t('time.minutes', { count: count });
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
    t: t,
    apply: apply,
    credit: credit,
    requestedBy: requestedBy,
    setHostName: setHostName,
    skippedBy: skippedBy,
    minutes: minutes
  };
})();
