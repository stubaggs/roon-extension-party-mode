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

const { listProfiles, selectProfile, selectProfileInBrowse } = require('./profiles');
const { isTrackList, pickAction, openTopEntry, isSearchBox } = require('./titles');
const { ArtCache, KnownKeys } = require('./art-cache');
const { nameTooLong, NAME_LENGTH } = require('./guests');
const { DEBUG, debug, debugEnabled, setDebug } = require('./log');
const { seconds } = require('./track-id');
const i18n = require('./i18n');
const crypto = require('crypto');
const { startPort, instanceName, rateLimitsFromEnv, DEFAULT_RATE_LIMIT, DEFAULT_SEARCH_LIMIT } = require('./env');

// Guests search and queue in Roon's main "browse" hierarchy, through Library →
// Search, rather than the separate "search" hierarchy: Roon keeps the profile
// per hierarchy within a session, and only "browse" also has Settings → Profile,
// so it is the one place a guest's requests can count toward the chosen profile.
const HIERARCHY = 'browse';
// How much of the zone's queue Roon sends us. The guest page lists all of it,
// so this is the longest queue it can show.
const QUEUE_ITEMS = 500;
// How long to wait before asking again for a queue the Core refused.
const QUEUE_RETRY_MS = 5000;
const MAX_RADIO_PICKS = 1000;
// Roon never answers a request for an image key it doesn't know, so album art
// gives up after this long rather than holding the guest's connection open.
const IMAGE_TIMEOUT_MS = 5000;
// How long the party zone may be gone before the party pauses itself (see
// _holdForZone): a device waking up or a moment's network trouble shouldn't
// flicker the guest pages between on and paused.
const ZONE_HOLD_MS = 10000;
// Party mode as the settings name it, for the log.
const MODE_NAMES = { on: 'On', paused: 'Paused', off: 'Off' };
// How long to wait before asking a Core that didn't answer about profiles again.
const PROFILE_RETRY_MS = 5000;

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

// Roon's menu names Party Mode looks for: the setting, its key in detected
// (found on a Core in another language), its title in the settings, and
// Roon's English name.
const MENU_NAMES = [
  ['title_tracks', 'tracks', 'Track category', DEFAULT_TITLES.tracks_category],
  ['title_add', 'add', 'Add to queue action', DEFAULT_TITLES.add],
  ['title_next', 'next', 'Play next action', DEFAULT_TITLES.next],
  ['title_profile', 'profile', 'Profile entry in Settings', DEFAULT_TITLES.profile_menu]
];

const DEFAULT_SETTINGS = {
  zone: null,
  party_name: '',
  host_name: '', // '' shows "Host" in each guest's language
  guest_invite: true, // the guest page's party name button shows the join QR code
  enabled: true,
  guest_profile: '', // '' leaves the extension's Roon profile as it is
  playlist_download: 'qr',
  playlist_hide_names: false,
  hub_language: '', // '' follows the Party Hub browser's language
  port: startPort(),
  detailed_log: false, // also on from the start with ROON_EXTENSION_PARTY_MODE_DEBUG
  // Requests a minute per device (see REQUEST_LIMIT_PRESETS). The numbers are
  // used for 'custom', and follow the default otherwise. request_limits_set: the
  // host changed them in Roon, so the environment's limits no longer apply.
  request_limits: 'default',
  rate_limit: DEFAULT_RATE_LIMIT,
  search_limit: DEFAULT_SEARCH_LIMIT,
  request_limits_set: false,
  allow_add: true,
  prevent_duplicates: true,
  // A track plays for about 4 minutes, so about 15 an hour: these keep one guest
  // from filling the queue, and play next a special request (see DEVELOPER.md).
  add_limit: 5,
  add_refill: 10,
  allow_next: true,
  next_limit: 1,
  next_refill: 60,
  allow_skip: false,
  skip_limit: 1,
  skip_refill: 60,
  title_tracks: DEFAULT_TITLES.tracks_category,
  title_add: DEFAULT_TITLES.add,
  title_next: DEFAULT_TITLES.next,
  title_profile: DEFAULT_TITLES.profile_menu
};

/**
 * Whether the zone is playing (or paused on) a live radio station. Roon plays a
 * station outside the queue, as a "now playing" with no length that can't be
 * seeked, and blocks next while it plays; a track always has a length. Checked
 * against a Core in October 2026.
 */
function isStation(zone) {
  const np = zone && zone.now_playing;
  return Boolean(np && !np.length && zone.is_seek_allowed === false);
}

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
  // Whether Roon will skip now: the guest page shows Skip only then.
  const skip = Boolean(zone.is_next_allowed);
  return JSON.stringify({ state: zone.state, radio, skip, now_playing: np });
}

/**
 * The party mode setting, stored as "enabled" (its name when it was a plain
 * on/off "Guest access"): true, "paused" or false. Anything else counts as on.
 * @returns {'on'|'paused'|'off'}
 */
function partyMode(settings) {
  const value = settings && settings.enabled;
  if (value === false) return 'off';
  if (value === 'paused') return 'paused';
  return 'on';
}

/**
 * How the Party Hub offers the playlist: 'qr', 'link' or 'off'. Stored as
 * "playlist_download", which was briefly a yes/no; anything else counts as 'qr'.
 * @returns {'qr'|'link'|'off'}
 */
function playlistDisplay(settings) {
  const value = settings && settings.playlist_download;
  if (value === false || value === 'off') return 'off';
  if (value === 'link') return 'link';
  return 'qr';
}

/**
 * Roon's status once the party zone is up, the same in every mode:
 *   Party mode: Paused
 *   Party: House Party
 *   Party zone: EX5
 *   Party Hub at http://…/PartyHub
 * The mode, as the Party mode setting names it, the party's name, the zone,
 * then the links line from app.js (the Hub's address, or why the web server
 * couldn't start). A party with no name of its own is named after its zone,
 * which is then said only once.
 */
function statusText(name, mode, links, zone = '') {
  const state = { on: 'On', paused: 'Paused', off: 'Off' }[mode] || mode;
  return [`Party mode: ${state}`, `Party: ${name}`, zone && zone !== name ? `Party zone: ${zone}` : '', links]
    .filter(Boolean)
    .join('\n');
}

/**
 * How the extension names itself to Roon. A version with a suffix (a beta,
 * "1.4.0-beta.1") is a separate extension, named after the suffix's word: its
 * own id and "(beta)" in its name, so Roon keeps it apart from the release when
 * both run against one Core. A suffix with no word ("1.4.0-1") counts as beta.
 */
function extensionIdentity(version, instance = '') {
  const suffix = String(version).split('-').slice(1).join('-');
  const channel = suffix && ((suffix.match(/^[a-z]+/i) || ['beta'])[0].toLowerCase());
  // A named copy (ROON_EXTENSION_PARTY_MODE_INSTANCE) is a separate extension
  // too: "Garden" becomes ….garden and "Party Mode (Garden)". A name with no
  // Latin letters or digits ("厨房") gets a short hash of itself instead.
  const name = String(instance || '').trim();
  let slug = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (name && !slug) slug = crypto.createHash('sha1').update(name).digest('hex').slice(0, 8);
  const id = ['com.stubaggs.party-mode', channel, slug].filter(Boolean).join('.');
  const label = [channel, name].filter(Boolean).join(', ');
  return {
    extension_id: id,
    display_name: label ? `Party Mode (${label})` : 'Party Mode',
    display_version: version
  };
}

