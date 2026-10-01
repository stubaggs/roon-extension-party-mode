'use strict';

const crypto = require('crypto');

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
   * Roon's queue items do not carry a "who asked for this" field, so requests
   * are matched back to guests by title afterwards. Good enough for badges.
   */
  attribute(session, title, subtitle, kind) {
    this.attributions.unshift({
      key: attributionKey(title, subtitle),
      name: session.name,
      kind,
      at: now()
    });
    this.attributions = this.attributions.slice(0, 400);
  }

  lookup(title, subtitle) {
    const key = attributionKey(title, subtitle);
    return this.attributions.find((entry) => entry.key === key) || null;
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

function attributionKey(title, subtitle) {
  return `${String(title || '').trim().toLowerCase()}|${String(subtitle || '').trim().toLowerCase()}`;
}

module.exports = { GuestStore, attributionKey };
