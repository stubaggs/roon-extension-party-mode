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

/**
 * A stand-in for a Roon Core's "browse" hierarchy, shaped like a real one:
 *
 *   Library → Search (takes input) → result categories → tracks → actions
 *   Settings → Profile (subtitle: the session's profile) → profiles
 *
 * Each multi_session_key is its own session with its own position and profile,
 * as on a real Core. Records what happened as "<session>:<event>" in `events`:
 * "profile Party", "search abba", "press Queue".
 */
function fakeBrowseCore(options = {}) {
  const o = Object.assign(
    {
      library: 'Library',
      settings: 'Settings',
      profileEntry: 'Profile',
      search: 'Search',
      profiles: ['Stu', 'Party'],
      current: 'Guest',
      categories: {},
      actions: ['Play Now', 'Add Next', 'Queue', 'Start Radio']
    },
    options
  );
  const sessions = {};
  const events = [];
  const session = (key) => sessions[key] || (sessions[key] = { path: [], profile: o.current });
  const categoryNames = () => Object.keys(o.categories);

  function itemsAt(s) {
    const level = s.path[s.path.length - 1];
    if (!level) {
      return [
        { title: o.library, item_key: 'lib', hint: 'list' },
        { title: 'Playlists', item_key: 'pl', hint: 'list' },
        { title: o.settings, item_key: 'set', hint: 'list' }
      ];
    }
    if (level === 'lib') {
      return [
        { title: o.search, item_key: 'search', hint: 'list', input_prompt: { prompt: o.search } },
        { title: 'Artists', item_key: 'artists', hint: 'list' }
      ];
    }
    if (level === 'pl') return [{ title: 'A playlist', item_key: 'pl1', hint: 'list' }];
    if (level === 'set') {
      return [
        { title: o.profileEntry, item_key: 'prof', hint: 'list', subtitle: s.profile },
        { title: 'Display Settings', item_key: 'disp', hint: 'list' }
      ];
    }
    if (level === 'prof') return o.profiles.map((title, i) => ({ title, item_key: `p${i}`, hint: 'action' }));
    if (level === 'results') return categoryNames().map((title, i) => ({ title, item_key: `c${i}`, hint: 'list' }));
    if (level.startsWith('c')) return o.categories[categoryNames()[Number(level.slice(1))]];
    if (level.startsWith('t')) return o.actions.map((title, i) => ({ title, item_key: `a${i}`, hint: 'action' }));
    return [];
  }

  const browse = async (opts) => {
    if (opts.hierarchy !== 'browse') throw new Error(`unexpected hierarchy ${opts.hierarchy}`);
    const key = opts.multi_session_key;
    const s = session(key);
    if (opts.pop_all) {
      s.path = [];
      return { action: 'list' };
    }
    if (opts.pop_levels) {
      s.path = s.path.slice(0, -opts.pop_levels);
      return { action: 'list' };
    }
    const item = opts.item_key;
    if (item === 'search') {
      events.push(`${key}:search ${opts.input}`);
      s.path = ['lib', 'results'];
      return { action: 'list' };
    }
    if (s.path[s.path.length - 1] === 'prof' && /^p\d+$/.test(item)) {
      s.profile = o.profiles[Number(item.slice(1))];
      events.push(`${key}:profile ${s.profile}`);
      return { action: 'list' }; // what a real Core answers
    }
    if (/^a\d+$/.test(item)) {
      events.push(`${key}:press ${o.actions[Number(item.slice(1))]}`);
      return { action: 'none' };
    }
    s.path.push(item);
    return { action: 'list' };
  };

  const load = async (opts) => {
    const s = session(opts.multi_session_key);
    const level = s.path[s.path.length - 1];
    return { list: { hint: level && level.startsWith('t') ? 'action_list' : null }, items: itemsAt(s) };
  };

  return { browse, load, events, profileOf: (key) => session(key).profile };
}

/** A RoonService wired to a fake Core, without a real connection. */
function serviceFor(core, settings = {}) {
  const { RoonService } = require('../lib/roon-service');
  const roon = Object.create(RoonService.prototype);
  roon.settings = Object.assign(
    {
      zone: { output_id: 'o1' },
      title_tracks: 'Tracks',
      title_add: 'Queue',
      title_next: 'Add Next',
      title_profile: 'Profile',
      guest_profile: ''
    },
    settings
  );
  roon.detected = {};
  roon.profileSessions = new Map();
  roon.browseTitles = {};
  roon.loggedCategories = true;
  roon.core = { services: { RoonApiBrowse: {} } };
  roon._browse = core.browse;
  roon._load = core.load;
  return roon;
}

module.exports = { fakeBrowseCore, serviceFor };
