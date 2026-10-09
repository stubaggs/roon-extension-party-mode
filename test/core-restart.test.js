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

// The queue after the Roon Core restarts (issue #42): the extension reconnects
// and asks for the queue before the Core knows the zone again.

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
const zone = { zone_id: 'z1', display_name: 'Lounge', state: 'playing', outputs: [{ output_id: 'o1' }], settings: {} };

/** A fake Core: the zones it knows, and every queue subscription made to it. */
function fakeCore(zones) {
  const core = { zones, queueSubs: [], zonesCb: null };
  core.services = {
    RoonApiTransport: {
      subscribe_zones: (cb) => (core.zonesCb = cb),
      subscribe_queue: (output, count, cb) => core.queueSubs.push(cb),
      zone_by_output_id: (id) => core.zones.find((z) => z.outputs.some((o) => o.output_id === id)) || null
    }
  };
  return core;
}

function service() {
  const roon = Object.setPrototypeOf(new EventEmitter(), RoonService.prototype);
  roon.settings = { zone: { output_id: 'o1' } };
  roon.zone = null;
  roon.queue = [];
  roon.queueGeneration = 0;
  roon.queueState = 'none';
  roon.queueRetry = null;
  roon.radioPicks = new Set();
  roon.profileSessions = new Map();
  roon._updateStatus = () => {};
  roon._applyProfile = () => {};
  return roon;
}

/** Runs fn with setTimeout captured, so a retry can be fired by hand. */
function withTimers(fn) {
  const real = global.setTimeout;
  const pending = [];
  global.setTimeout = (cb) => {
    pending.push(cb);
    return { unref() {} };
  };
  try {
    fn(pending);
  } finally {
    global.setTimeout = real;
  }
}

console.log('Core restart');

check('the queue comes back when the zone does, after the Core refused it', () => {
  const roon = service();
  const first = fakeCore([zone]);
  roon._onCorePaired(first);
  first.zonesCb('Subscribed', {});
  first.queueSubs[0]('Subscribed', { items: [entry(1, 'Waterloo'), entry(2, 'SOS')] });
  assert.strictEqual(roon.queue.length, 2);

  // The Core restarts: it drops the connection, then comes back not yet
  // knowing the zone, and refuses the queue.
  roon._onCoreUnpaired();
  const second = fakeCore([]);
  roon._onCorePaired(second);
  second.zonesCb('Subscribed', {});
  second.queueSubs[0]('InvalidRequest', { error: 'zone not found' });
  assert.strictEqual(roon.queue.length, 0);

  // The zone appears: the queue is asked for again, and arrives.
  second.zones.push(zone);
  second.zonesCb('Changed', {});
  assert.strictEqual(second.queueSubs.length, 2, 'asked again');
  second.queueSubs[1]('Subscribed', { items: [entry(1, 'Waterloo'), entry(2, 'SOS')] });
  assert.deepStrictEqual(roon.queue.map((i) => i.queue_item_id), [1, 2]);

  // And later changes are followed again.
  second.queueSubs[1]('Changed', { changes: [{ operation: 'insert', index: 2, items: [entry(3, 'Fernando')] }] });
  assert.strictEqual(roon.queue.length, 3);
});

check('a refused queue is asked for again shortly when the zone is already there', () => {
  withTimers((pending) => {
    const roon = service();
    const core = fakeCore([zone]);
    roon._onCorePaired(core);
    core.zonesCb('Subscribed', {});
    core.queueSubs[0]('InvalidRequest', {});
    assert.strictEqual(pending.length, 1, 'one retry waiting');
    pending[0]();
    assert.strictEqual(core.queueSubs.length, 2, 'asked again');
    core.queueSubs[1]('Subscribed', { items: [entry(1, 'Waterloo')] });
    assert.strictEqual(roon.queue.length, 1);
  });
});

check('a working queue is not asked for again on every zone update', () => {
  const roon = service();
  const core = fakeCore([zone]);
  roon._onCorePaired(core);
  core.queueSubs[0]('Subscribed', { items: [entry(1, 'Waterloo')] });
  core.zonesCb('Subscribed', {});
  core.zonesCb('Changed', {});
  core.zonesCb('Changed', {});
  assert.strictEqual(core.queueSubs.length, 1);
  assert.strictEqual(roon.queue.length, 1);
});

console.log(failures ? `\n${failures} failing` : '\nall passing');
process.exitCode = failures ? 1 : 0;
