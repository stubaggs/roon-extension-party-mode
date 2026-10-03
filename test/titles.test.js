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
const { isTrackList, pickAction, findProfileEntry } = require('../lib/titles');
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

const actions = (...titles) => titles.map((title, i) => ({ title, item_key: `a${i}`, hint: 'action' }));
const english = actions('Play Now', 'Add Next', 'Queue', 'Start Radio');
const german = actions('Jetzt abspielen', 'Als Nächstes', 'Zur Warteschlange', 'Radio starten');

const { fakeBrowseCore, serviceFor } = require('./fake-roon');

const fakeSearch = (categories) => {
  const actionsList = categories.actions;
  const cats = Object.assign({}, categories);
  delete cats.actions;
  return fakeBrowseCore({ categories: cats, actions: actionsList.map((a) => a.title) });
};
const service = (fake, settings) => serviceFor(fake, settings);
const pressed = (fake) => fake.events.filter((e) => e.includes(':press ')).map((e) => e.split(':press ')[1]);

const tracks = [
  { title: 'Dancing Queen', subtitle: 'ABBA', item_key: 't1', hint: 'action_list' },
  { title: 'Waterloo', subtitle: 'ABBA', item_key: 't2', hint: 'action_list' }
];
const albums = [{ title: 'Arrival', subtitle: 'ABBA', item_key: 'x1', hint: 'list' }];
const artists = [{ title: 'ABBA', item_key: 'x2', hint: 'list' }];

