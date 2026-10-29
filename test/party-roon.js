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

// A stand-in for Roon as the web server reads it, playing a party: for the
// page tests (test/pages.test.js, test/browsers.js). Only what lib/server.js
// uses: settings, the zone and its queue, search, requests and skips, and
// the events that make the server tell open pages.

const EventEmitter = require('events');
const { DEFAULT_SETTINGS } = require('../lib/roon-service');

function partyRoon() {
  const searchResults = [
    { item_key: '10:0', title: 'Waterloo', subtitle: 'ABBA', hint: 'action_list' },
    { item_key: '10:1', title: 'SOS', subtitle: 'ABBA', hint: 'action_list' }
  ];
  const roon = Object.assign(new EventEmitter(), {
    settings: Object.assign({}, DEFAULT_SETTINGS, { port: 0 }),
    queue: [],
    zone: null,
    ready: true,
    pageName: 'Garden Party',
    actions: [],
    skips: 0,
    radioPicks: new Set(),
    isRadioPick(id) {
      return this.radioPicks.has(id);
    },
    async search() {
      return searchResults;
    },
    async performAction(session, key, mode) {
      this.actions.push({ key, mode });
    },
    async skip() {
      this.skips += 1;
    }
  });

  const track = (id, title, artist, album = '', extra = {}) =>
    Object.assign({ queue_item_id: id, three_line: { line1: title, line2: artist, line3: album }, length: 200 + id, image_key: `art-${id}` }, extra);

  // Each test plays in a zone of its own, so Played starts empty (lib/history.js
  // keeps the last track while a zone is away).
  let zoneCount = 0;

  /** Roon playing `playing` (a queue item, or null), with `upcoming` queued after it. */
  function play(playing, upcoming = [], zone = {}) {
    roon.zone = playing
      ? Object.assign(
          { zone_id: `z${zoneCount}`, state: 'playing', is_next_allowed: true, settings: { auto_radio: false }, now_playing: { three_line: playing.three_line, image_key: playing.image_key, length: playing.length } },
          zone
        )
      : null;
    roon.queue = playing ? [playing, ...upcoming] : upcoming;
    roon.emit('now_playing_changed');
    roon.emit('queue_changed');
  }
  const set = (values) => {
    Object.assign(roon.settings, values);
    roon.emit('settings_changed', roon.settings);
  };
  function reset() {
    Object.assign(roon.settings, DEFAULT_SETTINGS, { port: 0, enabled: true, allow_add: true, allow_next: true, allow_skip: true, add_limit: 0, next_limit: 0, skip_limit: 0 });
    roon.actions = [];
    roon.skips = 0;
    delete roon.currentMode;
    zoneCount += 1;
    play(null);
    // A new party: an empty Played.
    roon.emit('party_mode_changed', 'on', 'off');
  }

  return { roon, searchResults, track, play, set, reset };
}

module.exports = { partyRoon };
