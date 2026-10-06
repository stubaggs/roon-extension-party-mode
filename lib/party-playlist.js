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

const { trackHash } = require('./track-id');

// About two weeks of non-stop play: the list grows only as fast as the queue
// does. Past it, the oldest of the host's and Roon Radio's entries go first.
const MAX_TRACKS = 5000;
// Roon's text is normally short; this keeps one odd entry from being large.
const MAX_FIELD = 200;

/**
 * Every track that entered the party zone's queue, in the order it did, for the
 * playlist the host can download. Roon gives each queue entry its own id, so a
 * track is counted once however often the queue around it changes, and a track
 * queued twice is listed twice. Held in memory, so it starts over when the
 * extension restarts or the party zone changes, like the played list, and when
 * the host turns party mode back on for a new party.
 */
class PartyPlaylist {
  constructor() {
    this.zone = null;
    this.tracks = [];
    this.seen = new Set();
    // The queue at the last update, id -> what the entry is (entryKey).
    this.queued = new Map();
  }

  /**
   * @param {string|null} zone - the party zone's output id
   * @param {object[]} items - the queue as the pages see it ({ id, title, artist, album, length })
   * @param {function} creditFor - a track's { requested_by, kind } credit, or null
   * @param {number} [now]
   */
  update(zone, items, creditFor, now = Date.now()) {
    if (!zone) return;
    if (zone !== this.zone) {
      this.reset();
      this.zone = zone;
    }
    // Entries that left the queue in this update, by what they are. Roon gives an
    // entry it only moved a new id: with Loop on, a track that has played goes
    // to the back, and playing the queue from a later entry does the same with
    // the ones before it. Such an entry keeps its place in the list rather than
    // being listed again.
    const current = new Set(items.map((item) => item.id));
    const left = new Map();
    for (const [id, key] of this.queued) {
      if (current.has(id)) continue;
      if (!left.has(key)) left.set(key, []);
      left.get(key).push(id);
    }
    this.queued = new Map(items.filter((item) => item.id).map((item) => [item.id, entryKey(item)]));

    // "Host" is only what's left when no guest is found, and Roon can report a
    // guest's insert before the request has finished: look again while the
    // entry is still queued, so it moves to the guest who asked for it.
    const unclaimed = new Map(this.tracks.filter((track) => track.kind === 'host').map((track) => [track.id, track]));
    for (const item of items) {
      const track = unclaimed.get(item.id);
      if (!track) continue;
      const credit = creditFor(item);
      if (credit && (credit.kind === 'add' || credit.kind === 'next')) setCredit(track, credit);
    }

    for (const item of items) {
      if (!item.id || this.seen.has(item.id)) continue;
      const moved = left.get(entryKey(item));
      if (moved && moved.length) {
        this._moved(moved.shift(), item.id);
        continue;
      }
      this.seen.add(item.id);
      // The credit is taken now: guests' attributions are cleared when the host
      // turns party mode off, and whether Roon Radio is on can change later.
      const track = {
        id: item.id,
        title: clip(item.title),
        artist: clip(item.artist),
        album: clip(item.album),
        length: item.length,
        queued_at: now
      };
      setCredit(track, creditFor(item));
      this.tracks.push(track);
    }
    if (this.tracks.length > MAX_TRACKS) this._trim();
  }

  /** An entry Roon moved under a new id: its track follows it. */
  _moved(oldId, newId) {
    this.seen.delete(oldId);
    this.seen.add(newId);
    const track = this.tracks.find((entry) => entry.id === oldId);
    if (track) track.id = newId;
  }

  /**
   * Down to MAX_TRACKS: the oldest entries no guest asked for go first, then, if
   * guests' requests alone are too many, the oldest of those. An id leaves seen
   * with its track, so seen stays as small as the list.
   */
  _trim() {
    let excess = this.tracks.length - MAX_TRACKS;
    const drop = new Set();
    for (const track of this.tracks) {
      if (excess === 0) break;
      if (!isGuests(track)) {
        drop.add(track);
        excess -= 1;
      }
    }
    for (const track of this.tracks) {
      if (excess === 0) break;
      if (!drop.has(track)) {
        drop.add(track);
        excess -= 1;
      }
    }
    for (const track of drop) this.seen.delete(track.id);
    this.tracks = this.tracks.filter((track) => !drop.has(track));
  }

