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
const { sameRecording, trackHash, identityKey, artistSet } = require('../lib/track-id');
const { GuestStore } = require('../lib/guests');

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

const t = (title, artist, length) => ({ title, artist, length: length ?? null });

console.log('sameRecording — versions are different recordings');
check('remaster tag makes a different recording', () => {
  assert.strictEqual(
    sameRecording(t('Dancing Queen', 'ABBA', 230), t('Dancing Queen (Remastered 2001)', 'ABBA')),
    false
  );
});
check('dash remaster suffix makes a different recording', () => {
  assert.strictEqual(
    sameRecording(t('Dancing Queen', 'ABBA', 230), t('Dancing Queen - 2014 Remaster', 'ABBA')),
    false
  );
});
check('same title, lengths far apart -> different recording', () => {
  assert.strictEqual(sameRecording(t('Hey Jude', 'The Beatles', 431), t('Hey Jude', 'The Beatles', 192)), false);
});
check('same title, lengths within tolerance -> same recording', () => {
  assert.strictEqual(sameRecording(t('Hey Jude', 'The Beatles', 431), t('Hey Jude', 'The Beatles', 432)), true);
});
check('no length on one side -> falls back to title and artist', () => {
  assert.strictEqual(sameRecording(t('Hey Jude', 'The Beatles', 431), t('Hey Jude', 'The Beatles')), true);
});
check('different artists -> not the same recording', () => {
  assert.strictEqual(sameRecording(t('Hurt', 'Nine Inch Nails', 373), t('Hurt', 'Johnny Cash', 218)), false);
});

console.log('sameRecording — spelling differences are the same recording');
check('artist separators differ', () => {
  assert.strictEqual(
    sameRecording(t('One Kiss', 'Calvin Harris / Dua Lipa', 214), t('One Kiss', 'Calvin Harris, Dua Lipa', 214)),
    true
  );
});
check('extra featured artist on one side', () => {
  assert.strictEqual(
    sameRecording(t('One Kiss', 'Calvin Harris', 214), t('One Kiss', 'Calvin Harris feat. Dua Lipa', 214)),
    true
  );
});
check('accents and punctuation', () => {
  assert.strictEqual(sameRecording(t('Déjà Vu', 'Beyoncé', 240), t('Deja Vu', 'Beyonce', 240)), true);
});

console.log('artistSet — separators');
check('"and" is not a separator', () => {
  assert.deepStrictEqual([...artistSet('Hall and Oates')], ['hall and oates']);
});
check('slash splits', () => {
  assert.deepStrictEqual([...artistSet('A / B')].sort(), ['a', 'b']);
});

console.log('trackHash');
check('null without a length', () => {
  assert.strictEqual(trackHash(t('Dancing Queen', 'ABBA')), null);
});
check('stable across spellings of the same recording', () => {
  assert.strictEqual(
    trackHash(t('One Kiss', 'Calvin Harris / Dua Lipa', 214)),
    trackHash(t('One Kiss', 'Dua Lipa, Calvin Harris', 214))
  );
});
check('differs by length', () => {
  assert.notStrictEqual(trackHash(t('Hey Jude', 'The Beatles', 431)), trackHash(t('Hey Jude', 'The Beatles', 192)));
});
check('differs by version tag', () => {
  assert.notStrictEqual(
    trackHash(t('Dancing Queen', 'ABBA', 230)),
    trackHash(t('Dancing Queen (Remastered 2001)', 'ABBA', 230))
  );
});
check('identityKey falls back without a length', () => {
  assert.strictEqual(typeof identityKey(t('Dancing Queen', 'ABBA')), 'string');
  assert.notStrictEqual(identityKey(t('Hey Jude', 'x', 431)), identityKey(t('Hey Jude', 'x', 192)));
});

console.log('attribution');
const store = new GuestStore();
const alice = store.create();
alice.name = 'Alice';
const bob = store.create();
bob.name = 'Bob';

check('credits by queue item id once bound', () => {
  const entry = store.attribute(alice, { title: 'Dancing Queen', artist: 'ABBA' }, 'add');
  store.bind(entry, { id: 'q1', title: 'Dancing Queen', artist: 'ABBA', length: 230 });
  const found = store.lookup({ id: 'q1', title: 'totally different', artist: 'nobody', length: 1 });
  assert.strictEqual(found && found.name, 'Alice');
});

check('credits by hash after the item leaves the queue', () => {
  const found = store.lookup(t('Dancing Queen', 'ABBA', 230));
  assert.strictEqual(found && found.name, 'Alice');
});

