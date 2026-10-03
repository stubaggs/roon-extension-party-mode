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
  for (const file of ['guest.js', 'roonparty.js', 'i18n-runtime.js']) {
    for (const m of read(file).matchAll(/\bt\('([a-z_.]+)'/g)) keys.add(m[1]);
  }
  for (const file of ['index.html', 'roonparty.html']) {
    for (const m of read(file).matchAll(/data-i18n(?:-[a-z-]+)?="([a-z_.]+)"/g)) keys.add(m[1]);
  }
  // Built from parts in guest.js: allowance.<bucket>.<state>
  for (const bucket of ['add', 'next', 'skip']) {
    for (const state of ['unlimited', 'left', 'waiting', 'used']) keys.add(`allowance.${bucket}.${state}`);
  }
  keys.add('join.closed');
  keys.add('join.expired');
  return keys;
}

const placeholders = (entry) =>
  [...new Set((typeof entry === 'object' ? Object.values(entry).join(' ') : entry).match(/\{\w+\}/g) || [])].sort();

/** Runs the page runtime as a browser would, with the given served data. */
function runtimeFor(lang, strings) {
  const html = { lang: '' };
  const window = { I18N_DATA: { lang, strings, fallback: en } };
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
  for (const file of ['guest.js', 'roonparty.js']) {
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
  assert.strictEqual(I18N.t('allowance.skip.left', { count: 1 }), '1 skip left.');
  assert.strictEqual(I18N.t('allowance.skip.left', { count: 3 }), '3 skips left.');
  assert.strictEqual(I18N.minutes(30 * 1000), 'a minute');
  assert.strictEqual(I18N.minutes(12 * 60 * 1000), '12 minutes');
});

check('credits: a name, "a guest", or Roon Radio', () => {
  const I18N = runtimeFor('en', en);
  assert.strictEqual(I18N.requestedBy({ kind: 'add', requested_by: 'Sam' }), 'Requested by Sam');
  assert.strictEqual(I18N.requestedBy({ kind: 'next', requested_by: null }), 'Requested by a guest');
  assert.strictEqual(I18N.requestedBy({ kind: 'radio', requested_by: null }), 'Roon Radio');
  assert.strictEqual(I18N.credit({ kind: 'add', requested_by: 'Sam' }), 'Sam');
  assert.strictEqual(I18N.credit({ kind: 'next', requested_by: null }), 'a guest');
  assert.strictEqual(I18N.credit({ kind: 'radio', requested_by: null }), 'Roon Radio');
});

check('no language preference, or any, gets English', () => {
  // The real negotiation Express uses, which offers the first language listed.
  const accepts = require('accepts');
  const real = (header) => {
    const req = { headers: header ? { 'accept-language': header } : {} };
    return { acceptsLanguages: (...langs) => accepts(req).languages(...langs) };
  };
  assert.strictEqual(i18n.pick(real()), 'en');
  assert.strictEqual(i18n.pick(real('*')), 'en');
  assert.strictEqual(i18n.pick(real('fr-FR,fr;q=0.9')), 'fr');
  assert.strictEqual(i18n.pick(real('ja')), 'en');
});

check('a key missing from a language falls back to English', () => {
  const I18N = runtimeFor('de', { 'queue.up_next': 'Als Nächstes' });
  assert.strictEqual(I18N.t('queue.up_next'), 'Als Nächstes');
  assert.strictEqual(I18N.t('played.title'), 'Played');
  assert.strictEqual(I18N.html.lang, 'de');
});

console.log('\nserver');

const request = (header) => ({
  acceptsLanguages: (...langs) => {
    const wanted = String(header || '').split(',').map((part) => part.split(';')[0].trim().split('-')[0]);
    return wanted.find((code) => langs.includes(code)) || false;
  }
});

check('a browser asking for a language without a file gets English', () => {
  assert.strictEqual(i18n.pick(request('it-IT,it;q=0.9')), 'en');
  assert.strictEqual(i18n.pick(request('ja')), 'en');
  assert.strictEqual(i18n.pick(request('')), 'en');
});

