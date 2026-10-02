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

/**
 * Finding Roon's browse menus on a Core in any language.
 *
 * Roon localises menu titles and the API doesn't say which language the Core
 * uses. The configured titles (English by default) are always tried first, so
 * an English Core behaves as before; these are the fallbacks when they aren't
 * found, chosen to fail safe rather than guess.
 */

const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

/**
 * A search category holds tracks when its items open straight into play actions
 * (hint "action_list"). Albums, artists and the rest open into further lists.
 */
function isTrackList(items) {
  const real = (items || []).filter((item) => item.item_key && item.hint !== 'header');
  return real.length > 0 && real.every((item) => item.hint === 'action_list');
}

/**
 * A track's action list is Play Now, Add Next, Queue, Start Radio. With no
 * title match, an action is taken by position, but only when the list has
 * exactly those four actions: any other shape means it isn't the list we know,
 * and pressing the wrong one (playing a guest's track straight away) is worse
 * than refusing.
 */
const ACTION_POSITION = { now: 0, next: 1, add: 2 };
const ACTIONS_IN_LIST = 4;

function pickAction(items, mode, wantedTitle) {
  const byTitle = (items || []).find((item) => item.item_key && same(item.title, wantedTitle));
  if (byTitle) return { item: byTitle, by: 'title' };

  const actions = (items || []).filter((item) => item.item_key && item.hint === 'action');
  if (actions.length !== ACTIONS_IN_LIST || actions.length !== (items || []).length) return null;
  const item = actions[ACTION_POSITION[mode]];
  return item ? { item, by: 'position' } : null;
}

/**
 * "Profile" in the languages Roon is translated into. A wrong guess here just
 * doesn't match, so the list errs on the side of including a word.
 */
const PROFILE_WORDS = [
  'Profile', // English
  'Profil', // German, French, Swedish, Danish, Norwegian, Polish, Czech
  'Perfil', // Spanish, Portuguese
  'Profilo', // Italian
  'Profiel', // Dutch
  'Profiili', // Finnish
  'Профиль', // Russian
  'プロフィール', // Japanese
  '프로필', // Korean
  '个人资料', // Chinese (simplified)
  '個人資料' // Chinese (traditional)
];

function findProfileEntry(menu, menuTitle) {
  const entries = (menu || []).filter((item) => item.item_key);
  const configured = entries.find((item) => same(item.title, menuTitle));
  if (configured) return { item: configured, by: 'title' };
  const known = entries.find((item) => PROFILE_WORDS.some((word) => same(item.title, word)));
  return known ? { item: known, by: 'language' } : null;
}

/**
 * Open the top-level entry of a browse hierarchy whose list satisfies
 * `holds(items)`: Library is the one holding a search box, Settings the one
 * holding the Profile entry, whatever they are called. `knownTitle` (found
 * earlier) is tried first; `fromEnd` starts at the bottom (Settings is last).
 * Leaves the session inside that entry and returns { title, items }, or null.
 */
async function openTopEntry(browse, load, at, holds, knownTitle, fromEnd) {
  const where = { hierarchy: at.hierarchy, multi_session_key: at.multi_session_key };
  const top = async () => {
    await browse(Object.assign({}, at, { pop_all: true }));
    return ((await load(Object.assign({ offset: 0, count: 100 }, where))) || {}).items || [];
  };
  let root = await top();
  let titles = root.filter((item) => item.item_key && item.hint === 'list').map((item) => item.title);
  if (fromEnd) titles.reverse();
  if (knownTitle && titles.includes(knownTitle)) titles = [knownTitle].concat(titles.filter((t) => t !== knownTitle));
  for (let i = 0; i < titles.length; i += 1) {
    if (i > 0) root = await top(); // keys may not survive going back up
    const entry = root.find((item) => item.item_key && item.title === titles[i]);
    if (!entry) continue;
    const opened = await browse(Object.assign({}, at, { item_key: entry.item_key }));
    if (!opened || opened.action !== 'list') continue;
    const items = ((await load(Object.assign({ offset: 0, count: 100 }, where))) || {}).items || [];
    if (holds(items)) return { title: titles[i], items };
  }
  return null;
}

/** Library's search box: the item that takes typed input. */
const isSearchBox = (item) => Boolean(item.item_key && item.input_prompt);

module.exports = { isTrackList, pickAction, findProfileEntry, openTopEntry, isSearchBox, PROFILE_WORDS, ACTION_POSITION };
