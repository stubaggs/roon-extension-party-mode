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

  console.log(failures ? `\n${failures} failing` : '\nall passing');
  process.exit(failures ? 1 : 0);
})();