  /** A guest named themselves, or changed their name: their tracks follow. */
  rename(guest, name) {
    if (!guest) return;
    for (const track of this.tracks) if (track.guest === guest) track.requested_by = name || null;
  }

  /** Start a new list. What is still queued is recorded again on the next update. */
  reset() {
    this.tracks = [];
    this.seen.clear();
    this.queued.clear();
  }

  /**
   * The playlist as CSV, in the form Soundiiz imports: a header row naming
   * title, artist and album in lower case, comma separated, UTF-8 with no byte
   * order mark (which would hide the first column name from an importer).
   * Importers ignore the other columns. Column names and credits stay in English.
   * @param {function} [creditFor] - looked up again for tracks with no credit, or
   *   only "Host", for a guest request whose insert Roon reported before the
   *   request finished
   * @param {{hideNames?: boolean, hostName?: string}} [options] - hideNames credits
   *   every guest as "Anon"; Roon Radio and the host stay. hostName, when set,
   *   credits the host's tracks in place of "Host".
   */
  toCsv(creditFor, { hideNames = false, hostName = '' } = {}) {
    const rows = [['title', 'artist', 'album', 'length', 'requested by', 'queued at']];
    for (const track of this.tracks) {
      let credit = track.kind && track.kind !== 'host' ? track : null;
      if (!credit && creditFor) credit = creditFor(track);
      if (!credit && track.kind) credit = track;
      rows.push([
        track.title,
        artists(track.artist),
        track.album,
        duration(track.length),
        // Guests choose their own names; the rest comes from Roon.
        defuse(hideNames && credit && isGuests(credit) ? 'Anon' : creditLabel(credit, hostName)),
        localTime(new Date(track.queued_at))
      ]);
    }
    return rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
  }
}

function setCredit(track, credit) {
  track.requested_by = credit ? credit.requested_by : null;
  track.kind = credit ? credit.kind : null;
  track.guest = (credit && credit.guest) || null;
}

/** What a queue entry is, to recognise it under a new id: its fingerprint, or its text. */
function entryKey(item) {
  return trackHash(item) || [item.title, item.artist, item.album].join('\u0000');
}

/** A guest's request: added, or put next. */
function isGuests(track) {
  return track.kind === 'add' || track.kind === 'next';
}

function clip(text) {
  if (typeof text !== 'string' || text.length <= MAX_FIELD) return text;
  return `${text.slice(0, MAX_FIELD - 1)}…`;
}

function creditLabel(credit, hostName = '') {
  if (!credit || !credit.kind) return '';
  if (credit.kind === 'radio') return 'Roon Radio';
  if (credit.kind === 'host') return hostName || 'Host';
  return credit.requested_by || 'Anon';
}

/** Roon separates artists with " / "; importers expect commas. */
function artists(text) {
  return String(text || '').split(' / ').join(', ');
}

function duration(length) {
  if (!length) return '';
  const total = Math.round(length);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** A leading apostrophe, so a spreadsheet shows text it would otherwise run as a formula. */
function defuse(text) {
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

/** Quote a cell when it holds a comma, a quote or a line break. */
function csvCell(value) {
  const text = value == null ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const pad = (n) => String(n).padStart(2, '0');
const localDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** "2026-10-02 21:30" in the extension's time zone, which spreadsheets read as a date. */
function localTime(d) {
  return `${localDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A file name for the download: the party's name and the date. */
function playlistFileName(partyName, now = new Date()) {
  const name = String(partyName || 'Party').replace(/[\\/:*?"<>|\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Party';
  return `${name} ${localDate(now)}.csv`;
}

module.exports = { PartyPlaylist, playlistFileName, csvCell, defuse, MAX_TRACKS };
