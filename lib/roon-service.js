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

const EventEmitter = require('events');
const fs = require('fs');

const RoonApi = require('node-roon-api');
const RoonApiStatus = require('node-roon-api-status');
const RoonApiSettings = require('node-roon-api-settings');
const RoonApiTransport = require('node-roon-api-transport');
const RoonApiBrowse = require('node-roon-api-browse');
const RoonApiImage = require('node-roon-api-image');

const { listProfiles, selectProfile } = require('./profiles');
const { isTrackList, pickAction } = require('./titles');

const HIERARCHY = 'search';
// How much of the zone's queue Roon sends us. The guest page lists all of it,
// so this is the longest queue it can show.
const QUEUE_ITEMS = 500;

/**
 * Roon localises browse titles, so the titles we match on are configurable.
 * These defaults are the English ones.
 */
const DEFAULT_TITLES = {
  tracks_category: 'Tracks',
  add: 'Queue',
  next: 'Add Next',
  now: 'Play Now',
  profile_menu: 'Profile'
};

const DEFAULT_SETTINGS = {
  zone: null,
  party_name: '',
  enabled: true,
  guest_profile: '', // '' leaves the extension's Roon profile as it is
  port: Number(process.env.PARTY_PORT) || 8338,
  allow_add: true,
  prevent_duplicates: true,
  add_limit: 10,
  add_refill: 2,
  allow_next: true,
  next_limit: 1,
  next_refill: 20,
  allow_skip: false,
  skip_limit: 1,
  skip_refill: 60,
  title_tracks: DEFAULT_TITLES.tracks_category,
  title_add: DEFAULT_TITLES.add,
  title_next: DEFAULT_TITLES.next,
  title_profile: DEFAULT_TITLES.profile_menu
};

/**
 * What the pages show about playback: the track, whether it is playing, and
 * whether Roon Radio is on (it decides the "Roon Radio" labels).
 * The seek position is left out because it changes every second, and the
 * transport library updates it in place on the zone we already hold.
 */
function playbackSignature(zone) {
  if (!zone) return null;
  const np = Object.assign({}, zone.now_playing);
  delete np.seek_position;
  const radio = Boolean(zone.settings && zone.settings.auto_radio);
  return JSON.stringify({ state: zone.state, radio, now_playing: np });
}

class RoonService extends EventEmitter {
  constructor() {
    super();
    this.core = null;
    this.zone = null;
    this.queue = [];
    this.queueGeneration = 0;
    this.settings = Object.assign({}, DEFAULT_SETTINGS);
    // Browse titles found on this Core when the configured ones didn't match
    // (a Core in another language). Shown in the settings hints.
    this.detected = {};
    // Guest browse sessions the profile has been selected in: session key ->
    // "profile|menu title". Cleared when the Core reconnects or the setting changes.
    this.profileSessions = new Map();

    this.api = new RoonApi({
      extension_id: 'com.stubaggs.party-mode',
      display_name: 'Party Mode',
      display_version: require('../package.json').version,
      publisher: 'Stubaggs',
      email: '',
      website: 'https://github.com/stubaggs/roon-extension-party-mode',

      core_paired: (core) => this._onCorePaired(core),
      core_unpaired: () => this._onCoreUnpaired()
    });

    this.settings = this._layout(this.api.load_config('settings') || {}).values;

    this.configWritable = configWritable();
    if (!this.configWritable) {
      console.warn(
        `config.json in ${process.cwd()} is not writable by this user (uid ${process.getuid ? process.getuid() : '?'}), ` +
          'so settings and the Roon pairing will not be saved. Make it writable, e.g. chmod 666 config.json.'
      );
    }

    this.svcStatus = new RoonApiStatus(this.api);
    this.svcSettings = new RoonApiSettings(this.api, {
      // Fetch the profile list first so the dropdown shows the current profiles.
      get_settings: (cb) => this._refreshProfiles().then(() => cb(this._layout(this.settings))),
      save_settings: (req, isdryrun, settings) => {
        const layout = this._layout(settings.values);
        req.send_complete(layout.has_error ? 'NotValid' : 'Success', { settings: layout });
        if (isdryrun || layout.has_error) return;

        const previousZone = this.settings.zone && this.settings.zone.output_id;
        const previousEnabled = this.settings.enabled;
        const previousProfile = `${this.settings.guest_profile}|${this.settings.title_profile}`;

        this.settings = layout.values;
        this.api.save_config('settings', this.settings);
        this.svcSettings.update_settings(layout);

        const newZone = this.settings.zone && this.settings.zone.output_id;
        if (newZone !== previousZone) this._subscribeQueue();
        if (this.settings.enabled !== previousEnabled) this.emit('access_changed', this.settings.enabled);
        if (`${this.settings.guest_profile}|${this.settings.title_profile}` !== previousProfile) this._applyProfile();

        this._updateStatus();
        this.emit('settings_changed', this.settings);
      }
    });

    this.api.init_services({
      required_services: [RoonApiTransport, RoonApiBrowse, RoonApiImage],
      provided_services: [this.svcStatus, this.svcSettings]
    });
  }

