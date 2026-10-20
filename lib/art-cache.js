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

// Every guest's phone and the Party Hub show the same now-playing and queue
// art, and ask for it at the same moment when a track changes. Each image used
// to be fetched from the Core once per phone; a Raspberry Pi 1 manages about 13
// a second. About 8 MB holds several hundred thumbnails: a party's queue and
// recent searches.
const ART_CACHE_BYTES = 8 * 1024 * 1024;

// Image keys Party Mode has had from the Core, so it only asks for art it has
// sent to a page. Several thousand cover a party's queue, now playing, Played
// and every guest's recent searches (40 results each), in well under a
// megabyte.
const KNOWN_KEYS = 5000;

// The largest size kept. The pages ask for 80 to 144 pixels, and the Party Hub
// 400 for the playing track; only a Hub on an 8K screen asks for 800, about
// four times the bytes of 400 and thirty times a thumbnail, for one screen.
// Those are still fetched once for any number asking at the same moment.
const LARGEST_KEPT = 400;

/**
 * Recently used album art, in memory, by image key and size. Roon's image keys
 * name fixed images, so a kept one never goes stale. The least recently used
 * go first once the cache is over its size. Requests for an image already on
 * its way from the Core wait for that one fetch. Failures aren't kept, so the
 * next request tries again, nor is an image fetched with `keep` false.
 */
class ArtCache {
  constructor(maxBytes = ART_CACHE_BYTES) {
    this.maxBytes = maxBytes;
    this.bytes = 0;
    this.images = new Map(); // in order of use, oldest first
    this.loading = new Map();
    // For the About page: covers answered from memory, and fetched from the Core.
    this.hits = 0;
    this.misses = 0;
    // Covers the Core couldn't send (an error or no answer in time).
    this.failed = 0;
  }

  /**
   * @param {string} key - image key and size
   * @param {() => Promise<{contentType: string, body: Buffer}>} load - fetches it from the Core
   * @param {{keep?: boolean}} [options] - keep: false to serve it without keeping it
   */
  get(key, load, { keep = true } = {}) {
    const kept = this.images.get(key);
    if (kept) {
      this.hits += 1;
      this.images.delete(key);
      this.images.set(key, kept);
      return Promise.resolve(kept);
    }
    if (this.loading.has(key)) {
      this.hits += 1;
      return this.loading.get(key);
    }
    this.misses += 1;
    const loading = load().then(
      (image) => {
        this.loading.delete(key);
        if (keep) this._keep(key, image);
        return image;
      },
      (err) => {
        this.loading.delete(key);
        this.failed += 1;
        throw err;
      }
    );
    this.loading.set(key, loading);
    return loading;
  }

  _keep(key, image) {
    const size = image && image.body ? image.body.length : 0;
    if (!size || size > this.maxBytes) return;
    this.images.set(key, image);
    this.bytes += size;
    for (const [oldest, old] of this.images) {
      if (this.bytes <= this.maxBytes) break;
      this.images.delete(oldest);
      this.bytes -= old.body.length;
    }
  }
}

/**
 * The image keys Party Mode has had from the Core: in the queue, now playing
 * and search results. Only these are fetched. The Core never answers for a key
 * it doesn't know, and the Roon API library keeps each unanswered request until
 * the Core disconnects, so made-up keys would use up memory. The least recently
 * seen or used go first once there are too many; one shown on a page stays,
 * since the page keeps asking for it.
 */
class KnownKeys {
  constructor(max = KNOWN_KEYS) {
    this.max = max;
    this.keys = new Set(); // in order of use, oldest first
  }

  /** @param {Array<{image_key?: string}>} items - from the Core */
  note(items) {
    for (const item of items) {
      const key = item && item.image_key;
      if (typeof key === 'string' && key) this._touch(key);
    }
  }

  /** Whether `key` came from the Core; using it keeps it. */
  use(key) {
    if (!this.keys.has(key)) return false;
    this._touch(key);
    return true;
  }

  _touch(key) {
    this.keys.delete(key);
    this.keys.add(key);
    if (this.keys.size > this.max) this.keys.delete(this.keys.values().next().value);
  }
}

module.exports = { ArtCache, ART_CACHE_BYTES, LARGEST_KEPT, KnownKeys, KNOWN_KEYS };
