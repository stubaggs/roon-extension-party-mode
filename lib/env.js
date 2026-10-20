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

/**
 * Whether the host chose the web port: saved in Roon's settings (`saved` is
 * config.json's settings), or set in the environment for the first run. A
 * chosen port is never swapped for another when busy (app.js).
 */
function portChosen(saved, env = process.env) {
  const port = saved && saved.port;
  if (port !== undefined && port !== null && port !== '') return true;
  return Boolean(envValue('PORT', ['PARTY_PORT'], env));
}

// Flood protection's Default (lib/roon-service.js): requests a minute from one device: all of them, and searches, which reach the
// Roon Core. Far above what a phone or the Party Hub sends (a guest searching
// hard makes about 10 searches and 60-120 requests a minute), so a dozen or so
// such guests fit behind one shared address; they're there for a misbehaving or
// rogue device on the Wi-Fi. 1200 is about two-thirds of what a Raspberry Pi 1
// serves, and 200 searches somewhat less than it can run.
const DEFAULT_RATE_LIMIT = 1200;
const DEFAULT_SEARCH_LIMIT = 200;

/**
 * ROON_EXTENSION_PARTY_MODE_BUILD: when and from which commit the image was
 * built ("2026-10-16 b51496d"), stamped by the publish workflow; '' for a
 * local build or Node.js. For the About page.
 */
function buildStamp(env = process.env) {
  return envValue('BUILD', [], env) || '';
}

module.exports = {
  buildStamp,
  envValue,
  instanceName,
  namesFor,
  startPort,
  portChosen,
  DEFAULT_PORT,
  DEFAULT_RATE_LIMIT,
  DEFAULT_SEARCH_LIMIT,
  PREFIXES
};
