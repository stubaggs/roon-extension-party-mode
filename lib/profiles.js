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
 * Party profile setting.
 *
 * Roon keeps the profile per browse session (multi_session_key): a queue action
 * is credited to the profile selected in the session that made it, and a session
 * nobody has selected one in uses Roon's default. So the profile is selected in
 * the extension's own session (to read the list) and again in each guest's
 * session before it searches or queues; see RoonService._profileFor.
 *
 * The API has no "set profile" call. Roon's browse service exposes its Settings
 * menu as the "settings" hierarchy, which has a "Profile" entry listing the
 * profiles; selecting one switches the profile Roon uses for this extension's
 * connection. Everything guests do goes through that connection, so their
 * plays count toward that profile's history and Roon Radio.
 *
 * Roon localises menu titles, so the entry's title is passed in (a setting,
 * "Profile" in English). Functions take the extension's promise-returning
 * browse/load helpers so they can be tested without a Core.
 */

const { findProfileEntry, openTopEntry } = require('./titles');

const HIERARCHY = 'settings';
// The extension's own browse session, for reading the list without disturbing
// a guest's. Callers pass a guest's session key to select the profile there.
const SESSION = 'party-profile';

const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

async function loadAll(load, session) {
  const page = await load({ hierarchy: HIERARCHY, multi_session_key: session, offset: 0, count: 100 });
  return (page && page.items) || [];
}

/**
 * @returns {{ profiles: Array<{title, subtitle, item_key}>|null, menu: string[] }}
 *   profiles is null when the menu has no entry called `menuTitle`; menu lists
 *   the titles that were there, for the log.
 */
async function listProfiles(browse, load, menuTitle, session = SESSION) {
  await browse({ hierarchy: HIERARCHY, multi_session_key: session, pop_all: true });
  const menu = await loadAll(load, session);
  const found = findProfileEntry(menu, menuTitle);
  const titles = menu.map((item) => item.title);
  if (!found) return { profiles: null, menu: titles };
  const entry = found.item;

  const opened = await browse({ hierarchy: HIERARCHY, multi_session_key: session, item_key: entry.item_key });
  if (!opened || opened.action !== 'list') return { profiles: null, menu: titles };
  const items = await loadAll(load, session);
  return {
    // The entry's title as Roon shows it, when found by language rather than setting.
    entryTitle: found.by === 'title' ? null : entry.title,
    // What Roon shows next to the entry, normally the session's current profile.
    current: entry.subtitle || null,
    profiles: items
      .filter((item) => item.item_key && item.title)
      .map((item) => ({ title: item.title, subtitle: item.subtitle || '', item_key: item.item_key })),
    menu: titles
  };
}

/**
 * Switch the browse session `session` to the profile called `name`.
 * @returns {{ ok: boolean, reason?: string, profiles?: string[], menu?: string[] }}
 */
async function selectProfile(browse, load, menuTitle, name, session = SESSION) {
  const { profiles, menu, current } = await listProfiles(browse, load, menuTitle, session);
  if (!profiles) return { ok: false, reason: 'no_menu', menu };
  const profile = profiles.find((item) => same(item.title, name));
  if (!profile) return { ok: false, reason: 'no_profile', profiles: profiles.map((p) => p.title) };
  const answer = await browse({ hierarchy: HIERARCHY, multi_session_key: session, item_key: profile.item_key });
  // Read the menu again to see what Roon now reports as the current profile.
  const after = await listProfiles(browse, load, menuTitle, session);
  return {
    ok: true,
    before: current,
    after: after.current,
    answer: answer && (answer.action + (answer.message ? `: ${answer.message}` : '')),
    options: profiles.map((p) => `${p.title}${p.subtitle ? ` [${p.subtitle}]` : ''}`)
  };
}

/**
 * Select the profile in a guest's session of the "browse" hierarchy, through
 * Settings → Profile there. Roon keeps the profile per hierarchy within a
 * session, and guests search and queue in "browse", so that is where it has to
 * be selected for their requests to count toward it.
 *
 * @param known { settings } - the Settings entry's title, found on an earlier call
 * @returns {{ ok, reason?, settingsTitle?, before?, after?, answer?, profiles?, menu? }}
 */
async function selectProfileInBrowse(browse, load, menuTitle, name, session, known = {}) {
  const at = { hierarchy: 'browse', multi_session_key: session };
  const holdsProfile = (items) => Boolean(findProfileEntry(items, menuTitle));
  const settingsMenu = await openTopEntry(browse, load, at, holdsProfile, known.settings, true);
  if (!settingsMenu) return { ok: false, reason: 'no_menu', menu: [] };

  const entry = findProfileEntry(settingsMenu.items, menuTitle).item;
  const before = entry.subtitle || null;
  const opened = await browse(Object.assign({ item_key: entry.item_key }, at));
  if (!opened || opened.action !== 'list') {
    return { ok: false, reason: 'no_menu', menu: settingsMenu.items.map((item) => item.title) };
  }
  const page = await load(Object.assign({ offset: 0, count: 100 }, at));
  const profiles = (page && page.items) || [];
  const profile = profiles.find((item) => item.item_key && same(item.title, name));
  if (!profile) return { ok: false, reason: 'no_profile', profiles: profiles.map((item) => item.title) };
  const answer = await browse(Object.assign({ item_key: profile.item_key }, at));

  // Read Settings again: the Profile entry's subtitle is the session's profile.
  const again = await openTopEntry(browse, load, at, holdsProfile, settingsMenu.title, true);
  const after = again ? findProfileEntry(again.items, menuTitle).item.subtitle || null : null;
  return { ok: true, settingsTitle: settingsMenu.title, before, after, answer: answer && answer.action };
}

module.exports = { listProfiles, selectProfile, selectProfileInBrowse };
