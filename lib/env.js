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
 * The port ROON_EXTENSION_PARTY_MODE_PORT sets, or undefined when it isn't set
 * or isn't a port. When set, it decides the port over the one saved in Roon:
 * in Docker the compose file is where the port is configured.
 */
function envPort(env = process.env) {
  const port = Number(envValue('PORT', ['PARTY_PORT'], env));
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined;
}

/** The port to use when neither the environment nor Roon's settings give one. */
function startPort(env = process.env) {
  return envPort(env) || DEFAULT_PORT;
}

module.exports = { envValue, envPort, namesFor, startPort, DEFAULT_PORT, PREFIXES };
