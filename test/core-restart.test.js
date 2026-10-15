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
const { KnownKeys } = require('../lib/art-cache');

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
  roon.artKeys = new KnownKeys();
  roon.profileSessions = new Map();
  roon.zoneOutput = null;
  roon.zoneLost = false;
  roon.zoneHold = false;
  roon.zoneHoldTimer = null;
  roon.announcedMode = 'on';
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

check("album art keys are noted from now playing and the queue, as they arrive", () => {
  const roon = service();
  const playing = Object.assign({}, zone, { now_playing: { image_key: 'playing', two_line: { line1: 'Waterloo' } } });
  const core = fakeCore([playing]);
  roon._onCorePaired(core);
  core.zonesCb('Subscribed', {});
  core.queueSubs[0]('Subscribed', { items: [Object.assign(entry(1, 'SOS'), { image_key: 'queued' })] });
  core.queueSubs[0]('Changed', { changes: [{ operation: 'insert', index: 1, items: [Object.assign(entry(2, 'Fernando'), { image_key: 'added' })] }] });
  for (const key of ['playing', 'queued', 'added']) assert.ok(roon.artKeys.use(key), key);
  assert.ok(!roon.artKeys.use('made-up'));
});

console.log('zone and Core log lines');

/** What fn logs, as "log: …" and "warn: …" lines. */
function logged(fn) {
  const lines = [];
  const real = { log: console.log, warn: console.warn };
  console.log = (m) => lines.push(`log: ${m}`);
  console.warn = (m) => lines.push(`warn: ${m}`);
  try {
    fn();
  } finally {
    Object.assign(console, real);
  }
  return lines;
}

check('the party zone going away and coming back is logged, once each way', () => {
  const roon = service();
  const core = fakeCore([zone]);
  core.display_name = 'Studio';
  const lines = logged(() => {
    roon._onCorePaired(core);
    core.zonesCb('Subscribed', {});
    core.zones = [];
    core.zonesCb('Changed', {});
    core.zonesCb('Changed', {});
    core.zones = [zone];
    core.zonesCb('Changed', {});
    core.zonesCb('Changed', {});
  });
  assert.deepStrictEqual(lines, [
    'log: Connected to the Roon Core "Studio"',
    'warn: Party zone "Lounge" is no longer available in Roon',
    'log: Party zone "Lounge" is available again'
  ]);
});

check('a zone not there yet, or the host choosing another, is not a loss', () => {
  const roon = service();
  const core = fakeCore([]);
  const lines = logged(() => {
    roon._onCorePaired(core);
    core.zonesCb('Subscribed', {}); // zones arrive empty after connecting
    core.zones = [zone];
    core.zonesCb('Changed', {});
    roon.settings = { zone: { output_id: 'o2' } }; // another zone, not known
    roon._refreshZone();
  });
  assert.deepStrictEqual(lines, ['log: Connected to the Roon Core']);
});

check('losing the Core is logged as that, not as the zone, and so is getting it back', () => {
  const roon = service();
  const first = fakeCore([zone]);
  const lines = logged(() => {
    roon._onCorePaired(first);
    first.zonesCb('Subscribed', {});
    roon._onCoreUnpaired();
    roon._onCoreUnpaired(); // already gone: nothing more
    const second = fakeCore([]);
    roon._onCorePaired(second);
    second.zonesCb('Subscribed', {});
    second.zones = [zone];
    second.zonesCb('Changed', {});
  });
  assert.deepStrictEqual(lines, [
    'log: Connected to the Roon Core',
    "warn: Lost the connection to the Roon Core: guests can't search or request until it's back",
    'log: Connected to the Roon Core'
  ]);
});

console.log('the party pauses itself while its zone is gone');

/** A paired service with the zone there, and the party mode changes it announces. */
function partyWithZone(enabled = true) {
  const roon = service();
  roon.settings = { zone: { output_id: 'o1', name: 'Lounge' }, enabled };
  roon.announcedMode = { true: 'on', paused: 'paused', false: 'off' }[enabled];
  const core = fakeCore([zone]);
  const changes = [];
  roon.on('party_mode_changed', (now, previous) => changes.push(`${previous} -> ${now}`));
  roon._onCorePaired(core);
  core.zonesCb('Subscribed', {});
  return { roon, core, changes };
}

