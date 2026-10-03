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
const { RoonService, describeZone, normaliseInteger, partyName, configWritable } = require('../lib/roon-service');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { GuestStore } = require('../lib/guests');

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

const picked = (name) => ({ output_id: 'o1', name });
const zone = (displayName, outputCount) => ({
  display_name: displayName,
  outputs: Array.from({ length: outputCount }, (_, i) => ({ output_id: `o${i + 1}` }))
});

console.log('describeZone');

check('nothing chosen yet', () => {
  assert.strictEqual(describeZone(null, null), 'Party zone');
});

check('no Core to resolve against', () => {
  assert.strictEqual(describeZone(picked('Kitchen'), null), 'Party zone — "Kitchen" is not available');
});

check('lone endpoint, same name -> no noise', () => {
  assert.strictEqual(describeZone(picked('Kitchen'), zone('Kitchen', 1)), 'Party zone');
});

check('grouped endpoint names the group and its size', () => {
  assert.strictEqual(
    describeZone(picked('Kitchen'), zone('Kitchen + Living Room + Study', 3)),
    'Party zone — plays to Kitchen + Living Room + Study (3 endpoints)'
  );
});

check('lone endpoint whose zone is named differently', () => {
  assert.strictEqual(
    describeZone(picked('Study Pi'), zone('Study', 1)),
    'Party zone — plays to Study'
  );
});

check('a very long group name is clipped', () => {
  const long = 'Kitchen + Living Room + Study + Bedroom + Bathroom + Garage + Garden';
  const out = describeZone(picked('Kitchen'), zone(long, 7));
  assert.ok(out.includes('…'), `expected clipping, got: ${out}`);
  assert.ok(out.length < long.length + 30, `too long: ${out}`);
  assert.ok(out.endsWith('(7 endpoints)'), out);
});

check('an unnamed zone does not produce a stray dash', () => {
  assert.strictEqual(describeZone(picked('Kitchen'), zone('', 1)), 'Party zone');
});

console.log('\nparty name');

check('a typed name wins', () => {
  assert.strictEqual(partyName({ party_name: "Sam's 40th", zone: picked('Kitchen') }, zone('Kitchen', 1)), "Sam's 40th");
});

check('blank uses the zone name', () => {
  assert.strictEqual(partyName({ party_name: '', zone: picked('Kitchen') }, zone('Kitchen', 1)), 'Kitchen');
});

check('blank with a grouped zone uses the group name, not the endpoint picked', () => {
  const group = zone('Kitchen + Living Room + Study', 3);
  assert.strictEqual(partyName({ party_name: '', zone: picked('Kitchen') }, group), 'Kitchen + Living Room + Study');
});

check('spaces only count as blank', () => {
  assert.strictEqual(partyName({ party_name: '   ', zone: picked('Kitchen') }, zone('Kitchen', 1)), 'Kitchen');
});

check('zone not available yet: the endpoint picked', () => {
  assert.strictEqual(partyName({ party_name: '', zone: picked('Kitchen') }, null), 'Kitchen');
});

check('nothing chosen at all: "Party"', () => {
  assert.strictEqual(partyName({ party_name: '', zone: null }, null), 'Party');
});

check('the settings say what a blank name will use', () => {
  const self = { _resolveZone: () => zone('Kitchen + Living Room', 2) };
  const result = RoonService.prototype._layout.call(self, { zone: picked('Kitchen') });
  const field = result.layout.find((item) => item.setting === 'party_name');
  assert.strictEqual(field.subtitle, 'Leave blank to use the zone name: Kitchen + Living Room');
});

console.log('\nconfig.json');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'party-config-'));

check('a writable config.json is fine', () => {
  const file = path.join(tmp, 'config.json');
  fs.writeFileSync(file, '');
  fs.chmodSync(file, 0o666);
  assert.strictEqual(configWritable(file), true);
});

check('a missing config.json in a writable folder is fine (it gets created)', () => {
  assert.strictEqual(configWritable(path.join(tmp, 'missing.json')), true);
});

// root can write anything, so the read-only cases only mean something as another user.
const isRoot = process.getuid && process.getuid() === 0;
check(`a read-only config.json is reported${isRoot ? ' (skipped as root)' : ''}`, () => {
  if (isRoot) return;
  const file = path.join(tmp, 'readonly.json');
  fs.writeFileSync(file, '');
  fs.chmodSync(file, 0o444);
  assert.strictEqual(configWritable(file), false);
});

console.log('\nnumber settings');

// _layout only needs a zone resolver from the instance.
const layout = (values) => RoonService.prototype._layout.call({ _resolveZone: () => null }, values);
const item = (result, setting) => {
  const all = result.layout.flatMap((entry) => (entry.type === 'group' ? entry.items : [entry]));
  return all.find((entry) => entry.setting === setting);
};

