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

const MAX_TRACKS = 2000;

/**
 * Every track that entered the party zone's queue, in the order it did, for the
 * playlist the host can download. Roon gives each queue entry its own id, so a
 * track is counted once however often the queue around it changes, and a track
 * queued twice is listed twice. Held in memory, so it starts over when the
 * extension restarts or the party zone changes, like the played list.
 */
class PartyPlaylist {
  constructor() {
    this.zone = null;
    this.tracks = [];
    this.seen = new Set();
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
      this.zone = zone;
      this.tracks = [];
      this.seen.clear();
    }
    for (const item of items) {
      if (!item.id || this.seen.has(item.id)) continue;
      this.seen.add(item.id);
      // The credit is taken now: guests' attributions are cleared when the host
      // closes guest access, and whether Roon Radio is on can change later.
      const credit = creditFor(item);
      this.tracks.push({
        id: item.id,
        title: item.title,
        artist: item.artist,
        album: item.album,
        length: item.length,
        requested_by: credit ? credit.requested_by : null,
        kind: credit ? credit.kind : null,
        queued_at: now
      });
    }
    if (this.tracks.length > MAX_TRACKS) this.tracks.splice(0, this.tracks.length - MAX_TRACKS);
  }

  /**
   * The playlist as CSV. Column names and credits stay in English, which is
   * what playlist import services look for.
   * @param {function} [creditFor] - looked up again for tracks with no credit yet,
   *   for a guest request whose insert Roon reported before the request finished
   */
  toCsv(creditFor) {
    const rows = [['Title', 'Artist', 'Album', 'Length', 'Requested by', 'Queued at']];
    for (const track of this.tracks) {
      let credit = track.kind ? track : null;
      if (!credit && creditFor) credit = creditFor(track);
      rows.push([
        track.title,
        track.artist,
        track.album,
        duration(track.length),
        creditLabel(credit),
        localTime(new Date(track.queued_at))
      ]);
    }
    // The byte order mark lets spreadsheet apps read accented names as UTF-8.
    return '﻿' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
  }
}

function creditLabel(credit) {
  if (!credit || !credit.kind) return '';
  if (credit.kind === 'radio') return 'Roon Radio';
  return credit.requested_by || 'a guest';
}

function duration(length) {
  if (!length) return '';
  const total = Math.round(length);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * Quote a cell when it needs it. Guests choose their own names, so a cell that
 * a spreadsheet would run as a formula gets a leading apostrophe.
 */
function csvCell(value) {
  let text = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
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

module.exports = { PartyPlaylist, playlistFileName, csvCell };
