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
const { MAX_TRACKS } = require('./party-playlist');

// A guest is logged out after this long without using the page; any use starts it
// again, and renews the cookie (see requireGuest in lib/server.js).
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
// Far more than a party has guests; a script making sessions in a loop drops
// the longest-idle ones rather than filling memory.
const MAX_SESSIONS = 2000;
// Searches whose results a guest may ask for, remembered per guest: the one on
// their screen and the one on its way (see offer()).
const OFFERED_SEARCHES = 2;
const NAME_LENGTH = 24;
// Who asked for a track is kept while it is queued, and this long after it
// last was; and only the newest MAX_ATTRIBUTIONS beyond those still queued, as
// many as the party playlist keeps. A day, because Roon reports only the first
// QUEUE_ITEMS of the queue: a request further back can't be seen to be queued
// until the tracks ahead of it have played.
const ATTRIBUTION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ATTRIBUTIONS = MAX_TRACKS;
// Credits remembered between changes: the queue, Played, and some to spare.
const MAX_FOUND = 2000;

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
    this.attributions = [];
    // The attributions by queue item id, hash and title keys (see _index), so a
    // lookup reads only the few that could match: every queue update credits
    // the whole queue, and a long queue on a Pi 1 can't afford a scan per track.
    this.index = new Map();
    this.seq = 0;
    // Each track's credit, as lookup() last found it, until the credits change:
    // every page load and queue update credits the whole queue again.
    this.found = new Map();
    // Told each session id that ends, so what is kept per guest elsewhere goes with it.
    this.onDrop = () => {};
    // The ids of the party zone's queue items, so a request still queued keeps its credit.
    this.queuedIds = () => new Set();
    setInterval(() => this._sweep(), 60 * 1000).unref();
  }

  _drop(id) {
    this.sessions.delete(id);
    this.onDrop(id);
  }

  /** Invalidate every guest session, e.g. when the host turns access off. */
  clear() {
    for (const id of [...this.sessions.keys()]) this._drop(id);
    for (const entry of this.attributions) entry.dropped = true;
    this.attributions = [];
    this.index = new Map();
    this.found.clear();
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
      // Search results this guest was sent, per search, oldest first (see
      // offer()): item key -> { title, subtitle, image_key }.
      offered: []
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
   *
   * Only the last two searches are kept: the page shows only its latest
   * search's results, and the server records only searches whose answer the
   * page will show (see RoonService.search), so these are the results on the
   * guest's screen and those on their way. A rerun of the search on screen
   * (see performWithRetry in lib/server.js) belongs to that search, and
   * replaces any earlier rerun of it.
   */
  offer(session, items, { rerun = false } = {}) {
    const results = new Map(items.map((item) => [item.item_key, {
      title: item.title || '',
      subtitle: item.subtitle || '',
      image_key: item.image_key || null
    }]));
    const latest = session.offered[session.offered.length - 1];
    if (rerun && latest) {
      latest.rerun = results;
      return;
    }
    session.offered.push({ shown: results, rerun: null });
    if (session.offered.length > OFFERED_SEARCHES) session.offered.shift();
  }

  /** The search result a guest asks for, or null if it was never sent to them. */
  offered(session, key) {
    if (typeof key !== 'string') return null;
    for (let i = session.offered.length - 1; i >= 0; i--) {
      const search = session.offered[i];
      const found = search.shown.get(key) || (search.rerun && search.rerun.get(key));
      if (found) return found;
    }
    return null;
  }

  _refill(session, bucket, limit, refillMinutes) {
    const state = session.buckets[bucket];
    if (state.tokens === null) {
      state.tokens = limit;
      state.limit = limit;
    } else if (state.limit !== limit) {
      // The host changed the allowance mid-party: what a guest has already
      // used still counts against the new one. 5 with one used is 9 of 10 or
      // 2 of 3, not left at 4. Lowered below what was used, it's none left,
      // with nothing owed.
      state.tokens = Math.max(0, Math.min(limit, state.tokens + limit - state.limit));
      state.limit = limit;
    }
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
  /**
   * Whether another guest's session already goes by this name, compared as
   * nameKey() compares them. A guest's own session never counts, but an older
   * one of theirs (from before a rescan) does: the page sends a remembered
   * name with `confirm`, so a returning guest isn't asked.
   */
  nameInUse(name, session) {
    const key = nameKey(name);
    if (!key) return false;
    for (const other of this.sessions.values()) {
      if (other !== session && nameKey(other.name) === key) return true;
    }
    return false;
  }

  /** A guest named themselves, or changed their name: their requests follow. */
  rename(session) {
    for (const entry of this.attributions) if (entry.guest === session.ref) entry.name = session.name;
    // A name can decide a credit (lookup's last step).
    this.found.clear();
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
      at: now(),
      seq: (this.seq += 1),
      keys: new Set()
    };
    this.attributions.unshift(entry);
    this._index(entry);
    this.found.clear();
    if (this.attributions.length > MAX_ATTRIBUTIONS) {
      const queued = this.queuedIds();
      let kept = 0;
      this._keep((entry) => queued.has(entry.queueItemId) || ++kept <= MAX_ATTRIBUTIONS);
    }
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
    this._unindex(entry);
    entry.queueItemId = item.id || null;
    entry.length = seconds(item.length);
    entry.hash = trackHash(item);
    entry.versions.add(versionTitle(item.title));
    entry.looses.add(looseTitle(item.title));
    for (const name of artistSet(item.artist)) entry.artists.add(name);
    // A request whose credit was already dropped (Party Off) stays dropped.
    if (!entry.dropped) this._index(entry);
    this.found.clear();
    return entry;
  }

  /** File an attribution under each key it can be found by. */
  _index(entry) {
    const keys = [
      entry.queueItemId && `id:${entry.queueItemId}`,
      entry.hash && `hash:${entry.hash}`,
      ...[...entry.versions].map((version) => version && `version:${version}`),
      ...[...entry.looses].map((loose) => loose && `loose:${loose}`)
    ].filter(Boolean);
    for (const key of keys) {
      if (!this.index.has(key)) this.index.set(key, new Set());
      this.index.get(key).add(entry);
      entry.keys.add(key);
    }
  }

  _unindex(entry) {
    for (const key of entry.keys) {
      const filed = this.index.get(key);
      if (!filed) continue;
      filed.delete(entry);
      if (!filed.size) this.index.delete(key);
    }
    entry.keys.clear();
  }

  /** Keep the attributions that pass, dropping the rest from the index too. */
  _keep(test) {
    this.attributions = this.attributions.filter((entry) => {
      if (test(entry)) return true;
      this._unindex(entry);
      entry.dropped = true;
      this.found.clear();
      return false;
    });
  }

  /** The attributions filed under a key, newest first, as the list is ordered. */
  _filed(key) {
    const filed = this.index.get(key);
    return filed ? [...filed].sort((a, b) => b.seq - a.seq) : [];
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
    const key = [track.id, track.title, track.artist, track.length].join('\u0000');
    if (this.found.has(key)) return this.found.get(key);
    const found = this._lookup(track);
    if (this.found.size >= MAX_FOUND) this.found.clear();
    this.found.set(key, found);
    return found;
  }

  _lookup(track) {
    if (track.id) {
      const [byId] = this._filed(`id:${track.id}`);
      if (byId) return byId;
    }

    const hash = trackHash(track);
    if (hash) {
      const [byHash] = this._filed(`hash:${hash}`);
      if (byHash) return byHash;
    }

    const version = versionTitle(track.title);
    if (version) {
      const byVersion = this._filed(`version:${version}`).find(
        (entry) =>
          artistsAgree([...entry.artists].join(','), track.artist) &&
          lengthsAgree(entry.length, track.length)
      );
      if (byVersion) return byVersion;
    }

    const loose = looseTitle(track.title);
    if (!loose) return null;
    const sameSong = this._filed(`loose:${loose}`);
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
    const queued = this.queuedIds();
    const attrCutoff = now() - ATTRIBUTION_TTL_MS;
    this._keep((entry) => {
      if (queued.has(entry.queueItemId)) entry.at = now();
      return entry.at > attrCutoff;
    });
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
  return Array.from(tidyName(value)).slice(0, NAME_LENGTH).join('').trim();
}

function tidyName(value) {
  return String(value == null ? '' : value)
    .replace(/[\p{Cc}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Whether cleanName() would cut `value` short. The guest page's box stops at
 * the limit; Roon's settings can't, so the Host name setting says so.
 */
function nameTooLong(value) {
  return Array.from(tidyName(value)).length > NAME_LENGTH;
}

/**
 * A name as two names are compared: case, accents, spaces and punctuation
 * ignored, so "Sam", "sam." and "S A M" are one name, and "Hôte" is "hote".
 */
function nameKey(name) {
  return String(name || '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, '');
}

module.exports = {
  GuestStore, cleanName, nameTooLong, nameKey, NAME_LENGTH, MAX_SESSIONS, SESSION_TTL_MS, OFFERED_SEARCHES,
  MAX_ATTRIBUTIONS, ATTRIBUTION_TTL_MS
};