  start() {
    this.api.start_discovery();
    this._updateStatus();
  }

  get transport() {
    return this.core && this.core.services.RoonApiTransport;
  }

  get browseSvc() {
    return this.core && this.core.services.RoonApiBrowse;
  }

  get imageSvc() {
    return this.core && this.core.services.RoonApiImage;
  }

  get ready() {
    return Boolean(this.core && this.zone);
  }

  // ---------------------------------------------------------------- pairing

  _onCorePaired(core) {
    this.core = core;
    this.profileSessions.clear(); // a new connection means new browse sessions

    core.services.RoonApiTransport.subscribe_zones((response, msg) => {
      if (response === 'Subscribed' || response === 'Changed') {
        this._refreshZone();
      }
    });

    this._subscribeQueue();
    this._updateStatus();
    this.emit('core_paired');
    this._applyProfile();
  }

  // ------------------------------------------------------------- profiles

  /**
   * Re-read the Core's profiles for the settings dropdown. Never rejects, and
   * gives up after a few seconds so the settings screen always opens.
   */
  async _refreshProfiles() {
    if (!this.browseSvc) return;
    const menuTitle = this.settings.title_profile || DEFAULT_TITLES.profile_menu;
    try {
      const result = await withTimeout(listProfiles((o) => this._browse(o), (o) => this._load(o), menuTitle), 4000);
      if (result.profiles) {
        this.profiles = result.profiles.map((profile) => profile.title);
        this.profileProblem = '';
        if (result.entryTitle) this._noteDetected('profile', 'Profile entry', result.entryTitle);
      } else {
        this.profiles = [];
        this.profileProblem = `No "${menuTitle}" entry in Roon's settings menu (found: ${result.menu.join(', ') || 'nothing'})`;
        console.warn(this.profileProblem);
      }
    } catch (err) {
      this.profileProblem = `Could not read profiles: ${err.message}`;
      console.warn(this.profileProblem);
    }
  }

  /**
   * Select the guest profile in one guest's browse session, once, before it
   * searches or queues: Roon credits a queue action to the profile selected in
   * the session that made it. Never throws; a failure is logged and the guest's
   * request goes ahead under Roon's default profile.
   */
  async _profileFor(sessionKey) {
    const name = this.settings.guest_profile;
    if (!name || !this.browseSvc || !sessionKey) return;
    const menuTitle = this.settings.title_profile || DEFAULT_TITLES.profile_menu;
    const wanted = `${name}|${menuTitle}`;
    if (this.profileSessions.get(sessionKey) === wanted) return;
    // Mark first, so concurrent requests from the same guest don't repeat it.
    this.profileSessions.set(sessionKey, wanted);
    try {
      const result = await withTimeout(
        selectProfile((o) => this._browse(o), (o) => this._load(o), menuTitle, name, sessionKey),
        4000
      );
      if (result.ok) {
        console.log(
          `Profile "${name}" selected for guest session ${sessionKey.slice(0, 6)}…: Roon answered ${result.answer}; ` +
            `current profile before "${result.before}", after "${result.after}"`
        );
      }
      else console.warn(`Could not select profile "${name}" for a guest (${result.reason})`);
    } catch (err) {
      console.warn(`Could not select profile "${name}" for a guest: ${err.message}`);
    }
  }

