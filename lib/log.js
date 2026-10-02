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
 * Debug logging, off unless ROON_EXTENSION_PARTY_MODE_DEBUG is set (1, true,
 * yes or on). It also turns on node-roon-api's own log of every message to and
 * from the Core, which is large and includes guests' searches, so it is for
 * troubleshooting. The hyphenated spelling is accepted too: Docker can pass it,
 * though shells can't set it.
 */
const NAMES = ['ROON_EXTENSION_PARTY_MODE_DEBUG', 'ROON-EXTENSION-PARTY-MODE_DEBUG'];

function debugOn(env = process.env) {
  return NAMES.some((name) => /^(1|true|yes|on)$/i.test(String(env[name] || '').trim()));
}

const DEBUG = debugOn();

function debug(...args) {
  if (DEBUG) console.log(...args);
}

module.exports = { DEBUG, debug, debugOn, NAMES };
