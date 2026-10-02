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
const { listProfiles, selectProfile } = require('../lib/profiles');
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

/**
 * A stand-in for Roon's "settings" browse hierarchy: a menu with a Profile
 * entry listing profiles. Records which item keys were selected.
 */
function fakeRoon(profiles, menuTitle = 'Profile') {
  const menu = [
    { title: 'General', item_key: 'general' },
    { title: menuTitle, item_key: 'profile-menu' },
    { title: 'Library', item_key: 'library' }
  ];
  let level = 'root';
  const selected = [];
  const browse = async (opts) => {
    assert.strictEqual(opts.hierarchy, 'settings');
    if (opts.pop_all) {
      level = 'root';
      return { action: 'list' };
    }
    if (opts.item_key === 'profile-menu') {
      level = 'profiles';
      return { action: 'list' };
    }
    selected.push(opts.item_key);
    return { action: 'none' };
  };
  const load = async () => ({
    items: level === 'root' ? menu : profiles.map((name, i) => ({ title: name, item_key: `p${i}` }))
  });
  return { browse, load, selected };
}

(async () => {
  console.log('profiles');

  await check('lists the profiles under the Profile entry', async () => {
    const roon = fakeRoon(['Stu', 'Guests', 'Kids']);
    const result = await listProfiles(roon.browse, roon.load, 'Profile');
    assert.deepStrictEqual(result.profiles.map((p) => p.title), ['Stu', 'Guests', 'Kids']);
  });

  await check('selects the named profile, ignoring case', async () => {
    const roon = fakeRoon(['Stu', 'Guests']);
    const result = await selectProfile(roon.browse, roon.load, 'Profile', 'guests');
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(roon.selected, ['p1']);
  });

  await check('reports a profile that no longer exists, without selecting anything', async () => {
    const roon = fakeRoon(['Stu']);
    const result = await selectProfile(roon.browse, roon.load, 'Profile', 'Guests');
    assert.strictEqual(result.reason, 'no_profile');
    assert.deepStrictEqual(result.profiles, ['Stu']);
    assert.deepStrictEqual(roon.selected, []);
  });

  await check('reports a missing menu entry with what was there', async () => {
    const roon = fakeRoon(['Stu'], 'Benutzer');
    const result = await selectProfile(roon.browse, roon.load, 'Profile', 'Stu');
    assert.strictEqual(result.reason, 'no_menu');
    assert.deepStrictEqual(result.menu, ['General', 'Benutzer', 'Library']);
  });

  await check('a Profile entry in another language is found without setting it', async () => {
    const roon = fakeRoon(['Stu', 'Gäste'], 'Profil');
    const result = await listProfiles(roon.browse, roon.load, 'Profile');
    assert.strictEqual(result.entryTitle, 'Profil');
    assert.strictEqual((await selectProfile(roon.browse, roon.load, 'Profile', 'Gäste')).ok, true);
  });

  await check('a localised menu title works when set', async () => {
    const roon = fakeRoon(['Stu'], 'Profil');
    assert.strictEqual((await selectProfile(roon.browse, roon.load, 'Profil', 'Stu')).ok, true);
  });

  console.log('\nprofile setting');
  const layout = (self, values) =>
    RoonService.prototype._layout.call(Object.assign({ _resolveZone: () => null }, self), values);
  const dropdown = (result) => result.layout.find((item) => item.setting === 'guest_profile');

  await check('offers "Leave as it is" plus the Core\'s profiles', async () => {
    const item = dropdown(layout({ profiles: ['Stu', 'Guests'] }, {}));
    assert.deepStrictEqual(item.values.map((v) => v.title), ['Leave as it is', 'Stu', 'Guests']);
    assert.strictEqual(item.values[0].value, '');
  });

  await check('keeps a saved profile the Core no longer has, marked not found', async () => {
    const item = dropdown(layout({ profiles: ['Stu'] }, { guest_profile: 'Guests' }));
    assert.strictEqual(item.values[item.values.length - 1].title, 'Guests (not found)');
  });

  await check('keeps a saved profile when the list could not be read', async () => {
    const item = dropdown(layout({ profiles: [] }, { guest_profile: 'Guests' }));
    assert.strictEqual(item.values[item.values.length - 1].title, 'Guests');
  });

  await check('shows a problem reading profiles under the setting', async () => {
    const item = dropdown(layout({ profiles: [], profileProblem: 'No "Profile" entry' }, {}));
    assert.strictEqual(item.subtitle, 'No "Profile" entry');
  });

  console.log('\nprofile per guest session');

  const { fakeBrowseCore, serviceFor } = require('./fake-roon');
  const tracks = [{ title: 'Dancing Queen', subtitle: 'ABBA', item_key: 't1', hint: 'action_list' }];

  await check("a guest's first search selects the profile in that guest's browse session, first", async () => {
    const core = fakeBrowseCore({ categories: { Tracks: tracks } });
    const roon = serviceFor(core, { guest_profile: 'Party' });
    await roon.search('guest-1', 'abba');
    assert.deepStrictEqual(core.events, ['guest-1:profile Party', 'guest-1:search abba']);
    assert.strictEqual(core.profileOf('guest-1'), 'Party');
  });

  await check('the songs a guest queues come from the session holding the profile', async () => {
    const core = fakeBrowseCore({ categories: { Tracks: tracks } });
    const roon = serviceFor(core, { guest_profile: 'Party' });
    const found = await roon.search('guest-1', 'abba');
    await roon.performAction('guest-1', found[0].item_key, 'add');
    assert.deepStrictEqual(core.events, ['guest-1:profile Party', 'guest-1:search abba', 'guest-1:press Queue']);
  });

  await check('only once per guest; each new guest gets it too', async () => {
    const core = fakeBrowseCore({ categories: { Tracks: tracks } });
    const roon = serviceFor(core, { guest_profile: 'Party' });
    await roon.search('guest-1', 'abba');
    await roon.search('guest-1', 'queen');
    await roon.search('guest-2', 'abba');
    assert.deepStrictEqual(core.events.filter((e) => e.includes(':profile ')), ['guest-1:profile Party', 'guest-2:profile Party']);
  });

  await check('changing the setting reselects in sessions already set up', async () => {
    const core = fakeBrowseCore({ categories: { Tracks: tracks }, profiles: ['Stu', 'Party', 'Kids'] });
    const roon = serviceFor(core, { guest_profile: 'Party' });
    await roon.search('guest-1', 'abba');
    roon.settings.guest_profile = 'Kids';
    roon.profileSessions.clear(); // what _applyProfile does on a change
    await roon.search('guest-1', 'abba');
    assert.strictEqual(core.profileOf('guest-1'), 'Kids');
  });

  await check('works when Settings and Profile have other names (another language)', async () => {
    const core = fakeBrowseCore({ categories: { Titel: tracks }, settings: 'Einstellungen', profileEntry: 'Profil', library: 'Bibliothek', search: 'Suche' });
    const roon = serviceFor(core, { guest_profile: 'Party' });
    await roon.search('guest-1', 'abba');
    assert.strictEqual(core.profileOf('guest-1'), 'Party');
    assert.ok(core.events.includes('guest-1:search abba'));
  });

  await check('"Leave as it is" selects nothing', async () => {
    const core = fakeBrowseCore({ categories: { Tracks: tracks } });
    const roon = serviceFor(core, { guest_profile: '' });
    await roon.search('guest-1', 'abba');
    assert.deepStrictEqual(core.events, ['guest-1:search abba']);
  });

  await check('a profile that has gone still lets the guest search', async () => {
    const core = fakeBrowseCore({ categories: { Tracks: tracks }, profiles: ['Stu'] });
    const roon = serviceFor(core, { guest_profile: 'Party' });
    const found = await roon.search('guest-1', 'abba');
    assert.strictEqual(found.length, 1);
  });

  console.log(failures ? `\n${failures} failing` : '\nall passing');
  process.exit(failures ? 1 : 0);
})();