  /** Switch the extension's Roon profile to the one chosen for guests, if any. */
  async _applyProfile() {
    // Guests' sessions pick up the new choice on their next search or request.
    this.profileSessions.clear();
    const name = this.settings.guest_profile;
    if (!name || !this.browseSvc) {
      await this._refreshProfiles();
      return;
    }
    const menuTitle = this.settings.title_profile || DEFAULT_TITLES.profile_menu;
    try {
      const result = await withTimeout(
        selectProfile((o) => this._browse(o), (o) => this._load(o), menuTitle, name),
        4000
      );
      if (result.ok) {
        this.profileProblem = '';
        console.log(
          `Guest requests use the Roon profile "${name}": Roon answered ${result.answer}; current profile ` +
            `before "${result.before}", after "${result.after}"; options ${result.options.join(', ')}`
        );
      } else if (result.reason === 'no_profile') {
        this.profileProblem = `Profile "${name}" not found (Roon has: ${result.profiles.join(', ')})`;
        console.warn(this.profileProblem);
      } else {
        this.profileProblem = `No "${menuTitle}" entry in Roon's settings menu (found: ${result.menu.join(', ') || 'nothing'})`;
        console.warn(this.profileProblem);
      }
    } catch (err) {
      this.profileProblem = `Could not switch profile: ${err.message}`;
      console.warn(this.profileProblem);
    }
    await this._refreshProfiles();
  }

  _onCoreUnpaired() {
    this.core = null;
    this.zone = null;
    this.queue = [];
    this.emit('queue_changed');
    this.emit('core_unpaired');
  }

  /**
   * The zone an endpoint currently belongs to.
   *
   * Grouping is dynamic: the setting stores one output_id, and Roon resolves it
   * to whichever zone contains that output right now. Group the endpoint and
   * this returns the group; ungroup it and this returns the endpoint on its own.
   */
  _resolveZone(zoneSetting) {
    const outputId = zoneSetting && zoneSetting.output_id;
    if (!outputId || !this.transport) return null;
    return this.transport.zone_by_output_id(outputId);
  }

  _refreshZone() {
    const configured = this.settings.zone && this.settings.zone.output_id;
    const zone = configured && this.transport
      ? this.transport.zone_by_output_id(configured)
      : null;

    const before = playbackSignature(this.zone);
    this.zone = zone;

    if (!zone) {
      this._updateStatus();
      return;
    }
    if (before !== playbackSignature(zone)) this.emit('now_playing_changed');
    this._updateStatus();
  }

  /**
   * Roon has no unsubscribe helper for queues that is convenient to use here,
   * so a generation counter is used to ignore callbacks from stale zones.
   */
  _subscribeQueue() {
    const outputId = this.settings.zone && this.settings.zone.output_id;
    this.queue = [];
    this.emit('queue_changed');
    if (!this.transport || !outputId) return;

    const generation = ++this.queueGeneration;

    this.transport.subscribe_queue(outputId, QUEUE_ITEMS, (response, msg) => {
      if (generation !== this.queueGeneration) return;

      const inserted = [];

      if (response === 'Subscribed') {
        this.queue = (msg && msg.items) || [];
      } else if (response === 'Changed' && msg && msg.changes) {
        for (const change of msg.changes) {
          if (change.operation === 'remove') {
            this.queue.splice(change.index, change.count);
          } else if (change.operation === 'insert') {
            this.queue.splice(change.index, 0, ...change.items);
            inserted.push(...change.items);
          }
        }
      } else {
        return;
      }

      // Before queue_changed, so a request is credited to its guest in the same
      // update the pages are about to receive. These items are the only place
      // Roon reports the queue item id and length of a track just requested.
      if (inserted.length) this.emit('queue_inserted', inserted);
      this.emit('queue_changed');
    });
  }

