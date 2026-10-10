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
const { envValue, startPort, DEFAULT_PORT, instanceName, rateLimits, rateLimitsFromEnv } = require('../lib/env');
const { debugOn } = require('../lib/log');

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

console.log('env');

check('port defaults to 8338', () => assert.strictEqual(startPort({}), DEFAULT_PORT));
check('new port name', () => assert.strictEqual(startPort({ ROON_EXTENSION_PARTY_MODE_PORT: '9000' }), 9000));
check('hyphenated port name', () =>
  assert.strictEqual(startPort({ 'ROON-EXTENSION-PARTY-MODE_PORT': '9001' }), 9001));
check('old PARTY_PORT still works', () => assert.strictEqual(startPort({ PARTY_PORT: '9002' }), 9002));
check('new name wins over the old one', () =>
  assert.strictEqual(startPort({ ROON_EXTENSION_PARTY_MODE_PORT: '9000', PARTY_PORT: '9002' }), 9000));
check('blank new name falls through to the old one', () =>
  assert.strictEqual(startPort({ ROON_EXTENSION_PARTY_MODE_PORT: ' ', PARTY_PORT: '9002' }), 9002));
check('bad port falls back to the default', () => {
  for (const bad of ['abc', '0', '-1', '70000', '80.5']) {
    assert.strictEqual(startPort({ ROON_EXTENSION_PARTY_MODE_PORT: bad }), DEFAULT_PORT, bad);
  }
});
check('instance name: trimmed, at most 40 characters, empty when unset', () => {
  assert.strictEqual(instanceName({}), '');
  assert.strictEqual(instanceName({ ROON_EXTENSION_PARTY_MODE_INSTANCE: ' Garden ' }), 'Garden');
  assert.strictEqual(instanceName({ 'ROON-EXTENSION-PARTY-MODE_INSTANCE': 'Dev' }), 'Dev');
  assert.strictEqual(Array.from(instanceName({ ROON_EXTENSION_PARTY_MODE_INSTANCE: '🎉'.repeat(50) })).length, 40);
});
check('envValue trims and skips unset names', () =>
  assert.strictEqual(envValue('X', ['OLD_X'], { OLD_X: ' y ' }), 'y'));
check('rate limits default to 600 a minute, and 60 searches', () =>
  assert.deepStrictEqual(rateLimits({}), { all: 600, search: 60 }));
check('rate limits from the environment, either spelling, 0 for none', () => {
  assert.deepStrictEqual(
    rateLimits({ ROON_EXTENSION_PARTY_MODE_RATE_LIMIT: '1200', 'ROON-EXTENSION-PARTY-MODE_SEARCH_LIMIT': '0' }),
    { all: 1200, search: 0 }
  );
});
check('a rate limit that is not a whole number keeps the default', () => {
  for (const v of ['-1', '1.5', 'lots', '']) {
    assert.deepStrictEqual(rateLimits({ ROON_EXTENSION_PARTY_MODE_RATE_LIMIT: v, ROON_EXTENSION_PARTY_MODE_SEARCH_LIMIT: v }), { all: 600, search: 60 }, v);
  }
});
check('limits from the environment only when one of the variables is set', () => {
  assert.strictEqual(rateLimitsFromEnv({}), null);
  assert.deepStrictEqual(rateLimitsFromEnv({ ROON_EXTENSION_PARTY_MODE_SEARCH_LIMIT: '0' }), { all: 600, search: 0 });
});

check('debug on for 1/true/yes/on, either spelling', () => {
  for (const v of ['1', 'true', 'YES', ' on ']) assert.ok(debugOn({ ROON_EXTENSION_PARTY_MODE_DEBUG: v }), v);
  assert.ok(debugOn({ 'ROON-EXTENSION-PARTY-MODE_DEBUG': '1' }));
});
check('debug off when unset or other values', () => {
  assert.ok(!debugOn({}));
  assert.ok(!debugOn({ ROON_EXTENSION_PARTY_MODE_DEBUG: '0' }));
});

if (failures) {
  console.log(`\n${failures} failed`);
  process.exit(1);
}
