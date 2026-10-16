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

// The About page: Party Mode's version and licence, the open-source libraries
// it runs on (read from node_modules, so the list is always what's installed),
// and a little run-time information. In English only, unlike the other pages.
// Nothing on it is private: the Party Hub needs no login, so neither does
// this, and it shows no addresses, paths or settings.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PACKAGE = require('../package.json');
const { buildStamp } = require('./env');
const { debugEnabled } = require('./log');
const { isStation, MENU_NAMES } = require('./roon-service');
const OWN_LICENSE = path.join(ROOT, 'LICENSE');
const LICENSE_FILE = /^(licen[cs]e|copying)(\.(md|txt|markdown))?$|^licen[cs]e-mit(\.txt)?$/i;

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** "MIT", or "MIT OR Apache-2.0" from the old object and array forms. */
function licenseName(json) {
  const value = json.license || json.licenses;
  if (!value) return '';
  if (typeof value === 'string') return value;
  const list = Array.isArray(value) ? value : [value];
  return list.map((entry) => (typeof entry === 'string' ? entry : entry.type)).filter(Boolean).join(' OR ');
}

function authorName(json) {
  const author = json.author;
  if (!author) return '';
  if (typeof author === 'string') return author.replace(/\s*[<(].*$/, '').trim();
  return author.name || '';
}

/**
 * The licence file's own copyright lines (a few have more than one holder),
 * else the package's author. Not the licence's wording about "the above
 * copyright notice", nor the "Copyright [yyyy] [name of copyright owner]"
 * template in the appendix of Apache licence texts.
 */
function copyrightOf(text, json) {
  const lines = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim().replace(/\s+/g, ' ');
    if (!/(^|\s)(copyright\b|\(c\)|©)/i.test(trimmed)) continue;
    if (/copyright (notice|owner|holder|license|law|statement)|\[yyyy\]|\[name of/i.test(trimmed)) continue;
    // "(c)" starting a line is also how licences number their clauses.
    if (/^\(c\)/i.test(trimmed) && !/^\(c\) ?\d{4}/i.test(trimmed)) continue;
    if (!/^(copyright\b|\(c\)|©)/i.test(trimmed) && !/copyright \(c\)|\(c\) \d{4}/i.test(trimmed)) continue;
    lines.push(trimmed);
    if (lines.length === 3) break;
  }
  if (lines.length) return lines.join('; ');
  const author = authorName(json);
  return author ? `Copyright ${author}` : '';
}

/**
 * Every package under node_modules, nested ones included, once per name and
 * version, sorted by name. Each has its licence's name, copyright line and
 * licence file, if it has one.
 */
function readPackages(dir = path.join(ROOT, 'node_modules')) {
  const found = new Map();
  const walk = (folder) => {
    let names;
    try {
      names = fs.readdirSync(folder);
    } catch (err) {
      return;
    }
    for (const name of names) {
      if (name.startsWith('.')) continue;
      const full = path.join(folder, name);
      if (name.startsWith('@')) {
        walk(full);
        continue;
      }
      let json;
      try {
        json = JSON.parse(fs.readFileSync(path.join(full, 'package.json'), 'utf8'));
      } catch (err) {
        continue;
      }
      if (json.name && json.version) {
        const id = `${json.name}@${json.version}`;
        if (!found.has(id)) {
          const file = fs.readdirSync(full).find((f) => LICENSE_FILE.test(f));
          const text = file ? fs.readFileSync(path.join(full, file), 'utf8') : '';
          found.set(id, {
            id,
            name: json.name,
            version: json.version,
            // Roon's own packages don't name theirs; Party Mode's package.json
            // installs them from GitHub ("github:roonlabs/node-roon-api").
            url: repositoryUrl(json) || repositoryUrl({ repository: (PACKAGE.dependencies || {})[json.name] }),
            license: licenseName(json) || (/\bMIT License\b|Permission is hereby granted, free of charge/.test(text) ? 'MIT' : ''),
            copyright: copyrightOf(text, json),
            file: file ? path.join(full, file) : null
          });
        }
      }
      walk(path.join(full, 'node_modules'));
    }
  };
  walk(dir);
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

/** "3 days, 4 hours", "12 minutes", "less than a minute". */
function duration(seconds) {
  const parts = [
    [Math.floor(seconds / 86400), 'day'],
    [Math.floor(seconds / 3600) % 24, 'hour'],
    [Math.floor(seconds / 60) % 60, 'minute']
  ].filter(([n]) => n > 0);
  if (!parts.length) return 'less than a minute';
  return parts
    .slice(0, 2)
    .map(([n, unit]) => `${n} ${unit}${n === 1 ? '' : 's'}`)
    .join(', ');
}

const BASE_IMAGE = path.join(__dirname, '..', 'base-image');
const inContainer = () => fs.existsSync('/.dockerenv') || fs.existsSync('/run/.containerenv');

/**
 * How this copy was installed, from where its settings are kept: a folder or
 * volume on /data, a file mounted on config.json (the Extension Manager, and
 * Docker installs from before 1.4.0), or only inside the container, where
 * recreating it loses them.
 */
function installKind(mountinfo = '/proc/self/mountinfo', container = inContainer()) {
  if (!container) return 'Node.js';
  let mounts = [];
  try {
    mounts = fs.readFileSync(mountinfo, 'utf8').split('\n').map((line) => line.split(' ')[4]);
  } catch (err) {
    // not Linux, or not readable: say what's known
  }
  if (mounts.includes('/data/config.json') || mounts.includes('/usr/src/app/config.json')) {
    return 'Docker, settings in a mounted file (the Extension Manager, or an install from before 1.4.0)';
  }
  if (mounts.includes('/data')) return 'Docker, settings in a volume or folder';
  return 'Docker, settings inside the container (lost if it is recreated)';
}

const read = (file) => {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch (err) {
    return '';
  }
};

/**
 * When and from which commit the image was built: the publish workflow's
 * stamp, or for an image someone built themselves, "Custom build" and the day
 * it was built, from the file the build wrote (base-image). Empty outside a
 * container.
 */
function imageBuilt(stamp = buildStamp(), file = BASE_IMAGE, container = inContainer()) {
  if (!container) return '';
  if (stamp) return stamp;
  try {
    return `Custom build, ${fs.statSync(file).mtime.toISOString().slice(0, 10)}`;
  } catch (err) {
    return 'Custom build';
  }
}

// Party Mode's own files: what the image copies in, apart from node_modules.
const CODE = ['app.js', 'healthcheck.js', 'package.json', 'LICENSE', 'lib', 'public'];
const BINARY = /\.(png|ico|jpe?g|gif|webp|woff2?)$/i;

/**
 * A short checksum of Party Mode's own files, by path and content. Copies of
 * the same version from unchanged code show the same one, however they were
 * installed, and on Windows; a different one means the code was changed.
 * Worked out once.
 */
function fingerprint(root = ROOT) {
  const hash = crypto.createHash('sha256');
  // Read as a folder, else as a file: no separate check first, which the
  // file could change after.
  const add = (rel) => {
    const full = path.join(root, rel);
    try {
      for (const name of fs.readdirSync(full).sort()) add(path.posix.join(rel, name));
      return;
    } catch (err) {
      if (err.code !== 'ENOTDIR') return; // not there
    }
    let content;
    try {
      content = fs.readFileSync(full);
    } catch (err) {
      return;
    }
    // Line endings as in the repository: Git on Windows can check text files
    // out with CRLF. Images are left as they are; Git doesn't convert them.
    if (!BINARY.test(rel)) content = content.toString('utf8').replace(/\r\n/g, '\n');
    hash.update(`${rel}\0`).update(content).update('\0');
  };
  CODE.forEach(add);
  return hash.digest('hex').slice(0, 12);
}
let codeFingerprint = null;

/**
 * The image Party Mode is built on, from the Dockerfile's FROM line, which
 * the build writes into the image: "node:22-alpine (sha256:0a7108bf6c7b)".
 */
function baseImage(file = BASE_IMAGE) {
  const [name, digest] = read(file).split('@');
  if (!name) return '';
  return digest ? `${name} (${digest.slice(0, 19)})` : name;
}

/**
 * How locked down the container is: a read-only root, no capabilities, and
 * no way to gain privileges, as the README runs it. Empty outside a container.
 */
function lockdown(
  mountinfo = '/proc/self/mountinfo',
  status = '/proc/self/status',
  container = inContainer()
) {
  if (!container) return '';
  const root = read(mountinfo).split('\n').map((line) => line.split(' ')).find((f) => f[4] === '/');
  const field = (name) => (read(status).match(new RegExp(`^${name}:\\s*(\\S+)`, 'm')) || [])[1];
  const parts = [];
  if (root && root[5].split(',').includes('ro')) parts.push('read-only');
  // The bounding set: what --cap-drop ALL empties. The effective set is empty
  // for the node user anyway.
  if (/^0+$/.test(field('CapBnd') || '')) parts.push('no capabilities');
  if (field('NoNewPrivs') === '1') parts.push('no new privileges');
  return parts.length ? parts.join(', ') : "Docker's defaults";
}

/** The container's memory limit, from its cgroup: "256 MB", or "None". */
function memoryLimit(file = '/sys/fs/cgroup/memory.max') {
  const limit = read(file);
  if (!limit) return '';
  return limit === 'max' ? 'None' : `${Math.round(Number(limit) / (1024 * 1024))} MB`;
}

function count(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

/** "12, 1 failed": how many since Party Mode started, and how many Roon couldn't do. */
function tally(done, failed) {
  return failed ? `${done}, ${failed} failed` : String(done);
}

/**
 * The party zone, never by name: whether Roon has it, what it's doing, and
 * the Roon settings that change what guests see.
 */
function zoneRows(roon) {
  const chosen = roon.settings && roon.settings.zone && roon.settings.zone.output_id;
  if (!chosen) return [['Party zone', 'Not chosen yet']];
  const zone = roon.zone;
  if (!zone) return [['Party zone', roon.core ? 'Not available in Roon (switched off, unplugged or removed?)' : 'Waiting for the Roon Core']];

  const outputs = (zone.outputs || []).length;
  const state = { playing: 'Playing', paused: 'Paused', stopped: 'Stopped', loading: 'Loading' }[zone.state] || zone.state || 'Unknown';
  const queue = {
    subscribed: count(roon.queue.length, 'track') + ' in the queue',
    asked: 'Waiting for Roon',
    refused: 'Refused by Roon (trying again)',
    none: 'Not followed'
  }[roon.queueState] || roon.queueState;
  const zs = zone.settings || {};
  const loop = { disabled: 'Off', loop: 'Queue', loop_one: 'One track' }[zs.loop] || 'Off';
  return [
    ['Party zone', outputs > 1 ? `Available, ${outputs} grouped outputs` : 'Available'],
    ['Playback', isStation(zone) ? `${state}, a radio station` : state],
    ['Queue', queue],
    ['Roon Radio', zs.auto_radio ? 'On' : 'Off'],
    // Roon's own answer to "next", apart from the Skip tracks setting: no while
    // a radio station plays, or on the last track with Roon Radio off.
    ['Roon skip', zone.is_next_allowed ? 'Yes' : 'No'],
    ['Shuffle', zs.shuffle ? 'On' : 'Off'],
    ['Repeat', loop]
  ];
}

/**
 * The Guest requests settings, as Roon's settings name them: "On, 5 per guest,
 * one back every 10 minutes". Not the Flood protection numbers.
 */
function requestRows(settings = {}) {
  const allowance = (allowed, limit, refill) => {
    if (!allowed) return 'Off';
    if (!Number(limit)) return 'On, no limit';
    const minutes = Number(refill);
    const back = minutes ? `one back every ${minutes === 1 ? 'minute' : `${minutes} minutes`}` : 'none back';
    return `On, ${limit} per guest, ${back}`;
  };
  return [
    ['Block duplicates', settings.prevent_duplicates ? 'Yes' : 'No'],
    ['Add to queue', allowance(settings.allow_add, settings.add_limit, settings.add_refill)],
    ['Play it next', allowance(settings.allow_next, settings.next_limit, settings.next_refill)],
    ['Skip tracks', allowance(settings.allow_skip, settings.skip_limit, settings.skip_refill)]
  ];
}

/**
 * Roon's menu names that aren't the English ones, a line each under its
 * English name, and where it came from: "found" on this Core, or "set" in
 * the settings. Found wins, as Party Mode uses it; a name set in the settings
 * that wasn't found is shown beside it, as it's often a typo. Roon's own
 * words, nothing about the host or guests. One line, "English", otherwise.
 */
function menuNames(settings = {}, detected = {}) {
  const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
  const rows = [];
  for (const [setting, key, , english] of MENU_NAMES) {
    const set = String(settings[setting] || '').trim();
    const typed = set && !same(set, english) ? set : '';
    const found = detected[key];
    const label = `Roon menu "${english}"`;
    if (found && typed && !same(found, typed)) {
      rows.push([label, `"${found}", found\n(set as "${typed}")`]);
    } else if (found) {
      rows.push([label, `"${found}", found`]);
    } else if (typed) {
      rows.push([label, `"${typed}", set`]);
    }
  }
  return rows.length ? rows : [['Roon menu names', 'English']];
}

/** "2 hours ago, for 15 seconds", or "3 minutes ago, not back yet". */
function outage(last) {
  if (!last) return '';
  const gone = last.back ? `for ${duration((last.back - last.at) / 1000)}` : 'not back yet';
  return `${ago(last.at)} ago, ${gone}`;
}

/** "node (uid 1000)": the user Party Mode runs as. */
function runsAs() {
  try {
    const user = os.userInfo();
    return `${user.username} (uid ${user.uid})`;
  } catch (err) {
    return typeof process.getuid === 'function' ? `uid ${process.getuid()}` : '';
  }
}

function ago(since) {
  return since ? duration((Date.now() - since) / 1000) : '';
}

/**
 * What the page shows, in sections, as [label, value] rows: enough to start
 * troubleshooting from, and nothing a guest shouldn't see. Not the party zone's
 * name, which could be a speaker a guest's phone can play to directly (AirPlay,
 * say), going round the party; not the Roon Core's name, addresses, profile
 * names, paths or the Flood protection numbers.
 * @param {object} ctx - { roon, guests, playlist, stats, streams } from lib/server.js
 * @param {number} [port] - the port this page was asked for on
 */
function runtime({ roon, guests, playlist, stats, streams }, port) {

  const mode = roon.currentMode || 'off';
  let party = { on: 'On', paused: 'Paused', off: 'Off' }[mode] || mode;
  if (mode === 'paused' && roon.zoneHold) {
    party = roon.holdForCore ? "Paused by itself: the Roon Core can't be reached" : "Paused by itself: the party zone isn't available";
  }
  const requested = playlist ? playlist.tracks.filter((track) => track.guest).length : 0;
  const joined = guests ? guests.sessions.size : 0;
  // Open pages, from their live-update connections: a guest with the page
  // open on two devices counts once.
  const open = [...(streams || [])];
  const guestsHere = new Set(open.map((res) => res.guestId).filter(Boolean)).size;
  const hubs = open.filter((res) => !res.guestId).length;

  const art = roon.artCache;
  const served = art ? art.hits + art.misses : 0;
  const mb = (bytes) => Math.round(bytes / (1024 * 1024));

  const setting = roon.settings && roon.settings.port;
  let webPort = String(port || '');
  if (port && setting && Number(setting) !== port) webPort += ` (${setting} was busy)`;

  let saved = roon.configWritable === false ? "Can't be saved: see Party Mode's status in Roon" : 'Saved';
  if (roon.settingsRejected) saved += `; last change not saved (${roon.settingsRejected})`;

  return [
    ['Installation', [
      ['Installed with', installKind()],
      ['Image built', imageBuilt()],
      ['Code fingerprint', (codeFingerprint = codeFingerprint || fingerprint())],
      ['Base image', baseImage()],
      ['Alpine Linux', read('/etc/alpine-release')],
      ['Node.js', process.version.replace(/^v/, '')],
      ['Platform', `${os.platform()} ${os.arch()}`],
      ['Kernel', os.release()],
      ['Hardware', `${count(os.cpus().length, 'CPU')}, ${(os.totalmem() / 1024 ** 3).toFixed(1)} GB memory`],
      ['Memory limit', memoryLimit()],
      ['Runs as', runsAs()],
      ['Locked down', lockdown()],
      ['Running for', duration(process.uptime())],
      ['Memory in use', `${mb(process.memoryUsage().rss)} MB`]
    ]],
    ['Roon', [
      ['Roon Core', roon.core ? `Connected for ${ago(roon.coreSince) || 'a moment'}` : 'Not connected'],
      ['Roon Core version', roon.core && roon.core.display_version ? String(roon.core.display_version) : ''],
      ['Connection lost', `${count(roon.coreLost || 0, 'time')} since Party Mode started`],
      ['Last lost', outage(roon.lastOutage)],
      ['Roon profile', roon.profileProblem ? "A problem: see Party Mode's status in Roon" : 'Working'],
      ...menuNames(roon.settings, roon.detected),
      ...zoneRows(roon)
    ]],
    ['Party', [
      ['Party mode', party],
      ['Started', playlist ? `${ago(playlist.started)} ago` : ''],
      ['Guests', `${joined} joined, ${guestsHere} on the page now`],
      ['Party Hub', `${hubs} open`],
      ['Tracks requested', stats && stats.requestsFailed ? `${requested}, and ${stats.requestsFailed} Roon couldn't add` : String(requested)],
      ['Searches', stats ? tally(stats.searches, stats.searchesFailed) : ''],
      ['Skips', stats ? tally(stats.skips, stats.skipsFailed) : ''],
      ...requestRows(roon.settings)
    ]],
    ['Health', [
      ['Settings', saved],
      ['Detailed log', debugEnabled() ? "On (it records guests' searches)" : 'Off'],
      ['Album art', art
        ? `${art.images.size} covers kept (${mb(art.bytes)} of ${mb(art.maxBytes)} MB), ${served ? Math.round((100 * art.hits) / served) : 0}% from memory`
        : ''],
      ['"Too many requests"', `${stats ? stats.tooMany : 0} since Party Mode started`],
      ['Web port', webPort]
    ]]
  ].map(([title, rows]) => [title, rows.filter(([, value]) => value)]);
}

/**
 * A library's repository as a web address, from its package.json: the
 * repository field in any of the forms npm accepts ("user/repo",
 * "github:user/repo", git+https, git://, git@host:path, git+ssh), else its
 * homepage. Only https addresses, else ''.
 */
function repositoryUrl(json) {
  const repo = json.repository;
  // A git address's #commit or #branch is dropped.
  let url = String((repo && typeof repo === 'object' ? repo.url : repo) || '').trim().replace(/#.*$/, '');
  const short = url.match(/^(?:(github|gitlab|bitbucket):)?([\w.-]+\/[\w.-]+)$/);
  if (short) {
    const host = { gitlab: 'gitlab.com', bitbucket: 'bitbucket.org' }[short[1]] || 'github.com';
    url = `https://${host}/${short[2]}`;
  }
  url = url
    .replace(/^git\+/, '')
    .replace(/^(?:ssh:\/\/)?git@([^:/]+)[:/]/, 'https://$1/')
    .replace(/^(?:git|http):\/\//, 'https://')
    .replace(/\.git$/, '');
  if (!/^https:\/\//.test(url)) url = String(json.homepage || '').trim();
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' ? parsed.href.replace(/\/$/, '') : '';
  } catch (err) {
    return '';
  }
}

/**
 * Software Party Mode works with but doesn't include, listed with the
 * libraries: no version (it isn't in the image), and its licence linking to
 * its repository rather than a file in node_modules.
 */
const ALONGSIDE = [
  {
    name: 'roon-extension-manager',
    version: '',
    license: 'Apache-2.0',
    url: 'https://github.com/TheAppgineer/roon-extension-manager',
    licenseUrl: 'https://github.com/TheAppgineer/roon-extension-manager',
    copyright: 'By TheAppgineer'
  }
];

function licenseLink(id, label) {
  return `<a href="/About/license/${encodeURIComponent(id)}">${escapeHtml(label)}</a>`;
}

function page(ctx, port, packages) {
  const sections = runtime(ctx, port)
    .map(([title, rows]) => `<section>
        <h2>${escapeHtml(title)}</h2>
        <table class="facts">
          ${rows.map(([label, value]) => `<tr><th scope="row">${escapeHtml(label)}</th><td>${value.split('\n').map(escapeHtml).join('<br />')}</td></tr>`).join('\n          ')}
        </table>
      </section>`)
    .join('\n\n      ');
  const libraries = packages
    .map((p) => {
      const license = p.license || 'See its licence';
      let lic = escapeHtml(license);
      if (p.file) lic = licenseLink(p.id, license);
      else if (p.licenseUrl) lic = `<a href="${p.licenseUrl}" target="_blank" rel="noopener">${lic}</a>`;
      // The name links to the project; the licence to its text in this copy.
      const name = p.url ? `<a href="${escapeHtml(p.url)}" target="_blank" rel="noopener">${escapeHtml(p.name)}</a>` : escapeHtml(p.name);
      return `<li><span class="lib">${name} <span class="ver">${escapeHtml(p.version)}</span></span>` +
        `<span class="lic">${lic}</span>` +
        (p.copyright ? `<span class="who">${escapeHtml(p.copyright)}</span>` : '') +
        '</li>';
    })
    .join('\n        ');
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>About Party Mode</title>
    <link rel="icon" href="/favicon.ico" sizes="32x32" />
    <link rel="icon" href="/icon.svg" type="image/svg+xml" />
    <link rel="stylesheet" href="/party.css" />
    <link rel="stylesheet" href="/about.css" />
  </head>
  <body class="about">
    <main>
      <h1>About Party Mode</h1>
      <p class="tagline">${escapeHtml(PACKAGE.description)}.</p>

      <section>
        <h2>Party Mode</h2>
        <p>Version ${escapeHtml(PACKAGE.version)}. Copyright © 2026 Stubaggs.<br />
        Licensed under the ${licenseLink('party-mode', 'Apache License, Version 2.0')}.</p>
        <p>Roon is a trademark of Roon Labs LLC. Party Mode is not made or endorsed by Roon Labs.</p>
        <p><a href="https://community.roonlabs.com/t/party-mode-extension/325638" target="_blank" rel="noopener">Roon forum</a> ·
        <a href="https://github.com/stubaggs/roon-extension-party-mode/blob/main/README.md" target="_blank" rel="noopener">Instructions and releases</a></p>
      </section>

      <p class="help">Asking for help on the forum? Copy these details into your post.</p>
      <div class="details" data-title="Party Mode ${escapeHtml(PACKAGE.version)}">
        <div class="copy-bar">
          <span id="copied" class="tagline" role="status"></span>
          <button type="button" id="copy-details" hidden>
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
              <rect x="8" y="8" width="12" height="12" rx="2" />
              <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
            </svg>
            Copy details
          </button>
        </div>

      ${sections}
      </div>

      <section>
        <h2>With thanks</h2>
        <p>Party Mode stands on the shoulders of the open-source community. A heartfelt
        thank you to everyone who writes, maintains and shares the libraries below, often in
        their own time and for nothing in return; to the <a href="https://nodejs.org" target="_blank" rel="noopener">Node.js</a>
        and <a href="https://alpinelinux.org" target="_blank" rel="noopener">Alpine Linux</a> projects it runs on; and to Roon Labs, whose
        Roon API lets extensions like this one exist.</p>
        <h3>Open-source licences</h3>
        <p>Each library is under its own licence, linked beside it. The Docker image is based
        on the official node:22-alpine image, whose packages carry their own licences.</p>
        <ul class="libs">
        ${libraries}
        </ul>
      </section>
    </main>
    <script src="/about.js"></script>
  </body>
</html>
`;
}

function licensePage(name, text) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Licence: ${escapeHtml(name)}</title>
    <link rel="icon" href="/favicon.ico" sizes="32x32" />
    <link rel="icon" href="/icon.svg" type="image/svg+xml" />
    <link rel="stylesheet" href="/party.css" />
    <link rel="stylesheet" href="/about.css" />
  </head>
  <body class="about">
    <main>
      <p><a href="/About">← About Party Mode</a></p>
      <h1>${escapeHtml(name)}</h1>
      <pre class="license">${escapeHtml(text)}</pre>
    </main>
  </body>
</html>
`;
}

/**
 * The About page and its licence texts, for lib/server.js. The packages are
 * read on the first visit and kept: they only change with a new image.
 */
function aboutRoutes(app, ctx) {
  let packages = null;
  const list = () =>
    (packages = packages || readPackages().concat(ALONGSIDE).sort((a, b) => a.name.localeCompare(b.name)));

  app.get('/About', (req, res) => {
    res.set('Cache-Control', 'no-cache').type('html').send(page(ctx, req.socket.localPort, list()));
  });

  // A licence's full text, by the name and version the page links to: only
  // files found above, never a path from the address. As a page in the
  // About page's style rather than plain text, which Safari shows with a
  // stylesheet of its own that the pages' Content-Security-Policy refuses.
  app.get('/About/license/:id', (req, res) => {
    const own = req.params.id === 'party-mode';
    const entry = own ? { name: 'Party Mode', file: OWN_LICENSE } : list().find((p) => p.id === req.params.id);
    if (!entry || !entry.file) return res.status(404).type('text').send('Not found');
    fs.readFile(entry.file, 'utf8', (err, text) => {
      if (err) return res.status(404).type('text').send('Not found');
      res.set('Cache-Control', 'max-age=86400').type('html').send(licensePage(own ? 'Party Mode' : entry.id, text));
    });
  });
}

module.exports = { aboutRoutes, readPackages, repositoryUrl, copyrightOf, licenseName, duration, runtime, installKind, menuNames, imageBuilt, fingerprint, baseImage, lockdown, memoryLimit };
