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
 * Environment variables are named ROON_EXTENSION_PARTY_MODE_<SETTING>. The
 * hyphenated spelling (ROON-EXTENSION-PARTY-MODE_<SETTING>) is accepted too:
 * Docker can pass it, though shells can't set it. Older names still work,
 * after the new ones.
 */
const PREFIXES = ['ROON_EXTENSION_PARTY_MODE_', 'ROON-EXTENSION-PARTY-MODE_'];

const DEFAULT_PORT = 8338;

function namesFor(setting, legacy = []) {
  return [...PREFIXES.map((prefix) => prefix + setting), ...legacy];
}

// The first of the names that is set and not blank, or undefined.
function envValue(setting, legacy = [], env = process.env) {
  for (const name of namesFor(setting, legacy)) {
    const value = String(env[name] == null ? '' : env[name]).trim();
    if (value) return value;
  }
  return undefined;
}

/**
 * ROON_EXTENSION_PARTY_MODE_INSTANCE: a name for this copy ("Garden"), so
 * several copies can run against one Core as separate extensions. Unset for
 * almost everyone. At most 40 characters.
 */
function instanceName(env = process.env) {
  const name = envValue('INSTANCE', [], env);
  return name ? Array.from(name).slice(0, 40).join('').trim() : '';
}

// The port to start on before one has been saved in Roon.
function startPort(env = process.env) {
  const port = Number(envValue('PORT', ['PARTY_PORT'], env));
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT;
}

// Requests a minute from one device: all of them, and searches, which reach the
// Roon Core. Far above what a phone or the Party Hub sends; they're there for a
// misbehaving or rogue device on the Wi-Fi.
const DEFAULT_RATE_LIMIT = 600;
const DEFAULT_SEARCH_LIMIT = 60;

/**
 * ROON_EXTENSION_PARTY_MODE_RATE_LIMIT and ROON_EXTENSION_PARTY_MODE_SEARCH_LIMIT:
 * requests a minute per device (by IP address), 0 for no limit. Anything that
 * isn't a whole number from 0 up keeps the default.
 * @returns {{all: number, search: number}}
 */
function rateLimits(env = process.env) {
  const read = (setting, fallback) => {
    const value = envValue(setting, [], env);
    const n = value === undefined ? NaN : Number(value);
    return Number.isInteger(n) && n >= 0 ? n : fallback;
  };
  return { all: read('RATE_LIMIT', DEFAULT_RATE_LIMIT), search: read('SEARCH_LIMIT', DEFAULT_SEARCH_LIMIT) };
}

/**
 * The limits from the environment, or null when neither variable is set (so the
 * Request limits setting in Roon decides).
 * @returns {{all: number, search: number}|null}
 */
function rateLimitsFromEnv(env = process.env) {
  const set = ['RATE_LIMIT', 'SEARCH_LIMIT'].some((setting) => envValue(setting, [], env) !== undefined);
  return set ? rateLimits(env) : null;
}

module.exports = {
  envValue,
  rateLimitsFromEnv,
  DEFAULT_RATE_LIMIT,
  DEFAULT_SEARCH_LIMIT,
  instanceName,
  namesFor,
  rateLimits,
  startPort,
  DEFAULT_PORT,
  DEFAULT_RATE_LIMIT,
  DEFAULT_SEARCH_LIMIT,
  PREFIXES
};