check('a different version is not credited to the same guest', () => {
  const store2 = new GuestStore();
  const g = store2.create();
  g.name = 'Alice';
  const entry = store2.attribute(g, { title: 'Hey Jude', artist: 'The Beatles' }, 'add');
  store2.bind(entry, { id: 'q9', title: 'Hey Jude', artist: 'The Beatles', length: 431 });
  // The short edit is a different recording; only the loose fallback could match,
  // and with a single recent request that fallback is allowed to claim it.
  const found = store2.lookup(t('Hey Jude', 'The Beatles', 192));
  assert.ok(found, 'loose fallback should still offer a credit');
});

check('two guests, same song, different versions stay separate', () => {
  const store3 = new GuestStore();
  const a = store3.create();
  a.name = 'Alice';
  const b = store3.create();
  b.name = 'Bob';
  const ea = store3.attribute(a, { title: 'Hey Jude', artist: 'The Beatles' }, 'add');
  store3.bind(ea, { id: 'qa', title: 'Hey Jude', artist: 'The Beatles', length: 431 });
  const eb = store3.attribute(b, { title: 'Hey Jude - Single Edit', artist: 'The Beatles' }, 'add');
  store3.bind(eb, { id: 'qb', title: 'Hey Jude - Single Edit', artist: 'The Beatles', length: 192 });

  assert.strictEqual(store3.lookup(t('Hey Jude', 'The Beatles', 431)).name, 'Alice');
  assert.strictEqual(store3.lookup(t('Hey Jude - Single Edit', 'The Beatles', 192)).name, 'Bob');
});

check('unrelated track gets no credit', () => {
  const found = store.lookup(t('Smells Like Teen Spirit', 'Nirvana', 301));
  assert.strictEqual(found, null);
});

console.log('\nduplicates: covers are not the queued original');

{
  const { sharedCredits, sameRecordingAsQueued } = require('../lib/track-id');
  const { results } = require('./fixtures/bad-guy-search.json');
  const asCandidate = (r) => ({ title: r.title, artist: r.subtitle });
  const blocked = (queued, list) =>
    list.filter((r) => sameRecordingAsQueued(queued, asCandidate(r), sharedCredits(list, r.title)));

  check('the writers of "bad guy" are inferred from the other results', () => {
    assert.deepStrictEqual([...sharedCredits(results, 'bad guy')].sort(), ['billie eilish', 'finneas']);
  });

  check('with the original queued, only the original is a duplicate, not its 20-odd covers', () => {
    const hits = blocked({ title: 'bad guy', artist: 'Billie Eilish' }, results);
    assert.deepStrictEqual(hits.map((r) => r.subtitle), ['Billie Eilish, FINNEAS']);
  });

  check('with a cover queued, only that cover is a duplicate', () => {
    const hits = blocked({ title: 'bad guy', artist: '2CELLOS' }, results);
    assert.deepStrictEqual(hits.map((r) => r.subtitle), ['FINNEAS, Billie Eilish, 2CELLOS']);
  });

  check('a cover credited to one writer: Hallelujah', () => {
    const list = [
      { title: 'Hallelujah', subtitle: 'Leonard Cohen' },
      { title: 'Hallelujah', subtitle: 'Jeff Buckley, Leonard Cohen' },
      { title: 'Hallelujah', subtitle: 'Rufus Wainwright, Leonard Cohen' },
      { title: 'Hallelujah', subtitle: 'Pentatonix, Leonard Cohen' }
    ];
    assert.deepStrictEqual(blocked({ title: 'Hallelujah', artist: 'Leonard Cohen' }, list).map((r) => r.subtitle), ['Leonard Cohen']);
    assert.deepStrictEqual(blocked({ title: 'Hallelujah', artist: 'Jeff Buckley' }, list).map((r) => r.subtitle), ['Jeff Buckley, Leonard Cohen']);
  });

  check('too few results to tell: any shared performer still counts', () => {
    const list = [{ title: 'Rush, Rush', subtitle: 'Deborah Harry, Giorgio Moroder, Blondie' }];
    assert.strictEqual(blocked({ title: 'Rush, Rush', artist: 'Deborah Harry / Blondie' }, list).length, 1);
  });

  check('a different version title is never a duplicate', () => {
    const hits = blocked({ title: 'bad guy (with Justin Bieber)', artist: 'Billie Eilish / Justin Bieber' }, results);
    assert.deepStrictEqual(hits.map((r) => r.title), ['bad guy (with Justin Bieber)']);
  });
}

console.log(failures ? `\n${failures} failing` : '\nall passing');
process.exit(failures ? 1 : 0);
