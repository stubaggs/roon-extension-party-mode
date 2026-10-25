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
const { RoonService, describeZone, normaliseInteger, partyName, configWritable, configFolder, extensionIdentity, statusText, detailedLogAfterSave, DETAILED_LOG_WARNING, settingErrors, REQUEST_LIMIT_PRESETS, requestLimits, hubFrame } = require('../lib/roon-service');
const { setDebug } = require('../lib/log');
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
  assert.strictEqual(describeZone(null, null), 'Zone');
});

check('no Core to resolve against', () => {
  assert.strictEqual(describeZone(picked('Kitchen'), null), 'Zone — "Kitchen" is not available');
});

check('lone endpoint, same name -> no noise', () => {
  assert.strictEqual(describeZone(picked('Kitchen'), zone('Kitchen', 1)), 'Zone');
});

check('grouped endpoint names the group and its size', () => {
  assert.strictEqual(
    describeZone(picked('Kitchen'), zone('Kitchen + Living Room + Study', 3)),
    'Zone — plays to Kitchen + Living Room + Study (3 endpoints)'
  );
});

check('lone endpoint whose zone is named differently', () => {
  assert.strictEqual(
    describeZone(picked('Study Pi'), zone('Study', 1)),
    'Zone — plays to Study'
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
  assert.strictEqual(describeZone(picked('Kitchen'), zone('', 1)), 'Zone');
});

console.log('\nparty name');

check('a typed name wins', () => {
  assert.strictEqual(partyName({ party_name: "Sam's 40th", zone: picked('Kitchen') }), "Sam's 40th");
});

check("blank is blank, never the zone's name: the pages say \"Party\" in the guest's language", () => {
  assert.strictEqual(partyName({ party_name: '', zone: picked('Kitchen') }), '');
  assert.strictEqual(partyName({ party_name: '   ', zone: picked('Kitchen') }), '');
  assert.strictEqual(partyName({ party_name: '', zone: null }), '');
  assert.strictEqual(partyName(undefined), '');
});

check('the settings say what a blank name will be', () => {
  const self = { _resolveZone: () => zone('Kitchen + Living Room', 2) };
  const result = RoonService.prototype._layout.call(self, { zone: picked('Kitchen') });
  const field = result.layout.find((item) => item.title === 'Party setup').items.find((item) => item.setting === 'party_name');
  assert.strictEqual(field.subtitle, 'Leave blank for "Party", in each guest\'s language');
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

check('a link to a file not made yet, in a writable folder, is fine (an empty mounted folder)', () => {
  fs.mkdirSync(path.join(tmp, 'data'));
  const link = path.join(tmp, 'linked.json');
  fs.symlinkSync('data/config.json', link);
  assert.strictEqual(configWritable(link), true);
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

check(`a link into a read-only folder is reported${isRoot ? ' (skipped as root)' : ''}`, () => {
  if (isRoot) return;
  const dir = path.join(tmp, 'readonly-data');
  fs.mkdirSync(dir);
  fs.chmodSync(dir, 0o555);
  const link = path.join(tmp, 'readonly-link.json');
  fs.symlinkSync('readonly-data/config.json', link);
  assert.strictEqual(configWritable(link), false);
});

check(`whether config.json can be saved is checked again, and logged when it changes${isRoot ? ' (skipped as root)' : ''}`, () => {
  if (isRoot) return;
  const dir = path.join(tmp, 'recheck');
  fs.mkdirSync(dir);
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, '{}');
  const cwd = process.cwd();
  const said = [];
  const { log, warn } = console;
  console.log = (m) => said.push(`log ${m}`);
  console.warn = (m) => said.push(`warn ${m}`);
  const self = { configWritable: true };
  try {
    process.chdir(dir);
    RoonService.prototype._checkConfigWritable.call(self);
    assert.strictEqual(self.configWritable, true);
    fs.chmodSync(file, 0o444); // the folder's permissions changed while running
    RoonService.prototype._checkConfigWritable.call(self);
    assert.strictEqual(self.configWritable, false);
    RoonService.prototype._checkConfigWritable.call(self); // said once, not on every save
    fs.chmodSync(file, 0o644); // and fixed again
    RoonService.prototype._checkConfigWritable.call(self);
    assert.strictEqual(self.configWritable, true);
  } finally {
    process.chdir(cwd);
    console.log = log;
    console.warn = warn;
  }
  assert.strictEqual(said.length, 2);
  assert.match(said[0], /^warn config\.json in .* is not writable/);
  assert.match(said[1], /^log config\.json is writable again/);
});

check('the warning names the folder config.json is really saved in', () => {
  fs.mkdirSync(path.join(tmp, 'store'));
  const link = path.join(tmp, 'store-link.json');
  fs.symlinkSync('store/config.json', link);
  assert.strictEqual(configFolder(link), path.join(tmp, 'store'));
  assert.strictEqual(configFolder(path.join(tmp, 'config.json')), tmp);
});

check(`a pairing made while config.json can't be saved is saved once it can${isRoot ? ' (skipped as root)' : ''}`, () => {
  if (isRoot) return;
  const dir = path.join(tmp, 'pairing');
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.symlinkSync('data/config.json', path.join(dir, 'config.json'));
  fs.chmodSync(path.join(dir, 'data'), 0o555); // a NAS folder Party Mode may not write to
  const cwd = process.cwd();
  const { log, warn } = console;
  console.log = () => {};
  console.warn = () => {};
  try {
    process.chdir(dir);
    const roon = new RoonService();
    assert.strictEqual(roon.configWritable, false);
    // What node-roon-api does when the Core registers it.
    const state = roon.api.get_persisted_state();
    state.tokens = { core1: 'token1' };
    roon.api.set_persisted_state(state);
    assert.strictEqual(fs.existsSync('data/config.json'), false);

    fs.chmodSync('data', 0o755); // the host fixes the permissions, then saves a setting
    roon.api.save_config('settings', roon.settings);
    roon._checkConfigWritable();
    assert.strictEqual(roon.configWritable, true);

    // After a restart, the pairing is there, so Roon needn't enable it again.
    const again = new RoonService();
    assert.deepStrictEqual(again.api.get_persisted_state().tokens, { core1: 'token1' });
  } finally {
    process.chdir(cwd);
    console.log = log;
    console.warn = warn;
  }
});

check("the host's Party changes are logged, naming both", () => {
  const dir = path.join(tmp, 'modes');
  fs.mkdirSync(dir, { recursive: true });
  const cwd = process.cwd();
  const { log, warn } = console;
  const lines = [];
  console.log = (m) => lines.push(m);
  console.warn = () => {};
  try {
    process.chdir(dir);
    const roon = new RoonService();
    // A save from Roon's settings window, as node-roon-api hands it over.
    const save = (changes) => roon.api._service_request_handlers['com.roonlabs.settings:1']({
      msg: { name: 'save_settings' },
      body: { is_dry_run: false, settings: { values: Object.assign({}, roon.settings, changes) } },
      send_complete() {}
    });
    save({ enabled: 'paused' });
    save({ enabled: 'paused', party_name: 'Garden' }); // no change of mode: nothing
    save({ enabled: false });
    save({ enabled: true });
    assert.deepStrictEqual(lines.filter((l) => String(l).startsWith('Party')), [
      'Party: Paused (was On)',
      'Party: Off (was Paused)',
      'Party: On (was Off)'
    ]);
  } finally {
    process.chdir(cwd);
    console.log = log;
    console.warn = warn;
  }
});

console.log('\nnumber settings');

// _layout only needs a zone resolver from the instance.
const layout = (values) => RoonService.prototype._layout.call({ _resolveZone: () => null }, values);
const item = (result, setting) => {
  const all = result.layout.flatMap((entry) => (entry.type === 'group' ? entry.items : [entry]));
  return all.find((entry) => entry.setting === setting);
};

check('a radio station is told apart from a track, playing, paused or loading', () => {
  const { isStation } = require('../lib/roon-service');
  const station = { is_seek_allowed: false, now_playing: { two_line: { line1: 'ABC Triple J Shift' } } };
  assert.strictEqual(isStation(station), true);
  assert.strictEqual(isStation({ is_seek_allowed: true, now_playing: { length: 210 } }), false, 'a track');
  assert.strictEqual(isStation({ is_seek_allowed: false, now_playing: { length: 210 } }), false, 'a track loading');
  assert.strictEqual(isStation({ is_seek_allowed: false }), false, 'nothing playing');
  assert.strictEqual(isStation(null), false);
});

check('guest defaults: 5 adds every 10 min, play next hourly, skipping off', () => {
  const { values } = layout({});
  assert.deepStrictEqual(
    [values.allow_add, values.add_limit, values.add_refill, values.allow_next, values.next_limit, values.next_refill],
    [true, 5, 10, true, 1, 60]
  );
  assert.deepStrictEqual([values.allow_skip, values.skip_limit, values.skip_refill, values.prevent_duplicates], [false, 1, 60, true]);
});

check('saved allowances are kept over the defaults', () => {
  const { values } = layout({ add_limit: 10, add_refill: 2, next_refill: 20 });
  assert.deepStrictEqual([values.add_limit, values.add_refill, values.next_refill], [10, 2, 20]);
});

check('Party Hub language: Automatic first, then every language by its own name; unknown reads as Automatic', () => {
  const result = layout({ hub_language: 'de' });
  const setting = item(result, 'hub_language');
  assert.deepStrictEqual(setting.values[0], { title: 'Automatic', value: '' });
  assert.strictEqual(setting.values.length, 31);
  assert.ok(setting.values.some((v) => v.value === 'de' && v.title === 'Deutsch'));
  assert.strictEqual(result.values.hub_language, 'de');
  assert.strictEqual(layout({ hub_language: 'xx' }).values.hub_language, '');
  assert.strictEqual(layout({}).values.hub_language, '');
});

check('Party Hub default view: Standard, Roon Display or Basic, Standard unless chosen', () => {
  const setting = item(layout({}), 'hub_playing');
  assert.deepStrictEqual(setting.values, [{ title: 'Standard', value: 'simple' }, { title: 'Roon Display', value: 'roon' }, { title: 'Basic', value: 'basic' }]);
  // The hint follows the choice: only Roon Display needs a zone picked in Roon;
  // each names the other views' addresses, on a line of their own.
  assert.strictEqual(setting.title, 'Party Hub default view');
  assert.strictEqual(setting.subtitle, "Party Mode's own: cover, track and artist.\nOverride: /PartyHub/Roon or /PartyHub/Basic");
  const roonHint = item(layout({ hub_playing: 'roon' }), 'hub_playing').subtitle;
  assert.strictEqual(roonHint, "Roon's Now Playing display. In Roon, open the\nzone's options and choose Displays.\nOverride: /PartyHub/Standard or /PartyHub/Basic");
  assert.strictEqual(item(layout({ hub_playing: 'basic' }), 'hub_playing').subtitle,
    'A plain 16:9 page for older TV browsers.\nOverride: /PartyHub/Standard or /PartyHub/Roon');
  assert.strictEqual(layout({ hub_playing: 'basic' }).values.hub_playing, 'basic');
  assert.doesNotMatch(roonHint, /http/, 'no address');
  assert.strictEqual(layout({}).values.hub_playing, 'simple');
  assert.strictEqual(layout({ hub_playing: 'roon' }).values.hub_playing, 'roon');
  assert.strictEqual(layout({ hub_playing: 'nope' }).values.hub_playing, 'simple');
});

check("Roon Display frames Roon's display page once the Core is known", () => {
  const roon = 'http://192.0.2.10:9330/display/';
  assert.strictEqual(hubFrame({ hub_playing: 'simple' }, roon), null);
  assert.strictEqual(hubFrame({ hub_playing: 'roon' }, roon).href, roon);
  assert.strictEqual(hubFrame({ hub_playing: 'roon' }, null), null, 'no Core yet');
});

check('Party is first, with on, paused and off', () => {
  const result = layout({});
  assert.strictEqual(result.layout[0].setting, 'enabled');
  assert.strictEqual(result.layout[0].title, 'Party');
  assert.deepStrictEqual(result.layout[0].values.map((v) => v.value), [true, 'paused', false]);
});

check("Roon's status line: the mode, the party's name, the zone and the Hub's address, in every mode", () => {
  const hub = 'Hub: http://192.0.2.10:8338/PartyHub';
  assert.strictEqual(statusText('House Party', 'on', hub, 'Living Room'), `Party: On\nName: House Party\nZone: Living Room\n${hub}`);
  assert.strictEqual(statusText('House Party', 'paused', hub, 'Living Room'), `Party: Paused\nName: House Party\nZone: Living Room\n${hub}`);
  assert.strictEqual(statusText('House Party', 'off', hub, 'Kitchen + 2'), `Party: Off\nName: House Party\nZone: Kitchen + 2\n${hub}`);
  // No web server address yet: the zone still follows the name.
  assert.strictEqual(statusText('House Party', 'on', '', 'Living Room'), 'Party: On\nName: House Party\nZone: Living Room');
  // A name typed the same as the zone's: the zone is still said.
  assert.strictEqual(statusText('Kitchen', 'on', '', 'Kitchen'), 'Party: On\nName: Kitchen\nZone: Kitchen');
  // No name typed: no "Name: Party", just the zone.
  assert.strictEqual(statusText('', 'on', '', 'Kitchen'), 'Party: On\nZone: Kitchen');
});

check('the status line uses the party name, and the zone, with the address; no Name line with no name', () => {
  const said = [];
  const self = {
    svcStatus: { set_status: (message) => said.push(message) },
    configWritable: true,
    core: {},
    zone: { display_name: 'Kitchen', outputs: [{ output_id: 'o1' }] },
    statusLine: 'Hub: http://h:8338/PartyHub',
    settings: { zone: { output_id: 'o1', name: 'Kitchen' }, enabled: 'paused', party_name: 'Sam\'s 40th' },
    get partyName() {
      return partyName(this.settings, this.zone);
    }
  };
  RoonService.prototype._updateStatus.call(self);
  self.settings.party_name = '';
  self.settings.enabled = false;
  RoonService.prototype._updateStatus.call(self);
  assert.deepStrictEqual(said, [
    "Party: Paused\nName: Sam's 40th\nZone: Kitchen\nHub: http://h:8338/PartyHub",
    'Party: Off\nZone: Kitchen\nHub: http://h:8338/PartyHub'
  ]);
});

check('a beta is a separate extension to Roon, named after its suffix; a release keeps its id', () => {
  assert.deepStrictEqual(extensionIdentity('1.1.1'), {
    extension_id: 'com.stubaggs.party-mode',
    display_name: 'Party Mode',
    display_version: '1.1.1'
  });
  assert.deepStrictEqual(extensionIdentity('1.4.0-beta.1'), {
    extension_id: 'com.stubaggs.party-mode.beta',
    display_name: 'Party Mode (beta)',
    display_version: '1.4.0-beta.1'
  });
  assert.strictEqual(extensionIdentity('1.4.0-1').display_name, 'Party Mode (beta)', 'no word counts as beta');
  assert.strictEqual(extensionIdentity('1.4.0-RC.2').extension_id, 'com.stubaggs.party-mode.rc');
});

check('the version Roon shows ends with the image\'s commit, and the id stays the same', () => {
  const stamped = extensionIdentity('1.4.0-beta.9.a', '', '2026-10-24 7bd0f78');
  assert.strictEqual(stamped.display_version, '1.4.0-beta.9.a (7bd0f78)');
  assert.strictEqual(stamped.extension_id, extensionIdentity('1.4.0-beta.9.a').extension_id);
  assert.strictEqual(extensionIdentity('1.4.0', 'Garden', '2026-10-24 7bd0f78').display_version, '1.4.0 (7bd0f78)');
  assert.strictEqual(extensionIdentity('1.4.0', '', '').display_version, '1.4.0', 'no stamp, no build');
  assert.strictEqual(extensionIdentity('1.4.0', '', 'hand-made').display_version, '1.4.0', 'a stamp with no commit adds nothing');
});

check('a named copy is its own extension, and the name shows in Roon', () => {
  assert.deepStrictEqual(extensionIdentity('1.1.1', 'Garden'), {
    extension_id: 'com.stubaggs.party-mode.garden',
    display_name: 'Party Mode (Garden)',
    display_version: '1.1.1'
  });
  const dev = extensionIdentity('1.4.0-beta.1', 'Dev');
  assert.strictEqual(dev.extension_id, 'com.stubaggs.party-mode.beta.dev');
  assert.strictEqual(dev.display_name, 'Party Mode (beta, Dev)');
  assert.strictEqual(extensionIdentity('1.1.1', 'Kitchen & Bar').extension_id, 'com.stubaggs.party-mode.kitchen-bar');
  assert.strictEqual(extensionIdentity('1.1.1', 'Café').extension_id, 'com.stubaggs.party-mode.cafe');
  assert.match(extensionIdentity('1.1.1', '厨房').extension_id, /^com\.stubaggs\.party-mode\.[0-9a-f]{8}$/);
  assert.deepStrictEqual(extensionIdentity('1.1.1', ''), extensionIdentity('1.1.1'), 'unset changes nothing');
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

check('host name: a text field after Name, blank unless set', () => {
  const result = layout({});
  assert.strictEqual(item(result, 'host_name').title, 'Host name');
  const names = result.layout.find((entry) => entry.title === 'Party setup').items.map((entry) => entry.setting);
  assert.strictEqual(names.indexOf('host_name'), names.indexOf('party_name') + 1);
  assert.strictEqual(item(result, 'host_name').type, 'string');
  assert.strictEqual(result.values.host_name, '');
  assert.strictEqual(layout({ host_name: 'DJ Stu' }).values.host_name, 'DJ Stu');
});

check('party host name: longer than a guest\'s name may be is an error, not cut short', () => {
  const ok = layout({ host_name: 'DJ Stu and the Party Crew'.slice(0, 24) });
  assert.strictEqual(item(ok, 'host_name').error, undefined);
  assert.strictEqual(ok.has_error, false);
  const long = layout({ host_name: 'DJ Stu and the Saturday Night Crew' });
  assert.strictEqual(item(long, 'host_name').error, '24 characters max');
  assert.strictEqual(long.has_error, true);
  // Counted as the name will show: an emoji is one, extra spaces don't count.
  assert.strictEqual(item(layout({ host_name: '🎧'.repeat(24) }), 'host_name').error, undefined);
  assert.strictEqual(item(layout({ host_name: '  DJ   Stu  ' + ' '.repeat(40) }), 'host_name').error, undefined);
});

check('Invites: On or Off after Host name, On unless turned off', () => {
  const result = layout({});
  const entry = item(result, 'guest_invite');
  assert.strictEqual(entry.title, 'Invites');
  assert.deepStrictEqual(entry.values.map((v) => v.value), [true, false]);
  const names = result.layout.find((e) => e.title === 'Party setup').items.map((e) => e.setting);
  assert.strictEqual(names.indexOf('guest_invite'), names.indexOf('host_name') + 1);
  assert.strictEqual(result.values.guest_invite, true);
  assert.strictEqual(layout({ guest_invite: false }).values.guest_invite, false);
});

check('display playlist download: QR code, link or off, QR code unless chosen', () => {
  const entry = item(layout({}), 'playlist_download');
  assert.strictEqual(entry.title, 'Playlist');
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

check("the Playlist hint says when the Hub shows it; the address is in Roon's status instead", () => {
  const hint = (self) => item(RoonService.prototype._layout.call(self, {}), 'playlist_download').subtitle;
  assert.strictEqual(hint({ _resolveZone: () => null }), 'On the Party Hub when Party is Off');
  assert.strictEqual(
    hint({ _resolveZone: () => null, playlistUrl: () => 'http://192.0.2.10:8338/p/7KQ4-M9XD' }),
    'On the Party Hub when Party is Off'
  );
});

check("Roon's status has the playlist's address under the Hub's, and the new one when it changes", () => {
  const said = [];
  let code = 'first0000000';
  const self = Object.assign(Object.create(RoonService.prototype), {
    svcStatus: { set_status: (message) => said.push(message) },
    configWritable: true,
    core: {},
    zone: { display_name: 'Kitchen', outputs: [{ output_id: 'o1' }] },
    statusLine: 'Hub: http://192.0.2.10:8338/PartyHub',
    settings: { zone: { output_id: 'o1', name: 'Kitchen' }, enabled: false, party_name: '' },
    playlistUrl: () => `http://192.0.2.10:8338/p/${code}`
  });
  self.refreshStatus();
  code = 'second000000';
  self.refreshStatus();
  assert.deepStrictEqual(said, [
    'Party: Off\nZone: Kitchen\nHub: http://192.0.2.10:8338/PartyHub\nPlaylist: http://192.0.2.10:8338/p/first0000000',
    'Party: Off\nZone: Kitchen\nHub: http://192.0.2.10:8338/PartyHub\nPlaylist: http://192.0.2.10:8338/p/second000000'
  ]);
  // No web server: neither address.
  assert.strictEqual(statusText('', 'on', "Party Hub couldn't start", 'Kitchen', ''), "Party: On\nZone: Kitchen\nParty Hub couldn't start");
});

check('hide names in playlist: a Yes/No under Advanced, off unless chosen', () => {
  const entry = item(layout({}), 'playlist_hide_names');
  assert.strictEqual(entry.title, 'Hide names in downloadable playlist');
  assert.strictEqual(entry.subtitle, 'Replace guest nicknames with Anon');
  assert.deepStrictEqual(entry.values.map((v) => v.value), [true, false]);
  assert.strictEqual(layout({}).values.playlist_hide_names, false);
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
    assert.strictEqual(item(result, setting).subtitle, '0 = never', setting);
  }
  for (const setting of ['add_refill', 'next_refill', 'skip_refill']) {
    assert.strictEqual(item(result, setting).title, 'One more every (minutes)', setting);
  }
  assert.strictEqual(item(result, 'add_limit').title, '"Add to queue" per guest', 'named after the button');
  assert.strictEqual(item(result, 'next_limit').title, '"Play it next" per guest', 'named after the button');
  assert.strictEqual(item(result, 'skip_limit').title, '"Skip" per guest', 'named after the button');
});

check('blocking duplicates comes first in Guest requests, then adding, playing next and skipping, each with its counts', () => {
  const groups = layout({}).layout.filter((entry) => entry.type === 'group');
  assert.deepStrictEqual(groups.map((g) => g.title), ['Party setup', 'Guest requests', 'Advanced']);
  assert.deepStrictEqual(groups[1].items.map((i) => i.setting), [
    'prevent_duplicates', 'allow_add', 'add_limit', 'add_refill', 'allow_next', 'next_limit', 'next_refill',
    'allow_skip', 'skip_limit', 'skip_refill'
  ]);
});

check('with the zone found, only Party is at the top; every group starts closed', () => {
  const self = { _resolveZone: () => zone('Kitchen', 1) };
  const result = RoonService.prototype._layout.call(self, { zone: picked('Kitchen') });
  assert.deepStrictEqual(result.layout.filter((entry) => entry.type !== 'group').map((entry) => entry.setting), ['enabled']);
  for (const group of result.layout.filter((entry) => entry.type === 'group')) {
    assert.strictEqual(group.collapsable, true, `${group.title} starts closed`);
  }
  // The Party Hub's settings last, Party Hub default view first.
  assert.deepStrictEqual(result.layout.find((entry) => entry.title === 'Party setup').items.map((i) => i.setting || `[${i.title}]`), [
    'zone', 'guest_profile', 'party_name', 'host_name', 'guest_invite', 'hub_playing', 'hub_language', 'playlist_download'
  ]);
});

check('while the saved zone needs the host, Party starts open and the zone has a red box and says why', () => {
  const run = (self, values) => {
    const result = RoonService.prototype._layout.call(self, values);
    const party = result.layout.find((entry) => entry.title === 'Party setup');
    const picker = party.items[0];
    return { open: !party.collapsable, error: picker.error, hint: picker.subtitle, top: result.layout[0].setting, has_error: result.has_error };
  };
  const kitchen = { zone: picked('Kitchen') };
  assert.deepStrictEqual(run({ _resolveZone: () => null, settings: {} }, {}),
    { open: true, error: '\u200b', hint: 'Pick the zone the party plays in', top: 'enabled', has_error: false }, 'none picked: not an error that stops a save');
  assert.deepStrictEqual(run({ _resolveZone: () => null, zoneHold: true, settings: kitchen }, kitchen),
    { open: true, error: '\u200b', hint: 'Turn it on in Roon, or pick another', top: 'enabled', has_error: false }, 'gone past the wait');
  assert.deepStrictEqual(run({ _resolveZone: () => null, zoneHold: false, settings: kitchen }, kitchen),
    { open: false, error: undefined, hint: 'The zone the party plays in', top: 'enabled', has_error: false }, 'gone only a moment, or not seen yet just after connecting');
  // Picking one: the red box goes at once, but the group stays open until it's saved.
  const found = () => zone('Kitchen', 1);
  assert.deepStrictEqual(run({ _resolveZone: found, settings: {} }, kitchen),
    { open: true, error: undefined, hint: 'The zone the party plays in', top: 'enabled', has_error: false }, 'picked, not saved yet');
  assert.deepStrictEqual(run({ _resolveZone: found, settings: kitchen }, kitchen),
    { open: false, error: undefined, hint: 'The zone the party plays in', top: 'enabled', has_error: false }, 'saved');
});

check('an out-of-range value keeps its hint alongside the error', () => {
  const field = item(layout({ skip_limit: -1 }), 'skip_limit');
  assert.strictEqual(field.subtitle, '0 = no limit');
  assert.match(field.error, /0 to 999/);
});

check('one Advanced group with sub-headings, and browse titles explain themselves in a hint', () => {
  const result = layout({});
  const groups = result.layout.filter((entry) => entry.type === 'group').map((g) => g.title);
  assert.deepStrictEqual(groups, ['Party setup', 'Guest requests', 'Advanced']);
  const advanced = result.layout.find((entry) => entry.title === 'Advanced');
  assert.strictEqual(advanced.collapsable, true, 'starts closed');
  // One group, with a label as the sub-heading for each kind of setting.
  assert.deepStrictEqual(advanced.items.map((i) => i.setting || `[${i.title}]`), [
    'detailed_log', 'playlist_hide_names',
    '[Network]', 'port', 'request_limits',
    '[Roon menu names]', 'title_tracks', 'title_add', 'title_next', 'title_profile'
  ]);
  // Hiding names is in Advanced, not at the top level.
  assert.ok(!result.layout.some((entry) => entry.setting === 'playlist_hide_names'));
  assert.strictEqual(
    item(result, 'title_add').subtitle,
    '"Queue" in English'
  );
  assert.match(item(result, 'title_tracks').subtitle, /^"Tracks" in English/);
});

check('the web port has a short, three-line hint', () => {
  const lines = item(layout({}), 'port').subtitle.split('\n');
  assert.strictEqual(lines.length, 3);
  assert.strictEqual(lines[0], 'Custom port for Party Mode');
  assert.match(lines[1], /^Changing it moves/);
});

check('the detailed log is an On/Off switch, off by default, with a warning hint', () => {
  const result = layout({});
  const field = item(result, 'detailed_log');
  assert.strictEqual(field.title, 'Detailed log');
  assert.deepStrictEqual(field.values.map((v) => v.value), [true, false]);
  assert.match(field.subtitle, /guests' searches/);
  assert.strictEqual(result.values.detailed_log, false);
});

check('the detailed log: only a change to the switch is saved', () => {
  // Saving other settings keeps it as it is.
  assert.deepStrictEqual(detailedLogAfterSave(false, false, false), { on: false, saved: false });
  assert.deepStrictEqual(detailedLogAfterSave(true, true, true), { on: true, saved: true });
  // On from the environment: saving other settings doesn't save it as on.
  assert.deepStrictEqual(detailedLogAfterSave(true, true, false), { on: true, saved: false });
  // Turned on in Roon: saved, so it survives a restart.
  assert.deepStrictEqual(detailedLogAfterSave(false, true, false), { on: true, saved: true });
  // Turned off in Roon: off now and saved off (the environment turns it on again at a restart).
  assert.deepStrictEqual(detailedLogAfterSave(true, false, false), { on: false, saved: false });
  assert.deepStrictEqual(detailedLogAfterSave(true, false, true), { on: false, saved: false });
});

check('a refused save says on the status line what wasn\'t saved, in red', () => {
  // Roon closes the settings window on Save even when it's refused.
  const refused = layout({ host_name: 'DJ Stu and the Saturday Night Crew', port: 0 });
  assert.strictEqual(settingErrors(refused.layout), 'Host name: 24 characters max; Web port: Enter a whole number from 1 to 65535');
  assert.strictEqual(settingErrors(layout({}).layout), '');
  const said = [];
  const self = {
    svcStatus: { set_status: (message, isError) => said.push([message, isError]) },
    configWritable: true,
    core: {},
    zone: { display_name: 'Kitchen', outputs: [{ output_id: 'o1' }] },
    statusLine: '',
    settings: { zone: { output_id: 'o1', name: 'Kitchen' }, enabled: true, party_name: '' },
    settingsRejected: 'Host name: 24 characters max',
    get partyName() {
      return partyName(this.settings, this.zone);
    }
  };
  RoonService.prototype._updateStatus.call(self);
  self.settingsRejected = null;
  RoonService.prototype._updateStatus.call(self);
  assert.deepStrictEqual(said, [
    ['Settings not saved: Host name: 24 characters max\nParty: On\nZone: Kitchen', true],
    ['Party: On\nZone: Kitchen', false]
  ]);
});

check("the web server's errors show in red: no port to listen on, or a new one refused", () => {
  const said = [];
  const self = Object.assign(Object.create(RoonService.prototype), {
    svcStatus: { set_status: (message, isError) => said.push([message, isError]) },
    configWritable: true,
    core: {},
    zone: { display_name: 'Kitchen', outputs: [{ output_id: 'o1' }] },
    settings: { zone: { output_id: 'o1', name: 'Kitchen' }, enabled: true, party_name: '' }
  });
  self.setStatusLine('Port 9000 is in use. Pick another web port in the settings.', true);
  self.setStatusLine('Hub: http://192.0.2.10:9001/PartyHub');
  assert.deepStrictEqual(said, [
    ['Party: On\nZone: Kitchen\nPort 9000 is in use. Pick another web port in the settings.', true],
    ['Party: On\nZone: Kitchen\nHub: http://192.0.2.10:9001/PartyHub', false]
  ]);
});

check('a new web port that could not be opened: the one in use is saved back, and the status says so in red until the next save', () => {
  const said = [];
  const saved = [];
  const self = Object.assign(Object.create(RoonService.prototype), {
    svcStatus: { set_status: (message, isError) => said.push([message, isError]) },
    api: { save_config: (key, value) => saved.push([key, value.port]) },
    configWritable: true,
    core: {},
    zone: { display_name: 'Kitchen', outputs: [{ output_id: 'o1' }] },
    statusLine: 'Hub: http://192.0.2.10:8339/PartyHub',
    settings: { zone: { output_id: 'o1', name: 'Kitchen' }, enabled: true, party_name: '', port: 8340 }
  });
  self.refusePort(8339, 'Web port not changed: 8340 is in use, still on 8339');
  assert.strictEqual(self.settings.port, 8339);
  assert.deepStrictEqual(saved, [['settings', 8339]]);
  assert.deepStrictEqual(said, [
    ['Web port not changed: 8340 is in use, still on 8339\nParty: On\nZone: Kitchen\nHub: http://192.0.2.10:8339/PartyHub', true]
  ]);
});

check('the status line starts with a warning while the detailed log is on', () => {
  const said = [];
  const self = {
    svcStatus: { set_status: (message, isError) => said.push([message, isError]) },
    configWritable: true,
    core: {},
    zone: { display_name: 'Kitchen', outputs: [{ output_id: 'o1' }] },
    statusLine: '',
    settings: { zone: { output_id: 'o1', name: 'Kitchen' }, enabled: true, party_name: '' },
    get partyName() {
      return partyName(this.settings, this.zone);
    }
  };
  setDebug(true);
  RoonService.prototype._updateStatus.call(self);
  setDebug(false);
  RoonService.prototype._updateStatus.call(self);
  assert.deepStrictEqual(said, [
    [`${DETAILED_LOG_WARNING}\nParty: On\nZone: Kitchen`, false],
    ['Party: On\nZone: Kitchen', false]
  ]);
});

check('the status goes to Roon only when it changes, not on every zone update', () => {
  const said = [];
  const self = {
    svcStatus: { set_status: (message, isError) => said.push([message, isError]) },
    configWritable: true,
    core: {},
    zone: { display_name: 'Kitchen', outputs: [{ output_id: 'o1' }] },
    statusLine: '',
    settings: { zone: { output_id: 'o1', name: 'Kitchen' }, enabled: true, party_name: '' },
    get partyName() {
      return partyName(this.settings, this.zone);
    }
  };
  // A playing zone's position updates, each second: the status is the same.
  for (let i = 0; i < 5; i++) RoonService.prototype._updateStatus.call(self);
  // A change is sent, and so is going back, as is the same text as an error.
  self.settings.enabled = 'paused';
  RoonService.prototype._updateStatus.call(self);
  self.settings.enabled = true;
  RoonService.prototype._updateStatus.call(self);
  RoonService.prototype._updateStatus.call(self);
  self.configWritable = false;
  RoonService.prototype._updateStatus.call(self);
  assert.deepStrictEqual(said, [
    ['Party: On\nZone: Kitchen', false],
    ['Party: Paused\nZone: Kitchen', false],
    ['Party: On\nZone: Kitchen', false],
    ["Party: On\nZone: Kitchen — settings can't be saved: config.json is read-only", true]
  ]);
});

check('flood protection: Default or Custom, with the numbers in the hint', () => {
  assert.deepStrictEqual(REQUEST_LIMIT_PRESETS, { default: { all: 1200, search: 200 } });
  const result = layout({});
  const field = item(result, 'request_limits');
  assert.deepStrictEqual(field.values.map((v) => v.value), ['default', 'custom']);
  assert.strictEqual(field.subtitle, 'Up to 1200 page loads and 200 searches\na minute from each IP address');
  // The default shows no number fields.
  assert.strictEqual(item(result, 'rate_limit'), undefined);
});

check("an early build's Normal, Shared Wi-Fi and Off keep their limits", () => {
  const loaded = (request_limits) => {
    const values = layout({ request_limits, rate_limit: 600, search_limit: 60 }).values;
    return [values.request_limits, requestLimits(values)];
  };
  assert.deepStrictEqual(loaded('normal'), ['default', { all: 1200, search: 200 }]);
  assert.deepStrictEqual(loaded('shared'), ['custom', { all: 6000, search: 600 }]);
  assert.deepStrictEqual(loaded('off'), ['custom', { all: 0, search: 0 }]);
  assert.deepStrictEqual(loaded('nonsense'), ['default', { all: 1200, search: 200 }]);
});

check('choosing Custom shows two number fields, starting from the default', () => {
  // Roon sends back the values it was shown, so the default's numbers come with Custom.
  const shown = layout({ request_limits: 'default', rate_limit: 5, search_limit: 5 }).values;
  const result = layout(Object.assign({}, shown, { request_limits: 'custom' }));
  assert.strictEqual(item(result, 'rate_limit').title, 'Page loads a minute per IP address');
  assert.strictEqual(item(layout({}), 'request_limits').title, 'Flood protection');
  assert.strictEqual(result.values.rate_limit, 1200);
  assert.strictEqual(result.values.search_limit, 200);
  assert.deepStrictEqual(requestLimits(result.values), { all: 1200, search: 200 });
  // A bad number is an error, like the other number fields.
  assert.strictEqual(layout({ request_limits: 'custom', rate_limit: -1 }).has_error, true);
});

check('request limits in force: the default, or the custom numbers (0 = no limit)', () => {
  assert.deepStrictEqual(requestLimits({ request_limits: 'default', rate_limit: 5, search_limit: 5 }), { all: 1200, search: 200 });
  assert.deepStrictEqual(requestLimits({ request_limits: 'custom', rate_limit: 0, search_limit: 0 }), { all: 0, search: 0 });
  assert.deepStrictEqual(requestLimits({ request_limits: 'custom', rate_limit: 2000, search_limit: 0 }), { all: 2000, search: 0 });
});

check('every title and hint line stays narrow, so the settings window does too', () => {
  const lines = [];
  const walk = (items) => items.forEach((i) => {
    for (const text of [i.title, i.subtitle]) if (text) String(text).split('\n').forEach((l) => lines.push(l));
    if (i.items) walk(i.items);
  });
  // As when running.
  const self = { _resolveZone: () => null, playlistUrl: () => 'http://192.168.100.200:65535/p/7KQ4-M9XD' };
  for (const values of [{}, { request_limits: 'custom' }, { hub_playing: 'roon' }, { hub_playing: 'basic' }]) {
    walk(RoonService.prototype._layout.call(self, values).layout);
  }
  const wide = lines.filter((l) => l.length > 51);
  assert.deepStrictEqual(wide, []);
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

check('a limit changed mid-party counts what each guest has already used', () => {
  const guests = new GuestStore();
  const session = guests.create();
  const at = (limit) => layout({ allow_add: true, add_limit: limit, add_refill: 10 }).values;
  const left = (limit) => guests.check(session, 'add', at(limit)).remaining;
  assert.strictEqual(left(5), 5);
  guests.consume(session, 'add', at(5));
  assert.strictEqual(left(10), 9, 'raised: one used of ten');
  assert.strictEqual(left(3), 2, 'lowered: one used of three');
  guests.consume(session, 'add', at(3));
  guests.consume(session, 'add', at(3));
  assert.strictEqual(guests.check(session, 'add', at(1)).allowed, false, 'lowered below what was used: none left');
  // Nothing is owed beyond none left: raised again, one used of five.
  assert.strictEqual(left(5), 4);
  // No limit in between leaves the count where it was.
  assert.strictEqual(guests.check(session, 'add', at(0)).remaining, null);
  assert.strictEqual(left(5), 4);
});

check('switched off wins over any limit', () => {
  const guests = new GuestStore();
  const settings = layout({ allow_skip: false, skip_limit: 0 }).values;
  assert.strictEqual(guests.check(guests.create(), 'skip', settings).reason, 'disabled');
});

check('adding and playing next are separate choices', () => {
  const guests = new GuestStore();
  const nextOnly = layout({ allow_add: false, allow_next: true }).values;
  assert.strictEqual(guests.check(guests.create(), 'add', nextOnly).reason, 'disabled');
  assert.strictEqual(guests.check(guests.create(), 'next', nextOnly).allowed, true);
  const addOnly = layout({ allow_add: true, allow_next: false }).values;
  assert.strictEqual(guests.check(guests.create(), 'add', addOnly).allowed, true);
  assert.strictEqual(guests.check(guests.create(), 'next', addOnly).reason, 'disabled');
});

console.log(failures ? `\n${failures} failing` : '\nall passing');
process.exit(failures ? 1 : 0);
