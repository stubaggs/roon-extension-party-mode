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

// Older or broader codes browsers send for a language we have a file for.
const ALIASES = { iw: 'he', no: 'nb', nn: 'nb' };
// Chinese is chosen by script: Traditional for Taiwan, Hong Kong and Macau.
const TRADITIONAL = ['hant', 'tw', 'hk', 'mo'];
// Languages written right to left.
const RTL = ['ar', 'he'];

/**
 * The file for one language tag ("pt-BR", "zh-TW", "fr-CA"), or null: the tag
 * itself, then the language with its region or script, then the language alone.
 */
function match(tag) {
  const codes = Object.keys(languages);
  const find = (code) => codes.find((c) => c.toLowerCase() === code.toLowerCase()) || null;
  const parts = tag.toLowerCase().split('-');
  const primary = ALIASES[parts[0]] || parts[0];
  if (primary === 'zh') return find(parts.some((p) => TRADITIONAL.includes(p)) ? 'zh-Hant' : 'zh-Hans');
  return find(tag) || (parts[1] && find(`${primary}-${parts[1]}`)) || find(primary);
}

/**
 * The language for an Express request: the browser's Accept-Language, in order
 * of preference, matched to the files present. English with none, or "*".
 */
function pick(req) {
  const header = String((req.headers && req.headers['accept-language']) || '');
  const wanted = header
    .split(',')
    .map((part, index) => {
      const [tag, ...params] = part.trim().split(';');
      const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
      return { tag: tag.trim(), q: q ? Number(q.slice(2)) : 1, index };
    })
    .filter((entry) => entry.tag && entry.q > 0)
    .sort((a, b) => b.q - a.q || a.index - b.index);
  for (const { tag } of wanted) {
    if (tag === '*') return FALLBACK;
    const code = match(tag);
    if (code) return code;
  }
  return FALLBACK;
}

/** 'rtl' for a language written right to left, else 'ltr'. */
function dir(lang) {
  return RTL.includes(String(lang).split('-')[0]) ? 'rtl' : 'ltr';
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
  const data = { lang, dir: dir(lang), strings: languages[lang] || {}, fallback: languages[FALLBACK] };
  return `window.I18N_DATA = ${JSON.stringify(data)};\n${runtime}`;
}

module.exports = { pick, match, dir, t, script, languages: () => Object.keys(languages), FALLBACK };
