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
const assert = require('assert');
const { envValue, startPort, DEFAULT_PORT, instanceName } = require('../lib/env');
const { debugOn, countWarnings, warningCount } = require('../lib/log');
const { portChosen } = require('../lib/env');

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
check('debug on for 1/true/yes/on, either spelling', () => {
  for (const v of ['1', 'true', 'YES', ' on ']) assert.ok(debugOn({ ROON_EXTENSION_PARTY_MODE_DEBUG: v }), v);
  assert.ok(debugOn({ 'ROON-EXTENSION-PARTY-MODE_DEBUG': '1' }));
});
check('debug off when unset or other values', () => {
  assert.ok(!debugOn({}));
  assert.ok(!debugOn({ ROON_EXTENSION_PARTY_MODE_DEBUG: '0' }));
});
check('the web port is chosen once saved in the settings, or set in the environment', () => {
  assert.ok(!portChosen({}, {}), 'first run, nothing set');
  assert.ok(!portChosen({ zone: null }, {}));
  assert.ok(portChosen({ port: 8338 }, {}), 'saved, even the default');
  assert.ok(portChosen({}, { ROON_EXTENSION_PARTY_MODE_PORT: '9000' }));
  assert.ok(portChosen({}, { PARTY_PORT: '9000' }), 'the old name');
});
check('warnings and errors are counted, and still written', () => {
  const written = [];
  const target = { log: () => {}, warn: (m) => written.push(`warn ${m}`), error: (m) => written.push(`error ${m}`) };
  countWarnings(target);
  const before = warningCount();
  target.warn('a');
  target.error('b');
  target.log('c');
  assert.strictEqual(warningCount() - before, 2);
  assert.deepStrictEqual(written, ['warn a', 'error b']);
});

if (failures) {
  console.log(`\n${failures} failed`);
  process.exit(1);
}
