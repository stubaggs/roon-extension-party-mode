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

// A radio station on the party zone: requests wait for the host, and skips are
// refused. Shaped on what a Core sent in October 2026: the station plays outside
// the queue, with no length and no seek.

const assert = require('assert');
const { EventEmitter } = require('events');
const { RoonService } = require('../lib/roon-service');

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

const station = {
  zone_id: 'z1',
  display_name: 'D90',
  state: 'playing',
  is_seek_allowed: false,
  is_next_allowed: false,
  now_playing: { two_line: { line1: 'ABC Triple J Shift', line2: '' } }
};
const track = { zone_id: 'z1', display_name: 'D90', state: 'paused', is_seek_allowed: true, is_next_allowed: true, now_playing: { length: 210 } };

/** A RoonService with a transport that records what it was asked. */
function service(zone, queue) {
  // An emitter with the service's methods, without connecting to a Core.
  const roon = Object.setPrototypeOf(new EventEmitter(), RoonService.prototype);
  roon.zone = zone;
  roon.queue = queue;
  roon.calls = [];
  const transport = {
    control: (z, control, cb) => {
      roon.calls.push([control]);
      cb(false);
    }
  };
  roon.core = { services: { RoonApiTransport: transport } };
  return roon;
}

(async () => {
  console.log('Radio station');

  const { fakeBrowseCore, serviceFor } = require('./fake-roon');
  const tracks = [{ title: 'Dancing Queen', subtitle: 'ABBA', item_key: 't1', hint: 'action_list' }];

  /** A request on a fake Core, with the zone given; returns the transport calls. */
  async function request(zone) {
    const roon = serviceFor(fakeBrowseCore({ categories: { Tracks: tracks } }));
    const calls = [];
    roon.core.services.RoonApiTransport = { control: (z, control, cb) => calls.push(control) && cb(false) };
    roon.zone = zone;
    const found = await roon.search('guest-1', 'abba');
    await roon.performAction('guest-1', found[0].item_key, 'add');
    return calls;
  }

  await check('a request over a station is queued and waits for the host: nothing is pressed', async () => {
    assert.deepStrictEqual(await request(station), []);
    assert.deepStrictEqual(await request(Object.assign({}, station, { state: 'paused' })), [], 'a paused station stays paused');
  });

  await check('a request on a paused track still presses play', async () => {
    assert.deepStrictEqual(await request(track), ['play']);
  });

  await check('a skip is refused while a station plays, without asking Roon', async () => {
    const roon = service(station, []);
    await assert.rejects(roon.skip(), /station/);
    assert.deepStrictEqual(roon.calls, []);
  });

  console.log(failures ? `\n${failures} failing` : '\nall passing');
  process.exit(failures ? 1 : 0);
})();
