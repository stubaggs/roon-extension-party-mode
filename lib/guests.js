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

const crypto = require('crypto');

const {
  LENGTH_TOLERANCE,
  artistSet,
  artistsAgree,
  looseTitle,
  seconds,
  trackHash,
  versionTitle
} = require('./track-id');

const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours, refreshed on use
const ATTRIBUTION_TTL_MS = 6 * 60 * 60 * 1000;

const BUCKETS = ['add', 'next', 'skip'];

function now() {
  return Date.now();
}

/**
 * In-memory guest state. Everything here is deliberately ephemeral: when the
 * extension restarts the party starts over.
 */
class GuestStore {
  constructor() {
    this.sessions = new Map();
    this.joinCode = this._newCode();
    this.attributions = [];
    setInterval(() => this._sweep(), 60 * 1000).unref();
  }

  _newCode() {
    return crypto.randomBytes(9).toString('base64url');
  }

  rotateJoinCode() {
    this.joinCode = this._newCode();
    return this.joinCode;
  }

  /** Invalidate every guest session, e.g. when the host turns access off. */
  clear() {
    this.sessions.clear();
    this.attributions = [];
  }

  create() {
    const id = crypto.randomBytes(18).toString('base64url');
    const session = {
      id,
      name: '',
      created: now(),
      seen: now(),
      buckets: {}
    };
    for (const bucket of BUCKETS) {
      session.buckets[bucket] = { tokens: null, updated: now() };
    }
    this.sessions.set(id, session);
    return session;
  }

  get(id) {
    if (!id) return null;
    const session = this.sessions.get(id);
    if (!session) return null;
    if (now() - session.seen > SESSION_TTL_MS) {
      this.sessions.delete(id);
      return null;
    }
    session.seen = now();
    return session;
  }

  _refill(session, bucket, limit, refillMinutes) {
    const state = session.buckets[bucket];
    if (state.tokens === null) state.tokens = limit;
    if (!refillMinutes || state.tokens >= limit) {
      state.tokens = Math.min(state.tokens, limit);
      return state;
    }
    const interval = refillMinutes * 60 * 1000;
    const earned = Math.floor((now() - state.updated) / interval);
    if (earned > 0) {
      state.tokens = Math.min(limit, state.tokens + earned);
      state.updated += earned * interval;
    }
    return state;
  }

  /** Returns { allowed, remaining, nextIn } without consuming anything. */
  check(session, bucket, settings) {
    const limit = settings[`${bucket}_limit`];
    const refill = settings[`${bucket}_refill`];
    const allowedByHost = settings[`allow_${bucket}`];

    if (!allowedByHost) return { allowed: false, remaining: 0, nextIn: null, reason: 'disabled' };
    if (!limit) return { allowed: true, remaining: null, nextIn: null };

    const state = this._refill(session, bucket, limit, refill);
    if (state.tokens > 0) return { allowed: true, remaining: state.tokens, nextIn: null };

    const interval = (refill || 0) * 60 * 1000;
    const nextIn = interval ? Math.max(0, state.updated + interval - now()) : null;
    return { allowed: false, remaining: 0, nextIn, reason: 'rate_limited' };
  }

  consume(session, bucket, settings) {
    const status = this.check(session, bucket, settings);
    if (!status.allowed) return status;
    const limit = settings[`${bucket}_limit`];
    if (!limit) return status;

    const state = session.buckets[bucket];
    if (state.tokens === limit) state.updated = now();
    state.tokens -= 1;
    return { allowed: true, remaining: state.tokens, nextIn: null };
  }

  allowances(session, settings) {
    const out = {};
    for (const bucket of BUCKETS) {
      out[bucket] = this.check(session, bucket, settings);
    }
    return out;
  }

