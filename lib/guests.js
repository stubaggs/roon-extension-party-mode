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

// A guest is logged out after this long without using the page; any use starts it
// again, and renews the cookie (see requireGuest in lib/server.js).
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
// Far more than a party has guests; a script making sessions in a loop drops
// the longest-idle ones rather than filling memory.
const MAX_SESSIONS = 2000;
// Search results a guest may ask for, remembered per guest (see offer()).
const MAX_OFFERED = 400;
const NAME_LENGTH = 24;
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
    // Told each session id that ends, so what is kept per guest elsewhere goes with it.
    this.onDrop = () => {};
    setInterval(() => this._sweep(), 60 * 1000).unref();
  }

  _drop(id) {
    this.sessions.delete(id);
    this.onDrop(id);
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
    for (const id of [...this.sessions.keys()]) this._drop(id);
    this.attributions = [];
  }

  create() {
    if (this.sessions.size >= MAX_SESSIONS) this._dropIdlest();
    const id = crypto.randomBytes(18).toString('base64url');
    const session = {
      id,
      // Links this guest's tracks to them so a name given later reaches them.
      // Kept on the server: unlike id, which is the session cookie, it is safe
      // to hold on records, but it is still never sent to the pages.
      ref: crypto.randomBytes(9).toString('base64url'),
      name: '',
      created: now(),
      seen: now(),
      buckets: {},
      // Search results this guest was sent: item key -> { title, subtitle }.
      offered: new Map()
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
      this._drop(id);
      return null;
    }
    session.seen = now();
    return session;
  }

  _dropIdlest() {
    let idlest = null;
    for (const session of this.sessions.values()) if (!idlest || session.seen < idlest.seen) idlest = session;
    if (idlest) this._drop(idlest.id);
  }

  /**
   * Remember search results sent to a guest. A request is only taken for one
   * of these, with the title and artist the server sent rather than whatever
   * the phone says: a guest can't send another browse key (an album, a
   * playlist, a whole category) or pass one track off as another.
   */
  offer(session, items) {
    for (const item of items) {
      session.offered.delete(item.item_key);
      session.offered.set(item.item_key, {
        title: item.title || '',
        subtitle: item.subtitle || '',
        image_key: item.image_key || null
      });
    }
    while (session.offered.size > MAX_OFFERED) session.offered.delete(session.offered.keys().next().value);
  }

  /** The search result a guest asks for, or null if it was never sent to them. */
  offered(session, key) {
    return (typeof key === 'string' && session.offered.get(key)) || null;
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
    // Playing next is a way of adding, so it needs adding on too.
    const allowedByHost = settings[`allow_${bucket}`] && (bucket !== 'next' || settings.allow_add);

    if (!allowedByHost) return { allowed: false, remaining: 0, nextIn: null, reason: 'disabled' };
    if (!limit) return { allowed: true, remaining: null, nextIn: null };

    const state = this._refill(session, bucket, limit, refill);
    if (state.tokens > 0) return { allowed: true, remaining: state.tokens, nextIn: null };

    const interval = (refill || 0) * 60 * 1000;
    const nextIn = interval ? Math.max(0, state.updated + interval - now()) : null;
    return { allowed: false, remaining: 0, nextIn, reason: 'rate_limited' };
  }

  /**
   * Hand back an allowance taken for a request Roon then refused. Requests
   * take their allowance before asking Roon, so several sent at once can't
   * all pass the check before any is counted.
   */
  refund(session, bucket, settings) {
    const limit = settings[`${bucket}_limit`];
    if (!limit) return;
    const state = session.buckets[bucket];
    state.tokens = Math.min(limit, state.tokens + 1);
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
  /** A guest named themselves, or changed their name: their requests follow. */
  rename(session) {
    for (const entry of this.attributions) if (entry.guest === session.ref) entry.name = session.name;
  }

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
      guest: session.ref,
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
      if (session.seen < cutoff) this._drop(id);
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

/**
 * A guest's name as it is kept and shown: control characters (line breaks
 * would fake lines in the log) and direction overrides (which can show a
 * name back to front) removed, spaces collapsed, at most 24 characters,
 * counted so an emoji is never cut in half.
 */
function cleanName(value) {
  const text = String(value == null ? '' : value)
    .replace(/[\p{Cc}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(text).slice(0, NAME_LENGTH).join('').trim();
}

module.exports = { GuestStore, cleanName, MAX_SESSIONS, SESSION_TTL_MS };
