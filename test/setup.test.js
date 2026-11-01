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

// The setup program (party-mode-setup.sh): its functions, run in bash
// against a stand-in for docker (test/fake-docker.js) and curl, with a PATH
// holding only those and the few tools the program uses, so nothing reaches
// the real Docker or the network. Menus get their answers on stdin (plain
// prompts, as without whiptail); with no terminal, ask() says no.
//
// Needs bash 4 or newer: skipped without it, as in the Docker build (Alpine,
// and the script isn't copied in).

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { extensionIdentity } = require('../lib/roon-service');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'party-mode-setup.sh');
const IMAGE = 'stubaggs/roon-extension-party-mode';
const REM = '/home/node/.rem';
const REPOSITORY_URL = 'https://repository.test/repository.json';
const SETUP_URL_PATTERN = /^SETUP_URL=(.*)$/m;

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

console.log('setup program');

const bash = spawnSync('bash', ['-c', 'echo ${BASH_VERSINFO[0]}'], { encoding: 'utf8' });
if (bash.error || Number(bash.stdout) < 4 || !fs.existsSync(SCRIPT)) {
  console.log(`  skipped: ${fs.existsSync(SCRIPT) ? 'needs bash 4 or newer' : 'party-mode-setup.sh is not here'}`);
  console.log('\nall passing');
  process.exit(0);
}
const BASH = spawnSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8' }).stdout.trim();

// --- The sandbox ---

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'party-mode-setup-test-'));
process.on('exit', () => fs.rmSync(TMP, { recursive: true, force: true }));

