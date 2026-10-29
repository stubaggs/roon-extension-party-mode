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

/**
 * What /embed/ tells other people's pages (see EMBED.md, and DEVELOPER.md, Security).
 * Any site may read it, so every object is built here field by field from the
 * pages' own, never passed through: a field added to those for Party Mode's
 * pages (a guest's reference, a link) can't reach other sites by accident.
 * Never an address (join link, playlist), the zone's name or the Core's.
 * Fields are only ever added, never renamed or removed.
 */

/** Cover sizes other pages may ask for: those the album art cache keeps, and one large. */
const ART_SIZES = [120, 400, 800];
const ART_SIZE = 400;

/**
 * Who asked for a track: a guest (by name, or null for one who gave none), the
 * host, or Roon Radio; and for a guest, how (`add` to the end, or `next`).
 */
function credit(track, hostName) {
  if (!track || track.station || !track.kind) return null;
  if (track.kind === 'radio') return { kind: 'radio', name: null, how: null };
  if (track.kind === 'host') return { kind: 'host', name: hostName || null, how: null };
  if (track.kind === 'add' || track.kind === 'next') return { kind: 'guest', name: track.requested_by || null, how: track.kind };
  return null;
}

/** Who skipped a played track: a guest (by name, or null), or the host in Roon; null if nobody did. */
function skippedBy(track, hostName) {
  if (!track.skipped) return null;
  if (track.skipped_by_host) return { kind: 'host', name: hostName || null };
  return { kind: 'guest', name: track.skipped_by || null };
}

const time = (value) => (Number.isFinite(value) ? value : null);

function art(track) {
  return track && track.image_key ? `/embed/art/${encodeURIComponent(track.image_key)}` : null;
}

function track(t, hostName) {
  return {
    title: t.title || '',
    artist: t.artist || '',
    album: t.album || '',
    length: Number.isFinite(t.length) ? t.length : null,
    art: art(t),
    credit: credit(t, hostName)
  };
}

/**
 * The playing track, with where it had got to (`seek_position`, seconds) at
 * `at` (the server's time, ms since 1970), so a page can count on while it plays.
 */
function nowPlaying(playing, hostName, now = Date.now()) {
  if (!playing) return { track: null };
  return {
    track: Object.assign(track(playing, hostName), {
      queued_at: time(playing.queued_at),
      state: playing.state || 'stopped',
      station: Boolean(playing.station),
      seek_position: Number.isFinite(playing.seek_position) ? playing.seek_position : 0,
      at: now
    })
  };
}

/** What an empty Up next would say, as a reason rather than text: the page words it. */
const EMPTY_REASONS = {
  'queue.empty': 'none',
  'queue.empty_add': 'add',
  'queue.empty_radio': 'radio',
  'queue.empty_add_radio': 'add_radio'
};

function upNext(upcoming, empty, hostName) {
  return {
    tracks: upcoming.map((t) => Object.assign(track(t, hostName), { queued_at: time(t.queued_at) })),
    empty: EMPTY_REASONS[empty] || 'none'
  };
}

function played(list, hostName) {
  return {
    tracks: list.map((t) =>
      Object.assign(track(t, hostName), {
        queued_at: time(t.queued_at),
        played_at: time(t.played_at),
        skipped: Boolean(t.skipped),
        skipped_by: skippedBy(t, hostName)
      })
    )
  };
}

/**
 * The party: on, paused or off; its name and the host's (as the Hub shows
 * them); whether Party Mode is connected to Roon; how the playlist is offered
 * once the party ends ('qr', 'link' or 'off'; null while it's on), never its
 * address; the Hub's language if the host chose one (else null); and whether
 * Roon Radio is on in the party zone, picking tracks when the queue runs out.
 */
function status({ party, partyName, hostName, ready, playlist, language, roonRadio }) {
  return {
    party,
    party_name: partyName || '',
    host_name: hostName || null,
    ready: Boolean(ready),
    playlist: party === 'off' ? playlist : null,
    language: language || null,
    roon_radio: Boolean(roonRadio)
  };
}

module.exports = { ART_SIZE, ART_SIZES, credit, nowPlaying, played, skippedBy, status, upNext };
