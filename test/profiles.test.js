// Copyright (c) 2026 Stubaggs
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
function fakeRoon(profiles, menuTitle = 'Profile', current = 'Guest') {
  const menu = [
    { title: 'General', item_key: 'general' },
    // Roon shows the session's profile next to the entry.
    { title: menuTitle, subtitle: current, item_key: 'profile-menu' },
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
  const dropdown = (result) => result.layout.find((item) => item.title === 'Party setup').items.find((item) => item.setting === 'guest_profile');

  await check("offers Roon's default, by name when known, plus the Core's profiles", async () => {
    const item = dropdown(layout({ profiles: ['Stu', 'Guests'], defaultProfile: 'Guest' }, {}));
    assert.deepStrictEqual(item.values.map((v) => v.title), ["Roon's default (Guest)", 'Stu', 'Guests']);
    assert.strictEqual(item.values[0].value, '');
    assert.strictEqual(dropdown(layout({ profiles: ['Stu'] }, {})).values[0].title, "Roon's default profile", 'not read');
    assert.strictEqual(item.title, 'Roon profile');
    assert.match(item.subtitle, /Roon profile guests' tracks play under/);
  });

  await check("Roon's default is read from a new session, selecting nothing", async () => {
    const roon = fakeRoon(['Guest', 'Stu'], 'Profile', 'Guest');
    const service = Object.assign(Object.create(RoonService.prototype), { _browse: roon.browse, _load: roon.load });
    assert.strictEqual(await service._readDefaultProfile('Profile'), 'Guest');
    assert.deepStrictEqual(roon.selected, []);
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

  await check('Roon losing a guest\'s session: their next step selects the profile again', async () => {
    const core = fakeBrowseCore({ categories: { Tracks: tracks } });
    const roon = serviceFor(core, { guest_profile: 'Party' });
    await roon.search('guest-1', 'abba');
    core.drop('guest-1');
    await assert.rejects(roon.search('guest-1', 'queen'), /SessionNotFound/);
    await roon.search('guest-1', 'queen');
    assert.strictEqual(core.profileOf('guest-1'), 'Party', 'not Roon\'s default');
    assert.deepStrictEqual(core.events.filter((e) => e.includes(':profile ')), ['guest-1:profile Party', 'guest-1:profile Party']);
    // The same after a request that failed.
    const found = await roon.search('guest-1', 'abba');
    core.drop('guest-1');
    await assert.rejects(roon.performAction('guest-1', found[0].item_key, 'add'), /SessionNotFound/);
    await roon.search('guest-1', 'abba');
    assert.strictEqual(core.profileOf('guest-1'), 'Party');
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

  await check("Roon's default selects nothing", async () => {
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

  await check('nothing is kept per guest once their searches finish and their session ends', async () => {
    const { GuestStore } = require('../lib/guests');
    const core = fakeBrowseCore({ categories: { Tracks: tracks } });
    const roon = serviceFor(core, { guest_profile: 'Party' });
    const guests = new GuestStore();
    guests.onDrop = (id) => roon.forgetSession(id);
    const one = guests.create();
    const two = guests.create();
    await Promise.all([roon.search(one.id, 'abba'), roon.search(one.id, 'queen'), roon.search(two.id, 'abba')]);
    assert.strictEqual(roon.latestSearch.size, 0, 'no finished searches kept');
    assert.strictEqual(roon.profileSessions.size, 2);
    guests._drop(one.id);
    assert.deepStrictEqual([...roon.profileSessions.keys()], [two.id]);
    guests.clear();
    assert.strictEqual(roon.profileSessions.size, 0);
  });

  // What _applyProfile does when Roon doesn't answer: note it, and say so unless quiet.
  const unanswered = (core, answers, zone = null) => {
    const roon = Object.setPrototypeOf({ core, zone, profileProblem: '', calls: [] }, RoonService.prototype);
    roon._applyProfile = async ({ quiet = false } = {}) => {
      roon.calls.push(quiet);
      const answered = answers(roon.calls.length);
      roon.profileProblem = answered ? '' : 'Could not read profiles: Roon did not answer';
      if (!answered && !quiet) console.warn(roon.profileProblem);
    };
    return roon;
  };
  const warnings = async (fn) => {
    const realWarn = console.warn;
    const warned = [];
    console.warn = (m) => warned.push(m);
    try {
      await fn();
    } finally {
      console.warn = realWarn;
    }
    return warned;
  };
  const NO_ANSWER = 'Could not read profiles: Roon did not answer';

  await check('a Core that just started and does not answer about profiles is asked again when the zone arrives', async () => {
    const core = {};
    const roon = unanswered(core, (call) => call > 1);
    const warned = await warnings(async () => {
      await roon._applyProfileOnConnect(core);
      assert.deepStrictEqual(roon.calls, [true], 'the first try is quiet, and nothing is on a timer');
      roon._retryProfile(); // the zone arrived
      await Promise.resolve();
    });
    assert.deepStrictEqual(roon.calls, [true, false]);
    assert.strictEqual(roon.profileProblem, '');
    assert.deepStrictEqual(warned, []);
  });

  await check('still no answer when the zone arrives: logged as a problem', async () => {
    const core = {};
    const roon = unanswered(core, () => false);
    const warned = await warnings(async () => {
      await roon._applyProfileOnConnect(core);
      roon._retryProfile();
      await Promise.resolve();
    });
    assert.deepStrictEqual(warned, [NO_ANSWER]);
  });

  await check('the zone arrived while the first try waited: asked again straight after it', async () => {
    const core = {};
    const roon = unanswered(core, (call) => call > 1, { display_name: 'Lounge' });
    await roon._applyProfileOnConnect(core);
    assert.deepStrictEqual(roon.calls, [true, false]);
    assert.strictEqual(roon.profileProblem, '');
  });

  // Roon's settings menu, on a Core that answers only when told to, as a busy one does.
  const slowCore = ({ profiles }) => {
    const levels = {};
    let release;
    const answered = new Promise((resolve) => (release = resolve));
    const core = {
      browse: async (o) => {
        await answered;
        if (o.pop_all) levels[o.multi_session_key] = 'menu';
        else if (o.item_key === 'prof') levels[o.multi_session_key] = 'profiles';
        return { action: 'list' };
      },
      load: async (o) => ({
        items: levels[o.multi_session_key] === 'profiles'
          ? profiles.map((title, i) => ({ title, item_key: `p${i}`, hint: 'action' }))
          : [{ title: 'Profile', item_key: 'prof', hint: 'list', subtitle: 'Guest' }]
      })
    };
    return { core, release };
  };
  const settled = () => new Promise((resolve) => setTimeout(resolve, 20));
  const logged = async (fn) => {
    const realLog = console.log;
    const realWarn = console.warn;
    const lines = [];
    console.log = (m) => lines.push(m);
    console.warn = (m) => lines.push(m);
    try {
      await fn();
    } finally {
      console.log = realLog;
      console.warn = realWarn;
    }
    return lines;
  };

  await check('a Core that answers about profiles after the wait: the answer still counts', async () => {
    const { core, release } = slowCore({ profiles: ['Stu', 'Party'] });
    const roon = serviceFor(core);
    roon.profileWaitMs = 5;
    const lines = await logged(async () => {
      await roon._refreshProfiles();
      assert.match(roon.profileProblem, /^Could not read profiles/);
      release();
      await settled();
    });
    assert.strictEqual(roon.profileProblem, '');
    assert.deepStrictEqual(roon.profiles, ['Stu', 'Party']);
    assert.deepStrictEqual(lines, [`[Roon] ${NO_ANSWER}`, '[Roon] Roon answered about profiles after all']);
  });

  await check('steps in the browse session take turns: a new one waits for one still going', async () => {
    const roon = serviceFor(fakeBrowseCore({}));
    const order = [];
    let finish;
    const going = new Promise((resolve) => (finish = resolve));
    const first = roon._inProfileSession(async () => {
      order.push('first starts');
      await going;
      order.push('first ends');
    });
    const second = roon._inProfileSession(async () => order.push('second starts'));
    await settled();
    assert.deepStrictEqual(order, ['first starts'], 'the second waits');
    finish();
    await Promise.all([first, second]);
    assert.deepStrictEqual(order, ['first starts', 'first ends', 'second starts']);
  });

  await check('a step that failed does not stop the next', async () => {
    const roon = serviceFor(fakeBrowseCore({}));
    await assert.rejects(roon._inProfileSession(async () => { throw new Error('no'); }), /no/);
    assert.strictEqual(await roon._inProfileSession(async () => 'next'), 'next');
  });

  await check('reads through the real menus take turns when one outlives its wait', async () => {
    const { core, release } = slowCore({ profiles: ['Stu', 'Party'] });
    const roon = serviceFor(core);
    roon.profileWaitMs = 5;
    await logged(async () => {
      await roon._refreshProfiles();
      const again = roon._refreshProfiles();
      await settled();
      release();
      await again;
      await settled();
    });
    assert.deepStrictEqual(roon.profiles, ['Stu', 'Party']);
    assert.strictEqual(roon.profileProblem, '');
  });

  await check('a step that never ends is left behind when the Core goes', async () => {
    const roon = serviceFor(fakeBrowseCore({}));
    roon._inProfileSession(() => new Promise(() => {}));
    roon.profileSteps = null; // what losing the Core does
    assert.strictEqual(await roon._inProfileSession(async () => 'next'), 'next');
  });

  await check('a late answer about profiles is left when the Core has gone, or a newer read has run', async () => {
    for (const change of [(roon) => (roon.core = null), (roon) => (roon.profileTurn += 1)]) {
      const { core, release } = slowCore({ profiles: ['Stu', 'Party'] });
      const roon = serviceFor(core);
      roon.profileWaitMs = 5;
      await logged(async () => {
        await roon._refreshProfiles();
        change(roon);
        release();
        await settled();
      });
      assert.match(roon.profileProblem, /^Could not read profiles/);
    }
  });

  await check('a Core that selects the guest profile after the wait: the answer still counts', async () => {
    const { core, release } = slowCore({ profiles: ['Stu', 'Party'] });
    const roon = serviceFor(core, { guest_profile: 'Party' });
    roon.profileWaitMs = 5;
    const lines = await logged(async () => {
      await roon._applyProfile();
      release();
      await settled();
    });
    assert.strictEqual(roon.profileProblem, '');
    assert.ok(lines.includes('[PartyMode] Guest requests use the Roon profile "Party"'), lines.join('\n'));
  });

  await check('a profile problem that is not a missing answer is not asked about again', async () => {
    const core = {};
    const roon = unanswered(core, () => true, { display_name: 'Lounge' });
    roon.profileProblem = 'Profile "Party" not found (Roon has: Stu)';
    roon._retryProfile();
    assert.deepStrictEqual(roon.calls, []);
  });

  await check('with the Core gone by then, the first try is not followed up', async () => {
    const core = {};
    const roon = unanswered(core, () => false, { display_name: 'Lounge' });
    const apply = roon._applyProfile;
    roon._applyProfile = async (o) => {
      await apply(o);
      roon.core = null;
    };
    await roon._applyProfileOnConnect(core);
    assert.deepStrictEqual(roon.calls, [true]);
  });

  console.log(failures ? `\n${failures} failing` : '\nall passing');
  process.exit(failures ? 1 : 0);
})();