check('gone for the grace period: paused, then back on when the zone returns', () => {
  withTimers((pending) => {
    let roon, core, changes;
    const lines = logged(() => {
      ({ roon, core, changes } = partyWithZone());
      core.zones = [];
      core.zonesCb('Changed', {});
      assert.strictEqual(roon.currentMode, 'on', 'not before the grace period');
      pending.forEach((fire) => fire());
      assert.strictEqual(roon.currentMode, 'paused');
      core.zones = [zone];
      core.zonesCb('Changed', {});
    });
    assert.strictEqual(roon.currentMode, 'on');
    assert.deepStrictEqual(changes, ['on -> paused', 'paused -> on']);
    assert.strictEqual(roon.settings.enabled, true, 'the saved setting is untouched');
    assert.deepStrictEqual(lines.slice(1), [
      'warn: Party zone "Lounge" is no longer available in Roon',
      'warn: Requests are paused until party zone "Lounge" is back',
      'log: Party zone "Lounge" is available again',
      'log: Requests are back on'
    ]);
  });
});

check('a zone Roon is slow to bring back after a Core restart: its absence and return are logged', () => {
  withTimers((pending) => {
    let roon;
    const lines = logged(() => {
      ({ roon } = partyWithZone());
      roon._onCoreUnpaired();
      const second = fakeCore([]);
      roon._onCorePaired(second);
      second.zonesCb('Subscribed', {}); // zones arrive empty after connecting
      pending.forEach((fire) => fire()); // and stay that way past the grace period
      second.zones = [zone];
      second.zonesCb('Changed', {});
    });
    assert.strictEqual(roon.currentMode, 'on');
    assert.deepStrictEqual(lines.slice(2), [
      'log: Connected to the Roon Core',
      'warn: Party zone "Lounge" is not available in Roon',
      'warn: Requests are paused until party zone "Lounge" is back',
      'log: Party zone "Lounge" is available again',
      'log: Requests are back on'
    ]);
  });
});

check('back within the grace period: nothing changes for guests', () => {
  withTimers((pending) => {
    let roon, core, changes;
    logged(() => {
      ({ roon, core, changes } = partyWithZone());
      core.zones = [];
      core.zonesCb('Changed', {});
      core.zones = [zone];
      core.zonesCb('Changed', {});
      pending.forEach((fire) => fire()); // the wait ends after the zone is back
    });
    assert.strictEqual(roon.currentMode, 'on');
    assert.deepStrictEqual(changes, []);
  });
});

check("the host's own Paused or Off is left as it is", () => {
  for (const enabled of ['paused', false]) {
    withTimers((pending) => {
      let roon, core, changes;
      const lines = logged(() => {
        ({ roon, core, changes } = partyWithZone(enabled));
        core.zones = [];
        core.zonesCb('Changed', {});
        pending.forEach((fire) => fire());
        core.zones = [zone];
        core.zonesCb('Changed', {});
      });
      assert.strictEqual(roon.currentMode, enabled === false ? 'off' : 'paused', String(enabled));
      assert.deepStrictEqual(changes, [], String(enabled));
      assert.ok(!lines.some((l) => l.includes('Requests are')), String(enabled));
    });
  }
});

check('the host unpausing while the zone is gone stays paused until it returns', () => {
  withTimers((pending) => {
    let roon, core, changes;
    logged(() => {
      ({ roon, core, changes } = partyWithZone('paused'));
      core.zones = [];
      core.zonesCb('Changed', {});
      pending.forEach((fire) => fire());
      roon.settings.enabled = true; // Unpause in Roon
      roon._announceMode();
      assert.strictEqual(roon.currentMode, 'paused');
      core.zones = [zone];
      core.zonesCb('Changed', {});
    });
    assert.strictEqual(roon.currentMode, 'on');
    assert.deepStrictEqual(changes, ['paused -> on']);
  });
});

check('a zone missing just after connecting does not pause', () => {
  withTimers((pending) => {
    const roon = service();
    roon.settings = { zone: { output_id: 'o1', name: 'Lounge' }, enabled: true };
    const core = fakeCore([]);
    logged(() => {
      roon._onCorePaired(core);
      core.zonesCb('Subscribed', {}); // zones arrive empty at first
      core.zones = [zone];
      core.zonesCb('Changed', {});
      pending.forEach((fire) => fire());
    });
    assert.strictEqual(roon.currentMode, 'on');
  });
});

