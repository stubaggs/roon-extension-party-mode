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

console.log('\nPlayHistory: skipped in Roon');

const ended = (title, seek, length = 200) => ({ title, artist: 'ABBA', length, seek });

check('a track left well before its end was skipped in Roon', () => {
  const history = new PlayHistory();
  history.update('z1', playing('Waterloo'), null);
  history.update('z1', playing('SOS'), null, ended('Waterloo', 42));
  const [played] = history.list();
  assert.strictEqual(played.skipped, true);
  assert.strictEqual(played.skipped_in_roon, true);
  assert.strictEqual(played.skipped_by, null);
});

check('a track that reached its last seconds played out', () => {
  const history = new PlayHistory();
  history.update('z1', playing('Waterloo'), null);
  history.update('z1', playing('SOS'), null, ended('Waterloo', 195));
  assert.ok(!history.list()[0].skipped);
});

check('the next track still loading: the early end is remembered', () => {
  const history = new PlayHistory();
  history.update('z1', playing('Waterloo'), null);
  history.update('z1', Object.assign(playing('SOS'), { state: 'loading' }), null, ended('Waterloo', 42));
  history.update('z1', playing('SOS'), null);
  assert.strictEqual(history.list()[0].skipped_in_roon, true);
});

check('a guest skip keeps the guest\'s name', () => {
  const history = new PlayHistory();
  history.update('z1', playing('Waterloo'), null);
  history.markSkipped(playing('Waterloo'), 'Stu');
  history.update('z1', playing('SOS'), null, ended('Waterloo', 42));
  const [played] = history.list();
  assert.strictEqual(played.skipped_by, 'Stu');
  assert.ok(!played.skipped_in_roon);
});

check('no position seen, or no length: not judged', () => {
  const history = new PlayHistory();
  history.update('z1', playing('Waterloo'), null);
  history.update('z1', playing('SOS'), null, ended('Waterloo', null));
  assert.ok(!history.list()[0].skipped);
  history.update('z1', playing('Radio', null), null, ended('SOS', 3, null));
  assert.ok(!history.list()[0].skipped);
});

check('a different track\'s position is ignored', () => {
  const history = new PlayHistory();
  history.update('z1', playing('Waterloo'), null);
  history.update('z1', playing('SOS'), null, ended('Mamma Mia', 3));
  assert.ok(!history.list()[0].skipped);
});

console.log('\nnaming yourself later');

check('a name given later reaches the tracks already played and playing', () => {
  const history = new PlayHistory();
  history.update('z1', playing('Waterloo'), { requested_by: null, kind: 'add', guest: 'g1' });
  history.markSkipped(playing('Waterloo'), '', 'g1');
  history.update('z1', playing('SOS'), { requested_by: null, kind: 'add', guest: 'g1' });
  history.update('z1', playing('Mamma Mia'), { requested_by: 'Sam', kind: 'add', guest: 'g2' });
  history.rename('g1', 'Stu');
  history.update('z1', playing('Fernando'), null);
  const [mamma, sos, waterloo] = history.list();
  assert.strictEqual(waterloo.requested_by, 'Stu');
  assert.strictEqual(waterloo.skipped_by, 'Stu');
  assert.strictEqual(sos.requested_by, 'Stu', 'the track that was playing when they renamed');
  assert.strictEqual(mamma.requested_by, 'Sam', "someone else's track is left alone");
});

check("guest refs never leave the server", () => {
  const history = new PlayHistory();
  history.update('z1', playing('Waterloo'), { requested_by: 'Stu', kind: 'add', guest: 'g1' });
  history.markSkipped(playing('Waterloo'), 'Stu', 'g1');
  history.update('z1', playing('SOS'), null);
  assert.ok(!JSON.stringify(history.list()).includes('g1'));
});

{
  const { GuestStore } = require('../lib/guests');
  check('renaming a guest renames their requests, and only theirs', () => {
    const store = new GuestStore();
    const stu = store.create();
    const sam = store.create();
    sam.name = 'Sam';
    store.attribute(stu, { title: 'Waterloo', artist: 'ABBA' }, 'add');
    store.attribute(sam, { title: 'SOS', artist: 'ABBA' }, 'add');
    stu.name = 'Stu';
    store.rename(stu);
    assert.strictEqual(store.lookup({ title: 'Waterloo', artist: 'ABBA' }).name, 'Stu');
    assert.strictEqual(store.lookup({ title: 'SOS', artist: 'ABBA' }).name, 'Sam');
    assert.notStrictEqual(stu.ref, stu.id, 'the ref is not the session cookie');
  });
}

check('a radio station never goes into Played, but the track before it does', () => {
  const history = new PlayHistory();
  history.update('z1', playing('Waterloo'), null);
  assert.strictEqual(history.update('z1', { title: 'ABC Triple J Shift', artist: '', state: 'playing', station: true }, null), true);
  assert.deepStrictEqual(history.list().map((t) => t.title), ['Waterloo']);
  history.update('z1', playing('SOS'), null);
  history.update('z1', playing('Fernando'), null);
  assert.deepStrictEqual(history.list().map((t) => t.title), ['SOS', 'Waterloo']);
});

console.log(failures ? `\n${failures} failing` : '\nall passing');
process.exit(failures ? 1 : 0);
