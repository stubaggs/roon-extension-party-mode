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

/**
 * Track identity.
 *
 * Roon gives no stable track ID an extension can hold on to. A browse `item_key`
 * is a cursor into a browse session and expires; a `queue_item_id` exists only
 * while the track sits in the queue and has no counterpart on a browse item. So
 * identity has to be rebuilt from what both sides do carry.
 *
 * Browse items (search results) carry only title and subtitle. Queue items and
 * now-playing also carry a length. Where a length is known on both sides it is
 * the strongest signal available, because it separates versions of a song that
 * share a title.
 *
 * Two kinds of title key are needed, for two different jobs:
 *
 *   versionTitle - keeps "(Remastered 2001)" and "- 2014 Remaster". Used to
 *                  decide whether two entries are the SAME RECORDING, which is
 *                  what duplicate checking needs: a remaster is a fair request
 *                  even when the original is already queued.
 *   looseTitle   - strips those tags. Used only as a last-resort fallback when
 *                  crediting a guest, where being slightly wrong is better than
 *                  showing no badge at all.
 */

/** Roon may report the same track a second or two apart from different sources. */
const LENGTH_TOLERANCE = 2;

function fold(text) {
  return String(text || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

/** "Dancing Queen (Remastered 2001)" -> "dancing queen remastered 2001". */
function versionTitle(title) {
  return fold(title)
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** "Dancing Queen (Remastered 2001)", "Dancing Queen - 2014 Remaster" -> "dancing queen". */
function looseTitle(title) {
  return fold(title)
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/\s+-\s+.*(remaster|version|edit|mix|live|mono|stereo).*$/, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * "Calvin Harris / Dua Lipa", "Calvin Harris, Dua Lipa feat. X" -> set of names.
 *
 * Only separators that are unambiguously separators. "and", "with" and a bare
 * "x" are not: they split "Hall and Oates" into two names that then match other
 * artists on their own, and an overlap of one name is enough to call it a match.
 */
function artistSet(subtitle) {
  return new Set(
    fold(subtitle)
      .split(/\s*(?:\/|,|;|&|\bfeat\.?|\bft\.?|\bfeaturing\b)\s*/)
      .map((name) => name.replace(/[^a-z0-9]+/g, ' ').trim())
      .filter(Boolean)
  );
}

/** Order-independent artist key, so "A, B" and "B / A" agree. */
function artistKey(subtitle) {
  return [...artistSet(subtitle)].sort().join('\u0001');
}

function seconds(length) {
  const value = Number(length);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}

/**
 * A short fingerprint of recording identity: version-sensitive title, artists
 * and exact length. Null when the length is unknown, which is always the case
 * for a search result, so callers must treat a null hash as "cannot fingerprint
 * yet" rather than as a value to compare.
 *
 * @param {{title: string, artist: string, length: number|null}} track
 * @returns {string|null} 12 hex characters, or null
 */
function trackHash(track) {
  const length = seconds(track && track.length);
  if (!length) return null;
  const canonical = [versionTitle(track.title), artistKey(track.artist), length].join('\u0000');
  return crypto.createHash('sha1').update(canonical).digest('hex').slice(0, 12);
}

/** Artists agree, or one side didn't say. */
function artistsAgree(a, b) {
  const left = artistSet(a);
  const right = artistSet(b);
  if (!left.size || !right.size) return true;
  for (const name of left) if (right.has(name)) return true;
  return false;
}

/**
 * Whether two entries are the same recording — the test duplicate checking uses.
 *
 * Lengths that are both known must agree within the tolerance, so a 3:12 single
 * edit and a 7:11 album version are different recordings. When one side has no
 * length (a search result), title and artist agreement is all there is to go on.
 *
 * @param {{title: string, artist: string, length: number|null}} a
 * @param {{title: string, artist: string, length: number|null}} b
 */
function sameRecording(a, b) {
  if (!a || !b) return false;
  if (versionTitle(a.title) !== versionTitle(b.title)) return false;
  if (!artistsAgree(a.artist, b.artist)) return false;
  const left = seconds(a.length);
  const right = seconds(b.length);
  if (left && right) return Math.abs(left - right) <= LENGTH_TOLERANCE;
  return true;
}

/**
 * Songwriters, inferred: names credited on at least half of the search results
 * with the same title, when there are three or more of them.
 *
 * A search result's subtitle credits writers as well as performers; a queue
 * entry credits performers only. So every cover of "bad guy" reads "FINNEAS,
 * Billie Eilish, 2CELLOS" and would share "Billie Eilish" with the queued
 * original. The names nearly every version credits are the writers; what is
 * left on each result is who performs that version.
 *
 * @param {{title: string, subtitle: string}[]} results - the search the candidate came from
 * @param {string} title
 * @returns {Set<string>} folded names, empty when there is too little to go on
 */
function sharedCredits(results, title) {
  const key = looseTitle(title);
  const group = (results || []).filter((item) => looseTitle(item.title) === key);
  const shared = new Set();
  if (group.length < 3) return shared;
  const counts = new Map();
  for (const item of group) {
    for (const name of artistSet(item.subtitle)) counts.set(name, (counts.get(name) || 0) + 1);
  }
  for (const [name, count] of counts) if (count * 2 >= group.length) shared.add(name);
  return shared;
}

/**
 * Whether a search result is the recording already queued — the duplicate
 * check. Titles must match exactly (version-sensitive). Then the result's
 * performers, its credits less the inferred writers, must include one of the
 * queued entry's artists. A result that credits only writers is the original,
 * by the writers themselves, and is compared on all its names.
 *
 * @param {{title: string, artist: string}} queued - a queue entry (performers)
 * @param {{title: string, artist: string}} candidate - a search result (subtitle as artist)
 * @param {Set<string>} [writers] - from sharedCredits
 */
function sameRecordingAsQueued(queued, candidate, writers = new Set()) {
  if (!queued || !candidate) return false;
  if (versionTitle(queued.title) !== versionTitle(candidate.title)) return false;
  const performers = [...artistSet(candidate.artist)].filter((name) => !writers.has(name));
  if (!performers.length) return artistsAgree(queued.artist, candidate.artist);
  const queuedArtists = artistSet(queued.artist);
  if (!queuedArtists.size) return true;
  return performers.some((name) => queuedArtists.has(name));
}

/** A key for "has the playing track changed", precise when a length is known. */
function identityKey(track) {
  return (
    trackHash(track) ||
    `${versionTitle(track && track.title)}|${artistKey(track && track.artist)}`
  );
}

module.exports = {
  LENGTH_TOLERANCE,
  artistKey,
  artistSet,
  artistsAgree,
  fold,
  identityKey,
  looseTitle,
  sameRecording,
  sameRecordingAsQueued,
  seconds,
  sharedCredits,
  trackHash,
  versionTitle
};
