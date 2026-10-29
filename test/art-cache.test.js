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
const assert = require('assert');
const { ArtCache, ART_CACHE_BYTES, LARGEST_KEPT, KnownKeys, KNOWN_KEYS } = require('../lib/art-cache');

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

const image = (bytes) => ({ contentType: 'image/jpeg', body: Buffer.alloc(bytes) });

(async () => {
  console.log('art cache');

  await check('about 8 MB', () => assert.strictEqual(ART_CACHE_BYTES, 8 * 1024 * 1024));

  await check('an image is fetched once, then served from memory', async () => {
    const cache = new ArtCache(1000);
    let loads = 0;
    const load = async () => { loads++; return image(100); };
    await cache.get('a', load);
    await cache.get('a', load);
    assert.strictEqual(loads, 1);
    assert.strictEqual(cache.bytes, 100);
  });

  await check('requests during a fetch wait for it', async () => {
    const cache = new ArtCache(1000);
    let loads = 0;
    let finish;
    const load = () => { loads++; return new Promise((resolve) => { finish = resolve; }); };
    const waiting = [cache.get('a', load), cache.get('a', load), cache.get('a', load)];
    finish(image(10));
    const images = await Promise.all(waiting);
    assert.strictEqual(loads, 1);
    assert.ok(images.every((i) => i === images[0]));
  });

  await check('a failure is not kept: the next request tries again', async () => {
    const cache = new ArtCache(1000);
    let loads = 0;
    const fail = async () => { loads++; throw new Error('no_core'); };
    await assert.rejects(cache.get('a', fail), /no_core/);
    await assert.rejects(cache.get('a', fail), /no_core/);
    assert.strictEqual(loads, 2);
    assert.strictEqual(cache.images.size, 0);
    assert.strictEqual(cache.loading.size, 0);
    assert.strictEqual(cache.failed, 2, 'counted for the About page');
  });

  await check('over its size, the least recently used go first', async () => {
    const cache = new ArtCache(300);
    await cache.get('a', async () => image(100));
    await cache.get('b', async () => image(100));
    await cache.get('c', async () => image(100));
    await cache.get('a', async () => assert.fail('a is kept')); // a is now the most recent
    await cache.get('d', async () => image(100));
    assert.deepStrictEqual([...cache.images.keys()], ['c', 'a', 'd']);
    assert.strictEqual(cache.bytes, 300);
  });

  await check('an image bigger than the whole cache, or empty, is served but not kept', async () => {
    const cache = new ArtCache(300);
    assert.strictEqual((await cache.get('big', async () => image(400))).body.length, 400);
    await cache.get('empty', async () => image(0));
    assert.strictEqual(cache.images.size, 0);
    assert.strictEqual(cache.bytes, 0);
  });

  await check('the Hub\'s 400-pixel cover is the largest kept', () => assert.strictEqual(LARGEST_KEPT, 400));

  await check('an image fetched with keep false is served, and shared while on its way, but not kept', async () => {
    const cache = new ArtCache(1000);
    let loads = 0;
    let finish;
    const load = () => { loads++; return new Promise((resolve) => { finish = resolve; }); };
    const waiting = [cache.get('big', load, { keep: false }), cache.get('big', load, { keep: false })];
    finish(image(100));
    const images = await Promise.all(waiting);
    assert.strictEqual(loads, 1, 'one fetch for both');
    assert.strictEqual(images[0].body.length, 100);
    assert.strictEqual(cache.images.size, 0);
    assert.strictEqual(cache.bytes, 0);
    await cache.get('big', async () => { loads++; return image(100); }, { keep: false });
    assert.strictEqual(loads, 2, 'asked for again later: fetched again');
  });

  console.log('known image keys');

  await check('5000 keys', () => assert.strictEqual(KNOWN_KEYS, 5000));

  await check('only keys noted from the Core are known', () => {
    const known = new KnownKeys(10);
    known.note([{ image_key: 'a' }, { image_key: null }, {}, null, { image_key: 7 }]);
    assert.ok(known.use('a'));
    assert.ok(!known.use('b'));
    assert.deepStrictEqual([...known.keys], ['a']);
  });

  await check('over the limit, the least recently seen or used go first', () => {
    const known = new KnownKeys(3);
    known.note([{ image_key: 'a' }, { image_key: 'b' }, { image_key: 'c' }]);
    known.use('a'); // a page still shows it
    known.note([{ image_key: 'd' }]);
    assert.deepStrictEqual([...known.keys], ['c', 'a', 'd']);
  });

  if (failures) {
    console.log(`\n${failures} failed`);
    process.exit(1);
  }
})();