  _updateStatus() {
    if (!this.svcStatus) return;
    // A read-only config.json is added to whatever else the status says.
    const say = (message, isError) =>
      this.configWritable
        ? this.svcStatus.set_status(message, isError)
        : this.svcStatus.set_status(`${message} — settings can't be saved: config.json is read-only`, true);
    if (!this.core) return say('Waiting for Roon Core', false);
    if (!this.settings.zone) return say('Select a party zone in the settings', true);
    if (!this.zone) return say(`Zone "${this.settings.zone.name}" is not available`, true);
    if (!this.settings.enabled) return say(`Guest access is off — zone ${this.zone.display_name}`, false);
    return say(this.statusLine || `Ready — zone ${this.zone.display_name}`, false);
  }

  /**
   * The website link Roon shows for the extension. It goes out with the
   * registration, which node-roon-api resends on every connect to the Core,
   * so set it before start().
   */
  setWebsite(url) {
    this.api.extension_reginfo.website = url;
  }

  /**
   * Drop the connection to the Core. Discovery reconnects within about ten
   * seconds and registers again, which is how Roon picks up a new website link.
   */
  reconnect() {
    this.api.disconnect_all();
  }

  /** See partyName(): the typed name, else the party zone's name. */
  get partyName() {
    return partyName(this.settings, this.zone);
  }

  setStatusLine(line) {
    this.statusLine = line;
    this._updateStatus();
  }

  // ---------------------------------------------------------------- browsing

  _browse(opts) {
    return new Promise((resolve, reject) => {
      if (!this.browseSvc) return reject(new Error('no_core'));
      this.browseSvc.browse(opts, (err, body) => (err ? reject(new Error(err)) : resolve(body)));
    });
  }

  _load(opts) {
    return new Promise((resolve, reject) => {
      if (!this.browseSvc) return reject(new Error('no_core'));
      this.browseSvc.load(opts, (err, body) => (err ? reject(new Error(err)) : resolve(body)));
    });
  }

  /**
   * Search the library (and any enabled streaming services) for tracks.
   * Returns raw browse Items; item_key values are only valid for as long as
   * this session key has not been re-used for another search.
   */
  async search(sessionKey, query, limit = 40) {
    const outputId = this.settings.zone && this.settings.zone.output_id;
    if (!outputId) throw new Error('no_zone');
    await this._profileFor(sessionKey);

    const result = await this._browse({
      hierarchy: HIERARCHY,
      multi_session_key: sessionKey,
      zone_or_output_id: outputId,
      input: query,
      pop_all: true
    });
    if (result.action !== 'list') return [];

    let page = await this._load({
      hierarchy: HIERARCHY,
      multi_session_key: sessionKey,
      offset: 0,
      count: 100
    });

    // Search results are grouped by category. Drill into the track category if
    // it is present; otherwise fall back to whatever playable items came back.
    const wanted = (this.settings.title_tracks || DEFAULT_TITLES.tracks_category).toLowerCase();
    const titled = (title) =>
      page.items.find((item) => item.item_key && item.title && item.title.toLowerCase() === String(title).toLowerCase());
    let category = titled(wanted) || (this.detected.tracks && titled(this.detected.tracks));

    // Not found by title: find the category whose items are tracks.
    if (!category && page.items.some((item) => item.hint === 'list')) {
      const found = await this._findTrackCategory(sessionKey, outputId);
      if (found) {
        this._noteDetected('tracks', 'Track category', found);
        page = await this._load({ hierarchy: HIERARCHY, multi_session_key: sessionKey, offset: 0, count: 100 });
        category = titled(found);
      }
    }

    if (category) {
      const drill = await this._browse({
        hierarchy: HIERARCHY,
        multi_session_key: sessionKey,
        zone_or_output_id: outputId,
        item_key: category.item_key
      });
      if (drill.action !== 'list') return [];
      page = await this._load({
        hierarchy: HIERARCHY,
        multi_session_key: sessionKey,
        offset: 0,
        count: limit
      });
      return page.items.filter((item) => item.item_key);
    }

    return page.items
      .filter((item) => item.item_key && item.hint !== 'header' && item.hint !== 'list')
      .slice(0, limit);
  }

