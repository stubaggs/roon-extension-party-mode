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

// The About page: Party Mode's version and licence, the open-source libraries
// it runs on (read from node_modules, so the list is always what's installed),
// and a little run-time information. In English only, unlike the other pages.
// Nothing on it is private: the Party Hub needs no login, so neither does
// this, and it shows no addresses, paths or settings.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { monitorEventLoopDelay } = require('perf_hooks');

const ROOT = path.join(__dirname, '..');
const PACKAGE = require('../package.json');
const { buildStamp } = require('./env');
const { debugEnabled, warningCount } = require('./log');
const { isStation, MENU_NAMES, hubPlaying } = require('./roon-service');
const OWN_LICENSE = path.join(ROOT, 'LICENSE');
const OWN_NOTICE = path.join(ROOT, 'NOTICE');
const LICENSE_FILE = /^(licen[cs]e|copying)(\.(md|txt|markdown))?$|^licen[cs]e-mit(\.txt)?$/i;
const README_FILE = /^readme(\.(md|markdown|txt))?$/i;

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
  const all = text.split('\n');
  for (const [i, line] of all.entries()) {
    let trimmed = line.trim().replace(/\s+/g, ' ');
    if (!/(^|\s)(copyright\b|\(c\)|©)/i.test(trimmed)) continue;
    if (/copyright (notice|owner|holder|license|law|statement)|\[yyyy\]|\[name of/i.test(trimmed)) continue;
    // "(c)" starting a line is also how licences number their clauses.
    if (/^\(c\)/i.test(trimmed) && !/^\(c\) ?\d{4}/i.test(trimmed)) continue;
    if (!/^(copyright\b|\(c\)|©)/i.test(trimmed) && !/copyright \(c\)|\(c\) \d{4}/i.test(trimmed)) continue;
    // Only "Copyright (C) 2008": the holder is on the next line.
    if (!/[a-z]/i.test(trimmed.replace(/copyright|\(c\)/gi, ''))) {
      const next = all.slice(i + 1).find((l) => l.trim());
      if (next) trimmed = `${trimmed} ${next.trim().replace(/\s+/g, ' ')}`;
    }
    lines.push(trimmed);
    if (lines.length === 3) break;
  }
  if (lines.length) return lines.join('; ');
  const author = authorName(json);
  return author ? `Copyright ${author}` : '';
}

/**
 * The licence section of a Readme, for a package that ships no licence file:
 * from a heading naming the licence to the next heading as high or higher.
 * Empty if it has none.
 */
