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
const { envValue, startPort, DEFAULT_PORT, envPort } = require('../lib/env');
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
check('envPort is the variable when it is a port, and nothing otherwise', () => {
  assert.strictEqual(envPort({ ROON_EXTENSION_PARTY_MODE_PORT: '9000' }), 9000);
  assert.strictEqual(envPort({ PARTY_PORT: '9002' }), 9002);
  for (const unset of [{}, { ROON_EXTENSION_PARTY_MODE_PORT: '' }, { ROON_EXTENSION_PARTY_MODE_PORT: 'abc' }]) {
    assert.strictEqual(envPort(unset), undefined, JSON.stringify(unset));
  }
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

if (failures) {
  console.log(`\n${failures} failed`);
  process.exit(1);
}
