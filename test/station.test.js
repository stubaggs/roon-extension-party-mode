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

// A request while a radio station plays: the queue takes over from its first
// item (see RoonService._playQueueOverStation). Shaped on what a Core sent in
// October 2026: the station plays outside the queue, with no length and no seek.

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
    // Like the Core: does it, and never answers.
    play_from_here: (z, id) => roon.calls.push(['play_from_here', id]),
    control: (z, control, cb) => {
      roon.calls.push([control]);
      cb(false);
    }
  };
  roon.core = { services: { RoonApiTransport: transport } };
  return roon;
}

const queued = (id, title) => ({ queue_item_id: id, two_line: { line1: title } });

(async () => {
  console.log('Radio station');

  await check('a request plays the queue from its first item, the host\'s queue first', async () => {
    const roon = service(station, [queued(7, 'Apsheron Quintet'), queued(8, 'Fade To Grey')]);
    await roon._playQueueOverStation();
    assert.deepStrictEqual(roon.calls, [['play_from_here', 7]]);
  });

  await check('with nothing queued before, it waits for the request to reach the queue', async () => {
    const roon = service(station, []);
    const done = roon._playQueueOverStation();
    setTimeout(() => {
      roon.queue = [queued(9, 'Fade To Grey')];
      roon.emit('queue_changed');
    }, 20);
    await done;
    assert.deepStrictEqual(roon.calls, [['play_from_here', 9]]);
  });

  await check('a skip is refused while a station plays, without asking Roon', async () => {
    const roon = service(station, []);
    await assert.rejects(roon.skip(), /station/);
    assert.deepStrictEqual(roon.calls, []);
  });

  await check('an ordinary paused track is still just played', async () => {
    const roon = service(track, [queued(1, 'Waterloo')]);
    await roon._resumePlayback();
    assert.deepStrictEqual(roon.calls, [['play']]);
  });

  console.log(failures ? `\n${failures} failing` : '\nall passing');
  process.exit(failures ? 1 : 0);
})();