check('party mode is first, with on, paused and off', () => {
  const result = layout({});
  assert.strictEqual(result.layout[0].setting, 'enabled');
  assert.strictEqual(result.layout[0].title, 'Party mode');
  assert.deepStrictEqual(result.layout[0].values.map((v) => v.value), [true, 'paused', false]);
});

check('the choices read as what they do from the mode the party is in now', () => {
  const titles = (enabled) =>
    RoonService.prototype._layout.call({ _resolveZone: () => null, settings: { enabled } }, { enabled }).layout[0].values.map((v) => v.title.split(' — ')[0]);
  assert.deepStrictEqual(titles(true), ['On', 'Pause', 'Off']);
  assert.deepStrictEqual(titles('paused'), ['Unpause', 'Paused', 'Off']);
  assert.deepStrictEqual(titles(false), ['On', 'Paused', 'Off']);
});

check('the wording follows the saved mode, not the one being picked', () => {
  const self = { _resolveZone: () => null, settings: { enabled: true } };
  const result = RoonService.prototype._layout.call(self, { enabled: 'paused' });
  assert.strictEqual(result.layout[0].values[1].title, 'Pause — hold playback and requests');
  assert.strictEqual(result.values.enabled, 'paused');
});

check('a saved on/off from "Guest access" carries over, and junk reads as on', () => {
  assert.strictEqual(layout({ enabled: false }).values.enabled, false);
  assert.strictEqual(layout({ enabled: 'paused' }).values.enabled, 'paused');
  assert.strictEqual(layout({ enabled: 'maybe' }).values.enabled, true);
});

check('display playlist download: QR code, link or off, QR code unless chosen', () => {
  const entry = item(layout({}), 'playlist_download');
  assert.strictEqual(entry.title, 'Display playlist download');
  assert.deepStrictEqual(entry.values.map((v) => v.value), ['qr', 'link', 'off']);
  assert.strictEqual(layout({}).values.playlist_download, 'qr');
  assert.strictEqual(layout({ playlist_download: 'link' }).values.playlist_download, 'link');
  assert.strictEqual(layout({ playlist_download: 'off' }).values.playlist_download, 'off');
});

check('a saved yes/no for the playlist carries over, and junk reads as QR code', () => {
  assert.strictEqual(layout({ playlist_download: true }).values.playlist_download, 'qr');
  assert.strictEqual(layout({ playlist_download: false }).values.playlist_download, 'off');
  assert.strictEqual(layout({ playlist_download: 'maybe' }).values.playlist_download, 'qr');
});

check('the hint names the download address once it is known', () => {
  const hint = (self) => item(RoonService.prototype._layout.call(self, {}), 'playlist_download').subtitle;
  assert.strictEqual(hint({ _resolveZone: () => null }), 'On the Party Hub when Party mode is Off');
  assert.strictEqual(
    hint({ _resolveZone: () => null, playlistUrl: 'http://192.168.1.73:8338/api/playlist.csv' }),
    'On the Party Hub when Party mode is Off. Always downloadable at http://192.168.1.73:8338/api/playlist.csv'
  );
});

check('a port set in the environment wins over the saved one, and Roon shows it', () => {
  const before = process.env.ROON_EXTENSION_PARTY_MODE_PORT;
  try {
    process.env.ROON_EXTENSION_PARTY_MODE_PORT = '9100';
    const result = layout({ port: 9200 });
    assert.strictEqual(result.values.port, 9100);
    assert.strictEqual(item(result, 'port'), undefined, 'no editable port field');
    const label = result.layout.find((entry) => entry.type === 'label');
    assert.match(label.title, /^Web port: 9100, set by ROON_EXTENSION_PARTY_MODE_PORT\./);
    assert.match(label.title, /next free port/);

    delete process.env.ROON_EXTENSION_PARTY_MODE_PORT;
    const saved = layout({ port: 9200 });
    assert.strictEqual(saved.values.port, 9200);
    assert.strictEqual(item(saved, 'port').title, 'Web port');
  } finally {
    if (before === undefined) delete process.env.ROON_EXTENSION_PARTY_MODE_PORT;
    else process.env.ROON_EXTENSION_PARTY_MODE_PORT = before;
  }
});

check('numbers in range pass through', () => {
  assert.strictEqual(normaliseInteger(10, 0, 999, 0), 10);
  assert.strictEqual(normaliseInteger(0, 0, 999, 0), 0);
});

check('numbers sent as text become numbers', () => {
  assert.strictEqual(normaliseInteger('0', 0, 999, 0), 0);
  assert.strictEqual(normaliseInteger(' 12 ', 0, 999, 0), 12);
});

check('blank takes the blank value', () => {
  assert.strictEqual(normaliseInteger('', 0, 999, 0), 0);
  assert.strictEqual(normaliseInteger(undefined, 1, 65535, null), null);
});

