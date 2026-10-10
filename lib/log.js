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
 * Debug logging: the "Detailed log" setting in Roon, also on from the start when
 * ROON_EXTENSION_PARTY_MODE_DEBUG is set (1, true, yes or on). It also turns on
 * node-roon-api's own log of every message to and from the Core, which is large
 * and includes guests' searches, so it is for troubleshooting. Naming follows
 * lib/env.js.
 */
const { envValue, namesFor } = require('./env');

const NAMES = namesFor('DEBUG');

function debugOn(env = process.env) {
  return /^(1|true|yes|on)$/i.test(envValue('DEBUG', [], env) || '');
}

// Whether the environment asked for it at startup.
const DEBUG = debugOn();
let enabled = DEBUG;

/** Whether the detailed log is on now. */
function debugEnabled() {
  return enabled;
}

/** Turns the detailed log on or off while running (the setting in Roon). */
function setDebug(on) {
  enabled = Boolean(on);
}

function debug(...args) {
  if (enabled) console.log(...args);
}

module.exports = { DEBUG, debug, debugOn, debugEnabled, setDebug, NAMES };
