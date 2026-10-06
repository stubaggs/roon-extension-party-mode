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

// Telling Roon Radio's queue entries from the host's (RoonService._noteRadioPick),
// with the queue updates a Core sent in October 2026 as the queue ran out.

const assert = require('assert');
const { EventEmitter } = require('events');
const { RoonService } = require('../lib/roon-service');

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

const entry = (id, title) => ({ queue_item_id: id, length: 200, two_line: { line1: title, line2: 'Artist' } });

/** A RoonService subscribed to a fake Core's queue; returns it and the queue callback. */
function subscribed(radio, items) {
  const roon = Object.setPrototypeOf(new EventEmitter(), RoonService.prototype);
  roon.settings = { zone: { output_id: 'o1' } };
  roon.zone = { zone_id: 'z1', settings: { auto_radio: radio } };
  roon.queue = [];
  roon.queueGeneration = 0;
  roon.radioPicks = new Set();
  let send = null;
  roon.core = { services: { RoonApiTransport: { subscribe_queue: (output, count, cb) => (send = cb) } } };
  roon._subscribeQueue();
  send('Subscribed', { items });
  return { roon, send };
}

const replaceAll = (count, items) => ({ changes: [{ operation: 'remove', index: 0, count }, { operation: 'insert', index: 0, items }] });

console.log('Roon Radio');

check("Roon Radio's pick replaces the last entry as it ends, alone", () => {
  const { roon, send } = subscribed(true, [entry(4421, 'Worried Man Blues')]);
  send('Changed', replaceAll(1, [entry(3428, 'The Music That Makes Me Dance')]));
  assert.strictEqual(roon.isRadioPick(3428), true);
  send('Changed', replaceAll(1, [entry(3429, 'Seasons')]));
  assert.strictEqual(roon.isRadioPick(3429), true, 'and the next one');
  assert.strictEqual(roon.isRadioPick(4421), false);
});

check('a track the host adds behind the playing one is not Roon Radio\'s', () => {
  const { roon, send } = subscribed(true, [entry(4421, 'Worried Man Blues')]);
  send('Changed', replaceAll(1, [entry(4421, 'Worried Man Blues'), entry(5000, 'Waterloo')]));
  assert.strictEqual(roon.isRadioPick(5000), false);
});

check('a track the host puts into an empty queue is not Roon Radio\'s', () => {
  const { roon, send } = subscribed(true, []);
  send('Changed', { changes: [{ operation: 'insert', index: 0, items: [entry(5001, 'Waterloo')] }] });
  assert.strictEqual(roon.isRadioPick(5001), false);
});

check('with Roon Radio off, nothing is taken for its pick', () => {
  const { roon, send } = subscribed(false, [entry(4421, 'Worried Man Blues')]);
  send('Changed', replaceAll(1, [entry(5002, 'SOS')]));
  assert.strictEqual(roon.isRadioPick(5002), false);
});

check('the same entry sent again is not a new pick', () => {
  const { roon, send } = subscribed(true, [entry(4421, 'Worried Man Blues')]);
  send('Changed', replaceAll(1, [entry(4421, 'Worried Man Blues')]));
  assert.strictEqual(roon.isRadioPick(4421), false);
});

console.log(failures ? `\n${failures} failing` : '\nall passing');
process.exit(failures ? 1 : 0);
