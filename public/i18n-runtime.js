/**
 * Page text. The server serves this as /i18n.js, preceded by
 * `window.I18N_DATA = { lang, strings, fallback }` for the language the
 * browser asked for (see lib/i18n.js), so text is ready before page scripts run.
 *
 *   I18N.t('queue.up_next')                          -> "Up next"
 *   I18N.t('credit.requested_by', { name: 'Sam' })   -> "Requested by Sam"
 *   I18N.t('allowance.skip.left', { count: 2 })      -> "2 skips left."
 *
 * A key missing from the language falls back to English. An entry that is an
 * object is a plural: { one, other, ... } chosen by the language's own rules.
 * Elements with data-i18n="key" get their text replaced; data-i18n-placeholder,
 * -aria-label, -alt and -title do the same for those attributes.
 */
(function () {
  'use strict';

  const data = window.I18N_DATA || { lang: 'en', strings: {}, fallback: {} };
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

  /** The credit line for a track: a guest's name, "a guest", or Roon Radio. */
  function credit(item) {
    if (item.kind === 'radio') return t('credit.radio');
    return item.requested_by || t('credit.guest');
  }

  /**
   * The line under the playing track: "Requested by Sam", "Requested by a
   * guest" or "Roon Radio". "By a guest" is its own phrase because some
   * languages change "a guest" after "by" (German: von einem Gast).
   */
  function requestedBy(item) {
    if (item.kind === 'radio') return t('credit.radio');
    return item.requested_by ? t('credit.requested_by', { name: item.requested_by }) : t('credit.requested_by_guest');
  }

  /** "a minute" / "12 minutes" for a wait in milliseconds. */
  function minutes(ms) {
    const count = Math.max(1, Math.ceil(ms / 60000));
    return t('time.minutes', { count });
  }

  /** A clock time in the page's language, e.g. 9:42 PM or 21:42. */
  function time(timestamp) {
    return new Date(timestamp).toLocaleTimeString(data.lang, { hour: 'numeric', minute: '2-digit' });
  }

  document.documentElement.lang = data.lang;
  apply();

  window.I18N = { lang: data.lang, t, apply, credit, requestedBy, minutes, time };
})();
