'use strict';

/**
 * Roon profile for guest requests.
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

const HIERARCHY = 'settings';
// A browse session of our own, so this never disturbs a guest's search.
const SESSION = 'party-profile';

const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

async function loadAll(load) {
  const page = await load({ hierarchy: HIERARCHY, multi_session_key: SESSION, offset: 0, count: 100 });
  return (page && page.items) || [];
}

/**
 * @returns {{ profiles: Array<{title, subtitle, item_key}>|null, menu: string[] }}
 *   profiles is null when the menu has no entry called `menuTitle`; menu lists
 *   the titles that were there, for the log.
 */
async function listProfiles(browse, load, menuTitle) {
  await browse({ hierarchy: HIERARCHY, multi_session_key: SESSION, pop_all: true });
  const menu = await loadAll(load);
  const entry = menu.find((item) => item.item_key && same(item.title, menuTitle));
  const titles = menu.map((item) => item.title);
  if (!entry) return { profiles: null, menu: titles };

  const opened = await browse({ hierarchy: HIERARCHY, multi_session_key: SESSION, item_key: entry.item_key });
  if (!opened || opened.action !== 'list') return { profiles: null, menu: titles };
  const items = await loadAll(load);
  return {
    profiles: items
      .filter((item) => item.item_key && item.title)
      .map((item) => ({ title: item.title, subtitle: item.subtitle || '', item_key: item.item_key })),
    menu: titles
  };
}

/**
 * Switch to the profile called `name`.
 * @returns {{ ok: boolean, reason?: string, profiles?: string[], menu?: string[] }}
 */
async function selectProfile(browse, load, menuTitle, name) {
  const { profiles, menu } = await listProfiles(browse, load, menuTitle);
  if (!profiles) return { ok: false, reason: 'no_menu', menu };
  const profile = profiles.find((item) => same(item.title, name));
  if (!profile) return { ok: false, reason: 'no_profile', profiles: profiles.map((p) => p.title) };
  await browse({ hierarchy: HIERARCHY, multi_session_key: SESSION, item_key: profile.item_key });
  return { ok: true };
}

module.exports = { listProfiles, selectProfile };