  /**
   * Record that a guest asked for a track.
   *
   * At this point only the search result's title and subtitle are known: a
   * browse item carries no length, so there is nothing to fingerprint yet. The
   * entry is returned so the caller can bind it to the real queue item once
   * Roon reports the insert, which is where the length and hash come from.
   *
   * @param {{title: string, artist: string}} track
   * @returns {object} the attribution entry
   */
  attribute(session, track, kind) {
    const entry = {
      queueItemId: null,
      hash: null,
      length: null,
      versions: new Set([versionTitle(track.title)]),
      looses: new Set([looseTitle(track.title)]),
      artists: artistSet(track.artist),
      title: track.title,
      artist: track.artist,
      name: session.name,
      kind,
      at: now()
    };
    this.attributions.unshift(entry);
    this.attributions = this.attributions.slice(0, 400);
    return entry;
  }

  /**
   * Tie a recorded request to the queue item Roon actually created for it.
   *
   * This is what makes attribution exact rather than a guess: the queue item id
   * identifies that entry for as long as it is queued, and its length completes
   * the fingerprint that survives the item leaving the queue. The queue's own
   * spelling is folded in too, since now-playing text comes from that side.
   *
   * @param {object} entry - from attribute()
   * @param {{id: string, title: string, artist: string, length: number|null}} item
   */
  bind(entry, item) {
    entry.queueItemId = item.id || null;
    entry.length = seconds(item.length);
    entry.hash = trackHash(item);
    entry.versions.add(versionTitle(item.title));
    entry.looses.add(looseTitle(item.title));
    for (const name of artistSet(item.artist)) entry.artists.add(name);
    return entry;
  }

  /**
   * Who asked for a track, most reliable signal first:
   *
   *   1. the queue item id, when the track is still queued  - exact
   *   2. the hash of title, artists and length              - exact recording
   *   3. same recording by version-sensitive title          - handles respellings
   *   4. same song ignoring version tags, artists agreeing  - best effort
   *   5. a title only one recent request has                - last resort
   *
   * Steps 4 and 5 deliberately collapse different versions of a song. That is
   * acceptable for a badge and wrong for duplicate checking, which is why
   * duplicates use sameRecording directly instead of this.
   *
   * @param {{id?: string, title: string, artist: string, length?: number|null}} track
   */
  lookup(track) {
    if (!track) return null;

    if (track.id) {
      const byId = this.attributions.find((entry) => entry.queueItemId === track.id);
      if (byId) return byId;
    }

    const hash = trackHash(track);
    if (hash) {
      const byHash = this.attributions.find((entry) => entry.hash === hash);
      if (byHash) return byHash;
    }

    const version = versionTitle(track.title);
    if (version) {
      const byVersion = this.attributions.find(
        (entry) =>
          entry.versions.has(version) &&
          artistsAgree([...entry.artists].join(','), track.artist) &&
          lengthsAgree(entry.length, track.length)
      );
      if (byVersion) return byVersion;
    }

    const loose = looseTitle(track.title);
    if (!loose) return null;
    const sameSong = this.attributions.filter((entry) => entry.looses.has(loose));
    const byArtist = sameSong.find((entry) =>
      artistsAgree([...entry.artists].join(','), track.artist)
    );
    if (byArtist) return byArtist;
    const requesters = new Set(sameSong.map((entry) => `${entry.name}|${entry.kind}`));
    return requesters.size === 1 ? sameSong[0] : null;
  }

  _sweep() {
    const cutoff = now() - SESSION_TTL_MS;
    for (const [id, session] of this.sessions) {
      if (session.seen < cutoff) this.sessions.delete(id);
    }
    const attrCutoff = now() - ATTRIBUTION_TTL_MS;
    this.attributions = this.attributions.filter((entry) => entry.at > attrCutoff);
  }
}

/** Two known lengths must agree; an unknown one can't rule anything out. */
function lengthsAgree(a, b) {
  const left = seconds(a);
  const right = seconds(b);
  if (!left || !right) return true;
  return Math.abs(left - right) <= LENGTH_TOLERANCE;
}

module.exports = { GuestStore };