check('server messages come from the same file', () => {
  assert.strictEqual(i18n.t('en', 'join.closed'), 'The party is closed.');
  assert.strictEqual(i18n.t('xx', 'join.closed'), 'The party is closed.');
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
  assert.strictEqual(i18n.pick(request('it-IT,fr;q=0.5')), 'fr');
  assert.strictEqual(i18n.pick(request('en-GB,fr;q=0.5')), 'en');
});

check('French text, plurals and clock', () => {
  const fr = JSON.parse(read('i18n/fr.json'));
  const I18N = runtimeFor('fr', fr);
  assert.strictEqual(I18N.t('queue.up_next'), 'À suivre');
  assert.strictEqual(I18N.t('credit.requested_by', { name: 'Sam' }), 'Demandé par Sam');
  assert.strictEqual(I18N.t('allowance.add.left', { count: 1 }), 'Il vous reste 1 morceau à ajouter.');
  assert.strictEqual(I18N.t('allowance.add.left', { count: 3 }), 'Il vous reste 3 morceaux à ajouter.');
  assert.strictEqual(I18N.minutes(30 * 1000), 'une minute');
  assert.strictEqual(I18N.credit({ kind: 'add', requested_by: null }), 'un invité');
  assert.strictEqual(i18n.t('fr', 'join.expired'), 'Ce code a expiré. Scannez à nouveau le code affiché à l\'écran.');
});

console.log('\nSpanish, German, Dutch');

for (const [header, lang] of [['es-ES,es;q=0.9', 'es'], ['es-419', 'es'], ['de-DE,de;q=0.9', 'de'], ['de-CH', 'de'], ['nl-NL', 'nl'], ['nl-BE,fr;q=0.8', 'nl']]) {
  check(`${header} gets ${lang}`, () => assert.strictEqual(i18n.pick(request(header)), lang));
}

const samples = {
  es: { up: 'A continuación', one: 'Te queda 1 canción por añadir.', many: 'Te quedan 3 canciones por añadir.', guest: 'Pedida por un invitado', wait: 'un minuto' },
  de: { up: 'Als Nächstes', one: 'Du kannst noch 1 Song hinzufügen.', many: 'Du kannst noch 3 Songs hinzufügen.', guest: 'Gewünscht von einem Gast', wait: 'einer Minute' },
  nl: { up: 'Hierna', one: 'Je kunt nog 1 nummer toevoegen.', many: 'Je kunt nog 3 nummers toevoegen.', guest: 'Aangevraagd door een gast', wait: 'een minuut' }
};
for (const [lang, want] of Object.entries(samples)) {
  check(`${lang}: text, plurals and "by a guest"`, () => {
    const I18N = runtimeFor(lang, JSON.parse(read(`i18n/${lang}.json`)));
    assert.strictEqual(I18N.t('queue.up_next'), want.up);
    assert.strictEqual(I18N.t('allowance.add.left', { count: 1 }), want.one);
    assert.strictEqual(I18N.t('allowance.add.left', { count: 3 }), want.many);
    assert.strictEqual(I18N.requestedBy({ kind: 'add', requested_by: null }), want.guest);
    assert.strictEqual(I18N.minutes(30 * 1000), want.wait);
  });
}

check('German "a guest" changes after "by", but not on its own', () => {
  const I18N = runtimeFor('de', JSON.parse(read('i18n/de.json')));
  assert.strictEqual(I18N.credit({ kind: 'add', requested_by: null }), 'ein Gast');
  assert.strictEqual(I18N.requestedBy({ kind: 'add', requested_by: 'Lena' }), 'Gewünscht von Lena');
  assert.strictEqual(I18N.t('toast.nothing_left_wait', { wait: I18N.minutes(5 * 60 * 1000) }), 'Gerade nichts mehr übrig. Versuch es in 5 Minuten wieder.');
});

console.log(failures ? `\n${failures} failing` : '\nall passing');
process.exit(failures ? 1 : 0);
