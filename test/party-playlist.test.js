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

const assert = require('assert');
const { PartyPlaylist, playlistFileName, csvCell, defuse, MAX_TRACKS } = require('../lib/party-playlist');

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

const track = (id, title, extra) =>
  Object.assign({ id, title, artist: 'ABBA', album: 'Arrival', length: 231 }, extra);
const nobody = () => null;
const rows = (playlist, creditFor) => playlist.toCsv(creditFor).trim().split('\r\n');
const titles = (playlist) => playlist.tracks.map((t) => t.title);

console.log('PartyPlaylist');

check('records each queue entry once, in the order it was queued', () => {
  const playlist = new PartyPlaylist();
  playlist.update('o1', [track(1, 'Dancing Queen')], nobody);
  playlist.update('o1', [track(1, 'Dancing Queen'), track(2, 'Waterloo')], nobody);
  playlist.update('o1', [track(3, 'SOS'), track(2, 'Waterloo')], nobody);
  assert.deepStrictEqual(titles(playlist), ['Dancing Queen', 'Waterloo', 'SOS']);
});

check('keeps tracks after they leave the queue', () => {
  const playlist = new PartyPlaylist();
  playlist.update('o1', [track(1, 'Dancing Queen'), track(2, 'Waterloo')], nobody);
  playlist.update('o1', [], nobody);
  assert.deepStrictEqual(titles(playlist), ['Dancing Queen', 'Waterloo']);
});

check('the same song queued twice is listed twice', () => {
  const playlist = new PartyPlaylist();
  playlist.update('o1', [track(1, 'Waterloo'), track(2, 'Waterloo')], nobody);
  assert.strictEqual(playlist.tracks.length, 2);
});

check('no zone leaves the list alone', () => {
  const playlist = new PartyPlaylist();
  playlist.update('o1', [track(1, 'Waterloo')], nobody);
  playlist.update(null, [], nobody);
  assert.deepStrictEqual(titles(playlist), ['Waterloo']);
});

check('a new party zone starts over', () => {
  const playlist = new PartyPlaylist();
  playlist.update('o1', [track(1, 'Waterloo')], nobody);
  playlist.update('o2', [track(9, 'SOS')], nobody);
  assert.deepStrictEqual(titles(playlist), ['SOS']);
});

check('a reset starts over from what is still queued', () => {
  const playlist = new PartyPlaylist();
  playlist.update('o1', [track(1, 'Dancing Queen'), track(2, 'Waterloo')], nobody);
  playlist.update('o1', [track(2, 'Waterloo')], nobody);
  playlist.reset();
  playlist.update('o1', [track(2, 'Waterloo'), track(3, 'SOS')], nobody);
  assert.deepStrictEqual(titles(playlist), ['Waterloo', 'SOS']);
});

check('credits are kept from when the track was queued', () => {
  const playlist = new PartyPlaylist();
  playlist.update('o1', [track(1, 'Waterloo'), track(2, 'SOS'), track(3, 'Mamma Mia')], (t) =>
    t.id === 1 ? { requested_by: 'Stu', kind: 'guest' } : t.id === 2 ? { requested_by: null, kind: 'radio' } : null
  );
  const csv = rows(playlist, nobody);
  assert.strictEqual(csv[0], 'title,artist,album,length,requested by,queued at');
  assert.ok(csv[1].startsWith('Waterloo,ABBA,Arrival,3:51,Stu,'), csv[1]);
  assert.ok(csv[2].startsWith('SOS,ABBA,Arrival,3:51,Roon Radio,'), csv[2]);
  assert.ok(csv[3].startsWith('Mamma Mia,ABBA,Arrival,3:51,,'), csv[3]);
});

check('a track with no credit yet is looked up again', () => {
  const playlist = new PartyPlaylist();
  playlist.update('o1', [track(1, 'Waterloo')], nobody);
  const csv = rows(playlist, () => ({ requested_by: null, kind: 'guest' }));
  assert.ok(csv[1].includes(',Anon,'), csv[1]);
});

check('queued at is local time, to the minute', () => {
  const playlist = new PartyPlaylist();
  playlist.update('o1', [track(1, 'Waterloo')], nobody, new Date(2026, 9, 2, 21, 5, 59).getTime());
  assert.ok(rows(playlist)[1].endsWith(',2026-10-02 21:05'), rows(playlist)[1]);
});

check('Soundiiz finds the title column: no byte order mark before it', () => {
  assert.ok(new PartyPlaylist().toCsv().startsWith('title,artist,album,'));
});

check("Roon's artist separator becomes a comma, in one quoted cell", () => {
  const playlist = new PartyPlaylist();
  playlist.update('o1', [track(1, 'Brand New', { artist: 'Pharrell Williams / Justin Timberlake' })], nobody);
  assert.ok(rows(playlist)[1].startsWith('Brand New,"Pharrell Williams, Justin Timberlake",'), rows(playlist)[1]);
});

check('track details are written as Roon gives them, even with a leading dash', () => {
  const playlist = new PartyPlaylist();
  playlist.update('o1', [track(1, '-ness', { artist: '+44', album: '@home' })], nobody);
  assert.ok(rows(playlist)[1].startsWith('-ness,+44,@home,'), rows(playlist)[1]);
});

check('cells with commas and quotes are quoted', () => {
  assert.strictEqual(csvCell('Love, Love, Love'), '"Love, Love, Love"');
  assert.strictEqual(csvCell('The "Best"'), '"The ""Best"""');
  assert.strictEqual(csvCell(null), '');
});