  /**
   * Open each category of the current search results until one holds tracks,
   * going back up after each. Returns that category's title, or null.
   */
  async _findTrackCategory(sessionKey, outputId) {
    const at = { hierarchy: HIERARCHY, multi_session_key: sessionKey };
    const top = await this._load(Object.assign({ offset: 0, count: 100 }, at));
    const titles = top.items.filter((item) => item.item_key && item.hint === 'list').map((item) => item.title);
    for (const title of titles) {
      // Re-read the list each time: keys may not survive going back up.
      const page = await this._load(Object.assign({ offset: 0, count: 100 }, at));
      const category = page.items.find((item) => item.item_key && item.title === title);
      if (!category) continue;
      const opened = await this._browse(Object.assign({ zone_or_output_id: outputId, item_key: category.item_key }, at));
      let tracks = false;
      if (opened.action === 'list') {
        const inside = await this._load(Object.assign({ offset: 0, count: 5 }, at));
        tracks = isTrackList(inside.items);
      }
      await this._browse(Object.assign({ zone_or_output_id: outputId, pop_levels: 1 }, at));
      if (tracks) return title;
    }
    return null;
  }

  /** Remember and log a browse title found on this Core, once per change. */
  _noteDetected(key, label, title) {
    if (this.detected[key] === title) return;
    this.detected[key] = title;
    console.log(`Browse titles: using "${title}" as the ${label} on this Core`);
  }

  /**
   * Drill into an item and invoke one of its actions, e.g. "Queue".
   * mode is 'add' | 'next' | 'now'.
   */
  async performAction(sessionKey, itemKey, mode) {
    const outputId = this.settings.zone && this.settings.zone.output_id;
    if (!outputId) throw new Error('no_zone');
    await this._profileFor(sessionKey);

    const titles = {
      add: this.settings.title_add || DEFAULT_TITLES.add,
      next: this.settings.title_next || DEFAULT_TITLES.next,
      now: DEFAULT_TITLES.now
    };
    const wanted = String(titles[mode] || '').toLowerCase();

    let result = await this._browse({
      hierarchy: HIERARCHY,
      multi_session_key: sessionKey,
      zone_or_output_id: outputId,
      item_key: itemKey
    });
    if (result.action !== 'list') throw new Error('unexpected_response');

    let page = await this._load({
      hierarchy: HIERARCHY,
      multi_session_key: sessionKey,
      offset: 0,
      count: 100
    });

    // Some items open a detail page before the action list.
    if (page.list && page.list.hint !== 'action_list') {
      const opener = page.items.find((item) => item.hint === 'action_list');
      if (!opener) throw new Error('no_action_list');
      result = await this._browse({
        hierarchy: HIERARCHY,
        multi_session_key: sessionKey,
        zone_or_output_id: outputId,
        item_key: opener.item_key
      });
      page = await this._load({
        hierarchy: HIERARCHY,
        multi_session_key: sessionKey,
        offset: 0,
        count: 100
      });
    }

    const picked = pickAction(page.items, mode, wanted);
    if (!picked) {
      console.warn(
        `No "${titles[mode]}" action and not the usual four actions; Roon offered: ` +
          page.items.map((item) => `"${item.title}"`).join(', ')
      );
      throw new Error('action_unavailable');
    }
    if (picked.by === 'position' && mode !== 'now') {
      this._noteDetected(mode, mode === 'add' ? 'Add to queue action' : 'Play next action', picked.item.title);
    }
    const action = picked.item;

    const done = await this._browse({
      hierarchy: HIERARCHY,
      multi_session_key: sessionKey,
      zone_or_output_id: outputId,
      item_key: action.item_key
    });

    if (done.action === 'message' && done.is_error) throw new Error(done.message || 'roon_error');
    return true;
  }

  skip() {
    return new Promise((resolve, reject) => {
      if (!this.zone) return reject(new Error('no_zone'));
      if (!this.zone.is_next_allowed) return reject(new Error('skip_not_allowed'));
      this.transport.control(this.zone, 'next', (err) =>
        err ? reject(new Error(err)) : resolve(true)
      );
    });
  }

  getImage(imageKey, size) {
    return new Promise((resolve, reject) => {
      if (!this.imageSvc) return reject(new Error('no_core'));
      this.imageSvc.get_image(
        imageKey,
        { scale: 'fit', width: size, height: size, format: 'image/jpeg' },
        (err, contentType, body) =>
          err ? reject(new Error(err)) : resolve({ contentType, body })
      );
    });
  }

  // ---------------------------------------------------------------- settings