// The tools the program uses besides bash's own commands. Linked into a
// folder of their own, so the PATH has nothing else (no real docker).
const TOOLS = ['awk', 'sed', 'grep', 'fold', 'mktemp', 'cat', 'rm', 'sort', 'head', 'tail', 'cut', 'tr', 'wc', 'tput', 'mkdir', 'sh'];
const tools = path.join(TMP, 'tools');
fs.mkdirSync(tools);
for (const tool of TOOLS) {
  const found = spawnSync('bash', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
  if (found) fs.symlinkSync(found, path.join(tools, tool));
}

// docker, curl, sleep and clear stand-ins. Without docker: the same, minus it.
function stubs(dir, withDocker) {
  fs.mkdirSync(dir);
  const write = (name, body) => fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  if (withDocker) write('docker', `exec "${process.execPath}" "${path.join(__dirname, 'fake-docker.js')}" "$@"`);
  // curl -fsSL … URL: the URL's page from FAKE_URLS (a JSON map), or a failure.
  const curl = path.join(dir, 'curl.js');
  fs.writeFileSync(
    curl,
    `const fs = require('fs');
const url = process.argv[process.argv.length - 1];
fs.appendFileSync(process.env.FAKE_CURL_LOG, url + '\\n');
const pages = JSON.parse(fs.readFileSync(process.env.FAKE_URLS, 'utf8'));
if (!(url in pages)) process.exit(22);
process.stdout.write(pages[url]);
`
  );
  write('curl', `exec "${process.execPath}" "${curl}" "$@"`);
  // whiptail: each screen's arguments logged, and the next scripted answer
  // given ({ rc, out }: out on stderr, as whiptail gives a choice). Every
  // screen is answered Enter (0) once the script runs out.
  const whiptail = path.join(dir, 'whiptail.js');
  fs.writeFileSync(
    whiptail,
    `const fs = require('fs');
fs.appendFileSync(process.env.FAKE_WHIPTAIL_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
const answers = JSON.parse(fs.readFileSync(process.env.FAKE_WHIPTAIL_ANSWERS, 'utf8'));
const answer = answers.shift() || {};
fs.writeFileSync(process.env.FAKE_WHIPTAIL_ANSWERS, JSON.stringify(answers));
if (answer.out) process.stderr.write(answer.out);
process.exit(answer.rc || 0);
`
  );
  write('whiptail', `exec "${process.execPath}" "${whiptail}" "$@"`);
  write('sleep', ':');
  write('clear', ':');
  return dir;
}
const withDocker = stubs(path.join(TMP, 'bin'), true);
const withoutDocker = stubs(path.join(TMP, 'bin-no-docker'), false);

// The program's functions without its last line (main "$@"), for sourcing.
const source = fs.readFileSync(SCRIPT, 'utf8');
const LIB = path.join(TMP, 'setup-functions.sh');
fs.writeFileSync(LIB, source.replace(/\nmain "\$@"\n$/, '\n'));

// The Manager's own list, with Party Mode in it or not.
function repository(listed) {
  const extension = (repo, name) => ({ display_name: name, author: 'Someone', image: { repo } });
  return JSON.stringify(
    [
      { display_name: 'Playback', extensions: [extension('someone/other', 'Other')].concat(listed ? [extension(IMAGE, 'Party Mode')] : []) },
      { display_name: 'Tools', extensions: [extension('someone/tool', 'Tool')] }
    ],
    null,
    4
  );
}

// --- Fixtures ---

let ids = 0;
function img(version, extra = {}) {
  ids += 1;
  return Object.assign({ id: `sha256:${String(ids).padStart(4, '0')}`, version, env: ['NODE_ENV=production', 'ROON_EXTENSION_PARTY_MODE_BUILD='], hasData: true, source: 'https://github.com/stubaggs/roon-extension-party-mode' }, extra);
}

/** A copy run with docker run, on a volume, from images[ref]. */
function dockerCopy(images, ref, extra = {}) {
  const image = images[ref];
  return Object.assign(
    {
      status: 'running',
      image: ref,
      imageId: image.id,
      labels: image.version ? { 'org.opencontainers.image.version': image.version } : {},
      mounts: [{ type: 'volume', name: 'roon-extension-party-mode-data', dest: '/data' }],
      env: image.env.slice(),
      log: '[PartyMode] Party Mode listening on port 8338\n'
    },
    extra
  );
}

function freshState(extra = {}) {
  const latest = img('1.4.0');
  const beta = img('1.5.0-beta.1');
  return Object.assign(
    {
      daemon: 'ok',
      memoryLimit: true,
      compose: false,
      registry: { [`${IMAGE}:latest`]: latest, [`${IMAGE}:beta`]: beta, [`${IMAGE}:1.3.2`]: img('', { hasData: false, pkgVersion: '1.3.2' }) },
      images: {},
      containers: {},
      volumes: {},
      failRun: []
    },
    extra
  );
}

/** The Extension Manager, with its data volume as a real folder. */
function withManager(state, status = 'running') {
  const data = fs.mkdtempSync(path.join(TMP, 'rem-'));
  fs.mkdirSync(path.join(data, 'repos'));
  state.images['theappgineer/roon-extension-manager:v1.x'] = img('', { id: 'sha256:rem', source: '' });
  state.containers['roon-extension-manager'] = {
    status,
    image: 'theappgineer/roon-extension-manager:v1.x',
    imageId: 'sha256:rem',
    labels: {},
    mounts: [{ type: 'volume', name: 'rem_data', dest: REM }],
    env: []
  };
  state.volumes.rem_data = data;
  return data;
}

/** Party Mode installed by the Manager: its data read-only on REM, the settings bound. */
function managerCopy(state, ref = `${IMAGE}:latest`, status = 'running') {
  state.images[ref] = state.images[ref] || state.registry[ref];
  state.containers['roon-extension-party-mode'] = dockerCopy(state.images, ref, {
    status,
    mounts: [
      { type: 'volume', name: 'rem_data', dest: REM },
      { type: 'bind', source: '/var/lib/docker/volumes/rem_data/_data/binds/roon-extension-party-mode/usr/src/app/config.json', dest: '/usr/src/app/config.json' }
    ]
  });
}

/**
 * Runs `snippet` in bash with the program's functions loaded, or the whole
 * program with `args` (snippet null). With `answers`, questions are answered
 * on stdin, as at a terminal; with `screens`, whiptail draws them, answered
 * in turn (see the stand-in above), and the terminal is a file. Returns the
 * output, exit status, the docker, curl and whiptail calls, what was drawn
 * on the terminal, and Docker's state after.
 */
function setup(snippet, { state = freshState(), input = '', args = [], listed = false, pages = {}, docker = true, answers = false, screens = null } = {}) {
  const dir = fs.mkdtempSync(path.join(TMP, 'run-'));
  const files = {
    state: path.join(dir, 'state.json'),
    log: path.join(dir, 'docker.log'),
    curl: path.join(dir, 'curl.log'),
    urls: path.join(dir, 'urls.json'),
    screens: path.join(dir, 'whiptail.log'),
    script: path.join(dir, 'whiptail-answers.json'),
    tty: path.join(dir, 'tty')
  };
  fs.writeFileSync(files.screens, '');
  fs.writeFileSync(files.script, JSON.stringify(screens || []));
  fs.writeFileSync(files.tty, '');
  if (answers) snippet = `can_ask() { true; }; ${snippet}`;
  if (screens) snippet = `WHIPTAIL=1; TTY='${files.tty}'; ${snippet}`;
  fs.writeFileSync(files.state, JSON.stringify(state));
  fs.writeFileSync(files.log, '');
  fs.writeFileSync(files.curl, '');
  fs.writeFileSync(files.urls, JSON.stringify(Object.assign({ [REPOSITORY_URL]: repository(listed) }, pages)));
  const command = snippet === null ? [SCRIPT, ...args] : ['-c', `source '${LIB}'; LIST_FILE=$(mktemp); ${snippet}`];
  const r = spawnSync(BASH, command, {
    input,
    encoding: 'utf8',
    cwd: dir,
    env: {
      PATH: `${docker ? withDocker : withoutDocker}:${tools}`,
      HOME: dir,
      TMPDIR: dir,
      LANG: 'C.UTF-8',
      USER: 'pi',
      PARTY_MODE_SETUP_REPOSITORY_URL: REPOSITORY_URL,
      FAKE_DOCKER_STATE: files.state,
      FAKE_DOCKER_LOG: files.log,
      FAKE_CURL_LOG: files.curl,
      FAKE_URLS: files.urls,
      FAKE_WHIPTAIL_LOG: files.screens,
      FAKE_WHIPTAIL_ANSWERS: files.script
    }
  });
  const calls = fs
    .readFileSync(files.log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return {
    out: r.stdout,
    err: r.stderr,
    status: r.status,
    calls,
    fetched: fs.readFileSync(files.curl, 'utf8').split('\n').filter(Boolean),
    screens: fs.readFileSync(files.screens, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)),
    tty: fs.readFileSync(files.tty, 'utf8'),
    state: JSON.parse(fs.readFileSync(files.state, 'utf8'))
  };
}
// Messages are joined and wrapped again at 78 columns: compare the words.
const said = (text) => text.replace(/\s+/g, ' ');
const ran = (r, ...prefix) => r.calls.filter((c) => prefix.every((p, i) => c[i] === p));
// bash -c with set -e: a function's failure shows as rc=N, not a stopped test.
const status = (call) => `if ${call}; then echo rc=0; else echo rc=$?; fi`;

// --- The program as a whole ---

check('the program ends with main "$@" (the tests load everything before it)', () => {
  assert.ok(source.endsWith('\nmain "$@"\n'));
  assert.ok(!fs.readFileSync(LIB, 'utf8').includes('\nmain "$@"'));
});

check('SETUP_VERSION is a plain version number, as newer_setup() reads it online', () => {
  assert.match(source, /^SETUP_VERSION=[0-9]+(\.[0-9]+)+$/m);
});

check('SETUP_URL points at this file in the repository, on main or beta', () => {
  assert.match(source.match(SETUP_URL_PATTERN)[1], /^https:\/\/raw\.githubusercontent\.com\/stubaggs\/roon-extension-party-mode\/(main|beta)\/party-mode-setup\.sh$/);
});

check('--help: its version and how to run it', () => {
  const r = setup(null, { args: ['--help'] });
  assert.strictEqual(r.status, 0);
  const version = source.match(/^SETUP_VERSION=(.*)$/m)[1];
  assert.ok(r.out.startsWith(`Party Mode setup ${version}\n\n`), r.out);
  assert.match(r.out, /^bash party-mode-setup\.sh +menus$/m);
  assert.match(r.out, /^bash party-mode-setup\.sh --status +what's installed$/m);
  assert.deepStrictEqual(r.calls, [], 'no docker for --help');
});

check('an unknown option: says so, with the usage, and exits 2', () => {
  const r = setup(null, { args: ['--frobnicate'] });
  assert.strictEqual(r.status, 2);
  assert.match(r.err, /^Unknown option: --frobnicate$/m);
  assert.match(r.err, /--status/);
});

check('without Docker: how to install it', () => {
  const r = setup(null, { args: ['--status'], docker: false });
  assert.strictEqual(r.status, 1);
  assert.match(r.err, /Docker isn't installed/);
  assert.match(r.err, /dietpi-software/);
});

check('no permission to use Docker: run it with sudo, or join the docker group', () => {
  const r = setup(null, { args: ['--status'], state: freshState({ daemon: 'permission denied' }) });
  assert.strictEqual(r.status, 1);
  assert.match(r.err, /You don't have permission to use Docker/);
  assert.match(r.err, /sudo bash\s+.*party-mode-setup\.sh/);
  assert.match(said(r.err), /\(sudo usermod -aG docker pi\), then log out and back in\./);
});

check("Docker not running: how to start it, with Docker's own words", () => {
  const r = setup(null, { args: ['--status'], state: freshState({ daemon: 'down' }) });
  assert.strictEqual(r.status, 1);
  assert.match(r.err, /Docker isn't running\. Start it \(sudo systemctl start docker\)/);
  assert.match(said(r.err), /Is the docker daemon running\?/);
});

check('menus need a terminal: without one, says to use --status', () => {
  const r = setup(null);
  assert.strictEqual(r.status, 1);
  assert.match(r.err, /Run this in a terminal, or with --status\./);
});

check('--status with nothing installed', () => {
  const r = setup(null, { args: ['--status'] });
  assert.strictEqual(r.status, 0, r.err);
  assert.strictEqual(r.out, "Docker\n  Party Mode isn't installed with Docker.\n\nExtension Manager (not installed)\n");
});

check('--status reads the Manager\'s list once, however often it is needed', () => {
  const state = freshState();
  withManager(state);
  const r = setup(null, { args: ['--status'], state });
  assert.strictEqual(r.status, 0, r.err);
  assert.deepStrictEqual(r.fetched, [REPOSITORY_URL]);
});

// --- Names: the same as Party Mode gives itself in Roon ---

check('channel_of: a version suffix\'s word, as Party Mode reads it', () => {
  const versions = ['1.4.0', '1.4.0-beta.2', '1.4.0-beta.rc1', '2.0.0-alpha.1', '1.4.1-RC.1', '1.4.0-1', '1.4.0-beta'];
  const r = setup(versions.map((v) => `printf '%s=' '${v}'; channel_of '${v}'; echo`).join('; '));
  const got = Object.fromEntries(r.out.split('\n').filter(Boolean).map((l) => l.split('=')));
  assert.deepStrictEqual(got, {
    '1.4.0': '',
    '1.4.0-beta.2': 'beta',
    '1.4.0-beta.rc1': 'beta',
    '2.0.0-alpha.1': 'alpha',
    '1.4.1-RC.1': 'rc',
    '1.4.0-1': 'beta',
    '1.4.0-beta': 'beta'
  });
});

check('roon_name(channel_of, name) matches the name Party Mode registers with', () => {
  const cases = [
    ['1.4.0', ''],
    ['1.4.0', 'Garden'],
    ['1.5.0-beta.1', ''],
    ['1.5.0-beta.1', 'Garden Party'],
    ['2.0.0-alpha.3', 'Kitchen 2']
  ];
  const r = setup(cases.map(([v, n]) => `roon_name "$(channel_of '${v}')" '${n}'`).join('; '));
  assert.deepStrictEqual(
    r.out.trim().split('\n'),
    cases.map(([v, n]) => extensionIdentity(v, n).display_name)
  );
});

check('slug: the extension id\'s part for a name, as Party Mode makes it', () => {
  const names = ['Garden', 'Garden Party', '  Kitchen  2 ', 'Up-Stairs', 'a--b'];
  const r = setup(names.map((n) => `slug '${n}'; echo`).join('; '));
  assert.deepStrictEqual(
    r.out.split('\n').slice(0, names.length),
    names.map((n) => extensionIdentity('1.4.0', n).extension_id.replace(/^com\.stubaggs\.party-mode\.?/, ''))
  );
});

check('kept_copy: the container and Roon name of a kept volume', () => {
  const r = setup(
    "kept_copy roon-extension-party-mode-data; kept_copy roon-extension-party-mode-beta-garden-party-data; kept_copy roon-extension-party-mode-kitchen-data; kept_copy roon-extension-party-mode-betamax-data"
  );
  assert.deepStrictEqual(r.out.trim().split('\n'), [
    'roon-extension-party-mode',
    'Party Mode',
    'roon-extension-party-mode-beta-garden-party',
    'Party Mode (beta, Garden Party)',
    'roon-extension-party-mode-kitchen',
    'Party Mode (Kitchen)',
    'roon-extension-party-mode-betamax',
    'Party Mode (Betamax)'
  ]);
});

// --- Text and prompts ---

check('paragraphs: joins a paragraph\'s lines, keeps indented and numbered lines', () => {
  const r = setup(`paragraphs $'One line\\nwrapped here.\\n\\n  sudo bash x\\nThen this.\\n\\n1. first\\n2. second'`);
  assert.strictEqual(r.out, 'One line wrapped here.\n\n  sudo bash x\nThen this.\n\n1. first\n2. second\n\n');
});

check('msg without whiptail: the text, wrapped at 78, on stderr', () => {
  const long = 'word '.repeat(30).trim();
  const r = setup(`msg '${long}'`);
  assert.strictEqual(r.out, '');
  const lines = r.err.trim().split('\n');
  assert.ok(lines.length > 1 && lines.every((l) => l.length <= 78), r.err);
});

check('menu: numbered choices, the key of the one chosen; 0, nothing or a wrong number is Back', () => {
  const menu = "menu 'Pick one' red 'Red label' green 'Green label'";
  let r = setup(status(menu), { input: '2\n' });
  assert.strictEqual(r.out, 'green\nrc=0\n');
  assert.match(r.err, /^ +1\) Red label$/m);
  assert.match(r.err, /^ +2\) Green label$/m);
  assert.match(r.err, /^ +0\) Back$/m);
  for (const input of ['0\n', '\n', '3\n', 'red\n', '']) {
    r = setup(status(menu), { input });
    assert.strictEqual(r.out, 'rc=1\n', JSON.stringify(input));
  }
  r = setup(status(`BACK=Finish ${menu}`), { input: '0\n' });
  assert.match(r.err, /^ +0\) Finish$/m);
});

check('answer: what was typed; nothing typed is Cancel', () => {
  let r = setup(status("answer 'A name?'"), { input: 'Garden\n' });
  assert.strictEqual(r.out, 'Garden\nrc=0\n');
  r = setup(status("answer 'A name?'"), { input: '\n' });
  assert.strictEqual(r.out, 'rc=1\n');
});

check('ask without a terminal is No, so nothing is done unasked', () => {
  const r = setup(status("ask 'Remove everything?'"), { input: 'y\n' });
  assert.strictEqual(r.out, 'rc=1\n');
});

// --- Versions ---

check('version_order: newest first, a release above its betas, numbers below words', () => {
  const list = ['1.3.2', '1.4.0-beta.2', '1.4.0', '1.4.0-beta.12', '1.4.0-beta.rc1', '1.10.0', '1.4.0-beta.9', '2.0.0-alpha.1'];
  const r = setup(`printf '%s\\n' ${list.join(' ')} | version_order`);
  assert.deepStrictEqual(r.out.trim().split('\n'), ['2.0.0-alpha.1', '1.10.0', '1.4.0', '1.4.0-beta.rc1', '1.4.0-beta.12', '1.4.0-beta.9', '1.4.0-beta.2', '1.3.2']);
});

check('versions: Docker Hub\'s version tags only, newest first', () => {
  const tags = JSON.stringify({ results: ['latest', 'beta', '1.3.2', '1.4.0', '1.4.0-beta.2', 'sha-abc', '1.4.0-x86'].map((name) => ({ name })) });
  const r = setup('versions', { pages: { [`https://hub.docker.com/v2/repositories/${IMAGE}/tags?page_size=100`]: tags } });
  assert.deepStrictEqual(r.out.trim().split('\n'), ['1.4.0', '1.4.0-x86', '1.4.0-beta.2', '1.3.2']);
});

check('choose_tag: latest, beta, or a version from the list; Back is Cancel', () => {
  const tags = JSON.stringify({ results: [{ name: '1.4.0' }, { name: '1.3.2' }] });
  const pages = { [`https://hub.docker.com/v2/repositories/${IMAGE}/tags?page_size=100`]: tags };
  assert.strictEqual(setup(status('choose_tag'), { input: '1\n' }).out, 'latest\nrc=0\n');
  assert.strictEqual(setup(status('choose_tag'), { input: '2\n' }).out, 'beta\nrc=0\n');
  assert.strictEqual(setup(status('choose_tag'), { input: '3\n2\n', pages }).out, '1.3.2\nrc=0\n');
  assert.strictEqual(setup(status('choose_tag'), { input: '0\n' }).out, 'rc=1\n');
  const offline = setup(status('choose_tag'), { input: '3\n' });
  assert.strictEqual(offline.out, 'rc=1\n');
  assert.match(offline.err, /Couldn't read the list of versions from Docker Hub\./);
});

check('newer_setup: only a later version online', () => {
  const url = source.match(SETUP_URL_PATTERN)[1];
  const online = (v) => ({ [url]: `#!/usr/bin/env bash\nSETUP_VERSION=${v}\n` });
  assert.strictEqual(setup(status('newer_setup'), { pages: online('99.0') }).out, '99.0\nrc=0\n');
  assert.strictEqual(setup(status('SETUP_VERSION=1.10; newer_setup'), { pages: online('1.9') }).out, 'rc=1\n');
  assert.strictEqual(setup(status('SETUP_VERSION=1.4; newer_setup'), { pages: online('1.4') }).out, 'rc=1\n');
  assert.strictEqual(setup(status('newer_setup')).out, 'rc=1\n', 'offline');
});

// --- Finding copies ---

function threeCopies() {
  const state = freshState();
  state.images = {
    [`${IMAGE}:latest`]: state.registry[`${IMAGE}:latest`],
    [`docker.io/${IMAGE}:beta`]: state.registry[`${IMAGE}:beta`],
    'ghcr.io/someone/party-fork:dev': img('1.4.0', { source: 'https://github.com/stubaggs/roon-extension-party-mode' }),
    'nginx:latest': img('', { source: 'https://github.com/nginx/docker-nginx' })
  };
  state.containers = {
    'roon-extension-party-mode': dockerCopy(state.images, `${IMAGE}:latest`),
    'party-beta': dockerCopy(state.images, `docker.io/${IMAGE}:beta`, {
      env: state.images[`docker.io/${IMAGE}:beta`].env.concat(['ROON_EXTENSION_PARTY_MODE_INSTANCE=Garden Party', 'ROON_EXTENSION_PARTY_MODE_PORT=8340']),
      mounts: [{ type: 'bind', source: '/srv/party', dest: '/data' }],
      status: 'exited'
    }),
    fork: dockerCopy(state.images, 'ghcr.io/someone/party-fork:dev'),
    web: dockerCopy(state.images, 'nginx:latest', { mounts: [] })
  };
  return state;
}

check('copies: by the image, wherever it comes from, or by its source label', () => {
  const r = setup('copies', { state: threeCopies() });
  assert.deepStrictEqual(r.out.trim().split('\n').sort(), ['fork', 'party-beta', 'roon-extension-party-mode']);
});

check('read_copy: how it runs, where its settings are, and only the variables given to it', () => {
  const r = setup(
    `read_copy party-beta; printf '%s\\n' "$C_STATE" "$C_VERSION" "$C_METHOD" "$C_DATA_TYPE" "$C_DATA" "$C_DATA_DEST" "$C_INSTANCE" "$C_CHANNEL" "$C_KEY" "\${C_ENV[@]}"`,
    { state: threeCopies() }
  );
  assert.deepStrictEqual(r.out.trim().split('\n'), [
    'exited',
    '1.5.0-beta.1',
    'docker',
    'bind',
    '/srv/party',
    '/data',
    'Garden Party',
    'beta',
    'beta/garden-party',
    'ROON_EXTENSION_PARTY_MODE_INSTANCE=Garden Party',
    'ROON_EXTENSION_PARTY_MODE_PORT=8340'
  ]);
});

check('read_copy: a Compose copy, a Manager copy, and an image before 1.4.0 (no version label)', () => {
  const state = freshState();
  managerCopy(state);
  state.images['old'] = img('latest', { pkgVersion: '1.3.2' });
  state.containers.party = dockerCopy(state.images, 'old', {
    image: `${IMAGE}:latest`,
    labels: { 'org.opencontainers.image.version': 'latest', 'com.docker.compose.project': 'party', 'com.docker.compose.project.working_dir': '/home/pi/party', 'com.docker.compose.project.config_files': '/home/pi/party/docker-compose.yml' }
  });
  const r = setup(
    'read_copy roon-extension-party-mode; echo "$C_METHOD $C_DATA_TYPE $C_DATA_DEST"; read_copy party; echo "$C_METHOD [$C_VERSION] $(copy_version) $C_PROJECT $C_DIR"',
    { state }
  );
  assert.deepStrictEqual(r.out.trim().split('\n'), ['manager bind /usr/src/app/config.json', 'compose [] 1.3.2 party /home/pi/party']);
});

check('copies_by: the Manager\'s copy apart from those run with Docker or Compose', () => {
  const state = threeCopies();
  withManager(state);
  managerCopy(state, `${IMAGE}:latest`);
  state.containers.mine = dockerCopy(state.images, `${IMAGE}:latest`);
  delete state.containers['roon-extension-party-mode'].env;
  const r = setup('copies_by manager; echo --; copies_by docker | sort', { state });
  assert.deepStrictEqual(r.out.trim().split('\n'), ['roon-extension-party-mode', '--', 'fork', 'mine', 'party-beta']);
});

check('duplicates: two copies that are the same extension to Roon', () => {
  const state = threeCopies();
  state.containers.another = dockerCopy(state.images, `${IMAGE}:latest`, { mounts: [] });
  const r = setup('duplicates', { state });
  assert.match(r.out, /Warning: (roon-extension-party-mode|fork|another) and (fork|another) are the same extension/);
  assert.ok(!/party-beta/.test(r.out), 'the named beta is a different extension');
});

check('status: each copy, its version and state, settings kept from an uninstall, and the Manager', () => {
  const state = threeCopies();
  delete state.containers.fork;
  state.volumes['roon-extension-party-mode-beta-kitchen-data'] = TMP;
  const r = setup('status_text', { state });
  assert.strictEqual(
    r.out,
    [
      'Docker',
      '  Party Mode (beta, Kitchen)',
      '    roon-extension-party-mode-beta-kitchen: settings only',
      '  Party Mode 1.4.0',
      '    roon-extension-party-mode: running',
      '  Party Mode (beta, Garden Party) 1.5.0-beta.1',
      '    party-beta: stopped',
      '',
      'Extension Manager (not installed)',
      ''
    ].join('\n')
  );
});

check('status: the Manager with Party Mode, beside a copy run with Docker, says to fix it', () => {
  const state = freshState();
  withManager(state);
  managerCopy(state);
  state.images[`${IMAGE}:beta`] = state.registry[`${IMAGE}:beta`];
  state.containers['roon-extension-party-mode-beta'] = dockerCopy(state.images, `${IMAGE}:beta`, { mounts: [{ type: 'volume', name: 'roon-extension-party-mode-beta-data', dest: '/data' }] });
  const r = setup('status_text', { state });
  assert.match(r.out, /^Extension Manager \(running\)\n {2}Party Mode 1\.4\.0\n {4}roon-extension-party-mode: running$/m);
  assert.match(r.out, /On one computer, run Party Mode with Docker or with the Extension\nManager, not both\. Choose Fix in the menu\./);
});

check('status: where the Manager offers Party Mode when it isn\'t installed', () => {
  const state = freshState();
  const data = withManager(state);
  let r = setup('manager_text', { state, listed: true });
  assert.strictEqual(r.out, "Extension Manager (running)\n  Party Mode isn't installed with the Extension Manager.\n  The Extension Manager offers it to install, under Playback.\n");
  fs.writeFileSync(path.join(data, 'repos', 'roon-extension-party-mode.json'), `"repo": "${IMAGE}"`);
  r = setup('manager_text', { state, listed: true });
  assert.match(r.out, /offers it to install, under Playback and under Local\.$/m);
  r = setup('manager_text', { state, listed: false });
  assert.match(r.out, /offers it to install, under Local\.$/m);
  state.containers['roon-extension-manager'].status = 'exited';
  r = setup('manager_text', { state, listed: false });
  assert.match(r.out, /^Extension Manager \(installed, not running\)$/m);
  assert.match(r.out, /offers it to install, under Local\.$/m, 'read from a short-lived container while the Manager is stopped');
});

check("manager_category: the category of the Manager's list, or Local; the list read once", () => {
  let r = setup('manager_category; manager_category; listed && echo listed', { listed: true });
  assert.strictEqual(r.out, 'Playback\nPlayback\nlisted\n');
  assert.deepStrictEqual(r.fetched, [REPOSITORY_URL]);
  r = setup(status('listed'), { listed: false });
  assert.strictEqual(r.out, 'rc=1\n');
  r = setup('manager_category', { pages: { [REPOSITORY_URL]: undefined } });
  assert.strictEqual(r.out, 'Local\n', 'offline');
});

// --- Installing with Docker ---

check('run_container: the README\'s options; read-only with /data; a memory limit where Docker can apply it', () => {
  let r = setup(`docker pull ${IMAGE}:latest >/dev/null; run_container pm ${IMAGE}:latest -v pm-data:/data -e ROON_EXTENSION_PARTY_MODE_INSTANCE=Garden`);
  assert.deepStrictEqual(ran(r, 'run', '-d')[0], [
    'run', '-d', '--name', 'pm', '--network', 'host', '--restart', 'unless-stopped',
    '--log-driver', 'json-file', '--log-opt', 'max-size=10m', '--log-opt', 'max-file=3',
    '--read-only', '--memory', '512m', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '-v', 'pm-data:/data', '-e', 'ROON_EXTENSION_PARTY_MODE_INSTANCE=Garden', `${IMAGE}:latest`
  ]);
  r = setup(`docker pull ${IMAGE}:1.3.2 >/dev/null; run_container pm ${IMAGE}:1.3.2`, { state: freshState({ memoryLimit: false }) });
  const call = ran(r, 'run', '-d')[0];
  assert.ok(!call.includes('--read-only') && !call.includes('--memory'), call.join(' '));
});

check('install: the latest release, on a volume, then the step in Roon', () => {
  const r = setup('install_docker', { input: '1\n' });
  assert.strictEqual(r.status, 0, r.err);
  const c = r.state.containers['roon-extension-party-mode'];
  assert.ok(c, Object.keys(r.state.containers).join());
  assert.strictEqual(c.image, `${IMAGE}:latest`);
  assert.deepStrictEqual(c.mounts, [{ type: 'volume', name: 'roon-extension-party-mode-data', dest: '/data' }]);
  assert.ok(!c.env.some((e) => e.includes('INSTANCE')));
  assert.match(r.err, /Party Mode 1\.4\.0 has started\.\s+In Roon, open Settings > Extensions to enable and configure it\./);
});

check('install the beta: its own container and volume, beside a release', () => {
  const state = freshState();
  state.images[`${IMAGE}:latest`] = state.registry[`${IMAGE}:latest`];
  state.containers['roon-extension-party-mode'] = dockerCopy(state.images, `${IMAGE}:latest`);
  const r = setup('install_docker', { state, input: '2\n' });
  const c = r.state.containers['roon-extension-party-mode-beta'];
  assert.ok(c, Object.keys(r.state.containers).join());
  assert.strictEqual(c.mounts[0].name, 'roon-extension-party-mode-beta-data');
  assert.match(r.err, /Party Mode \(beta\) 1\.5\.0-beta\.1 has started/);
});

check('install a named copy: asks until the name is usable and not taken', () => {
  const state = freshState();
  state.images[`${IMAGE}:latest`] = state.registry[`${IMAGE}:latest`];
  state.containers['roon-extension-party-mode-garden'] = dockerCopy(state.images, `${IMAGE}:latest`, {
    env: ['ROON_EXTENSION_PARTY_MODE_INSTANCE=Garden']
  });
  const r = setup('install_docker named', { state, input: '1\nGarden/Shed\n garden \n  Kitchen 2 \n' });
  assert.match(r.err, /Use letters, digits, spaces and hyphens only, up to 30\./);
  assert.match(r.err, /Party Mode \(garden\) is already installed \(roon-extension-party-mode-garden\)\./);
  const c = r.state.containers['roon-extension-party-mode-kitchen-2'];
  assert.ok(c, Object.keys(r.state.containers).join());
  assert.ok(c.env.includes('ROON_EXTENSION_PARTY_MODE_INSTANCE=Kitchen 2'), c.env.join());
  assert.strictEqual(c.mounts[0].name, 'roon-extension-party-mode-kitchen-2-data');
  assert.match(r.err, /Party Mode \(Kitchen 2\) 1\.4\.0 has started/);
});

check('install over the same extension: without a yes to a name of its own, nothing is installed', () => {
  const state = freshState();
  state.images[`${IMAGE}:latest`] = state.registry[`${IMAGE}:latest`];
  state.containers.party = dockerCopy(state.images, `${IMAGE}:latest`);
  const r = setup('install_docker', { state, input: '1\n' });
  assert.deepStrictEqual(Object.keys(r.state.containers), ['party']);
  assert.deepStrictEqual(ran(r, 'run', '-d'), []);
});

check('install refused while the Extension Manager has Party Mode', () => {
  const state = freshState();
  withManager(state);
  managerCopy(state);
  const r = setup('install_docker', { state, input: '1\n' });
  assert.match(r.err, /Party Mode is installed with the Extension Manager here/);
  assert.deepStrictEqual(ran(r, 'pull'), []);
});

check('install: a download that fails, a name already used, a container that won\'t start', () => {
  let r = setup('install_docker', { state: freshState({ registry: {} }), input: '1\n' });
  assert.match(r.err, /Couldn't download stubaggs\/roon-extension-party-mode:latest\./);
  const state = freshState();
  state.images.other = img('', { source: '' });
  state.containers['roon-extension-party-mode'] = dockerCopy(state.images, 'other', { mounts: [] });
  r = setup('install_docker', { state, input: '1\n' });
  assert.match(r.err, /There's already a container called roon-extension-party-mode\. Remove it first\./);
  r = setup('install_docker', { state: freshState({ failRun: ['roon-extension-party-mode'] }), input: '1\n' });
  assert.match(r.err, /Docker couldn't start Party Mode \(see above\)\./);
  assert.deepStrictEqual(r.state.containers, {}, 'the container it left is removed');
});

check('install: once installed with Docker, the Manager stops offering its local entry', () => {
  const state = freshState();
  const data = withManager(state);
  fs.writeFileSync(path.join(data, 'repos', 'roon-extension-party-mode.json'), `{"repo": "${IMAGE}"}`);
  const r = setup('install_docker', { state, input: '1\n' });
  assert.ok(r.state.containers['roon-extension-party-mode']);
  assert.ok(!fs.existsSync(path.join(data, 'repos', 'roon-extension-party-mode.json')));
  assert.strictEqual(ran(r, 'restart', 'roon-extension-manager').length, 1);
});

check('wait_ready: a copy that stopped shows the end of its log', () => {
  const state = freshState();
  state.images[`${IMAGE}:latest`] = state.registry[`${IMAGE}:latest`];
  state.containers.party = dockerCopy(state.images, `${IMAGE}:latest`, { status: 'exited', log: 'line one\nError: EACCES /data/config.json\n' });
  const r = setup('wait_ready party', { state });
  assert.match(r.err, /Party Mode stopped\. The end of its log:\n\n line one\n Error: EACCES \/data\/config\.json/);
});

// --- Updating with Docker ---

function installedLatest(oldVersion = '1.3.9') {
  const state = freshState();
  const old = img(oldVersion);
  state.images[`${IMAGE}:latest`] = old;
  state.containers.party = dockerCopy(state.images, `${IMAGE}:latest`, {
    env: old.env.concat(['ROON_EXTENSION_PARTY_MODE_INSTANCE=Garden']),
    mounts: [{ type: 'volume', name: 'party-settings', dest: '/data' }]
  });
  state.volumes['party-settings'] = TMP;
  return { state, old };
}

check('update: a new image replaces the container, with its settings and variables; the old image goes', () => {
  const { state, old } = installedLatest();
  const r = setup('update_docker', { state });
  assert.strictEqual(r.status, 0, r.err);
  const c = r.state.containers.party;
  assert.strictEqual(c.imageId, state.registry[`${IMAGE}:latest`].id);
  assert.deepStrictEqual(c.mounts, [{ type: 'volume', name: 'party-settings', dest: '/data' }]);
  assert.ok(c.env.includes('ROON_EXTENSION_PARTY_MODE_INSTANCE=Garden'));
  assert.ok(!c.options.includes('ROON_EXTENSION_PARTY_MODE_BUILD='), "the image's own variables aren't passed");
  assert.ok(!r.state.containers['party-old']);
  assert.deepStrictEqual(ran(r, 'image', 'rm'), [['image', 'rm', old.id]]);
  assert.match(r.err, /Party Mode \(Garden\) 1\.4\.0 has started\./);
});

check('update: up to date says so and changes nothing', () => {
  const state = freshState();
  state.images[`${IMAGE}:latest`] = state.registry[`${IMAGE}:latest`];
  state.containers.party = dockerCopy(state.images, `${IMAGE}:latest`);
  const r = setup('update_docker', { state });
  assert.match(r.err, /party is up to date \(1\.4\.0\)\./);
  assert.deepStrictEqual(ran(r, 'stop'), []);
});

check("update: a new version that won't start puts the old one back, running", () => {
  const { state, old } = installedLatest();
  state.failRun = ['party'];
  const r = setup('update_docker', { state });
  assert.match(r.err, /Couldn't start the new version, so the old one is running again\./);
  assert.strictEqual(r.state.containers.party.imageId, old.id);
  assert.strictEqual(r.state.containers.party.status, 'running');
  assert.ok(!r.state.containers['party-old']);
});

check('update: a copy on a particular version stays on it unless asked', () => {
  const state = freshState();
  state.images[`${IMAGE}:1.3.2`] = state.registry[`${IMAGE}:1.3.2`];
  state.containers.party = dockerCopy(state.images, `${IMAGE}:1.3.2`);
  const r = setup('update_docker', { state });
  assert.deepStrictEqual(ran(r, 'pull'), []);
});

check('update: a Compose copy is updated with Compose, in its folder', () => {
  const state = freshState({ compose: true });
  state.images[`${IMAGE}:latest`] = state.registry[`${IMAGE}:latest`];
  state.containers.party = dockerCopy(state.images, `${IMAGE}:latest`, {
    labels: { 'com.docker.compose.project': 'party', 'com.docker.compose.project.working_dir': TMP, 'com.docker.compose.project.config_files': `${TMP}/a.yml,${TMP}/b.yml` }
  });
  const r = setup('update_docker', { state });
  assert.deepStrictEqual(ran(r, 'compose').filter((c) => c[1] !== 'version'), [
    ['compose', '-p', 'party', '-f', `${TMP}/a.yml`, '-f', `${TMP}/b.yml`, 'pull'],
    ['compose', '-p', 'party', '-f', `${TMP}/a.yml`, '-f', `${TMP}/b.yml`, 'up', '-d']
  ]);
  assert.deepStrictEqual(ran(r, 'run'), []);
});

check('update: several copies, the one chosen', () => {
  const { state } = installedLatest();
  state.containers.other = dockerCopy(state.images, `${IMAGE}:latest`, { mounts: [{ type: 'volume', name: 'other-data', dest: '/data' }] });
  const r = setup('update_docker', { state, input: '2\n' });
  assert.match(r.err, /Update which copy\?/);
  assert.strictEqual(r.state.containers.other.imageId, state.registry[`${IMAGE}:latest`].id);
  assert.strictEqual(r.state.containers.party.imageId, state.containers.party.imageId);
});

// --- Uninstalling with Docker ---

check('remove a copy, keeping its settings: the volume stays and shows as kept', () => {
  const { state } = installedLatest();
  state.containers.party.mounts[0].name = 'roon-extension-party-mode-garden-data';
  state.volumes['roon-extension-party-mode-garden-data'] = TMP;
  const r = setup('remove_docker_copy party keep; echo; docker_text', { state });
  assert.match(r.out, /^Removed\. Its settings are kept \(roon-extension-party-mode-garden-data\): installing it again\nwith the same name picks them up\.$/m);
  assert.ok(!r.state.containers.party);
  assert.ok(r.state.volumes['roon-extension-party-mode-garden-data']);
  assert.match(r.out, / {2}Party Mode \(Garden\)\n {4}roon-extension-party-mode-garden: settings only/);
});

check('remove everything: the volume too; a folder is left for the host to delete', () => {
  const { state } = installedLatest();
  let r = setup('remove_docker_copy party all', { state });
  assert.strictEqual(r.out, 'Removed.\n');
  assert.ok(!r.state.volumes['party-settings']);
  state.containers.party.mounts = [{ type: 'bind', source: '/srv/party', dest: '/data' }];
  r = setup('remove_docker_copy party all', { state });
  assert.strictEqual(r.out, 'Removed. Its settings are in /srv/party: delete it yourself.\n');
});

check('uninstall: copies and kept settings to choose from; Everything removes the volume', () => {
  const { state } = installedLatest();
  state.volumes['roon-extension-party-mode-data'] = TMP;
  const r = setup('uninstall_docker', { state, input: '1\n2\n' });
  assert.match(r.err, /1\) Party Mode \(Garden\)/);
  assert.match(r.err, /2\) Party Mode: settings only/);
  assert.ok(!r.state.containers.party);
  assert.ok(!r.state.volumes['party-settings']);
  assert.ok(r.state.volumes['roon-extension-party-mode-data'], 'the other kept settings stay');
});

check('fix both ways, keeping the Manager: the copies run with Docker go', () => {
  const state = freshState();
  withManager(state);
  managerCopy(state);
  state.images[`${IMAGE}:beta`] = state.registry[`${IMAGE}:beta`];
  state.containers['roon-extension-party-mode-beta'] = dockerCopy(state.images, `${IMAGE}:beta`, { mounts: [{ type: 'volume', name: 'beta-data', dest: '/data' }] });
  state.volumes['beta-data'] = TMP;
  const r = setup(status('mixed') + '; fix_mixed; ' + status('mixed'), { state, input: '2\n1\n' });
  assert.strictEqual(r.out, 'rc=0\nrc=1\n');
  assert.ok(r.state.containers['roon-extension-party-mode'], "the Manager's copy stays");
  assert.ok(!r.state.containers['roon-extension-party-mode-beta']);
  assert.ok(r.state.volumes['beta-data'], 'Party Mode only: settings kept');
  assert.match(said(r.err), /Party Mode runs with the Extension Manager here\./);
});

// --- The Extension Manager ---

check("entry_json: the same entry as the Extension Manager's listing", () => {
  const r = setup('entry_json latest');
  const entry = JSON.parse(r.out);
  assert.strictEqual(entry[0].display_name, 'Local');
  assert.deepStrictEqual(entry[0].extensions, [JSON.parse(fs.readFileSync(path.join(ROOT, 'extension-manager', 'repository-entry.json'), 'utf8'))]);
});

check('install with the Manager: writes the local entry, restarts the Manager, then points to Roon', () => {
  const state = freshState();
  const data = withManager(state);
  const r = setup(status('install_manager'), { state });
  const written = fs.readFileSync(path.join(data, 'repos', 'roon-extension-party-mode.json'), 'utf8');
  assert.strictEqual(written, setup('entry_json latest').out);
  assert.strictEqual(ran(r, 'restart', 'roon-extension-manager').length, 1);
  assert.strictEqual(r.out, 'rc=1\n', 'no terminal to answer Done: check, so back to the menu');
  // Run again: the entry is already there, so no restart.
  const again = setup(status('install_manager'), { state: r.state });
  assert.strictEqual(ran(again, 'restart').length, 0);
});

check('install with the Manager once it lists Party Mode: no local entry, its category', () => {
  const state = freshState();
  const data = withManager(state);
  const r = setup(status('install_manager'), { state, listed: true });
  assert.deepStrictEqual(fs.readdirSync(path.join(data, 'repos')), []);
  assert.deepStrictEqual(ran(r, 'restart'), []);
  assert.strictEqual(r.out, 'rc=1\n');
});

check("in_roon: where in Roon, under the Manager's category for Party Mode", () => {
  const state = freshState();
  withManager(state);
  assert.match(said(setup('in_roon Install', { state }).out), /Under the Local category, choose Party Mode\. Below its description, set Action to Install, then Save\./);
  assert.match(said(setup('in_roon Uninstall', { state, listed: true }).out), /Under the Playback category, .* set Action to Uninstall, then Save\./);
});

check('install with the Manager refused while Party Mode runs with Docker, and when the Manager has it', () => {
  const state = freshState();
  withManager(state);
  state.images[`${IMAGE}:latest`] = state.registry[`${IMAGE}:latest`];
  state.containers.party = dockerCopy(state.images, `${IMAGE}:latest`);
  let r = setup('install_manager', { state });
  assert.match(said(r.err), /Party Mode is installed with Docker here: uninstall it there first/);
  delete state.containers.party;
  managerCopy(state);
  r = setup('install_manager', { state });
  assert.match(r.err, /The Extension Manager has already installed Party Mode\./);
});

check('local entries: files naming the image; one listing other extensions too is left alone', () => {
  const state = freshState();
  const data = withManager(state);
  fs.writeFileSync(path.join(data, 'repos', 'mine.json'), `{"repo": "${IMAGE}"}`);
  fs.writeFileSync(path.join(data, 'repos', 'shared.json'), `{"repo": "${IMAGE}"}, {"repo": "someone/other"}`);
  fs.writeFileSync(path.join(data, 'repos', 'unrelated.json'), '{"repo": "someone/other"}');
  const r = setup('local_entries | sort; ' + status('remove_entry_file mine.json') + '; ' + status('remove_entry_file shared.json'), { state });
  assert.strictEqual(r.out, 'mine.json\nshared.json\nrc=0\nrc=1\n');
  assert.match(said(r.err), /shared\.json in the Extension Manager's repos folder lists other extensions too/);
  assert.deepStrictEqual(fs.readdirSync(path.join(data, 'repos')).sort(), ['shared.json', 'unrelated.json']);
});

check('tidy: once the Manager lists Party Mode, the local entry goes; a beta it installed is pointed to the release', () => {
  const state = freshState();
  const data = withManager(state);
  managerCopy(state, `${IMAGE}:beta`);
  fs.writeFileSync(path.join(data, 'repos', 'roon-extension-party-mode.json'), `{"repo": "${IMAGE}"}`);
  const r = setup('tidy_entries', { state, listed: true });
  assert.deepStrictEqual(fs.readdirSync(path.join(data, 'repos')), []);
  assert.strictEqual(ran(r, 'restart', 'roon-extension-manager').length, 1);
  assert.match(said(r.err), /To move to it, uninstall Party Mode \(beta\) in Roon/);
  const quiet = setup('tidy_entries', { state: r.state, listed: true });
  assert.strictEqual(quiet.err, '', 'nothing to tidy');
});

check('uninstall from the Manager: once Roon has removed it, the local entry goes', () => {
  const state = freshState();
  const data = withManager(state);
  fs.writeFileSync(path.join(data, 'repos', 'roon-extension-party-mode.json'), `{"repo": "${IMAGE}"}`);
  const r = setup('uninstall_manager', { state });
  assert.deepStrictEqual(fs.readdirSync(path.join(data, 'repos')), []);
  assert.match(said(r.err), /Party Mode has been uninstalled from the Extension Manager, and it's no longer offered there\./);
});

check('the Manager menu: not installed, or not running, says what to do', () => {
  let r = setup('manager_menu');
  assert.match(said(r.err), /The Extension Manager isn't installed\. On DietPi, install it with dietpi-software/);
  const state = freshState();
  withManager(state, 'exited');
  r = setup('manager_menu', { state });
  assert.match(r.err, /The Extension Manager isn't running\. Start it, then choose this again\./);
});

// --- Questions answered, as at a terminal ---

const tagsPage = (...names) => ({ [`https://hub.docker.com/v2/repositories/${IMAGE}/tags?page_size=100`]: JSON.stringify({ results: names.map((name) => ({ name })) }) });

check('ask at a terminal: the question, then y is Yes and anything else No', () => {
  let r = setup(status("ask 'Remove it?'"), { answers: true, input: 'y\n' });
  assert.strictEqual(r.out, 'rc=0\n');
  assert.match(r.err, /^Remove it\?$/m);
  for (const input of ['n\n', '\n', 'no\n', '']) {
    r = setup(status("ask 'Remove it?'"), { answers: true, input });
    assert.strictEqual(r.out, 'rc=1\n', JSON.stringify(input));
  }
  assert.strictEqual(setup(status("ask 'Remove it?'"), { answers: true, input: 'Y\n' }).out, 'rc=0\n');
});

check('install over the same extension, then Name it: a named copy beside it', () => {
  const state = freshState();
  state.images[`${IMAGE}:latest`] = state.registry[`${IMAGE}:latest`];
  state.containers.party = dockerCopy(state.images, `${IMAGE}:latest`);
  const r = setup('install_docker', { state, answers: true, input: '1\ny\nGarden\n' });
  assert.match(said(r.err), /Party Mode is already installed \(party, with Docker\)\. Another copy of it would clash in Roon\./);
  const c = r.state.containers['roon-extension-party-mode-garden'];
  assert.ok(c, Object.keys(r.state.containers).join());
  assert.ok(c.env.includes('ROON_EXTENSION_PARTY_MODE_INSTANCE=Garden'));
  assert.ok(r.state.containers.party, 'the first stays');
});

check('install a version before 1.4.0: says its settings stay inside it; Install runs it without --read-only', () => {
  const pages = tagsPage('1.3.2');
  let r = setup('install_docker', { answers: true, input: '3\n1\ny\n', pages });
  assert.match(said(r.err), /Party Mode 1\.3\.2 keeps its settings inside its container, so they don't carry over to the next version/);
  const c = r.state.containers['roon-extension-party-mode'];
  assert.ok(c, Object.keys(r.state.containers).join());
  assert.strictEqual(c.image, `${IMAGE}:1.3.2`);
  assert.ok(!c.options.includes('--read-only'));
  r = setup('install_docker', { answers: true, input: '3\n1\nn\n', pages });
  assert.deepStrictEqual(r.state.containers, {}, 'Cancel installs nothing');
});

check('update a copy on a particular version: Yes, then the version chosen; its settings kept', () => {
  const state = freshState();
  state.images[`${IMAGE}:1.3.2`] = state.registry[`${IMAGE}:1.3.2`];
  state.containers.party = dockerCopy(state.images, `${IMAGE}:1.3.2`);
  const r = setup('update_docker', { state, answers: true, input: 'y\n1\n' });
  assert.match(r.err, /party stays on version 1\.3\.2\. Choose another version\?/);
  const c = r.state.containers.party;
  assert.strictEqual(c.image, `${IMAGE}:latest`);
  assert.deepStrictEqual(c.mounts, [{ type: 'volume', name: 'roon-extension-party-mode-data', dest: '/data' }]);
});

check('update a copy that keeps its settings inside: Update gives it a volume; Cancel leaves it', () => {
  const state = freshState();
  state.images[`${IMAGE}:latest`] = img('1.3.9');
  state.containers.party = dockerCopy(state.images, `${IMAGE}:latest`, { mounts: [] });
  let r = setup('update_docker', { state, answers: true, input: 'y\n' });
  assert.match(said(r.err), /party keeps its settings inside its container, so they don't carry over/);
  assert.deepStrictEqual(r.state.containers.party.mounts, [{ type: 'volume', name: 'party-data', dest: '/data' }]);
  r = setup('update_docker', { state, answers: true, input: 'n\n' });
  assert.deepStrictEqual(ran(r, 'pull'), []);
});

check('uninstall settings kept from before: Yes removes the volume', () => {
  const state = freshState();
  state.volumes['roon-extension-party-mode-data'] = TMP;
  let r = setup('uninstall_docker', { state, answers: true, input: '1\nn\n' });
  assert.ok(r.state.volumes['roon-extension-party-mode-data'], 'No keeps it');
  r = setup('uninstall_docker', { state, answers: true, input: '1\ny\n' });
  assert.match(said(r.err), /Remove the volume roon-extension-party-mode-data, with the settings and Roon's pairing in it\?/);
  assert.ok(!r.state.volumes['roon-extension-party-mode-data']);
  assert.match(r.err, /^Removed\.$/m);
});

check('fix both ways, keeping Docker: asks until Roon has removed the Manager\'s copy; Cancel stops', () => {
  const state = freshState();
  withManager(state);
  managerCopy(state);
  state.images[`${IMAGE}:beta`] = state.registry[`${IMAGE}:beta`];
  state.containers['roon-extension-party-mode-beta'] = dockerCopy(state.images, `${IMAGE}:beta`);
  const r = setup('fix_mixed', { state, answers: true, input: '1\ny\nn\n' });
  assert.strictEqual(said(r.err).split('Uninstall Party Mode with the Extension Manager, so it runs only with Docker').length - 1, 2);
  assert.match(said(r.err), /set Action to Uninstall, then Save\./);
  assert.ok(r.state.containers['roon-extension-party-mode'] && r.state.containers['roon-extension-party-mode-beta'], 'nothing removed from here');
});

check('install with the Manager: asks until Roon has installed it; Cancel goes back', () => {
  const state = freshState();
  withManager(state);
  const r = setup(status('install_manager'), { state, answers: true, input: 'y\nn\n' });
  assert.strictEqual(said(r.err).split('Party Mode is ready to install with the Extension Manager.').length - 1, 2);
  assert.match(said(r.err), /Choose Done: check once Roon shows Party Mode installed\./);
  assert.strictEqual(r.out, 'rc=1\n');
});

check('uninstall from the Manager: asks until Roon has removed it, and leaves the entry until then', () => {
  const state = freshState();
  const data = withManager(state);
  managerCopy(state);
  fs.writeFileSync(path.join(data, 'repos', 'roon-extension-party-mode.json'), `{"repo": "${IMAGE}"}`);
  const r = setup(status('uninstall_manager'), { state, answers: true, input: 'y\nn\n' });
  assert.strictEqual(said(r.err).split('Uninstall Party Mode with the Extension Manager.').length - 1, 2);
  assert.strictEqual(r.out, 'rc=1\n');
  assert.deepStrictEqual(fs.readdirSync(path.join(data, 'repos')), ['roon-extension-party-mode.json']);
});

// --- Menus ---

check('the main menu: Status, then Finish; the Manager marked not installed', () => {
  const r = setup('main_menu', { input: '1\n0\n' });
  assert.strictEqual(r.status, 0, r.err);
  assert.match(r.err, new RegExp(`^Party Mode setup ${source.match(/^SETUP_VERSION=(.*)$/m)[1].replace('.', '\\.')}$`, 'm'));
  assert.match(r.err, /^ +1\) Status: what's installed$/m);
  assert.match(r.err, /^ +3\) With the Extension Manager \(not installed\)$/m);
  assert.match(r.err, /^ +0\) Finish$/m);
  assert.match(r.err, /Party Mode isn't installed with Docker\./, 'the status');
});

check('the main menu: Fix first when installed both ways; a later setup program online is mentioned', () => {
  const state = freshState();
  withManager(state);
  managerCopy(state);
  state.images[`${IMAGE}:beta`] = state.registry[`${IMAGE}:beta`];
  state.containers['roon-extension-party-mode-beta'] = dockerCopy(state.images, `${IMAGE}:beta`);
  const url = source.match(SETUP_URL_PATTERN)[1];
  const r = setup('main_menu', { state, input: '0\n', pages: { [url]: 'SETUP_VERSION=99.0\n' } });
  assert.match(r.err, /^ +1\) Fix: Party Mode is installed both ways here$/m);
  assert.match(r.err, /^ +4\) With the Extension Manager$/m);
  assert.match(said(r.err), /Setup program 99\.0 is available \(this is \d+(\.\d+)+\): download it again \(see the README\)\./);
});

check("the Docker menu: only what can be done; a long list of copies is left to Status", () => {
  let r = setup('docker_menu', { input: '0\n' });
  assert.match(r.err, /^ +2\) Install another copy, with its own name \(such as Garden\)$/m);
  assert.doesNotMatch(r.err, /Update|Restart|Uninstall/);
  const kept = freshState();
  kept.volumes['roon-extension-party-mode-data'] = TMP;
  r = setup('docker_menu', { state: kept, input: '0\n' });
  assert.match(r.err, /^ +3\) Uninstall$/m, 'kept settings can be removed');
  assert.doesNotMatch(r.err, /Update|Restart/);
  const many = freshState();
  many.images[`${IMAGE}:latest`] = many.registry[`${IMAGE}:latest`];
  for (const name of ['a', 'b', 'c', 'd']) many.containers[name] = dockerCopy(many.images, `${IMAGE}:latest`, { mounts: [{ type: 'volume', name: `${name}-data`, dest: '/data' }] });
  r = setup('docker_menu', { state: many, input: '0\n' });
  assert.match(r.err, /^ {2}4 copies are installed \(see Status\)\.$/m);
  assert.match(r.err, /3\) Update[\s\S]*4\) Restart[\s\S]*5\) Uninstall/);
});

check('restart from the Docker menu: the copy restarts and is waited for', () => {
  const state = freshState();
  state.images[`${IMAGE}:latest`] = state.registry[`${IMAGE}:latest`];
  state.containers.party = dockerCopy(state.images, `${IMAGE}:latest`);
  const r = setup('docker_menu', { state, input: '4\n0\n' });
  assert.deepStrictEqual(ran(r, 'restart'), [['restart', 'party']]);
  assert.match(r.err, /Party Mode 1\.4\.0 has started\./);
  assert.match(setup('restart docker').err, /Party Mode isn't installed this way\./);
});

check('the Manager menu: install, or stop offering the local entry; once installed, Uninstall', () => {
  const state = freshState();
  const data = withManager(state);
  fs.writeFileSync(path.join(data, 'repos', 'roon-extension-party-mode.json'), `{"repo": "${IMAGE}"}`);
  let r = setup('manager_menu', { state, input: '2\n' });
  assert.match(r.err, /^ +1\) Install Party Mode$/m);
  assert.match(r.err, /^ +2\) Stop offering Party Mode under Local in the Extension Manager$/m);
  assert.deepStrictEqual(fs.readdirSync(path.join(data, 'repos')), []);
  assert.strictEqual(ran(r, 'restart', 'roon-extension-manager').length, 1);
  assert.match(r.err, /The Extension Manager no longer offers Party Mode under Local\./);
  managerCopy(state);
  r = setup('manager_menu', { state, input: '0\n' });
  assert.match(r.err, /^ +1\) Uninstall$/m);
  assert.match(said(r.err), /The Extension Manager updates Party Mode each night\./);
  assert.doesNotMatch(r.err, /Install Party Mode/);
});

// --- whiptail ---

check('whiptail: a message that fits closes with Enter; a long one scrolls; between screens, "One moment"', () => {
  let r = setup("msg 'Short message.'", { screens: [] });
  assert.strictEqual(r.screens.length, 1);
  const [box] = r.screens;
  assert.deepStrictEqual(box.slice(0, 4), ['--title', `Party Mode setup ${source.match(/^SETUP_VERSION=(.*)$/m)[1]}`, '--msgbox', 'Short message.']);
  assert.strictEqual(box[4], '8', 'one line, and the box around it');
  assert.match(r.tty, /One moment\.\.\./);
  assert.strictEqual(r.err, '', 'nothing printed beside the box');
  const long = Array.from({ length: 40 }, (_, i) => `  line ${i}`).join('\\n');
  r = setup(`msg $'${long}'`, { screens: [] });
  assert.ok(r.screens[0].includes('--scrolltext'), r.screens[0].join(' '));
  assert.match(r.screens[0][r.screens[0].indexOf('--msgbox') + 1], /\(Tab, then Enter, to close\.\)$/);
});

check('whiptail: a menu gives the key chosen; Cancel (named Back, or BACK) is Back', () => {
  const menu = "menu 'Pick one' red 'Red label' green 'Green label'";
  let r = setup(status(menu), { screens: [{ out: 'green' }] });
  assert.strictEqual(r.out, 'green\nrc=0\n');
  const args = r.screens[0];
  assert.ok(args.includes('--notags'));
  assert.strictEqual(args[args.indexOf('--cancel-button') + 1], 'Back');
  assert.deepStrictEqual(args.slice(-4), ['red', 'Red label', 'green', 'Green label']);
  r = setup(status(menu), { screens: [{ rc: 1 }] });
  assert.strictEqual(r.out, '\nrc=1\n');
  r = setup(status(`BACK=Finish ${menu}`), { screens: [{ rc: 1 }] });
  assert.strictEqual(r.screens[0][r.screens[0].indexOf('--cancel-button') + 1], 'Finish');
});

check('whiptail: a yes/no question with its own button names; a text box', () => {
  let r = setup(status("ask 'Do that?' 'Name it' 'Cancel'"), { screens: [{ rc: 0 }] });
  assert.strictEqual(r.out, 'rc=0\n');
  const args = r.screens[0];
  assert.strictEqual(args[args.indexOf('--yes-button') + 1], 'Name it');
  assert.strictEqual(args[args.indexOf('--no-button') + 1], 'Cancel');
  assert.strictEqual(args[args.indexOf('--yesno') + 1], 'Do that?');
  assert.strictEqual(setup(status("ask 'Do that?'"), { screens: [{ rc: 1 }] }).out, 'rc=1\n');
  r = setup(status("answer 'A name?' Garden"), { screens: [{ out: 'Kitchen' }] });
  assert.strictEqual(r.out, 'Kitchen\nrc=0\n');
  assert.deepStrictEqual(r.screens[0].slice(2, 4), ['--inputbox', 'A name?']);
  assert.strictEqual(r.screens[0][r.screens[0].length - 1], 'Garden', 'the suggestion');
  assert.strictEqual(setup(status("answer 'A name?'"), { screens: [{ rc: 1 }] }).out, '\nrc=1\n');
});

check('whiptail: installing, start to finish', () => {
  const r = setup('install_docker', { screens: [{ out: 'latest' }] });
  assert.ok(r.state.containers['roon-extension-party-mode']);
  assert.deepStrictEqual(r.screens.map((args) => args[2]), ['--notags', '--msgbox']);
  assert.match(r.screens[1][3], /Party Mode 1\.4\.0 has started\./);
  assert.match(r.tty, /Party Mode setup/);
});

if (failures) {
  console.log(`\n${failures} failing`);
  process.exit(1);
}
console.log('\nall passing');
