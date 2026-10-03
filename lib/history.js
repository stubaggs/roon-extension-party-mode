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

const { identityKey, seconds } = require('./track-id');

const MAX_PLAYED = 200;
// Left this many seconds or more before its end, a track was skipped.
const SKIP_MARGIN = 10;

/**
 * Roon's API has no play history, so the extension keeps its own: each track
 * that starts playing is remembered, and moves into the played list when the
 * next one starts. Held in memory, so it starts over when the extension restarts
 * or the party zone changes.
 */
class PlayHistory {
  constructor() {
    this.zoneId = null;
    this.current = null;
    this.played = [];
  }

  /**
   * @param {string|null} zoneId - the party zone
   * @param {object|null} playing - the now-playing summary the pages get
   * @param {object|null} credit - { requested_by, kind } for who asked for it, if anyone
   * @param {object|null} [ended] - when the track changed, how far the one before
   *   got ({ title, artist, length, seek }); see RoonService._notePosition
   * @returns {boolean} whether the played list changed
   */
  update(zoneId, playing, credit, ended) {
    // Noted before anything else: the next track may still be loading.
    if (ended && this.current && identityKey(ended) === this.current.key) this.current.ended = ended;
    // No zone just means the Core is away for a moment; keep what we have.
    if (!zoneId) return false;
    if (zoneId !== this.zoneId) {
      const hadHistory = this.played.length > 0;
      this.zoneId = zoneId;
      this.current = null;
      this.played = [];
      if (hadHistory) return true;
    }
    if (!playing || playing.state !== 'playing') return false;

    // Includes the length, so a different version of a song counts as a change.
    const key = identityKey(playing);
    if (this.current && this.current.key === key) return false;

    const previous = this.current;
    this.current = {
      key,
      title: playing.title,
      artist: playing.artist,
      length: seconds(playing.length),
      image_key: playing.image_key,
      requested_by: credit ? credit.requested_by : null,
      kind: credit ? credit.kind : null,
      played_at: Date.now()
    };
    if (!previous) return false;

    // Left early with no guest skip to say who: someone skipped it in Roon.
    if (!previous.skipped && endedEarly(previous.ended)) {
      previous.skipped = true;
      previous.skipped_by = null;
      previous.skipped_in_roon = true;
    }
    delete previous.ended;
    this.played.unshift(previous);
    this.played.length = Math.min(this.played.length, MAX_PLAYED);
    return true;
  }

  /**
   * Note that a guest skipped the playing track, so Played can say who did.
   * Called before the skip reaches Roon, since the next track may start before
   * Roon answers; only marks the track if it is the one playing.
   * @param {object} playing - the now-playing summary the pages get
   * @param {string|null} by - the guest's name, or null for "a guest"
   * @returns {function} undo, for when the skip fails
   */
  markSkipped(playing, by) {
    const track = this.current;
    if (!track || !playing || track.key !== identityKey(playing)) return () => {};
    track.skipped = true;
    track.skipped_by = by || null;
    return () => {
      track.skipped = false;
      track.skipped_by = null;
    };
  }

  list() {
    return this.played.map(({ key, ...track }) => track);
  }
}

/** Only judged when Roon reported a length and at least one position. */
function endedEarly(ended) {
  return Boolean(ended && ended.length && ended.seek !== null && ended.seek < ended.length - SKIP_MARGIN);
}

module.exports = { PlayHistory, SKIP_MARGIN };