  _layout(values) {
    const settings = Object.assign({}, DEFAULT_SETTINGS, values);
    delete settings.guest_host; // removed setting, may linger in old config.json
    const layout = [];
    let hasError = false;

    // The picker lists outputs (endpoints), not zones, so the endpoint chosen
    // here may belong to a grouped zone that plays to several speakers. The
    // title says which zone it resolves to, so that is visible when choosing.
    layout.push({
      type: 'zone',
      title: describeZone(settings.zone, this._resolveZone(settings.zone)),
      setting: 'zone'
    });
    layout.push({
      type: 'string',
      title: 'Party name',
      subtitle: settings.zone && settings.zone.output_id
        ? `Leave blank to use the zone name: ${clip(partyName({ zone: settings.zone }, this._resolveZone(settings.zone)))}`
        : 'Leave blank to use the party zone\'s name',
      setting: 'party_name'
    });

    // Profiles are stored by name: browse keys for them expire.
    const profileValues = [{ title: 'Leave as it is', value: '' }];
    for (const name of this.profiles || []) profileValues.push({ title: name, value: name });
    if (settings.guest_profile && !profileValues.some((v) => v.value === settings.guest_profile)) {
      const missing = (this.profiles || []).length ? ' (not found)' : '';
      profileValues.push({ title: `${settings.guest_profile}${missing}`, value: settings.guest_profile });
    }
    const profileItem = {
      type: 'dropdown',
      title: 'Roon profile for guest requests',
      values: profileValues,
      setting: 'guest_profile'
    };
    if (this.profileProblem) profileItem.subtitle = this.profileProblem;
    layout.push(profileItem);
    layout.push({
      type: 'dropdown',
      title: 'Guest access',
      values: [
        { title: 'On', value: true },
        { title: 'Off', value: false }
      ],
      setting: 'enabled'
    });

    /**
     * An integer widget whose value is stored as a number, so "10" and 10 behave
     * the same, with an error on the widget when it is out of range.
     */
    const integer = (setting, title, min, max, blank, extra) => {
      const item = Object.assign({ type: 'integer', title, min, max, setting }, extra);
      const value = normaliseInteger(settings[setting], min, max, blank);
      if (value === null) {
        item.error = `Enter a whole number from ${min} to ${max}`;
        hasError = true;
      } else {
        settings[setting] = value;
      }
      return item;
    };
    // Per guest: 0 (or blank) means no limit. Minutes: 0 (or blank) means a
    // used allowance never comes back. Turning a feature off is the Yes/No.
    const perGuest = (setting, title) =>
      integer(setting, title, 0, 999, 0, { subtitle: '0 = no limit' });
    const refill = (setting) =>
      integer(setting, 'Minutes to earn one back', 0, 1440, 0, { subtitle: '0 = a used one never comes back' });

    layout.push(
      integer('port', 'Web port', 1, 65535, null, {
        subtitle: 'Changing it moves the guest and RoonParty pages to the new port'
      })
    );

    layout.push({
      type: 'group',
      title: 'Adding tracks',
      items: [
        {
          type: 'dropdown',
          title: 'Let guests add tracks',
          values: [
            { title: 'Yes', value: true },
            { title: 'No', value: false }
          ],
          setting: 'allow_add'
        },
        {
          type: 'dropdown',
          title: 'Block tracks already in the queue',
          values: [
            { title: 'Yes', value: true },
            { title: 'No', value: false }
          ],
          setting: 'prevent_duplicates'
        },
        perGuest('add_limit', 'Tracks per guest'),
        refill('add_refill')
      ]
    });

    layout.push({
      type: 'group',
      title: 'Playing next',
      items: [
        {
          type: 'dropdown',
          title: 'Let guests jump the queue',
          values: [
            { title: 'Yes', value: true },
            { title: 'No', value: false }
          ],
          setting: 'allow_next'
        },
        perGuest('next_limit', 'Jumps per guest'),
        refill('next_refill')
      ]
    });

    layout.push({
      type: 'group',
      title: 'Skipping',
      items: [
        {
          type: 'dropdown',
          title: 'Let guests skip the current track',
          values: [
            { title: 'Yes', value: true },
            { title: 'No', value: false }
          ],
          setting: 'allow_skip'
        },
        perGuest('skip_limit', 'Skips per guest'),
        refill('skip_refill')
      ]
    });

    layout.push({
      type: 'group',
      // Browse titles are found automatically (see lib/titles.js); these fields
      // only matter if that fails, so they sit in a group that starts closed.
      title: 'Advanced',
      collapsable: true,
      // The hint goes on each field: a group heading may not show one.
      items: [
        ['title_tracks', 'Track category', DEFAULT_TITLES.tracks_category],
        ['title_add', 'Add to queue action', DEFAULT_TITLES.add],
        ['title_next', 'Play next action', DEFAULT_TITLES.next],
        ['title_profile', 'Profile entry in Settings', DEFAULT_TITLES.profile_menu]
      ].map(([setting, title, english]) => {
        const key = { title_tracks: 'tracks', title_add: 'add', title_next: 'next', title_profile: 'profile' }[setting];
        const found = this.detected && this.detected[key];
        return {
          type: 'string',
          title,
          subtitle: found
            ? `Found "${found}" on your Core and using that. Fill this in to override it.`
            : `"${english}" in English. Usually found automatically on a Core in another language.`,
          setting
        };
      })
    });

    return { values: settings, layout, has_error: hasError };
  }
}

