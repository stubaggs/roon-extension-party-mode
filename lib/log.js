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

// Warnings and errors logged since Party Mode started, for the About page.
let warnings = 0;

/** Counts every console.warn and console.error from now on (app.js, at startup). */
function countWarnings(target = console) {
  for (const level of ['warn', 'error']) {
    const write = target[level];
    target[level] = (...args) => {
      warnings += 1;
      return write.apply(target, args);
    };
  }
}

function warningCount() {
  return warnings;
}

/**
 * A name or typed text for a log line, in quotes. Line breaks and other
 * control characters are written as escapes, so text can't start a line of
 * its own that looks like Party Mode's.
 */
function quote(text) {
  const escaped = String(text).replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, (c) => {
    if (c === '\n') return '\\n';
    if (c === '\r') return '\\r';
    if (c === '\t') return '\\t';
    return `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`;
  });
  return `"${escaped}"`;
}

module.exports = { DEBUG, debug, debugOn, debugEnabled, setDebug, countWarnings, warningCount, quote, NAMES };