check('a guest name that looks like a formula is defused', () => {
  assert.strictEqual(defuse('=HYPERLINK("x")'), '\'=HYPERLINK("x")');
  assert.strictEqual(defuse('@Stu'), "'@Stu");
  assert.strictEqual(defuse('Stu'), 'Stu');
  const playlist = new PartyPlaylist();
  playlist.update('o1', [track(1, 'Waterloo')], () => ({ requested_by: '=1+1', kind: 'guest' }));
  assert.ok(rows(playlist)[1].includes(",'=1+1,"), rows(playlist)[1]);
});

check('file name is the party and the date, without unsafe characters', () => {
  const day = new Date(2026, 9, 2);
  assert.strictEqual(playlistFileName('Stu\'s 50th', day), 'Stu\'s 50th 2026-10-02.csv');
  assert.strictEqual(playlistFileName('A/B: party?', day), 'A B party 2026-10-02.csv');
  assert.strictEqual(playlistFileName('', day), 'Party 2026-10-02.csv');
});

check('a name given later reaches the playlist', () => {
  const playlist = new PartyPlaylist();
  playlist.update('o1', [track(1, 'Waterloo'), track(2, 'SOS')], (t) =>
    t.id === 1 ? { requested_by: null, kind: 'add', guest: 'g1' } : { requested_by: 'Sam', kind: 'add', guest: 'g2' }
  );
  playlist.rename('g1', 'Stu');
  const csv = rows(playlist);
  assert.ok(csv[1].includes(',Stu,'), csv[1]);
  assert.ok(csv[2].includes(',Sam,'), csv[2]);
  assert.ok(!playlist.toCsv().includes('g1'), 'no guest refs in the file');
});

check('a full list drops the host\'s and Roon Radio\'s oldest entries before any guest\'s', () => {
  const playlist = new PartyPlaylist();
  // A guest's request first, then entries no guest asked for, past the limit.
  const credit = (t) => (t.id === 1 ? { requested_by: 'Sam', kind: 'add', guest: 'g1' } : t.id % 2 ? { kind: 'radio' } : null);
  const queue = [track(1, 'Guest pick')];
  for (let id = 2; id <= MAX_TRACKS + 11; id += 1) queue.push(track(id, `Track ${id}`));
  playlist.update('o1', queue, credit);
  assert.strictEqual(playlist.tracks.length, MAX_TRACKS);
  assert.strictEqual(playlist.tracks[0].title, 'Guest pick');
  assert.strictEqual(playlist.tracks[1].title, 'Track 13');
  assert.strictEqual(playlist.seen.size, MAX_TRACKS, 'seen shrinks with the list');
});

check('guests\' requests alone past the limit drop the oldest of them', () => {
  const playlist = new PartyPlaylist();
  const queue = [];
  for (let id = 1; id <= MAX_TRACKS + 3; id += 1) queue.push(track(id, `Track ${id}`));
  playlist.update('o1', queue, () => ({ requested_by: 'Sam', kind: 'add', guest: 'g1' }));
  assert.strictEqual(playlist.tracks.length, MAX_TRACKS);
  assert.strictEqual(playlist.tracks[0].title, 'Track 4');
  assert.strictEqual(playlist.seen.size, MAX_TRACKS);
});

check('with Loop on, a track that goes round again is listed once', () => {
  const playlist = new PartyPlaylist();
  const credit = (t) => (t.title === 'Waterloo' ? { requested_by: 'Sam', kind: 'add', guest: 'g1' } : null);
  playlist.update('o1', [track(1, 'Waterloo'), track(2, 'SOS')], credit);
  // Waterloo has played: Roon moves it to the back under a new id.
  playlist.update('o1', [track(2, 'SOS'), track(3, 'Waterloo')], nobody);
  playlist.update('o1', [track(3, 'Waterloo'), track(4, 'SOS')], nobody);
  assert.deepStrictEqual(titles(playlist), ['Waterloo', 'SOS']);
  assert.ok(rows(playlist)[1].includes(',Sam,'), 'keeps its credit');
  assert.strictEqual(playlist.seen.size, 2);
});

check('playing the queue from a later entry doesn\'t list the ones before it again', () => {
  const playlist = new PartyPlaylist();
  playlist.update('o1', [track(1, 'SOS'), track(2, 'Fernando'), track(3, 'Waterloo')], nobody);
  playlist.update('o1', [track(3, 'Waterloo'), track(4, 'SOS'), track(5, 'Fernando')], nobody);
  assert.deepStrictEqual(titles(playlist), ['SOS', 'Fernando', 'Waterloo']);
});

check('the same track queued again later is listed again', () => {
  const playlist = new PartyPlaylist();
  playlist.update('o1', [track(1, 'Waterloo')], nobody);
  playlist.update('o1', [], nobody);
  playlist.update('o1', [track(2, 'Waterloo')], nobody);
  assert.deepStrictEqual(titles(playlist), ['Waterloo', 'Waterloo']);
});

check('very long titles, artists and albums are cut short', () => {
  const playlist = new PartyPlaylist();
  const long = 'x'.repeat(5000);
  playlist.update('o1', [track(1, long, { artist: long, album: long })], nobody);
  const [entry] = playlist.tracks;
  for (const field of ['title', 'artist', 'album']) {
    assert.strictEqual(entry[field].length, 200, field);
    assert.ok(entry[field].endsWith('…'), field);
  }
});

console.log(failures ? `\n${failures} failing` : '\nall passing');
process.exit(failures ? 1 : 0);