const MAX_ZONE_NAME = 48;

/**
 * The zone picker's title, naming the zone the chosen endpoint resolves to.
 *
 * Silent when there is nothing useful to add — no endpoint chosen yet, no Core
 * to ask, or the endpoint is a zone of its own under the same name, where the
 * picker already says it. Kept short, since this renders as a field label.
 *
 * @param {{output_id: string, name: string}|null} zoneSetting - the picked endpoint
 * @param {object|null} zone - the resolved Roon zone, or null
 */
/**
 * Roon's integer widgets don't promise to send numbers back, and don't enforce
 * min/max themselves. Accepts a number or numeric text; returns the whole
 * number, `blank` for an empty field, or null when it is not valid.
 */
/**
 * Whether node-roon-api will be able to save settings. It writes config.json in
 * the working directory and ignores write errors, so a read-only file (a bind
 * mount owned by another user, say) would lose settings and pairing silently.
 */
function configWritable(file = 'config.json') {
  try {
    fs.accessSync(file, fs.constants.W_OK);
    return true;
  } catch (err) {
    if (err.code !== 'ENOENT') return false;
  }
  try {
    fs.accessSync(require('path').dirname(file), fs.constants.W_OK);
    return true;
  } catch (err) {
    return false;
  }
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Roon did not answer')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function normaliseInteger(value, min, max, blank) {
  if (value === '' || value === null || value === undefined) return blank;
  const n = typeof value === 'string' ? Number(value.trim()) : value;
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

function describeZone(zoneSetting, zone) {
  const title = 'Party zone';
  if (!zoneSetting || !zoneSetting.output_id) return title;
  if (!zone) return `${title} — "${clip(zoneSetting.name)}" is not available`;

  const outputs = (zone.outputs || []).length;
  const name = clip(zone.display_name);
  if (outputs > 1) return `${title} — plays to ${name} (${outputs} endpoints)`;
  if (zone.display_name && zone.display_name !== zoneSetting.name) {
    return `${title} — plays to ${name}`;
  }
  return title;
}

/**
 * The party's name: the one typed in the settings, else the party zone's name.
 * For a grouped zone that is Roon's name for the group, not the endpoint picked
 * in the zone picker. Falls back to the picked endpoint's name while the zone
 * isn't available, then to "Party".
 */
function partyName(settings, zone) {
  const typed = String((settings && settings.party_name) || '').trim();
  if (typed) return typed;
  if (zone && zone.display_name) return zone.display_name;
  if (settings && settings.zone && settings.zone.name) return settings.zone.name;
  return 'Party';
}

function clip(text) {
  const value = String(text || '');
  return value.length > MAX_ZONE_NAME ? `${value.slice(0, MAX_ZONE_NAME - 1)}…` : value;
}

module.exports = { RoonService, DEFAULT_SETTINGS, describeZone, normaliseInteger, partyName, configWritable };
