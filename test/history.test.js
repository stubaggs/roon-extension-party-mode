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
const { PlayHistory } = require('../lib/history');

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

const playing = (title, length = 200) => ({ title, artist: 'ABBA', length, state: 'playing' });

console.log('PlayHistory: skips');

check('a skipped track says who skipped it once it has played', () => {
  const history = new PlayHistory();
  history.update('z1', playing('Waterloo'), null);
  history.markSkipped(playing('Waterloo'), 'Stu');
  history.update('z1', playing('SOS'), null);
  const [played] = history.list();
  assert.strictEqual(played.title, 'Waterloo');
  assert.strictEqual(played.skipped, true);
  assert.strictEqual(played.skipped_by, 'Stu');
});

check('a guest with no name is kept as null, for "a guest"', () => {
  const history = new PlayHistory();
  history.update('z1', playing('Waterloo'), null);
  history.markSkipped(playing('Waterloo'), '');
  history.update('z1', playing('SOS'), null);
  assert.strictEqual(history.list()[0].skipped_by, null);
});

check('only the track that is playing is marked', () => {
  const history = new PlayHistory();
  history.update('z1', playing('Waterloo'), null);
  history.markSkipped(playing('SOS'), 'Stu');
  history.update('z1', playing('SOS'), null);
  assert.ok(!history.list()[0].skipped);
});

check('a skip that failed is undone', () => {
  const history = new PlayHistory();
  history.update('z1', playing('Waterloo'), null);
  const undo = history.markSkipped(playing('Waterloo'), 'Stu');
  undo();
  history.update('z1', playing('SOS'), null);
  assert.ok(!history.list()[0].skipped);
  assert.strictEqual(history.list()[0].skipped_by, null);
});

check('tracks that played to the end are not marked', () => {
  const history = new PlayHistory();
  history.update('z1', playing('Waterloo'), null);
  history.update('z1', playing('SOS'), null);
  assert.ok(!history.list()[0].skipped);
});

console.log(failures ? `\n${failures} failing` : '\nall passing');
process.exit(failures ? 1 : 0);
