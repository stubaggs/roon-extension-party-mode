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

/**
 * Loaded first by the Party Hub (hub.html): a browser that can't show it is
 * sent to the basic Party Hub instead, a TV's built-in browser years behind
 * most often. The Party Hub needs CSS clamp() (Chrome 79, Safari 13.1, Firefox
 * 75) and MediaQueryList events (Safari 14); everything else it uses is older.
 * Plain ES5, so the oldest browsers run it.
 */
(function () {
  'use strict';

  var able = false;
  try {
    able = Boolean(
      window.CSS && CSS.supports && CSS.supports('width', 'clamp(1px, 2px, 3px)') &&
        window.matchMedia && typeof window.matchMedia('all').addEventListener === 'function'
    );
  } catch (err) {
    able = false;
  }
  if (!able) window.location.replace('/PartyHub/Basic');
})();