function readmeLicense(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^#{1,6}\s.*licen[cs]e/i.test(l));
  if (start < 0) return '';
  const level = lines[start].match(/^#+/)[0].length;
  const end = lines.findIndex((l, i) => i > start && (l.match(/^(#{1,6})\s/) || [])[1]?.length <= level);
  const entities = { lt: '<', gt: '>', amp: '&', quot: '"', '#39': "'" };
  return lines
    .slice(start + 1, end < 0 ? undefined : end)
    .join('\n')
    .replace(/&(lt|gt|amp|quot|#39);/g, (m, e) => entities[e])
    .trim();
}

/** A package's dependencies, by name, as its code requires them. */
function requiredNames(text) {
  const names = new Set();
  for (const [, spec] of text.matchAll(/(?:require\s*\(\s*|\bfrom\s+|import\s*\(\s*)['"]([^'"./][^'"]*)['"]/g)) {
    names.add(spec.split('/').slice(0, spec.startsWith('@') ? 2 : 1).join('/'));
  }
  return names;
}

/**
 * The dependencies a package installs only for its command-line tool (its
 * `bin`): none of its other code requires them. qrcode's, for one, installs
 * yargs and all yargs needs. Only packages with a `bin` are read.
 */
function cliOnly(dir, json) {
  const bin = typeof json.bin === 'string' ? [json.bin] : Object.values(json.bin || {});
  if (!bin.length) return [];
  const bins = new Set(bin.map((b) => path.join(dir, b)));
  const used = new Set();
  const scan = (folder) => {
    let entries;
    try {
      entries = fs.readdirSync(folder, { withFileTypes: true });
    } catch (err) {
      return;
    }
    for (const e of entries) {
      const full = path.join(folder, e.name);
      if (e.isDirectory()) {
        if (e.name !== 'node_modules') scan(full);
      } else if (/\.(c|m)?js$/.test(e.name) && !bins.has(full)) {
        requiredNames(fs.readFileSync(full, 'utf8')).forEach((n) => used.add(n));
      }
    }
  };
  scan(dir);
  return Object.keys(json.dependencies || {}).filter((name) => !used.has(name));
}

/**
 * Marks the packages installed only for a dependency's command-line tool,
 * which Party Mode never runs: each gets a `note` naming that dependency.
 * Followed from Party Mode's own dependencies, as Node finds them (the
 * package's own node_modules, then each folder above).
 */
function markUnused(byDir, top, rootDeps) {
  const resolve = (from, name) => {
    for (let d = from; ; d = path.dirname(d)) {
      const hit = byDir.get(path.join(d, 'node_modules', name));
      if (hit) return hit;
      if (d === top || d === path.dirname(d)) return null;
    }
  };
  const edges = (pkg) => {
    const skip = new Set(cliOnly(pkg.dir, pkg.json));
    return Object.keys(pkg.json.dependencies || {})
      .concat(Object.keys(pkg.json.optionalDependencies || {}))
      .map((name) => ({ to: resolve(pkg.dir, name), cli: skip.has(name) }))
      .filter((e) => e.to);
  };
  const used = new Set();
  const queue = rootDeps.map((name) => resolve(top, name)).filter(Boolean);
  while (queue.length) {
    const pkg = queue.shift();
    if (used.has(pkg)) continue;
    used.add(pkg);
    edges(pkg).filter((e) => !e.cli).forEach((e) => queue.push(e.to));
  }
  // Who brought in the rest, for the note: the package whose tool needs it.
  const owner = new Map();
  const next = [];
  for (const pkg of used) edges(pkg).filter((e) => e.cli && !used.has(e.to)).forEach((e) => next.push([e.to, pkg.json.name]));
  while (next.length) {
    const [pkg, name] = next.shift();
    if (owner.has(pkg)) continue;
    owner.set(pkg, name);
    edges(pkg).filter((e) => !used.has(e.to)).forEach((e) => next.push([e.to, name]));
  }
  return { used, owner };
}

/**
 * Every package under node_modules, nested ones included, once per name and
 * version, sorted by name. Each has its licence's name, copyright line and
 * licence file (else its Readme's licence section), if it has one, and a
 * note if it's installed only for a dependency's command-line tool.
 */
function readPackages(dir = path.join(ROOT, 'node_modules')) {
  const found = new Map();
  const byDir = new Map();
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
        byDir.set(full, { id, dir: full, json });
        if (!found.has(id)) {
          const files = fs.readdirSync(full);
          let file = files.find((f) => LICENSE_FILE.test(f));
          let text = file ? fs.readFileSync(path.join(full, file), 'utf8') : '';
          let fromReadme = false;
          if (!file) {
            const readme = files.find((f) => README_FILE.test(f));
            text = readme ? readmeLicense(fs.readFileSync(path.join(full, readme), 'utf8')) : '';
            if (text) [file, fromReadme] = [readme, true];
          }
          found.set(id, {
            id,
            name: json.name,
            version: json.version,
            // Roon's own packages don't name theirs; Party Mode's package.json
            // installs them from GitHub ("github:roonlabs/node-roon-api").
            url: repositoryUrl(json) || repositoryUrl({ repository: (PACKAGE.dependencies || {})[json.name] }),
            license: licenseName(json) || (/\bMIT License\b|Permission is hereby granted, free of charge/.test(text) ? 'MIT' : ''),
            copyright: copyrightOf(text, json),
            file: file ? path.join(full, file) : null,
            fromReadme
          });
        }
      }
      walk(path.join(full, 'node_modules'));
    }
  };
  walk(dir);
  // Party Mode's own dependencies, or a test folder's.
  let rootJson = PACKAGE;
  try {
    rootJson = JSON.parse(fs.readFileSync(path.join(path.dirname(dir), 'package.json'), 'utf8'));
  } catch (err) {
    /* Party Mode's */
  }
  const { used, owner } = markUnused(byDir, path.dirname(dir), Object.keys(rootJson.dependencies || {}));
  for (const pkg of byDir.values()) {
    const entry = found.get(pkg.id);
    if (used.has(pkg)) entry.used = true;
    else if (owner.has(pkg) && !entry.cliOf) entry.cliOf = owner.get(pkg);
  }
  for (const entry of found.values()) {
    if (!entry.used && entry.cliOf) entry.note = `Installed with ${entry.cliOf} package`;
    delete entry.used;
    delete entry.cliOf;
  }
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
 * stamp, or "Custom build" for an image someone built themselves. No date for
 * those: Docker's build cache reuses files with their old times, and the code
 * fingerprint tells one build from another. Empty outside a container.
 */
function imageBuilt(stamp = buildStamp(), container = inContainer()) {
  if (!container) return '';
  return stamp || 'Custom build';
}

// Party Mode's own files: what the image copies in, apart from node_modules.
const CODE = ['app.js', 'healthcheck.js', 'package.json', 'LICENSE', 'NOTICE', 'lib', 'public'];
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
 * How the container is hardened: a read-only root, no capabilities, and
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
  return parts.length ? parts.join(', ') : "None (the container's defaults)";
}

/**
 * The container's memory limit, from its cgroup: "256 MB", or "None". cgroup v2
 * first; then, inside a container only, cgroup v1 (older kernels, such as
 * Synology's), where no limit is a huge number that depends on the page size,
 * so anything from the machine's memory up counts as none.
 */
function memoryLimit(
  file = '/sys/fs/cgroup/memory.max',
  v1File = '/sys/fs/cgroup/memory/memory.limit_in_bytes',
  container = inContainer(),
  total = os.totalmem()
) {
  let limit = read(file);
  if (!limit && container) {
    limit = read(v1File);
    if (limit && Number(limit) >= total) limit = 'max';
  }
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

// How long Party Mode was too busy to answer (its event loop held up), since it
// started. Each reading includes the 20 ms between checks, which is taken off.
const LOOP_RESOLUTION_MS = 20;
const loopDelay = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS });
loopDelay.enable();

// CPU use, as a share of one CPU (Node runs on one), over each CPU_SAMPLE_MS:
// the last, and the most.
const CPU_SAMPLE_MS = 10000;
const cpu = { last: process.cpuUsage(), at: Date.now(), now: null, most: 0 };
function sampleCpu() {
  const used = process.cpuUsage(cpu.last);
  const elapsed = Date.now() - cpu.at;
  cpu.last = process.cpuUsage();
  cpu.at = Date.now();
  if (elapsed <= 0) return;
  cpu.now = Math.round((100 * (used.user + used.system)) / 1000 / elapsed);
  cpu.most = Math.max(cpu.most, cpu.now);
}
setInterval(sampleCpu, CPU_SAMPLE_MS).unref();

/** "3% now, 40% at most", or nothing until the first sample. */
function cpuUse(sample = cpu) {
  return sample.now === null ? '' : `${sample.now}% now, ${sample.most}% at most`;
}

const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;

/** The median of recent times, in ms. */
function typical(times) {
  const sorted = [...times].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** "0.4 s typical, 3.2 s slowest": the Core's time over guests' searches. */
function searchTime(roon) {
  const times = roon.searchTimes || [];
  if (!times.length) return 'No searches yet';
  return `${seconds(typical(times))} typical, ${seconds(roon.searchSlowest || 0)} slowest`;
}

/** "0.7 s typical, 3.1 s slowest, 0 timed out": guests' searches, requests and skips, start to finish. */
function guestActions(roon) {
  const times = roon.actionTimes || [];
  const timedOut = `${roon.timedOut || 0} timed out`;
  if (!times.length) return roon.timedOut ? timedOut : 'None yet';
  return `${seconds(typical(times))} typical, ${seconds(roon.actionSlowest || 0)} slowest, ${timedOut}`;
}

/** "2 typical, 9 at most": guests' searches running at once, while any ran, rounded. */
function concurrentSearches(roon) {
  const load = roon.searchLoad || {};
  if (!roon.searchesMost) return 'No searches yet';
  const average = load.busyMs ? load.area / load.busyMs : roon.searchesMost;
  return `${Math.max(1, Math.round(average))} typical, ${roon.searchesMost} at most`;
}

/** "1 ms typical, 40 ms slowest": the processing delay, from the event loop's. */
function loopTime(histogram = loopDelay) {
  const ms = (ns) => Math.max(0, Math.round(ns / 1e6 - LOOP_RESOLUTION_MS));
  if (!histogram.count) return '';
  return `${ms(histogram.percentile(50))} ms typical, ${ms(histogram.max)} ms slowest`;
}

/**
 * The Guest requests settings, as Roon's settings name them, shortened: "On, 5
 * per guest, 10 minutes refresh". Not the Flood protection numbers.
 */
/** "Add to queue 3, play next 0, skip 1": guests turned away with none left. */
function usedUp({ add = 0, next = 0, skip = 0 }) {
  return `Add to queue ${add}, play next ${next}, skip ${skip}`;
}

function requestRows(settings = {}, stats) {
  const allowance = (allowed, limit, refill) => {
    if (!allowed) return 'Off';
    if (!Number(limit)) return 'On, no limit';
    const minutes = Number(refill);
    const back = minutes ? `${minutes === 1 ? '1 minute' : `${minutes} minutes`} refresh` : 'no refresh';
    return `On, ${limit} per guest, ${back}`;
  };
  return [
    ['Block duplicates', settings.prevent_duplicates ? (stats ? `Yes, ${stats.duplicates || 0} blocked` : 'Yes') : 'No'],
    ['Add to queue', allowance(settings.allow_add, settings.add_limit, settings.add_refill)],
    ['Play it next', allowance(settings.allow_next, settings.next_limit, settings.next_refill)],
    ['Skip tracks', allowance(settings.allow_skip, settings.skip_limit, settings.skip_refill)],
    ['Allowances used up', stats && stats.usedUp ? usedUp(stats.usedUp) : '']
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
 * @param {object} ctx - { roon, guests, playlist, stats, streams, screens } from lib/server.js
 */
function runtime({ roon, guests, playlist, stats, streams, screens }) {

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


  let saved = roon.configWritable === false ? "Can't be saved: see Party Mode's status in Roon" : 'Saved';
  if (roon.settingsRejected) saved += `; last change not saved (${roon.settingsRejected})`;

  return [
    ['Installation', [
      ['Installed with', installKind()],
      ['Image built', imageBuilt()],
      ['Code version', PACKAGE.version],
      ['Code fingerprint', (codeFingerprint = codeFingerprint || fingerprint())],
      ['Base image', baseImage()],
      ['Alpine Linux', read('/etc/alpine-release')],
      ['Node.js', process.version.replace(/^v/, '')],
      ['Platform', `${os.platform()} ${os.arch()}`],
      ['Kernel', os.release()],
      ['Hardware', `${count(os.cpus().length, 'CPU')}, ${(os.totalmem() / 1024 ** 3).toFixed(1)} GB memory`],
      ['Memory limit', memoryLimit()],
      ['Runs as', runsAs()],
      ['Container hardening', lockdown()]
    ]],
    ['Roon', [
      ['Roon Core', roon.core ? `Connected for ${ago(roon.coreSince) || 'a moment'}` : 'Not connected'],
      ['Roon Core version', roon.core && roon.core.display_version ? String(roon.core.display_version) : ''],
      ['Connection lost', `${count(roon.coreLost || 0, 'time')} since Party Mode started`],
      ['Last lost', outage(roon.lastOutage)],
      ['Roon profile', roon.profileProblem ? "A problem: see Party Mode's status in Roon" : 'Working'],
      ...menuNames(roon.settings, roon.detected),
      ['Search time', searchTime(roon)],
      ['Concurrent searches', concurrentSearches(roon)],
      ...zoneRows(roon)
    ]],
    ['Party', [
      ['State', party],
      ['Started', playlist ? `${ago(playlist.started)} ago` : ''],
      ['Guests', `${joined} joined, ${guestsHere} on the page now`],
      // With the Party Hub now playing setting (not what each screen shows: a
      // phone, or a Hub waiting for Roon's page, shows Standard).
      ['Party Hub', `${hubs} open, ${hubPlaying(roon.settings) === 'roon' ? 'Roon Display' : 'Standard'}`],
      // Pages built on /embed/ that follow its live updates.
      ['Custom Party Hub pages', `${screens ? screens.size : 0} open`],
      ['Tracks requested', stats && stats.requestsFailed ? `${requested}, and ${stats.requestsFailed} Roon couldn't add` : String(requested)],
      ['Searches', stats ? tally(stats.searches, stats.searchesFailed) : ''],
      ['Skips', stats ? tally(stats.skips, stats.skipsFailed) : ''],
      ...requestRows(roon.settings, stats)
    ]],
    ['Health', [
      ['Running for', duration(process.uptime())],
      ['Settings', saved],
      ['Detailed log', debugEnabled() ? "On (it records guests' searches)" : 'Off'],
      ['Memory in use', `${mb(process.memoryUsage().rss)} MB now, ${mb(process.resourceUsage().maxRSS * 1024)} MB at most`],
      ['CPU use', cpuUse()],
      ['Album art cache', art
        ? `${art.images.size} covers, ${served ? Math.round((100 * art.hits) / served) : 0}% hit rate, ${art.failed || 0} failed`
        : ''],
      ['Guest actions', guestActions(roon)],
      ['Processing delay', loopTime()],
      ['"Too many requests"', `${stats ? stats.tooMany : 0} since Party Mode started`],
      ['Live update reconnects', `${stats ? stats.reconnects || 0 : 0} since Party Mode started`],
      ['Warnings logged', `${warningCount()} since Party Mode started`]
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
 * Open-source software Party Mode doesn't include, thanked on the page in a list
 * of its own: the Extension Manager and Docker Engine, which install and run
 * it, and the tools its security is checked with. No versions (none is in the image), and
 * each licence links to the project's repository.
 */
const by = (name, license, url, copyright) => ({ name, version: '', license, url, licenseUrl: url, copyright });
const THANKS = [
  by('roon-extension-manager', 'Apache-2.0', 'https://github.com/TheAppgineer/roon-extension-manager', 'By TheAppgineer'),
  by('Docker Engine', 'Apache-2.0', 'https://github.com/moby/moby', 'By Docker and the Moby project'),
  ...[
    by('autocannon', 'MIT', 'https://github.com/mcollina/autocannon', 'By Matteo Collina'),
    by('Dockle', 'Apache-2.0', 'https://github.com/goodwithtech/dockle', 'By Goodwith Tech'),
    by('ffuf', 'MIT', 'https://github.com/ffuf/ffuf', 'By Joona Hoikkala'),
    by('Gitleaks', 'MIT', 'https://github.com/gitleaks/gitleaks', 'By Zachary Rice'),
    by('Grype', 'Apache-2.0', 'https://github.com/anchore/grype', 'By Anchore'),
    by('Hadolint', 'GPL-3.0', 'https://github.com/hadolint/hadolint', 'By the Hadolint authors'),
    by('Nuclei', 'MIT', 'https://github.com/projectdiscovery/nuclei', 'By ProjectDiscovery'),
    by('OSV-Scanner', 'Apache-2.0', 'https://github.com/google/osv-scanner', 'By Google'),
    by('Playwright', 'Apache-2.0', 'https://github.com/microsoft/playwright', 'By Microsoft'),
    by('Schemathesis', 'MIT', 'https://github.com/schemathesis/schemathesis', 'By Dmitry Dygalo'),
    by('SecLists', 'MIT', 'https://github.com/danielmiessler/SecLists', 'By Daniel Miessler, Jason Haddix and contributors'),
    by('Semgrep Community Edition', 'LGPL-2.1', 'https://github.com/semgrep/semgrep', 'By Semgrep'),
    by('slowhttptest', 'Apache-2.0', 'https://github.com/shekyan/slowhttptest', 'By Sergey Shekyan'),
    by('Trivy', 'Apache-2.0', 'https://github.com/aquasecurity/trivy', 'By Aqua Security'),
    by('ZAP', 'Apache-2.0', 'https://github.com/zaproxy/zaproxy', 'By the ZAP Dev Team')
  ].sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }))
];

function licenseLink(id, label) {
  return `<a href="/About/license/${encodeURIComponent(id)}">${escapeHtml(label)}</a>`;
}

function page(ctx, packages) {
  const sections = runtime(ctx)
    .map(([title, rows]) => `<section>
        <h2>${escapeHtml(title)}</h2>
        <table class="facts">
          ${rows.map(([label, value]) => `<tr><th scope="row">${escapeHtml(label)}</th><td>${value.split('\n').map(escapeHtml).join('<br />')}</td></tr>`).join('\n          ')}
        </table>
      </section>`)
    .join('\n\n      ');
  const item = (p) => {
    const license = p.license || 'See its licence';
    let lic = escapeHtml(license);
    if (p.file) lic = licenseLink(p.id, license);
    else if (p.licenseUrl) lic = `<a href="${p.licenseUrl}" target="_blank" rel="noopener">${lic}</a>`;
    // The name links to the project; the licence to its text in this copy.
    const name = p.url ? `<a href="${escapeHtml(p.url)}" target="_blank" rel="noopener">${escapeHtml(p.name)}</a>` : escapeHtml(p.name);
    return `<li><span class="lib">${name} <span class="ver">${escapeHtml(p.version)}</span></span>` +
      `<span class="lic">${lic}</span>` +
      (p.copyright ? `<span class="who">${escapeHtml(p.copyright)}</span>` : '') +
      (p.note ? `<span class="who">${escapeHtml(p.note)}</span>` : '') +
      '</li>';
  };
  const libraries = packages.map(item).join('\n        ');
  const thanks = THANKS.map(item).join('\n        ');
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
        <h3>Installed and tested with</h3>
        <ul class="libs">
        ${thanks}
        </ul>
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

function licensePage(name, text, notice) {
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
${notice ? `      <pre class="license">${escapeHtml(notice)}</pre>
` : ''}      <pre class="license">${escapeHtml(text)}</pre>
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
    (packages = packages || readPackages().sort((a, b) => a.name.localeCompare(b.name)));

  app.get('/About', (req, res) => {
    res.set('Cache-Control', 'no-cache').type('html').send(page(ctx, list()));
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
      if (entry.fromReadme) text = readmeLicense(text);
      // Party Mode's own NOTICE, the copyright notice Apache-2.0 asks
      // redistributors to carry, goes above its licence.
      const notice = own && fs.existsSync(OWN_NOTICE) ? fs.readFileSync(OWN_NOTICE, 'utf8') : '';
      res.set('Cache-Control', 'max-age=86400').type('html').send(licensePage(own ? 'Party Mode' : entry.id, text, notice));
    });
  });
}

module.exports = { aboutRoutes, readPackages, readmeLicense, requiredNames, repositoryUrl, copyrightOf, licenseName, duration, runtime, installKind, menuNames, imageBuilt, fingerprint, baseImage, lockdown, memoryLimit, searchTime, loopTime, cpuUse };
