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

/**
 * Page languages. Each public/i18n/<code>.json is a language; en.json is the
 * fallback for anything missing. The language for a request is the best match
 * between the browser's Accept-Language and the files present, so each guest's
 * phone gets its own language.
 */

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'public', 'i18n');
const RUNTIME = path.join(__dirname, '..', 'public', 'i18n-runtime.js');
const FALLBACK = 'en';

function load() {
  const languages = {};
  for (const file of fs.readdirSync(DIR)) {
    if (!file.endsWith('.json')) continue;
    languages[path.basename(file, '.json')] = JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8'));
  }
  if (!languages[FALLBACK]) throw new Error(`public/i18n/${FALLBACK}.json is missing`);
  return languages;
}

const languages = load();
const runtime = fs.readFileSync(RUNTIME, 'utf8');

/** The language code to use for an Express request. */
function pick(req) {
  return req.acceptsLanguages(...Object.keys(languages)) || FALLBACK;
}

/** One string, server side, with the same fallback and {name} rules as the page. */
function t(lang, key, vars = {}) {
  const entry = (languages[lang] || {})[key] ?? languages[FALLBACK][key] ?? key;
  return String(typeof entry === 'object' ? entry.other : entry).replace(/\{(\w+)\}/g, (m, name) =>
    vars[name] === undefined ? m : vars[name]
  );
}

/** The /i18n.js the pages load: the chosen language's text, then the runtime. */
function script(lang) {
  const data = { lang, strings: languages[lang] || {}, fallback: languages[FALLBACK] };
  return `window.I18N_DATA = ${JSON.stringify(data)};\n${runtime}`;
}

module.exports = { pick, t, script, languages: () => Object.keys(languages), FALLBACK };
