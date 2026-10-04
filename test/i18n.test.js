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

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const i18n = require('../lib/i18n');

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

const PUBLIC = path.join(__dirname, '..', 'public');
const read = (file) => fs.readFileSync(path.join(PUBLIC, file), 'utf8');
const en = JSON.parse(read('i18n/en.json'));

/** Keys the pages use: t('key') and the plural/credit keys used by name. */
function usedKeys() {
  const keys = new Set();
  for (const file of ['guest.js', 'hub.js', 'i18n-runtime.js']) {
    for (const m of read(file).matchAll(/\bt\('([a-z_.]+)'/g)) keys.add(m[1]);
    // Button labels relabelled in place: dataset { label: 'track.add' }.
    for (const m of read(file).matchAll(/\blabel: '([a-z_.]+)'/g)) keys.add(m[1]);
    // Messages passed to doneMessage('toast.queued', …).
    for (const line of read(file).split('\n').filter((l) => l.includes('doneMessage('))) {
      for (const m of line.matchAll(/'(toast\.[a-z_]+)'/g)) keys.add(m[1]);
    }
  }
  for (const file of ['index.html', 'hub.html']) {
    for (const m of read(file).matchAll(/data-i18n(?:-[a-z-]+)?="([a-z_.]+)"/g)) keys.add(m[1]);
  }
  // The server's own pages: messagePage(res, lang, 'title.key', 'text.key', { linkKey }).
  const server = fs.readFileSync(path.join(__dirname, '..', 'lib', 'server.js'), 'utf8');
  for (const m of server.matchAll(/messagePage\(res, [\w.()]+, '([a-z_.]+)', '([a-z_.]+)'/g)) keys.add(m[1]).add(m[2]);
  for (const m of server.matchAll(/linkKey: '([a-z_.]+)'/g)) keys.add(m[1]);
  return keys;
}

const placeholders = (entry) =>
  [...new Set((typeof entry === 'object' ? Object.values(entry).join(' ') : entry).match(/\{\w+\}/g) || [])].sort();

/** Runs the page runtime as a browser would, with the given served data. */
function runtimeFor(lang, strings) {
  const html = { lang: '' };
  const window = { I18N_DATA: { lang, dir: i18n.dir(lang), strings, fallback: en } };
  vm.runInNewContext(fs.readFileSync(path.join(PUBLIC, 'i18n-runtime.js'), 'utf8'), {
    window,
    document: { documentElement: html, querySelectorAll: () => [] },
    Intl,
    Date
  });
  return Object.assign(window.I18N, { html });
}

console.log('page text');

check('every key the pages use is in en.json', () => {
  const missing = [...usedKeys()].filter((key) => !(key in en));
  assert.deepStrictEqual(missing, []);
});

check('en.json has no unused keys', () => {
  const used = usedKeys();
  const unused = Object.keys(en).filter((key) => !key.startsWith('_') && !used.has(key));
  assert.deepStrictEqual(unused, []);
});

check('no hard-coded English left in the page scripts', () => {
  for (const file of ['guest.js', 'hub.js']) {
    const quoted = read(file).match(/(['`])(?:[A-Z][a-z]+ )+[a-z]+[^'`]*\1/g) || [];
    assert.deepStrictEqual(quoted, [], file);
  }
});

for (const lang of i18n.languages()) {
  if (lang === 'en') continue;
  const strings = JSON.parse(read(`i18n/${lang}.json`));
  check(`${lang}.json uses the same keys and placeholders as English`, () => {
    for (const [key, entry] of Object.entries(strings)) {
      if (key.startsWith('_')) continue;
      assert.ok(key in en, `unknown key ${key}`);
      assert.deepStrictEqual(placeholders(entry), placeholders(en[key]), key);
      if (typeof en[key] === 'object') assert.ok(entry.other, `${key} needs an "other" form`);
    }
  });
}

console.log('\nruntime');

check('fills in names and counts, with plurals', () => {
  const I18N = runtimeFor('en', en);
  assert.strictEqual(I18N.t('credit.requested_by', { name: 'Sam' }), 'Requested by Sam');
  assert.strictEqual(I18N.t('button.left', { count: 1 }), '1 left');
  assert.strictEqual(I18N.t('button.wait', { wait: I18N.t('time.short', { count: 5 }) }), 'in 5 min');
  assert.strictEqual(I18N.minutes(30 * 1000), 'a minute');
  assert.strictEqual(I18N.minutes(12 * 60 * 1000), '12 minutes');
});

check('credits: a name, "Anon", or Roon Radio', () => {
  const I18N = runtimeFor('en', en);
  assert.strictEqual(I18N.requestedBy({ kind: 'add', requested_by: 'Sam' }), 'Requested by Sam');
  assert.strictEqual(I18N.requestedBy({ kind: 'next', requested_by: null }), 'Requested by Anon');
  assert.strictEqual(I18N.skippedBy({ skipped: true, skipped_by: null }), 'Skipped by Anon');
  assert.strictEqual(I18N.requestedBy({ kind: 'radio', requested_by: null }), 'Roon Radio');
  assert.strictEqual(I18N.credit({ kind: 'add', requested_by: 'Sam' }), 'Sam');
  assert.strictEqual(I18N.credit({ kind: 'next', requested_by: null }), 'Anon');
  assert.strictEqual(I18N.credit({ kind: 'radio', requested_by: null }), 'Roon Radio');
});

check('no language preference, or any, gets English', () => {
  // The real negotiation Express uses, which offers the first language listed.
  const accepts = require('accepts');
  const real = (header) => {
    const req = { headers: header ? { 'accept-language': header } : {} };
    return Object.assign(req, { acceptsLanguages: (...langs) => accepts(req).languages(...langs) });
  };
  assert.strictEqual(i18n.pick(real()), 'en');
  assert.strictEqual(i18n.pick(real('*')), 'en');
  assert.strictEqual(i18n.pick(real('fr-FR,fr;q=0.9')), 'fr');
  assert.strictEqual(i18n.pick(real('is')), 'en');
});

check('a key missing from a language falls back to English', () => {
  const I18N = runtimeFor('de', { 'queue.up_next': 'Als Nächstes' });
  assert.strictEqual(I18N.t('queue.up_next'), 'Als Nächstes');
  assert.strictEqual(I18N.t('played.title'), 'Played');
  assert.strictEqual(I18N.html.lang, 'de');
});

console.log('\nserver');

// A request as Express gives it: the language comes from the header.
const request = (header) => ({ headers: header ? { 'accept-language': header } : {} });

check('a browser asking for a language without a file gets English', () => {
  assert.strictEqual(i18n.pick(request('is-IS,is;q=0.9')), 'en');
  assert.strictEqual(i18n.pick(request('sw')), 'en');
  assert.strictEqual(i18n.pick(request('')), 'en');
});

check('server messages come from the same file', () => {
  assert.ok(usedKeys().has('join.expired'));
  assert.strictEqual(i18n.t('en', 'screen.closed_title'), 'Requests are closed');
  assert.strictEqual(i18n.t('fr', 'screen.closed_title'), JSON.parse(read('i18n/fr.json'))['screen.closed_title']);
  assert.strictEqual(i18n.t('xx', 'screen.closed_title'), 'Requests are closed');
});

check('/i18n.js carries the language and its text before the runtime', () => {
  const js = i18n.script('en');
  assert.match(js, /^window\.I18N_DATA = \{"lang":"en"/);
  assert.ok(js.includes('window.I18N = '));
});

console.log('\nFrench');

check('French browsers get French, including regional ones', () => {
  assert.strictEqual(i18n.pick(request('fr-FR,fr;q=0.9,en;q=0.8')), 'fr');
  assert.strictEqual(i18n.pick(request('fr-CA')), 'fr');
  assert.strictEqual(i18n.pick(request('is-IS,fr;q=0.5')), 'fr');
  assert.strictEqual(i18n.pick(request('en-GB,fr;q=0.5')), 'en');
});

check('French text, plurals and clock', () => {
  const fr = JSON.parse(read('i18n/fr.json'));
  const I18N = runtimeFor('fr', fr);
  assert.strictEqual(I18N.t('queue.up_next'), 'À suivre');
  assert.strictEqual(I18N.t('credit.requested_by', { name: 'Sam' }), 'Demandé par Sam');
  assert.strictEqual(I18N.t('button.left', { count: 1 }), '1 restant');
  assert.strictEqual(I18N.t('button.left', { count: 3 }), '3 restants');
  assert.strictEqual(I18N.minutes(30 * 1000), 'une minute');
  assert.strictEqual(I18N.credit({ kind: 'add', requested_by: null }), 'Anonyme');
  assert.strictEqual(i18n.t('fr', 'join.expired'), 'Ce code a expiré. Scannez à nouveau le code affiché sur le Party Hub.');
});

console.log('\nSpanish, German, Dutch');

for (const [header, lang] of [['es-ES,es;q=0.9', 'es'], ['es-419', 'es'], ['de-DE,de;q=0.9', 'de'], ['de-CH', 'de'], ['nl-NL', 'nl'], ['nl-BE,fr;q=0.8', 'nl']]) {
  check(`${header} gets ${lang}`, () => assert.strictEqual(i18n.pick(request(header)), lang));
}

const samples = {
  es: { up: 'A continuación', one: 'queda 1', many: 'quedan 3', guest: 'Pedida por Anónimo', wait: 'un minuto' },
  de: { up: 'Als Nächstes', one: 'noch 1', many: 'noch 3', guest: 'Gewünscht von Anonym', wait: 'einer Minute' },
  nl: { up: 'Hierna', one: 'nog 1', many: 'nog 3', guest: 'Aangevraagd door Anoniem', wait: 'een minuut' }
};
for (const [lang, want] of Object.entries(samples)) {
  check(`${lang}: text, plurals and "by Anon"`, () => {
    const I18N = runtimeFor(lang, JSON.parse(read(`i18n/${lang}.json`)));
    assert.strictEqual(I18N.t('queue.up_next'), want.up);
    assert.strictEqual(I18N.t('button.left', { count: 1 }), want.one);
    assert.strictEqual(I18N.t('button.left', { count: 3 }), want.many);
    assert.strictEqual(I18N.requestedBy({ kind: 'add', requested_by: null }), want.guest);
    assert.strictEqual(I18N.minutes(30 * 1000), want.wait);
  });
}

check('German: a name after "von", and the wait', () => {
  const I18N = runtimeFor('de', JSON.parse(read('i18n/de.json')));
  assert.strictEqual(I18N.credit({ kind: 'add', requested_by: null }), 'Anonym');
  assert.strictEqual(I18N.requestedBy({ kind: 'add', requested_by: 'Lena' }), 'Gewünscht von Lena');
  assert.strictEqual(I18N.t('toast.nothing_left_wait', { wait: I18N.minutes(5 * 60 * 1000) }), 'Gerade nichts mehr übrig. Versuch es in 5 Minuten wieder.');
});

console.log(failures ? `\n${failures} failing` : '\nall passing');

console.log('\nmore languages');

const languageCases = [
  ['it-IT,it;q=0.9', 'it'], ['cs-CZ', 'cs'], ['da-DK', 'da'], ['hu', 'hu'], ['pl-PL', 'pl'],
  ['ro-RO', 'ro'], ['fi-FI', 'fi'], ['sv-SE', 'sv'], ['vi-VN', 'vi'], ['tr-TR', 'tr'],
  ['el-GR', 'el'], ['bg-BG', 'bg'], ['ru-RU', 'ru'], ['uk-UA', 'uk'], ['th-TH', 'th'],
  ['ko-KR', 'ko'], ['ja-JP', 'ja'], ['he-IL', 'he'], ['iw', 'he'],
  // Norwegian: Bokmål for nb, the general "no" and Nynorsk alike.
  ['nb-NO', 'nb'], ['no', 'nb'], ['nn-NO', 'nb'],
  // Portuguese: Brazil has its own file; Portugal and the rest use pt.
  ['pt-BR', 'pt-BR'], ['pt-PT', 'pt'], ['pt', 'pt'], ['pt-AO', 'pt'],
  // Arabic: Egypt has its own file.
  ['ar-EG', 'ar-EG'], ['ar-SA', 'ar'], ['ar', 'ar'],
  // Chinese by script: Traditional for Taiwan, Hong Kong and Macau.
  ['zh-CN', 'zh-Hans'], ['zh-SG', 'zh-Hans'], ['zh', 'zh-Hans'], ['zh-Hans-CN', 'zh-Hans'],
  ['zh-TW', 'zh-Hant'], ['zh-HK', 'zh-Hant'], ['zh-MO', 'zh-Hant'], ['zh-Hant', 'zh-Hant'],
  // Preference order and weights.
  ['sw,ja;q=0.8,en;q=0.9', 'en'], ['en;q=0.5,ko', 'ko'], ['*', 'en'], ['ja;q=0', 'en']
];
for (const [header, lang] of languageCases) {
  check(`${header} gets ${lang}`, () => assert.strictEqual(i18n.pick(request(header)), lang));
}

check('every language file has a name, and every page key', () => {
  for (const lang of i18n.languages()) {
    const strings = JSON.parse(read(`i18n/${lang}.json`));
    assert.ok(strings._language, lang);
    const missing = Object.keys(en).filter((key) => !(key in strings));
    assert.deepStrictEqual(missing, [], lang);
  }
});

check('Hebrew and Arabic read right to left; the page is told so', () => {
  for (const lang of ['he', 'ar', 'ar-EG']) assert.strictEqual(i18n.dir(lang), 'rtl', lang);
  for (const lang of ['en', 'ru', 'zh-Hant', 'ja']) assert.strictEqual(i18n.dir(lang), 'ltr', lang);
  assert.match(i18n.script('he'), /"dir":"rtl"/);
  assert.strictEqual(runtimeFor('ar', JSON.parse(read('i18n/ar.json'))).html.dir, 'rtl');
  assert.strictEqual(runtimeFor('fr', JSON.parse(read('i18n/fr.json'))).html.dir, 'ltr');
});

check('plurals follow each language: Russian, Polish, Czech, Arabic, Japanese', () => {
  const t = (lang, key, count) => runtimeFor(lang, JSON.parse(read(`i18n/${lang}.json`))).t(key, { count });
  assert.strictEqual(t('ru', 'time.minutes', 1), '1 минуту');
  assert.strictEqual(t('ru', 'time.minutes', 3), '3 минуты');
  assert.strictEqual(t('ru', 'time.minutes', 5), '5 минут');
  assert.strictEqual(t('ru', 'time.minutes', 21), '21 минуту');
  assert.strictEqual(t('pl', 'search.results', 2), 'Znaleziono 2 utwory.');
  assert.strictEqual(t('pl', 'search.results', 12), 'Znaleziono 12 utworów.');
  assert.strictEqual(t('cs', 'button.left', 3), 'zbývají 3');
  assert.strictEqual(t('ar', 'time.minutes', 2), 'دقيقتين');
  assert.strictEqual(t('ar', 'time.minutes', 4), '4 دقائق');
  assert.strictEqual(t('ja', 'search.results', 1), '1 件のトラックが見つかりました。');
});

console.log('\nchosen language');

check("a language the guest chose wins over the browser's", () => {
  const req = (cookie, header) => Object.assign(request(header), { cookies: cookie ? { party_lang: cookie } : {} });
  assert.strictEqual(i18n.pick(req('ja', 'fr-FR')), 'ja');
  assert.strictEqual(i18n.pick(req('pt-BR', 'en')), 'pt-BR');
  assert.strictEqual(i18n.pick(req('xx', 'fr-FR')), 'fr', 'an unknown choice is ignored');
  assert.strictEqual(i18n.pick(req(null, 'fr-FR')), 'fr');
});

check('the page gets every language by its own name, and whether one was chosen', () => {
  const names = i18n.list();
  assert.strictEqual(names.length, i18n.languages().length);
  assert.ok(names.some((l) => l.code === 'ja' && l.name === '日本語'));
  assert.ok(names.some((l) => l.code === 'zh-Hant' && l.name === '繁體中文'));
  assert.match(i18n.script('ja', true), /"chosen":true/);
  assert.match(i18n.script('en'), /"chosen":false/);
});

console.log('\nmixed scripts');

check('a name in another script keeps its place; plain text otherwise', () => {
  const he = runtimeFor('he', JSON.parse(read('i18n/he.json')));
  assert.strictEqual(he.t('credit.requested_by', { name: 'Sam' }), 'בבקשת \u2068Sam\u2069');
  const enPage = runtimeFor('en', en);
  assert.strictEqual(enPage.t('credit.requested_by', { name: 'Sam' }), 'Requested by Sam');
  assert.strictEqual(enPage.t('credit.requested_by', { name: 'יוסי' }), 'Requested by \u2068יוסי\u2069');
  assert.strictEqual(enPage.t('lang.change', { language: 'العربية' }), 'Language: \u2068العربية\u2069. Change');
  assert.strictEqual(enPage.t('search.results', { count: 3 }), '3 tracks found.', 'counts are never wrapped');
});

check('"Up next" and "Play it next" read differently, and nothing says song', () => {
  for (const lang of i18n.languages()) {
    const strings = JSON.parse(read(`i18n/${lang}.json`));
    assert.notStrictEqual(strings['queue.up_next'], strings['track.next'], lang);
  }
  assert.strictEqual(JSON.parse(read('i18n/ko.json'))['queue.up_next'], '다음 순서');
});


process.exit(failures ? 1 : 0);