const PARTY_MODE_CHOICES = {
  on: ['On — guests can make requests', 'Pause — hold playback and requests', 'Off — close requests'],
  paused: ['Unpause — playback and requests resume', 'Paused — playback and requests on hold', 'Off — close requests'],
  off: ['On — start a new party', 'Paused — start a new party, on hold', 'Off — requests closed']
};

/** The Party mode dropdown's choices, worded for the mode the party is in now. */
function partyModeChoices(current) {
  const [on, paused, off] = PARTY_MODE_CHOICES[current] || PARTY_MODE_CHOICES.on;
  return [
    { title: on, value: true },
    { title: paused, value: 'paused' },
    { title: off, value: false }
  ];
}

class RoonService extends EventEmitter {
  constructor() {
    super();
    this.core = null;
    this.zone = null;
    this.queue = [];
    this.artCache = new ArtCache();
    this.artKeys = new KnownKeys();
    this.queueGeneration = 0;
    // The queue subscription: 'none', 'asked' (no answer yet), 'subscribed' or
    // 'refused'; and the retry waiting after a refusal (see _subscribeQueue).
    this.queueState = 'none';
    this.queueRetry = null;
    // The output the zone was last looked up for, and whether its loss was
    // logged (see _noteZoneChange).
    this.zoneOutput = null;
    this.zoneLost = false;
    // The party paused itself while its zone is gone (see _holdForZone), and the
    // wait before it does.
    this.zoneHold = false;
    this.zoneHoldTimer = null;
    // Whether that hold began with the Core going, rather than just the zone.
    this.holdForCore = false;
    // For the About page: when the Core connected, how often it was lost, and
    // the last time: when it went and, once back, for how long.
    this.coreSince = null;
    this.coreLost = 0;
    this.lastOutage = null;
    // Queue item ids Roon Radio added, oldest first (see _noteRadioPick).
    this.radioPicks = new Set();
    this.settings = Object.assign({}, DEFAULT_SETTINGS);
    // Browse titles found on this Core when the configured ones didn't match
    // (a Core in another language). Shown in the settings hints.
    this.detected = {};
    // Guest browse sessions the profile has been selected in: session key ->
    // "profile|menu title". Cleared when the Core reconnects or the setting changes.
    this.profileSessions = new Map();
    // Titles of the browse menu's Library and Settings entries, once found.
    this.browseTitles = {};
    // Roon's pairing, as node-roon-api last gave it (see get_persisted_state below).
    this.pairing = null;

    this.api = new RoonApi({
      // node-roon-api logs every message to and from the Core unless told not
      // to: guests' searches and Roon's full replies. Only with the detailed log
      // on (lib/log.js); _setDetailedLog changes it while running.
      log_level: 'none',
      ...extensionIdentity(require('../package.json').version, instanceName()),
      publisher: 'Stubaggs',
      email: 'partymode@stubaggs.com',
      website: 'https://github.com/stubaggs/roon-extension-party-mode',

      core_paired: (core) => this._onCorePaired(core),
      core_unpaired: () => this._onCoreUnpaired(),

      // node-roon-api keeps Roon's pairing only in config.json, writing it when
      // the Core pairs and registers. If config.json can't be written then, the
      // pairing would be lost even after the permissions are fixed. So it's kept
      // here too, and written again once config.json can be (_checkConfigWritable).
      get_persisted_state: () => {
        if (!this.pairing) this.pairing = this.api.load_config('roonstate') || {};
        return this.pairing;
      },
      set_persisted_state: (state) => {
        this.pairing = state;
        this.api.save_config('roonstate', state);
      }
    });

    this.settings = this._layout(this.api.load_config('settings') || {}).values;
    // The mode the web server was last told of (see _announceMode).
    this.announcedMode = partyMode(this.settings);
    // The detailed log: on if the environment asks for it or the host turned it
    // on in Roon. Only a change the host makes in Roon is saved (see
    // detailedLogAfterSave), so the environment never writes it into config.json.
    this.savedDetailedLog = Boolean(this.settings.detailed_log);
    // The environment's request limits apply until the host changes them in Roon.
    this.limitsFromEnv = !this.settings.request_limits_set && rateLimitsFromEnv();
    if (this.limitsFromEnv) Object.assign(this.settings, requestLimitSettings(this.limitsFromEnv));
    this._setDetailedLog(DEBUG || this.savedDetailedLog, false);

    this.configWritable = true;
    this._checkConfigWritable();

    this.svcStatus = new RoonApiStatus(this.api);
    this.svcSettings = new RoonApiSettings(this.api, {
      // Fetch the profile list first so the dropdown shows the current profiles.
      get_settings: (cb) => this._refreshProfiles().then(() => cb(this._layout(this.settings))),
      save_settings: (req, isdryrun, settings) => {
        const layout = this._layout(settings.values);
        req.send_complete(layout.has_error ? 'NotValid' : 'Success', { settings: layout });
        if (isdryrun) return;
        // Roon closes the window on Save even when we refuse it, and shows the
        // errors only for a moment. So the status line says what wasn't saved,
        // until a save goes through.
        this.settingsRejected = layout.has_error ? settingErrors(layout.layout) : null;
        if (layout.has_error) return this._updateStatus();

        const previousZone = this.settings.zone && this.settings.zone.output_id;
        const previousMode = partyMode(this.settings);
        const previousProfile = `${this.settings.guest_profile}|${this.settings.title_profile}`;
        const previousLimits = limitsKey(this.settings);

        const log = detailedLogAfterSave(debugEnabled(), layout.values.detailed_log, this.savedDetailedLog);
        this.savedDetailedLog = log.saved;
        if (log.on !== debugEnabled()) this._setDetailedLog(log.on, true);

        // A change to Flood protection makes the setting win over the environment from now on.
        layout.values.request_limits_set =
          Boolean(this.settings.request_limits_set) || limitsKey(layout.values) !== previousLimits;
        if (layout.values.request_limits_set) this.limitsFromEnv = null;

        this.settings = layout.values;
        this.api.save_config('settings', Object.assign({}, this.settings, { detailed_log: this.savedDetailedLog }));
        // node-roon-api drops a failed write without a word. Checked again on
        // every save, so permissions fixed while running clear the warning, and
        // a folder that turns read-only shows it, with no restart.
        this._checkConfigWritable();
        // Built again from the new mode, so Pause and Unpause swap over.
        this.svcSettings.update_settings(this._layout(this.settings));

        const newZone = this.settings.zone && this.settings.zone.output_id;
        if (newZone !== previousZone) {
          // Resolve it now: the zone subscription only reports changes, and a
          // paused Core may send none for a long time.
          this._refreshZone();
          this._subscribeQueue();
        }
        if (partyMode(this.settings) !== previousMode) {
          // The host's own change, told apart in the log from the automatic pause.
          console.log(`Party mode: ${MODE_NAMES[partyMode(this.settings)]} (was ${MODE_NAMES[previousMode]})`);
          this._partyModeChanged(previousMode, partyMode(this.settings));
        }
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
    this.coreSince = Date.now();
    if (this.lastOutage && !this.lastOutage.back) this.lastOutage.back = this.coreSince;
    // Back within the Core's wait: the zone, when it arrives or doesn't, decides.
    clearTimeout(this.zoneHoldTimer);
    this.zoneHoldTimer = null;
    console.log(core.display_name ? `Connected to the Roon Core "${core.display_name}"` : 'Connected to the Roon Core');
    this.profileSessions.clear(); // a new connection means new browse sessions

    core.services.RoonApiTransport.subscribe_zones((response, msg) => {
      if (response === 'Subscribed' || response === 'Changed') {
        this._refreshZone();
      }
    });

    this._subscribeQueue();
    this._updateStatus();
    this.emit('core_paired');
    this._applyProfileOnConnect(core);
  }

  /**
   * Just after a Core starts, it may not answer browse calls for a few seconds,
   * so a profile check that gets no answer is tried once more before it's
   * logged as a problem.
   */
  async _applyProfileOnConnect(core) {
    await this._applyProfile({ quiet: true });
    if (!/^Could not/.test(this.profileProblem || '')) return;
    const timer = setTimeout(() => {
      if (this.core === core) this._applyProfile();
    }, PROFILE_RETRY_MS);
    if (timer.unref) timer.unref();
  }

  /**
   * Re-read the Core's profiles for the settings dropdown. Never rejects, and
   * gives up after a few seconds so the settings screen always opens.
   */
  async _refreshProfiles({ quiet = false } = {}) {
    if (!this.browseSvc) return;
    const menuTitle = this.settings.title_profile || DEFAULT_TITLES.profile_menu;
    try {
      const result = await withTimeout(listProfiles((o) => this._browse(o), (o) => this._load(o), menuTitle), 4000);
      if (result.profiles) {
        this.profiles = result.profiles.map((profile) => profile.title);
        this.profileProblem = '';
        if (result.entryTitle) this._noteDetected('profile', 'Profile entry', result.entryTitle);
        this.defaultProfile = await this._readDefaultProfile(menuTitle);
      } else {
        this.profiles = [];
        this.profileProblem = `No "${menuTitle}" entry in Roon's settings menu (found: ${result.menu.join(', ') || 'nothing'})`;
        console.warn(this.profileProblem);
      }
    } catch (err) {
      this.profileProblem = `Could not read profiles: ${err.message}`;
      if (!quiet) console.warn(this.profileProblem);
    }
  }

  /**
   * The profile Roon gives a new browse session, which is what guests' tracks
   * play under when no profile is chosen. Roon's API doesn't name it, so a new
   * session is opened and its Profile entry read; nothing is selected. "Guest"
   * on a Core in October 2026. Null when it can't be read.
   */
  async _readDefaultProfile(menuTitle) {
    const session = `party-default-${crypto.randomBytes(6).toString('hex')}`;
    try {
      const result = await withTimeout(
        listProfiles((o) => this._browse(o), (o) => this._load(o), menuTitle, session),
        4000
      );
      return result.current || null;
    } catch (err) {
      debug(`Could not read Roon's default profile: ${err.message}`);
      return null;
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
        selectProfileInBrowse((o) => this._browse(o), (o) => this._load(o), menuTitle, name, sessionKey, this.browseTitles),
        6000
      );
      if (result.ok) this.browseTitles.settings = result.settingsTitle;
      if (result.ok) {
        console.log(`Guest ${sessionKey.slice(0, 6)}…: profile "${name}"`);
        debug(`  Roon answered ${result.answer}; profile before "${result.before}", after "${result.after}"`);
      }
      else console.warn(`Could not select profile "${name}" for a guest (${result.reason})`);
    } catch (err) {
      console.warn(`Could not select profile "${name}" for a guest: ${err.message}`);
    }
  }

  /** Switch the extension's Roon profile to the one chosen for guests, if any. */
  async _applyProfile({ quiet = false } = {}) {
    // Guests' sessions pick up the new choice on their next search or request.
    this.profileSessions.clear();
    const name = this.settings.guest_profile;
    if (!name || !this.browseSvc) {
      await this._refreshProfiles({ quiet });
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
        console.log(`Guest requests use the Roon profile "${name}"`);
        debug(`  profiles on offer: ${result.options.join(', ')}`);
      } else if (result.reason === 'no_profile') {
        this.profileProblem = `Profile "${name}" not found (Roon has: ${result.profiles.join(', ')})`;
        console.warn(this.profileProblem);
      } else {
        this.profileProblem = `No "${menuTitle}" entry in Roon's settings menu (found: ${result.menu.join(', ') || 'nothing'})`;
        console.warn(this.profileProblem);
      }
    } catch (err) {
      this.profileProblem = `Could not switch profile: ${err.message}`;
      if (!quiet) console.warn(this.profileProblem);
    }
    await this._refreshProfiles({ quiet });
  }

  _onCoreUnpaired() {
    const wasConnected = Boolean(this.core);
    if (wasConnected) console.warn("Lost the connection to the Roon Core: guests can't search or request until it's back");
    if (wasConnected) {
      this.coreLost += 1;
      this.lastOutage = { at: Date.now(), back: null };
    }
    this.coreSince = null;
    clearTimeout(this.zoneHoldTimer);
    this.zoneHoldTimer = null;
    if (wasConnected) this._holdForCore();
    this.core = null;
    this.zone = null;
    this.queue = [];
    this.queueState = 'none';
    clearTimeout(this.queueRetry);
    this.queueRetry = null;
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
    // The party zone is back (the Core restarted, or its endpoint returned)
    // after the Core refused its queue, asked for before it knew the zone.
    // Ask again now that it does. A request still waiting is left to answer.
    const returned = zone && !this.zone && this.queueState === 'refused';
    this._noteZoneChange(configured, zone);
    this.zone = zone;
    this._holdForZone(zone);
    if (returned) this._subscribeQueue();
    const ended = this._notePosition(zone);

    if (!zone) {
      this._updateStatus();
      return;
    }
    if (zone.now_playing) this.artKeys.note([zone.now_playing]);
    if (before !== playbackSignature(zone)) this.emit('now_playing_changed', ended);
    this._updateStatus();
  }

  /**
   * Logs the party zone going away and coming back (its endpoint switched off or
   * unplugged, or gone from Roon). Otherwise the only sign is that guests' searches
   * and requests are refused as not ready. Not when the host picks another zone,
   * and not when the whole Core goes (_onCoreUnpaired says so).
   */
  _noteZoneChange(configured, zone) {
    const same = Boolean(configured) && configured === this.zoneOutput;
    if (same && this.zone && !zone) {
      console.warn(`Party zone "${this.zone.display_name}" is no longer available in Roon`);
      this.zoneLost = true;
    } else if (same && zone && this.zoneLost) {
      console.log(`Party zone "${zone.display_name}" is available again`);
      this.zoneLost = false;
    } else if (!same) {
      this.zoneLost = false;
    }
    this.zoneOutput = configured;
  }

  /**
   * While the party zone is gone (its device off or unplugged, or gone from
   * Roon), the party pauses itself after ZONE_HOLD_MS: guests see "Requests are
   * paused for a moment" rather than errors, and the Party Hub shows requests on
   * hold. It's back on as soon as the zone returns. The host's own Paused or Off
   * is left alone, and nothing is saved, so a restart starts as the host set it.
   * While the Core itself is gone, _holdForCore does the same.
   */
  _holdForZone(zone) {
    // The Core's hold runs meanwhile; its timer isn't this one to cancel.
    if (!this.core) return;
    const configured = this.settings.zone && this.settings.zone.output_id;
    if (zone || !configured) {
      clearTimeout(this.zoneHoldTimer);
      this.zoneHoldTimer = null;
      if (this.zoneHold) {
        this.zoneHold = false;
        this.holdForCore = false;
        if (partyMode(this.settings) === 'on') console.log('Requests are back on');
        this._announceMode();
      }
      return;
    }
    // Back from a Core restart without the zone: still on hold, now for the zone.
    if (this.zoneHold && this.holdForCore) {
      this.holdForCore = false;
      const name = this.settings.zone && this.settings.zone.name;
      if (!this.zoneLost) {
        console.warn(`Party zone "${name}" is not available in Roon`);
        this.zoneLost = true;
      }
      if (partyMode(this.settings) === 'on') console.warn(`Requests are paused until party zone "${name}" is back`);
      this._updateStatus();
      return;
    }
    if (this.zoneHold || this.zoneHoldTimer) return;
    const timer = setTimeout(() => {
      this.zoneHoldTimer = null;
      if (this.zone || !this.core) return;
      this.zoneHold = true;
      const name = this.settings.zone && this.settings.zone.name;
      // Just after connecting (a Core restart, say) the zone was never seen go, so
      // say so now, and its return is logged too (_noteZoneChange).
      if (!this.zoneLost) {
        console.warn(`Party zone "${name}" is not available in Roon`);
        this.zoneLost = true;
      }
      if (partyMode(this.settings) === 'on') console.warn(`Requests are paused until party zone "${name}" is back`);
      this._announceMode();
      this._updateStatus();
    }, ZONE_HOLD_MS);
    if (timer.unref) timer.unref();
    this.zoneHoldTimer = timer;
  }

  /**
   * Losing the Core holds the party as losing the zone does, after the same
   * wait (a quick reconnect changes nothing for guests): the pages keep the
   * last track and Up next and say requests are paused, rather than inviting
   * requests that can't work. Back on once the Core and the zone are back
   * (_holdForZone). Nothing is sent to Roon, and nothing saved.
   */
  _holdForCore() {
    if (!(this.settings.zone && this.settings.zone.output_id) || this.zoneHold) return;
    const timer = setTimeout(() => {
      this.zoneHoldTimer = null;
      if (this.core || this.zoneHold) return;
      this.zoneHold = true;
      this.holdForCore = true;
      if (partyMode(this.settings) === 'on') console.warn('Requests are paused until the Roon Core is back');
      this._announceMode();
      this._updateStatus();
    }, ZONE_HOLD_MS);
    if (timer.unref) timer.unref();
    this.zoneHoldTimer = timer;
  }

  /** The party mode in force: the host's choice, or paused while its zone or the Core is gone. */
  get currentMode() {
    const chosen = partyMode(this.settings);
    return chosen === 'on' && this.zoneHold ? 'paused' : chosen;
  }

  /** Tells the web server when the mode in force changes, once per change. */
  _announceMode() {
    const now = this.currentMode;
    const previous = this.announcedMode;
    if (now === previous) return;
    this.announcedMode = now;
    this.emit('party_mode_changed', now, previous);
  }

  /**
   * How far the playing track got, so a track left early can be told apart
   * from one that played out. Roon updates the position every second; the
   * furthest seen is kept per track, since a zone update can carry a reset one.
   * @returns {object|null} when the track changed: the one before, as
   *   { title, artist, length, seek } with seek null if no position was seen
   */
  _notePosition(zone) {
    const np = zone && zone.now_playing;
    const lines = np ? np.three_line || np.two_line || {} : {};
    const id = np ? `${lines.line1 || ''}|${lines.line2 || ''}|${np.length || ''}` : null;
    let ended = null;
    if (this.position && this.position.id !== id) ended = this.position.track;
    if (!id) {
      this.position = null;
      return ended;
    }
    if (!this.position || this.position.id !== id) {
      this.position = {
        id,
        track: { title: lines.line1 || '', artist: lines.line2 || '', length: seconds(np.length), seek: null }
      };
    }
    const seek = Number(np.seek_position);
    if (Number.isFinite(seek) && seek > (this.position.track.seek || 0)) this.position.track.seek = seek;
    return ended;
  }

  /**
   * Roon has no unsubscribe helper for queues that is convenient to use here,
   * so a generation counter is used to ignore callbacks from stale zones.
   */
  _subscribeQueue() {
    const outputId = this.settings.zone && this.settings.zone.output_id;
    this.queue = [];
    this.queueState = 'none';
    clearTimeout(this.queueRetry);
    this.queueRetry = null;
    this.emit('queue_changed');
    if (!this.transport || !outputId) return;
    this.queueState = 'asked';

    const generation = ++this.queueGeneration;

    this.transport.subscribe_queue(outputId, QUEUE_ITEMS, (response, msg) => {
      if (generation !== this.queueGeneration) return;
      if (response !== 'Subscribed' && response !== 'Changed') {
        // Refused or ended (just after a Core restart, the zone may not exist
        // yet). Without this the queue stays empty until the zone is chosen
        // again. Ask again when the zone appears (_refreshZone), or shortly
        // if it's already here.
        debug(`Queue subscription ended: ${response}`);
        this.queueState = 'refused';
        if (this.zone && !this.queueRetry) {
          this.queueRetry = setTimeout(() => {
            this.queueRetry = null;
            if (generation === this.queueGeneration) this._subscribeQueue();
          }, QUEUE_RETRY_MS);
          if (this.queueRetry.unref) this.queueRetry.unref();
        }
        return;
      }
      this.queueState = 'subscribed';

      const inserted = [];
      // A copy: Changed edits the queue in place.
      const previous = this.queue.slice();

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

      if (response === 'Changed') this._noteRadioPick(previous, this.queue);
      this.artKeys.note(this.queue);

      // Before queue_changed, so a request is credited to its guest in the same
      // update the pages are about to receive. These items are the only place
      // Roon reports the queue item id and length of a track just requested.
      if (inserted.length) this.emit('queue_inserted', inserted);
      this.emit('queue_changed');
    });
  }

  /**
   * Roon doesn't say which queue entries Roon Radio added, but it adds them in a
   * way of its own (seen on a Core in October 2026): as the last entry ends, one
   * update replaces it with exactly one new entry. Something the host queues is
   * appended to what's there, or put into an empty queue. So with Roon Radio on,
   * an entry that arrives that way is taken for Roon Radio's.
   */
  _noteRadioPick(previous, queue) {
    const radioOn = Boolean(this.zone && this.zone.settings && this.zone.settings.auto_radio);
    if (!radioOn || previous.length !== 1 || queue.length !== 1) return;
    const id = queue[0].queue_item_id;
    if (id === previous[0].queue_item_id) return;
    this.radioPicks.add(id);
    // Only recent ones matter: an entry is long gone before this many more arrive.
    if (this.radioPicks.size > MAX_RADIO_PICKS) this.radioPicks.delete(this.radioPicks.values().next().value);
  }

  /** Whether Roon Radio added this queue entry (see _noteRadioPick). */
  isRadioPick(queueItemId) {
    return this.radioPicks.has(queueItemId);
  }

  /**
   * Whether config.json can be saved, logged when that changes: at startup if
   * it can't, and whenever it starts or stops working after that.
   */
  _checkConfigWritable() {
    const writable = configWritable();
    if (writable === this.configWritable) return;
    this.configWritable = writable;
    if (writable) {
      // Written now: node-roon-api won't write it again until the Core next pairs.
      if (this.pairing) this.api.save_config('roonstate', this.pairing);
      console.log('config.json is writable again: settings and the Roon pairing are saved');
      return;
    }
    console.warn(
      `config.json in ${configFolder()} is not writable by this user (uid ${process.getuid ? process.getuid() : '?'}), ` +
        'so settings and the Roon pairing will not be saved. In Docker, mount a volume on ' +
        '/data (as docker-compose.yml does); with a folder or a config.json file mounted ' +
        'instead, make it writable by this user, e.g. sudo chown 1000 <folder or config.json>.'
    );
  }

  _updateStatus() {
    if (!this.svcStatus) return;
    // A read-only config.json is added to whatever else the status says, and a
    // reminder goes first while the detailed log is on.
    const say = (message, isError) => {
      let text = this.configWritable ? message : `${message} — settings can't be saved: config.json is read-only`;
      if (debugEnabled()) text = `${DETAILED_LOG_WARNING}\n${text}`;
      if (this.settingsRejected) text = `Settings not saved: ${this.settingsRejected}\n${text}`;
      this.svcStatus.set_status(text, isError || !this.configWritable || Boolean(this.settingsRejected));
    };
    if (!this.core) return say('Waiting for Roon Core', false);
    if (!this.settings.zone) return say('Select a party zone in the settings', true);
    if (!this.zone) {
      const held = this.zoneHold && partyMode(this.settings) === 'on' ? ": requests are paused until it's back" : '';
      return say(`Zone "${this.settings.zone.name}" is not available${held}`, true);
    }
    return say(statusText(this.partyName, partyMode(this.settings), this.statusLine, this.zone.display_name), false);
  }

  /** Requests a minute per device, for the web server: {all, search}, 0 for no limit. */
  get requestLimits() {
    return requestLimits(this.settings);
  }

  /**
   * Turns the detailed log on or off: Party Mode's own debug lines and
   * node-roon-api's log of every message to and from the Core.
   */
  _setDetailedLog(on, announce) {
    setDebug(on);
    this.api.log_level = on ? 'all' : 'none';
    this.settings.detailed_log = on;
    if (announce) console.log(`Detailed log ${on ? 'on' : 'off'}`);
  }

  /**
   * The website link Roon shows for the extension. It goes out with the
   * registration, which node-roon-api resends on every connect to the Core,
   * so set it before start().
   */
  setWebsite(url) {
    this.api.extension_reginfo.website = url;
  }

  /** The playlist's download address, for the hint in the settings. */
  setPlaylistUrl(url) {
    this.playlistUrl = url;
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

  /**
   * The name the pages show: as partyName, but '' rather than "Party" when
   * there's neither, so each page uses its own party.default_name.
   */
  get pageName() {
    return partyName(this.settings, this.zone, '');
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
   * Run fn when nothing else is browsing in this guest's session.
   *
   * A browse session has one position, and a search or a request is several
   * steps through it. Two at once interleave: one search opens Tracks, the
   * other takes the session back to the result categories, and the first then
   * reads "Tracks, Artists, TIDAL" as its tracks. So each guest's steps run one
   * operation at a time.
   */
  _inSession(sessionKey, fn) {
    this.sessionLocks = this.sessionLocks || new Map();
    const before = this.sessionLocks.get(sessionKey) || Promise.resolve();
    const run = before.then(fn);
    const done = run.catch(() => {});
    this.sessionLocks.set(sessionKey, done);
    done.then(() => {
      if (this.sessionLocks.get(sessionKey) === done) this.sessionLocks.delete(sessionKey);
    });
    return run;
  }

  /**
   * Search the library (and any enabled streaming services) for tracks.
   * Returns raw browse Items; item_key values are only valid for as long as
   * this session key has not been re-used for another search. Returns null
   * when a newer search from the same guest came in while this one waited or
   * ran: the guest has typed on, and only the latest is worth running or
   * showing.
   */
  search(sessionKey, query, limit = 40) {
    this.latestSearch = this.latestSearch || new Map();
    const ticket = (this.latestSearch.get(sessionKey) || 0) + 1;
    this.latestSearch.set(sessionKey, ticket);
    const latest = () => this.latestSearch.get(sessionKey) === ticket;
    const run = this._inSession(sessionKey, async () => {
      if (!latest()) return null;
      const items = await this._search(sessionKey, query, limit);
      // Overtaken while it ran: the page will show the newer one's results, so
      // these aren't offered to the guest.
      return latest() ? items : null;
    });
    run.then((items) => items && this.artKeys.note(items), () => {});
    // Kept only while a search waits, so the map holds no more than are running.
    const done = () => {
      if (this.latestSearch.get(sessionKey) === ticket) this.latestSearch.delete(sessionKey);
    };
    run.then(done, done);
    return run;
  }

  /** A guest's session ended: forget what was kept for it. */
  forgetSession(sessionKey) {
    this.profileSessions.delete(sessionKey);
    if (this.latestSearch) this.latestSearch.delete(sessionKey);
  }

  async _search(sessionKey, query, limit) {
    const outputId = this.settings.zone && this.settings.zone.output_id;
    if (!outputId) throw new Error('no_zone');
    await this._profileFor(sessionKey);

    const result = await this._openSearch(sessionKey, outputId, query);
    if (!result || result.action !== 'list') return [];

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
      // Tracks open an action list; anything else (a category) is not a track.
      return page.items.filter((item) => item.item_key && item.hint === 'action_list');
    }

    return page.items
      .filter((item) => item.item_key && item.hint !== 'header' && item.hint !== 'list')
      .slice(0, limit);
  }

  /**
   * Run a search through Library → Search in the browse hierarchy. Library is
   * found as the top-level entry holding a search box, so the wording doesn't
   * matter. Logs the result categories once, to check what the search covers.
   */
  async _openSearch(sessionKey, outputId, query) {
    const at = { hierarchy: HIERARCHY, multi_session_key: sessionKey, zone_or_output_id: outputId };
    const library = await openTopEntry(
      (o) => this._browse(o),
      (o) => this._load(o),
      at,
      (items) => items.some(isSearchBox),
      this.browseTitles.library,
      false
    );
    if (!library) throw new Error('no_search');
    this.browseTitles.library = library.title;
    const box = library.items.find(isSearchBox);
    const result = await this._browse(Object.assign({ item_key: box.item_key, input: query }, at));
    if (debugEnabled() && !this.loggedCategories && result && result.action === 'list') {
      this.loggedCategories = true;
      const page = await this._load({ hierarchy: HIERARCHY, multi_session_key: sessionKey, offset: 0, count: 20 });
      debug(`Search (${library.title} → ${box.title}) result categories: ${(page.items || []).map((i) => i.title).join(', ')}`);
    }
    return result;
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
  performAction(sessionKey, itemKey, mode) {
    return this._inSession(sessionKey, () => this._performAction(sessionKey, itemKey, mode));
  }

  async _performAction(sessionKey, itemKey, mode) {
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
    // A radio station plays outside the queue and never ends: the track waits
    // until the host plays the queue in Roon, and pressing play would only
    // resume the station.
    if (mode !== 'now' && !isStation(this.zone)) await this._resumePlayback();
    return true;
  }

  /**
   * Queue and Add Next leave a paused or stopped zone as it is, so a song
   * requested once the queue has run out would never play. Press play after
   * them; Roon handles requests in order, so the new track is already queued.
   * Never fails the request: the song is queued either way.
   */
  _resumePlayback(reason = 'a request') {
    const zone = this.zone;
    if (!zone || !this.transport || zone.state === 'playing' || zone.state === 'loading') {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.transport.control(zone, 'play', (err) => {
        if (err) console.warn(`Could not start playback for ${reason}: ${err}`);
        else console.log(`Started playback in "${zone.display_name}" for ${reason}`);
        resolve();
      });
    });
  }

  /**
   * Paused and off both stop the music along with the requests. Back on from
   * paused picks the music up where it was; back on from off is a new party,
   * so it waits for the host or the first request.
   */
  async _partyModeChanged(previous, mode) {
    if (mode !== 'on' && previous === 'on') await this._pausePlayback();
    if (mode === 'on' && previous === 'paused' && this.zone && this.zone.is_play_allowed) {
      await this._resumePlayback('party mode');
    }
    this._announceMode();
  }

  _pausePlayback() {
    const zone = this.zone;
    if (!zone || !this.transport || zone.state !== 'playing') return Promise.resolve();
    return new Promise((resolve) => {
      this.transport.control(zone, 'pause', (err) => {
        if (err) console.warn(`Could not pause for party mode: ${err}`);
        else console.log(`Paused "${zone.display_name}" for party mode`);
        resolve();
      });
    });
  }

  skip() {
    return new Promise((resolve, reject) => {
      if (!this.zone) return reject(new Error('no_zone'));
      if (isStation(this.zone)) return reject(new Error('station'));
      if (!this.zone.is_next_allowed) return reject(new Error('skip_not_allowed'));
      this.transport.control(this.zone, 'next', (err) =>
        err ? reject(new Error(err)) : resolve(true)
      );
    });
  }

  getImage(imageKey, size, timeoutMs = IMAGE_TIMEOUT_MS) {
    if (!this.artKeys.use(imageKey)) return Promise.reject(new Error('unknown_image'));
    return this.artCache.get(`${imageKey}|${size}`, () => {
      const image = new Promise((resolve, reject) => {
        if (!this.imageSvc) return reject(new Error('no_core'));
        this.imageSvc.get_image(
          imageKey,
          { scale: 'fit', width: size, height: size, format: 'image/jpeg' },
          (err, contentType, body) =>
            err ? reject(new Error(err)) : resolve({ contentType, body })
        );
      });
      return withTimeout(image, timeoutMs);
    });
  }

  // ---------------------------------------------------------------- settings

  _layout(values) {
    const settings = Object.assign({}, DEFAULT_SETTINGS, values);
    delete settings.guest_host; // removed setting, may linger in old config.json
    const layout = [];
    let hasError = false;

    // The switch a host uses most, so it comes first. Stored as "enabled", the
    // name it had as "Guest access", so saved settings carry over.
    // Roon settings have no buttons, so the choices read as what picking them
    // does from the mode the party is in now (the saved one, not the one being
    // picked): Pause while on, Unpause while paused, a new party while off.
    layout.push({
      type: 'dropdown',
      title: 'Party mode',
      values: partyModeChoices(partyMode(this.settings)),
      setting: 'enabled'
    });
    settings.enabled = { on: true, paused: 'paused', off: false }[partyMode(settings)];

    // Set once, at setup: in a group that starts closed, so Party mode is what
    // a host sees on opening the settings.
    const party = [];
    // The picker lists outputs (endpoints), not zones, so the endpoint chosen
    // here may belong to a grouped zone that plays to several speakers. The
    // title says which zone it resolves to, so that is visible when choosing.
    const resolved = this._resolveZone(settings.zone);
    const zoneItem = {
      type: 'zone',
      title: describeZone(settings.zone, resolved),
      setting: 'zone'
    };
    // A red box while it needs the host: none picked, or the zone gone past the
    // hold's wait (so a moment's absence doesn't flash it). The hint says what
    // to do; the error is a zero-width space, so Roon draws the box with no text
    // against it (Roon's hints can't be coloured). Not an error that stops a
    // save: the host may still want to pause the party meanwhile.
    const needsHost = (zoneSetting) =>
      !(zoneSetting && zoneSetting.output_id) || (!this._resolveZone(zoneSetting) && this.zoneHold);
    if (!(settings.zone && settings.zone.output_id)) {
      zoneItem.subtitle = 'Pick the zone the party plays in';
      zoneItem.error = '\u200b';
    } else if (needsHost(settings.zone)) {
      zoneItem.subtitle = 'Turn it on in Roon, or pick another';
      zoneItem.error = '\u200b';
    } else {
      zoneItem.subtitle = 'The zone the party plays in';
    }
    party.push(zoneItem);
    // The Party group starts open while the saved zone needs the host. The
    // saved one, not the one being picked: Roon rebuilds the layout on every
    // change, and the group shouldn't fold away under the host's hand.
    const partyOpen = needsHost((this.settings || settings).zone);

    // Next to the zone: both set how the party plays in Roon, once.
    // Profiles are stored by name: browse keys for them expire.
    // Unset, guests play under the profile Roon gives new sessions, named when known.
    const roonDefault = this.defaultProfile ? `Roon's default (${this.defaultProfile})` : "Roon's default profile";
    const profileValues = [{ title: roonDefault, value: '' }];
    for (const name of this.profiles || []) profileValues.push({ title: name, value: name });
    if (settings.guest_profile && !profileValues.some((v) => v.value === settings.guest_profile)) {
      const missing = (this.profiles || []).length ? ' (not found)' : '';
      profileValues.push({ title: `${settings.guest_profile}${missing}`, value: settings.guest_profile });
    }
    const profileItem = {
      type: 'dropdown',
      title: 'Roon profile',
      values: profileValues,
      setting: 'guest_profile'
    };
    profileItem.subtitle = this.profileProblem || "The Roon profile guests' tracks play under,\nand count toward";
    party.push(profileItem);

    party.push({
      type: 'string',
      title: 'Name',
      subtitle: settings.zone && settings.zone.output_id
        ? `Leave blank to use the zone name: ${clip(partyName({ zone: settings.zone }, this._resolveZone(settings.zone)))}`
        : 'Leave blank to use the party zone\'s name',
      setting: 'party_name'
    });

    // A name for the host's own tracks and skips, in place of "Host". Two lines,
    // so the hint doesn't widen Roon's settings page.
    const hostItem = {
      type: 'string',
      title: 'Host name',
      subtitle: "Shown on tracks you queue or skip in Roon.\nLeave blank for \"Host\" in each guest's language.",
      setting: 'host_name'
    };
    // As long as a guest's name may be, rather than cut short without a word.
    if (nameTooLong(settings.host_name)) {
      hostItem.error = `${NAME_LENGTH} characters max`;
      hasError = true;
    }
    party.push(hostItem);

    // Guests pass the party on by showing the join code from their phone.
    party.push({
      type: 'dropdown',
      title: 'Invites',
      subtitle: 'Guests can tap the party name to share the QR code',
      values: [
        { title: 'On', value: true },
        { title: 'Off', value: false }
      ],
      setting: 'guest_invite'
    });

    // The Party Hub's language, for a screen whose browser can't easily be set.
    // Language names in their own language, as on the guest page's list.
    if (!i18n.languages().includes(settings.hub_language)) settings.hub_language = '';
    party.push({
      type: 'dropdown',
      title: 'Party Hub language',
      // Two lines, so the hint doesn't widen Roon's settings page.
      subtitle: "Automatic follows the Party Hub screen's browser.\nGuests' phones always follow their own.",
      values: [
        { title: 'Automatic', value: '' },
        ...i18n.list().map((language) => ({ title: language.name, value: language.code }))
      ],
      setting: 'hub_language'
    });

    // What the Party Hub shows for the playlist once requests close. Only
    // the display: the download address works whatever is chosen.
    party.push({
      type: 'dropdown',
      title: 'Playlist',
      subtitle:
        'On the Party Hub when Party mode is Off' +
        // Its own line, like the status line's links, so the address stands out.
        (this.playlistUrl ? `\nAlways downloadable at\n${this.playlistUrl}` : ''),
      values: [
        { title: 'QR code — guests can scan it', value: 'qr' },
        { title: 'Link only — click it on the Party Hub', value: 'link' },
        { title: 'Off — not shown', value: 'off' }
      ],
      setting: 'playlist_download'
    });
    layout.push({ type: 'group', title: 'Party', collapsable: !partyOpen, items: party });
    settings.playlist_download = playlistDisplay(settings);

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
    const refill = (setting, title = 'Minutes to earn one back') =>
      integer(setting, title, 0, 1440, 0, { subtitle: '0 = never' });

    layout.push({
      type: 'group',
      // What guests may do, and how often: adding, playing next and skipping.
      title: 'Guest requests',
      collapsable: true,
      items: [
        // First: it applies to both ways of adding.
        {
          type: 'dropdown',
          title: 'Block tracks already in the queue',
          values: [
            { title: 'Yes', value: true },
            { title: 'No', value: false }
          ],
          setting: 'prevent_duplicates'
        },
        {
          type: 'dropdown',
          // Named after the guest page's buttons, as are the counts.
          title: 'Add to queue',
          values: [
            { title: 'Yes', value: true },
            { title: 'No', value: false }
          ],
          setting: 'allow_add'
        },
        perGuest('add_limit', '"Add to queue" per guest'),
        refill('add_refill'),
        // Its own choice: a host can allow either way of adding, or both.
        {
          type: 'dropdown',
          title: 'Play it next',
          subtitle: 'Each one plays before earlier requests',
          values: [
            { title: 'Yes', value: true },
            { title: 'No', value: false }
          ],
          setting: 'allow_next'
        },
        perGuest('next_limit', '"Play it next" per guest'),
        // Each refill sits under its own count, so "one" is clear in each.
        refill('next_refill'),
        // Independent too: a host can let guests only skip, as a veto.
        {
          type: 'dropdown',
          title: 'Skip tracks',
          subtitle: 'Skips the track playing now, for everyone',
          values: [
            { title: 'Yes', value: true },
            { title: 'No', value: false }
          ],
          setting: 'allow_skip'
        },
        perGuest('skip_limit', '"Skip" per guest'),
        refill('skip_refill')
      ]
    });

    // Roon's menu names, found automatically (see lib/titles.js); a field only
    // matters if that fails on a Core in another language.
    const menuNames = MENU_NAMES.map(([setting, key, title, english]) => {
      const found = this.detected && this.detected[key];
      return {
        type: 'string',
        title,
        // Why these exist is said once, in the heading above them.
        subtitle: found ? `Found "${found}" on your Core` : `"${english}" in English`,
        setting
      };
    });

    layout.push({
      type: 'group',
      // Settings that rarely need changing, in one group that starts closed,
      // with a sub-heading (a label) for each kind: Roon has no group within a group.
      title: 'Advanced',
      collapsable: true,
      // The hint goes on each field: a group heading may not show one.
      items: [
        // First, with no heading: the one a host turns on and off again.
        {
          type: 'dropdown',
          title: 'Detailed log',
          subtitle: "For troubleshooting. It logs everything,\nincluding guests' searches,\nso turn it off when you're done",
          values: [
            { title: 'On', value: true },
            { title: 'Off', value: false }
          ],
          setting: 'detailed_log'
        },
        // Rarely changed: whose names the playlist file carries.
        {
          type: 'dropdown',
          title: 'Hide names in downloadable playlist',
          subtitle: 'Replace guest names with Anon',
          values: [
            { title: 'Yes', value: true },
            { title: 'No', value: false }
          ],
          setting: 'playlist_hide_names'
        },
        // How phones reach Party Mode.
        { type: 'label', title: 'Network' },
        integer('port', 'Web port', 1, 65535, null, {
          subtitle:
            'Custom port for Party Mode\n' +
            'Changing it moves the guest pages\n' +
            'and the Party Hub to the new port'
        }),
        ...requestLimitItems(settings, integer, Boolean(this.limitsFromEnv)),
        // Found automatically, so filled in only when that fails.
        {
          type: 'label',
          title: 'Roon menu names',
          subtitle:
            'Party Mode normally finds these itself.\n' +
            'Change them only if search or adding tracks fails\n' +
            'on a Core that is not in English'
        },
        ...menuNames
      ]
    });

    return { values: settings, layout, has_error: hasError };
  }
}

const MAX_ZONE_NAME = 48;

/**
 * Requests a minute per device (by IP address): all requests, and searches,
 * which reach the Core. The default is far above what a phone or the Party Hub
 * sends, with room for guest Wi-Fi that puts several phones behind one address.
 * Custom takes any numbers, 0 for no limit.
 */
const REQUEST_LIMIT_PRESETS = {
  default: { all: DEFAULT_RATE_LIMIT, search: DEFAULT_SEARCH_LIMIT }
};

/** Choices saved by early 1.4.0 builds, as the settings they now are. */
const OLD_REQUEST_LIMITS = {
  normal: { request_limits: 'default' },
  shared: { request_limits: 'custom', rate_limit: 6000, search_limit: 600 },
  off: { request_limits: 'custom', rate_limit: 0, search_limit: 0 }
};
const MAX_RATE_LIMIT = 1000000;

/** The limits the settings ask for: a preset's, or the custom numbers. */
function requestLimits(settings) {
  const preset = REQUEST_LIMIT_PRESETS[settings.request_limits];
  if (preset) return Object.assign({}, preset);
  return { all: Number(settings.rate_limit) || 0, search: Number(settings.search_limit) || 0 };
}

/** Settings showing the given limits: the preset they match, else custom. */
function requestLimitSettings(limits) {
  const name = Object.keys(REQUEST_LIMIT_PRESETS).find((key) => {
    const preset = REQUEST_LIMIT_PRESETS[key];
    return preset.all === limits.all && preset.search === limits.search;
  });
  return { request_limits: name || 'custom', rate_limit: limits.all, search_limit: limits.search };
}

// What a change to Flood protection compares.
const limitsKey = (settings) => [settings.request_limits, settings.rate_limit, settings.search_limit].join('|');

/**
 * The Flood protection fields: the choice, with a hint giving its numbers, and
 * for Custom two number fields. The default keeps the numbers in step with it, so
 * choosing Custom starts from the limits in force.
 */
function requestLimitItems(settings, integer, fromEnv) {
  const old = OLD_REQUEST_LIMITS[settings.request_limits];
  if (old) Object.assign(settings, old);
  if (settings.request_limits !== 'custom' && !REQUEST_LIMIT_PRESETS[settings.request_limits]) {
    settings.request_limits = 'default';
  }
  const preset = REQUEST_LIMIT_PRESETS[settings.request_limits];
  if (preset) {
    settings.rate_limit = preset.all;
    settings.search_limit = preset.search;
  }
  const numbers = ({ all, search }) => `Up to ${all} page loads and ${search} searches\na minute from each IP address`;
  const hint = {
    default: numbers(REQUEST_LIMIT_PRESETS.default),
    custom: fromEnv ? 'Set by the environment until you change them here' : 'Your own limits, below'
  }[settings.request_limits];
  const items = [
    {
      type: 'dropdown',
      title: 'Flood protection',
      subtitle: fromEnv && preset ? `${hint}\nSet by the environment until you change it here` : hint,
      values: [
        { title: 'Default', value: 'default' },
        { title: 'Custom', value: 'custom' }
      ],
      setting: 'request_limits'
    }
  ];
  if (!preset) {
    items.push(
      integer('rate_limit', 'Page loads a minute per IP address', 0, MAX_RATE_LIMIT, 0, {
        subtitle: 'Pages, album art and updates\n0 = no limit'
      }),
      integer('search_limit', 'Searches a minute per IP address', 0, MAX_RATE_LIMIT, 0, { subtitle: '0 = no limit' })
    );
  }
  return items;
}

// The status line's first line while the detailed log is on, so it isn't
// forgotten. Not red: Roon can only colour the whole status, and red is for
// real problems.
const DETAILED_LOG_WARNING = "Detailed log is on (includes guests' searches): turn it off when done";

/** The settings Roon was refused for, as "Host name: 24 characters max". */
function settingErrors(layout) {
  return layout
    .flatMap((item) => (item.type === 'group' ? item.items : [item]))
    // The zone's red box isn't why a save failed.
    .filter((item) => item.error && item.type !== 'zone')
    .map((item) => `${item.title}: ${item.error}`)
    .join('; ');
}

/**
 * The detailed log after the host saves the settings. Only a change to the
 * switch counts: saving other settings keeps it as it is, and doesn't save an
 * "on" that came from ROON_EXTENSION_PARTY_MODE_DEBUG. Turned off, it stays off
 * until the next restart, when the environment variable (if set) turns it on again.
 *
 * @param {boolean} shown - on now, as the settings window showed it
 * @param {boolean} wanted - the switch as saved
 * @param {boolean} saved - the host's choice in config.json
 * @returns {{on: boolean, saved: boolean}}
 */
function detailedLogAfterSave(shown, wanted, saved) {
  wanted = Boolean(wanted);
  if (wanted === Boolean(shown)) return { on: Boolean(shown), saved: Boolean(saved) };
  return { on: wanted, saved: wanted };
}

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
 * The folder config.json is really saved in: the one its link points into (in
 * the image, /data), or the working directory. The folder to fix when it can't
 * be written.
 */
function configFolder(file = 'config.json') {
  const path = require('path');
  let target = path.resolve(file);
  try {
    target = path.resolve(path.dirname(target), fs.readlinkSync(file));
  } catch (err) {
    // not a link
  }
  return path.dirname(target);
}

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
  // Missing: it gets created. In the image config.json links to /data, and an
  // empty folder mounted there (a NAS folder, say) has no file yet, so the one
  // that counts is the folder the link points into.
  try {
    fs.accessSync(configFolder(file), fs.constants.W_OK);
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
  // In the Party group, so no "Party" in front.
  const title = 'Zone';
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
 * isn't available, then to `fallback`: "Party" for Roon's status line, which
 * stays in English, or '' for the pages, which say it in the guest's language.
 */
function partyName(settings, zone, fallback = 'Party') {
  const typed = String((settings && settings.party_name) || '').trim();
  if (typed) return typed;
  if (zone && zone.display_name) return zone.display_name;
  if (settings && settings.zone && settings.zone.name) return settings.zone.name;
  return fallback;
}

function clip(text) {
  const value = String(text || '');
  return value.length > MAX_ZONE_NAME ? `${value.slice(0, MAX_ZONE_NAME - 1)}…` : value;
}

module.exports = { RoonService, DEFAULT_SETTINGS, MENU_NAMES, isStation, describeZone, normaliseInteger, partyName, partyMode, partyModeChoices, extensionIdentity, statusText, playlistDisplay, configWritable, configFolder, detailedLogAfterSave, DETAILED_LOG_WARNING, settingErrors, REQUEST_LIMIT_PRESETS, requestLimits, requestLimitSettings };