(async () => {
  console.log('matching helpers');

  await check('track lists are recognised by their items', async () => {
    assert.strictEqual(isTrackList(tracks), true);
    assert.strictEqual(isTrackList(albums), false);
    assert.strictEqual(isTrackList([]), false);
  });

  await check('actions are found by title first', async () => {
    assert.strictEqual(pickAction(english, 'add', 'Queue').item.title, 'Queue');
    assert.strictEqual(pickAction(english, 'next', 'add next').by, 'title');
  });

  await check('in another language, the four actions are taken by position', async () => {
    assert.strictEqual(pickAction(german, 'add', 'Queue').item.title, 'Zur Warteschlange');
    assert.strictEqual(pickAction(german, 'next', 'Add Next').item.title, 'Als Nächstes');
    assert.strictEqual(pickAction(german, 'add', 'Queue').by, 'position');
  });

  await check('any other shape of action list is refused, not guessed', async () => {
    assert.strictEqual(pickAction(actions('Eins', 'Zwei', 'Drei'), 'add', 'Queue'), null);
    assert.strictEqual(pickAction(actions('A', 'B', 'C', 'D', 'E'), 'add', 'Queue'), null);
    const mixed = german.slice(0, 3).concat({ title: 'Mehr', item_key: 'm', hint: 'list' });
    assert.strictEqual(pickAction(mixed, 'add', 'Queue'), null);
  });

  await check('the Profile entry is found in other languages', async () => {
    const menu = (title) => [{ title: 'Allgemein', item_key: 'g' }, { title, item_key: 'p' }];
    assert.strictEqual(findProfileEntry(menu('Profil'), 'Profile').by, 'language');
    assert.strictEqual(findProfileEntry(menu('Perfil'), 'Profile').item.item_key, 'p');
    assert.strictEqual(findProfileEntry(menu('Profile'), 'Profile').by, 'title');
    assert.strictEqual(findProfileEntry(menu('Bibliothek'), 'Profile'), null);
  });

  console.log('\na Core in German');

  await check('search finds the track category without its title', async () => {
    const fake = fakeSearch({ Künstler: artists, Alben: albums, Titel: tracks, actions: german });
    const roon = service(fake);
    const found = await roon.search('s1', 'abba');
    assert.deepStrictEqual(found.map((t) => t.title), ['Dancing Queen', 'Waterloo']);
    assert.strictEqual(roon.detected.tracks, 'Titel');
  });

  await check('the next search goes straight to it', async () => {
    const fake = fakeSearch({ Künstler: artists, Alben: albums, Titel: tracks, actions: german });
    const roon = service(fake);
    await roon.search('s1', 'abba');
    const calls = [];
    const browse = fake.browse;
    roon._browse = async (opts) => { calls.push(opts); return browse(opts); };
    await roon.search('s1', 'abba');
    assert.strictEqual(calls.filter((c) => c.pop_levels).length, 0, 'no probing the second time');
  });

  await check('Queue and Add Next press the right German actions', async () => {
    const fake = fakeSearch({ Titel: tracks, actions: german });
    const roon = service(fake);
    await roon.performAction('s1', 't1', 'add');
    await roon.performAction('s1', 't1', 'next');
    assert.deepStrictEqual(pressed(fake), ['Zur Warteschlange', 'Als Nächstes']);
    assert.strictEqual(roon.detected.add, 'Zur Warteschlange');
    assert.strictEqual(roon.detected.next, 'Als Nächstes');
  });

  await check('an English Core behaves as before', async () => {
    const fake = fakeSearch({ Artists: artists, Tracks: tracks, actions: english });
    const roon = service(fake);
    const found = await roon.search('s1', 'abba');
    assert.strictEqual(found.length, 2);
    await roon.performAction('s1', 't1', 'add');
    assert.deepStrictEqual(pressed(fake), ['Queue']);
    assert.deepStrictEqual(roon.detected, {});
  });

  await check('an unfamiliar action list fails instead of pressing something', async () => {
    const fake = fakeSearch({ Titel: tracks, actions: actions('Eins', 'Zwei', 'Drei') });
    const roon = service(fake);
    await assert.rejects(roon.performAction('s1', 't1', 'add'), /action_unavailable/);
    assert.deepStrictEqual(pressed(fake), []);
  });

  const withTransport = (roon, state) => {
    const controls = [];
    roon.zone = { state, display_name: 'Kitchen' };
    roon.core = { services: { RoonApiTransport: { control: (zone, control, cb) => { controls.push(control); cb(false); } } } };
    return controls;
  };

  for (const state of ['paused', 'stopped']) {
    await check(`a request to a ${state} zone starts playback`, async () => {
      const roon = service(fakeSearch({ Tracks: tracks, actions: english }));
      const controls = withTransport(roon, state);
      await roon.performAction('s1', 't1', 'add');
      await roon.performAction('s1', 't1', 'next');
      assert.deepStrictEqual(controls, ['play', 'play']);
    });
  }

  await check('a request to a playing zone leaves playback alone', async () => {
    const roon = service(fakeSearch({ Tracks: tracks, actions: english }));
    const controls = withTransport(roon, 'playing');
    await roon.performAction('s1', 't1', 'add');
    assert.deepStrictEqual(controls, []);
  });

  console.log('\nparty mode');

  const { partyMode } = require('../lib/roon-service');

  await check('stored values read as on, paused or off; anything else is on', async () => {
    assert.strictEqual(partyMode({ enabled: true }), 'on');
    assert.strictEqual(partyMode({ enabled: 'paused' }), 'paused');
    assert.strictEqual(partyMode({ enabled: false }), 'off');
    assert.strictEqual(partyMode({}), 'on');
    assert.strictEqual(partyMode({ enabled: 'nonsense' }), 'on');
  });

  const modeChange = async (state, from, to, extra) => {
    const roon = service(fakeSearch({ Tracks: tracks, actions: english }));
    const controls = withTransport(roon, state);
    Object.assign(roon.zone, { is_play_allowed: true }, extra);
    const events = [];
    roon.on('party_mode_changed', (...args) => events.push(args));
    await roon._partyModeChanged(from, to);
    return { controls, events };
  };

  await check('on to paused pauses the music', async () => {
    const { controls, events } = await modeChange('playing', 'on', 'paused');
    assert.deepStrictEqual(controls, ['pause']);
    assert.deepStrictEqual(events, [['paused', 'on']]);
  });

  await check('paused back to on plays the queue', async () => {
    assert.deepStrictEqual((await modeChange('paused', 'paused', 'on')).controls, ['play']);
  });

  await check('back to on with nothing to play leaves it', async () => {
    assert.deepStrictEqual((await modeChange('stopped', 'paused', 'on', { is_play_allowed: false })).controls, []);
  });

  await check('off pauses the music too', async () => {
    assert.deepStrictEqual((await modeChange('playing', 'on', 'off')).controls, ['pause']);
  });

  await check('paused to off has nothing more to pause', async () => {
    assert.deepStrictEqual((await modeChange('paused', 'paused', 'off')).controls, []);
  });

  await check('back on from off, a new party, waits for someone to press play', async () => {
    assert.deepStrictEqual((await modeChange('paused', 'off', 'on')).controls, []);
  });

  console.log('\nhow far a track got');

  const zoneAt = (title, seek, length = 200) => ({
    now_playing: { three_line: { line1: title, line2: 'ABBA' }, length, seek_position: seek }
  });

  await check('the furthest position seen is reported when the track changes', async () => {
    const roon = service(fakeSearch({ Tracks: tracks, actions: english }));
    assert.strictEqual(roon._notePosition(zoneAt('Waterloo', 10)), null);
    roon._notePosition(zoneAt('Waterloo', 42));
    roon._notePosition(zoneAt('Waterloo', 0)); // a zone update with a reset position
    assert.deepStrictEqual(roon._notePosition(zoneAt('SOS', 0)), { title: 'Waterloo', artist: 'ABBA', length: 200, seek: 42 });
  });

  await check('no position ever seen is reported as unknown', async () => {
    const roon = service(fakeSearch({ Tracks: tracks, actions: english }));
    roon._notePosition(zoneAt('Waterloo', undefined));
    assert.strictEqual(roon._notePosition(zoneAt('SOS', 0)).seek, null);
  });

  await check('nothing playing any more also ends the track', async () => {
    const roon = service(fakeSearch({ Tracks: tracks, actions: english }));
    roon._notePosition(zoneAt('Waterloo', 42));
    assert.strictEqual(roon._notePosition({}).title, 'Waterloo');
    assert.strictEqual(roon._notePosition(zoneAt('SOS', 1)), null);
  });

  console.log(failures ? `\n${failures} failing` : '\nall passing');
  process.exit(failures ? 1 : 0);
})();
