'use strict';

const EventEmitter = require('events');

const RoonApi = require('node-roon-api');
const RoonApiStatus = require('node-roon-api-status');
const RoonApiSettings = require('node-roon-api-settings');
const RoonApiTransport = require('node-roon-api-transport');
const RoonApiBrowse = require('node-roon-api-browse');
const RoonApiImage = require('node-roon-api-image');

const HIERARCHY = 'search';
const QUEUE_ITEMS = 50;

/**
 * Roon localises browse titles, so the titles we match on are configurable.
 * These defaults are the English ones.
 */
const DEFAULT_TITLES = {
  tracks_category: 'Tracks',
  add: 'Queue',
  next: 'Add Next',
  now: 'Play Now'
};

const DEFAULT_SETTINGS = {
  zone: null,
  party_name: '',
  enabled: true,
  port: Number(process.env.PARTY_PORT) || 8080,
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
  title_next: DEFAULT_TITLES.next
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

    this.api = new RoonApi({
      extension_id: 'com.stubaggs.party-mode',
      display_name: 'Party Mode',
      display_version: require('../package.json').version,
      publisher: 'stubaggs',
      email: '',
      website: 'https://github.com/stubaggs/roon-extension-party-mode',

      core_paired: (core) => this._onCorePaired(core),
      core_unpaired: () => this._onCoreUnpaired()
    });

    this.settings = this._layout(this.api.load_config('settings') || {}).values;

    this.svcStatus = new RoonApiStatus(this.api);
    this.svcSettings = new RoonApiSettings(this.api, {
      get_settings: (cb) => cb(this._layout(this.settings)),
      save_settings: (req, isdryrun, settings) => {
        const layout = this._layout(settings.values);
        req.send_complete(layout.has_error ? 'NotValid' : 'Success', { settings: layout });
        if (isdryrun || layout.has_error) return;

        const previousZone = this.settings.zone && this.settings.zone.output_id;
        const previousEnabled = this.settings.enabled;

        this.settings = layout.values;
        this.api.save_config('settings', this.settings);
        this.svcSettings.update_settings(layout);

        const newZone = this.settings.zone && this.settings.zone.output_id;
        if (newZone !== previousZone) this._subscribeQueue();
        if (this.settings.enabled !== previousEnabled) this.emit('access_changed', this.settings.enabled);

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

    core.services.RoonApiTransport.subscribe_zones((response, msg) => {
      if (response === 'Subscribed' || response === 'Changed') {
        this._refreshZone();
      }
    });

    this._subscribeQueue();
    this._updateStatus();
    this.emit('core_paired');
  }

  _onCoreUnpaired() {
    this.core = null;
    this.zone = null;
    this.queue = [];
    this.emit('queue_changed');
    this.emit('core_unpaired');
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

      if (response === 'Subscribed') {
        this.queue = (msg && msg.items) || [];
      } else if (response === 'Changed' && msg && msg.changes) {
        for (const change of msg.changes) {
          if (change.operation === 'remove') {
            this.queue.splice(change.index, change.count);
          } else if (change.operation === 'insert') {
            this.queue.splice(change.index, 0, ...change.items);
          }
        }
      } else {
        return;
      }
      this.emit('queue_changed');
    });
  }

  _updateStatus() {
    if (!this.svcStatus) return;
    if (!this.core) {
      this.svcStatus.set_status('Waiting for Roon Core', false);
      return;
    }
    if (!this.settings.zone) {
      this.svcStatus.set_status('Select a party zone in the settings', true);
      return;
    }
    if (!this.zone) {
      this.svcStatus.set_status(`Zone "${this.settings.zone.name}" is not available`, true);
      return;
    }
    if (!this.settings.enabled) {
      this.svcStatus.set_status(`Guest access is off — zone ${this.zone.display_name}`, false);
      return;
    }
    this.svcStatus.set_status(this.statusLine || `Ready — zone ${this.zone.display_name}`, false);
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
    const category = page.items.find(
      (item) => item.item_key && item.title && item.title.toLowerCase() === wanted
    );

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
   * Drill into an item and invoke one of its actions, e.g. "Queue".
   * mode is 'add' | 'next' | 'now'.
   */
  async performAction(sessionKey, itemKey, mode) {
    const outputId = this.settings.zone && this.settings.zone.output_id;
    if (!outputId) throw new Error('no_zone');

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

    const action = page.items.find(
      (item) => item.title && item.title.toLowerCase() === wanted
    );
    if (!action) throw new Error('action_unavailable');

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

    layout.push({ type: 'zone', title: 'Party zone', setting: 'zone' });
    layout.push({ type: 'string', title: 'Party name', setting: 'party_name' });
    layout.push({
      type: 'dropdown',
      title: 'Guest access',
      values: [
        { title: 'On', value: true },
        { title: 'Off', value: false }
      ],
      setting: 'enabled'
    });

    const port = {
      type: 'integer',
      title: 'Web port',
      subtitle: 'Changing it moves the guest and RoonParty pages to the new port',
      min: 1,
      max: 65535,
      setting: 'port'
    };
    if (!(settings.port >= 1 && settings.port <= 65535)) {
      port.error = 'Port must be between 1 and 65535';
      hasError = true;
    }
    layout.push(port);

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
        { type: 'integer', title: 'Tracks per guest', min: 0, max: 999, setting: 'add_limit' },
        { type: 'integer', title: 'Minutes to earn one back', min: 0, max: 1440, setting: 'add_refill' }
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
        { type: 'integer', title: 'Jumps per guest', min: 0, max: 999, setting: 'next_limit' },
        { type: 'integer', title: 'Minutes to earn one back', min: 0, max: 1440, setting: 'next_refill' }
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
        { type: 'integer', title: 'Skips per guest', min: 0, max: 999, setting: 'skip_limit' },
        { type: 'integer', title: 'Minutes to earn one back', min: 0, max: 1440, setting: 'skip_refill' }
      ]
    });

    layout.push({
      type: 'group',
      title: 'Browse titles (change these if your Core is not in English)',
      items: [
        { type: 'string', title: 'Track category', setting: 'title_tracks' },
        { type: 'string', title: 'Add to queue action', setting: 'title_add' },
        { type: 'string', title: 'Play next action', setting: 'title_next' }
      ]
    });

    return { values: settings, layout, has_error: hasError };
  }
}

module.exports = { RoonService, DEFAULT_SETTINGS };
