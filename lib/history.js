'use strict';

const { attributionKey } = require('./guests');

const MAX_PLAYED = 200;

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
   * @returns {boolean} whether the played list changed
   */
  update(zoneId, playing, credit) {
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

    const key = attributionKey(playing.title, playing.artist);
    if (this.current && this.current.key === key) return false;

    const previous = this.current;
    this.current = {
      key,
      title: playing.title,
      artist: playing.artist,
      image_key: playing.image_key,
      requested_by: credit ? credit.requested_by : null,
      kind: credit ? credit.kind : null,
      played_at: Date.now()
    };
    if (!previous) return false;

    this.played.unshift(previous);
    this.played.length = Math.min(this.played.length, MAX_PLAYED);
    return true;
  }

  list() {
    return this.played.map(({ key, ...track }) => track);
  }
}

module.exports = { PlayHistory };