check('out of range, fractions and words are invalid', () => {
  for (const bad of [-1, 1000, 2.5, 'abc', '1e3', NaN]) {
    assert.strictEqual(normaliseInteger(bad, 0, 999, 0), null, String(bad));
  }
});

check('saved values are numbers, so "0" and 0 behave the same', () => {
  const result = layout({ add_limit: '0', skip_refill: '45', port: '8080' });
  assert.strictEqual(result.has_error, false);
  assert.strictEqual(result.values.add_limit, 0);
  assert.strictEqual(result.values.skip_refill, 45);
  assert.strictEqual(result.values.port, 8080);
});

check('a negative allowance is refused with a message', () => {
  const result = layout({ skip_limit: -1 });
  assert.strictEqual(result.has_error, true);
  assert.match(item(result, 'skip_limit').error, /0 to 999/);
});

check('a refill over a day is refused', () => {
  const result = layout({ next_refill: 1441 });
  assert.strictEqual(result.has_error, true);
  assert.match(item(result, 'next_refill').error, /0 to 1440/);
});

check('the hints under the settings say what 0 means', () => {
  const result = layout({});
  for (const setting of ['add_limit', 'next_limit', 'skip_limit']) {
    assert.strictEqual(item(result, setting).subtitle, '0 = no limit', setting);
    assert.doesNotMatch(item(result, setting).title, /0 =/, setting);
  }
  for (const setting of ['add_refill', 'next_refill', 'skip_refill']) {
    assert.strictEqual(item(result, setting).subtitle, '0 = a used one never comes back', setting);
    assert.strictEqual(item(result, setting).title, 'Minutes to earn one back', setting);
  }
});

check('an out-of-range value keeps its hint alongside the error', () => {
  const field = item(layout({ skip_limit: -1 }), 'skip_limit');
  assert.strictEqual(field.subtitle, '0 = no limit');
  assert.match(field.error, /0 to 999/);
});

check('browse titles explain themselves in a hint', () => {
  const result = layout({});
  const group = result.layout.find((entry) => entry.type === 'group' && entry.title === 'Advanced');
  assert.ok(group, 'an "Advanced" group');
  assert.strictEqual(group.collapsable, true, 'starts closed');
  assert.deepStrictEqual(group.items.map((i) => i.setting), ['title_tracks', 'title_add', 'title_next', 'title_profile']);
  assert.strictEqual(
    item(result, 'title_add').subtitle,
    '"Queue" in English. Usually found automatically on a Core in another language.'
  );
  assert.match(item(result, 'title_tracks').subtitle, /^"Tracks" in English/);
});

check('a title found on the Core shows in its hint', () => {
  const self = { _resolveZone: () => null, detected: { tracks: 'Titel' } };
  const result = RoonService.prototype._layout.call(self, {});
  assert.match(item(result, 'title_tracks').subtitle, /^Found "Titel" on your Core/);
  assert.match(item(result, 'title_add').subtitle, /^"Queue" in English/);
});

console.log('\nallowances');

function tries(limit, refill, attempts = 3) {
  const guests = new GuestStore();
  const session = guests.create();
  const settings = layout({ allow_skip: true, skip_limit: limit, skip_refill: refill }).values;
  const out = [];
  for (let i = 0; i < attempts; i += 1) {
    const status = guests.check(session, 'skip', settings);
    out.push(status.allowed ? (status.remaining === null ? 'unlimited' : status.remaining) : status.reason);
    if (status.allowed) guests.consume(session, 'skip', settings);
  }
  return out;
}

check('0 per guest is no limit, as a number or as text', () => {
  assert.deepStrictEqual(tries(0, 60), ['unlimited', 'unlimited', 'unlimited']);
  assert.deepStrictEqual(tries('0', 60), ['unlimited', 'unlimited', 'unlimited']);
});

check('blank per guest is no limit', () => {
  assert.deepStrictEqual(tries('', 60), ['unlimited', 'unlimited', 'unlimited']);
});

check('a limit runs out, as a number or as text', () => {
  assert.deepStrictEqual(tries(2, 60), [2, 1, 'rate_limited']);
  assert.deepStrictEqual(tries('2', '60'), [2, 1, 'rate_limited']);
});

check('0 minutes means a used allowance never comes back', () => {
  const guests = new GuestStore();
  const session = guests.create();
  const settings = layout({ allow_skip: true, skip_limit: 1, skip_refill: 0 }).values;
  guests.consume(session, 'skip', settings);
  const status = guests.check(session, 'skip', settings);
  assert.strictEqual(status.allowed, false);
  assert.strictEqual(status.nextIn, null);
});

check('switched off wins over any limit', () => {
  const guests = new GuestStore();
  const settings = layout({ allow_skip: false, skip_limit: 0 }).values;
  assert.strictEqual(guests.check(guests.create(), 'skip', settings).reason, 'disabled');
});

console.log(failures ? `\n${failures} failing` : '\nall passing');
process.exit(failures ? 1 : 0);