check('the Core gone for the wait: paused, then back on when it returns with the zone', () => {
  withTimers((pending) => {
    let roon, core, changes;
    const lines = logged(() => {
      ({ roon, core, changes } = partyWithZone());
      roon._onCoreUnpaired();
      assert.strictEqual(roon.currentMode, 'on', 'not before the wait');
      pending.forEach((fire) => fire());
      assert.strictEqual(roon.currentMode, 'paused');
      roon._onCorePaired(core);
      core.zonesCb('Subscribed', {});
    });
    assert.strictEqual(roon.currentMode, 'on');
    assert.deepStrictEqual(changes, ['on -> paused', 'paused -> on']);
    assert.deepStrictEqual(lines.filter((l) => !l.includes('Connected')), [
      "warn: Lost the connection to the Roon Core: guests can't search or request until it's back",
      'warn: Requests are paused until the Roon Core is back',
      'log: Requests are back on'
    ]);
  });
});

check('the Core back within the wait: nothing changes for guests', () => {
  withTimers((pending) => {
    let roon, core, changes;
    logged(() => {
      ({ roon, core, changes } = partyWithZone());
      roon._onCoreUnpaired();
      roon._onCorePaired(core);
      core.zonesCb('Subscribed', {});
      pending.forEach((fire) => fire()); // the Core's wait ends after it's back
    });
    assert.strictEqual(roon.currentMode, 'on');
    assert.deepStrictEqual(changes, []);
  });
});

check('the Core back without the zone: still paused, now until the zone is back', () => {
  withTimers((pending) => {
    let roon, core, changes;
    const lines = logged(() => {
      ({ roon, core, changes } = partyWithZone());
      roon._onCoreUnpaired();
      pending.forEach((fire) => fire());
      core.zones = [];
      roon._onCorePaired(core);
      core.zonesCb('Subscribed', {});
      pending.forEach((fire) => fire());
      assert.strictEqual(roon.currentMode, 'paused');
      core.zones = [zone];
      core.zonesCb('Changed', {});
    });
    assert.strictEqual(roon.currentMode, 'on');
    assert.deepStrictEqual(changes, ['on -> paused', 'paused -> on']);
    assert.deepStrictEqual(lines.filter((l) => !l.includes('Connected') && !l.includes('Lost')), [
      'warn: Requests are paused until the Roon Core is back',
      'warn: Party zone "Lounge" is not available in Roon',
      'warn: Requests are paused until party zone "Lounge" is back',
      'log: Party zone "Lounge" is available again',
      'log: Requests are back on'
    ]);
  });
});

check('back within the wait but without the zone: the zone\'s own wait still pauses', () => {
  withTimers((pending) => {
    let roon, core;
    logged(() => {
      ({ roon, core } = partyWithZone());
      roon._onCoreUnpaired();
      core.zones = [];
      roon._onCorePaired(core);
      core.zonesCb('Subscribed', {});
      pending.forEach((fire) => fire());
    });
    assert.strictEqual(roon.currentMode, 'paused');
  });
});

check("the host's own Paused or Off is left alone when the Core goes", () => {
  for (const enabled of ['paused', false]) {
    withTimers((pending) => {
      let roon, changes;
      const lines = logged(() => {
        ({ roon, changes } = partyWithZone(enabled));
        roon._onCoreUnpaired();
        pending.forEach((fire) => fire());
      });
      assert.strictEqual(roon.currentMode, enabled === false ? 'off' : 'paused', String(enabled));
      assert.deepStrictEqual(changes, [], String(enabled));
      assert.ok(!lines.some((l) => l.includes('Requests are')), String(enabled));
    });
  }
});

check('Roon starting or stopping to allow a skip tells the pages, so Skip shows or hides', () => {
  const roon = service();
  const core = fakeCore([Object.assign({}, zone, { is_next_allowed: true })]);
  roon._onCorePaired(core);
  core.zonesCb('Subscribed', {});
  let told = 0;
  roon.on('now_playing_changed', () => (told += 1));
  core.zones = [Object.assign({}, zone, { is_next_allowed: false })]; // a radio station started, say
  roon._refreshZone();
  assert.strictEqual(told, 1);
  roon._refreshZone();
  assert.strictEqual(told, 1, 'no change, nothing said');
});

console.log(failures ? `\n${failures} failing` : '\nall passing');
process.exitCode = failures ? 1 : 0;
