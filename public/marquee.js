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

/**
 * Scrolls track and artist names that don't fit their space: pause, slide to
 * show the end, slide back, twice, then stop with the "…" back (party.css sets
 * the count; hovering pauses it). Names that fit are left alone. Each page
 * lists its selectors in data-marquee on the <script> tag that loads this file.
 */
(function () {
  'use strict';

  const SPEED = 40; // px per second while sliding
  const selectors = document.currentScript.dataset.marquee;
  // With reduced motion, long names keep their "…" instead.
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  // When a page redraws a name that was already scrolling, carry on from where
  // it was instead of starting over (the Party Hub redraws every 30s).
  const started = new Map();
  // Names that have had their turn; they keep their "…" until they leave the page.
  const finished = new Set();

  function unwrap(target) {
    const inner = target.querySelector(':scope > .marquee-inner');
    if (!inner) return;
    target.append(...inner.childNodes);
    inner.remove();
    target.classList.remove('marquee-on');
  }

  function apply(target) {
    let inner = target.querySelector(':scope > .marquee-inner');
    if (inner && target.childNodes.length !== 1) {
      // The page replaced the text next to our wrapper; start over.
      unwrap(target);
      inner = null;
    }
    if (inner) return;
    if (finished.has(target.textContent)) return;
    if (target.scrollWidth <= target.clientWidth + 1) return;

    inner = document.createElement('span');
    inner.className = 'marquee-inner';
    inner.append(...target.childNodes);
    target.appendChild(inner);

    const shift = inner.scrollWidth - target.clientWidth;
    if (shift <= 1) {
      unwrap(target);
      return;
    }
    // The slide takes 70% of each half cycle; the rest is the pause at each end.
    const seconds = Math.max(4, shift / SPEED / 0.7);
    const text = target.textContent;
    if (!started.has(text)) started.set(text, performance.now());
    const elapsed = (performance.now() - started.get(text)) / 1000;
    inner.style.setProperty('--marquee-shift', `${-shift}px`);
    inner.style.setProperty('--marquee-time', `${seconds.toFixed(2)}s`);
    inner.style.animationDelay = `${-elapsed.toFixed(2)}s`;
    inner.addEventListener('animationend', () => {
      finished.add(text);
      unwrap(target);
    });
    target.classList.add('marquee-on');
  }

  let scheduled = false;
  function scan() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      const targets = document.querySelectorAll(selectors);
      targets.forEach(apply);
      // Forget names that are no longer on the page.
      const shown = new Set([...targets].map((target) => target.textContent));
      for (const text of started.keys()) if (!shown.has(text)) started.delete(text);
      for (const text of finished) if (!shown.has(text)) finished.delete(text);
    });
  }

  // The pages rebuild their lists on every update, so watch for that.
  new MutationObserver(scan).observe(document.body, { childList: true, subtree: true, characterData: true });

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      document.querySelectorAll(selectors).forEach(unwrap);
      scan();
    }, 150);
  });

  if (document.fonts && document.fonts.ready) document.fonts.ready.then(scan);
  scan();
})();
