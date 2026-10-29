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

// A stand-in for the docker command, for the setup program's tests
// (test/setup.test.js): only the commands and Go templates party-mode-setup.sh
// uses. Its state is a JSON file (FAKE_DOCKER_STATE), read and written on
// every call, and every call is logged to FAKE_DOCKER_LOG, one JSON array of
// arguments a line. The state:
//
//   daemon      'ok', 'permission denied' or 'down'
//   memoryLimit whether `docker info` says the kernel limits memory
//   compose     whether `docker compose` is installed
//   registry    ref -> image, what `docker pull` can fetch
//   images      ref -> image, those pulled: { id, version, env, hasData, pkgVersion, source }
//   containers  name -> { status, image, imageId, labels, mounts, env, log }
//   volumes     name -> a real folder, so commands run "in" the Manager's data work
//   failRun     names `docker run -d` refuses to start
//
// `docker exec … sh -c "cd /home/node/.rem && …"` and the short-lived
// container doing the same run the command for real, in the folder of the
// volume mounted there.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const STATE = process.env.FAKE_DOCKER_STATE;
const REM = '/home/node/.rem';
const VERSION_LABEL = 'org.opencontainers.image.version';
const SOURCE_LABEL = 'org.opencontainers.image.source';

const state = JSON.parse(fs.readFileSync(STATE, 'utf8'));
const args = process.argv.slice(2);
if (process.env.FAKE_DOCKER_LOG) fs.appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify(args) + '\n');

function save() {
  fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
}
function out(text) {
  process.stdout.write(text);
}
function fail(message, code = 1) {
  process.stderr.write(`Error response from daemon: ${message}\n`);
  process.exit(code);
}
function container(name) {
  const c = state.containers[name];
  if (!c) fail(`No such container: ${name}`);
  return c;
}
function image(ref) {
  const found = Object.entries(state.images).find(([key, img]) => key === ref || img.id === ref);
  if (!found) fail(`No such image: ${ref}`);
  return found[1];
}
const lines = (list) => list.map((l) => `${l}\n`).join('');

// Splits off `-f <template>` / `--format <template>`; returns [template, rest].
function template(list) {
  const rest = [];
  let tpl = null;
  for (let i = 0; i < list.length; i += 1) {
    if (list[i] === '-f' || list[i] === '--format') tpl = list[(i += 1)];
    else rest.push(list[i]);
  }
  return [tpl, rest];
}

// A container's fields by the templates party-mode-setup.sh uses.
function inspectContainer(tpl, c) {
  if (tpl === null) return JSON.stringify([c]) + '\n';
  if (tpl === '{{.State.Status}}') return `${c.status}\n`;
  if (tpl === '{{.Config.Image}}') return `${c.image}\n`;
  if (tpl.startsWith('{{.State.Status}}|')) {
    const l = c.labels || {};
    return (
      [
        c.status,
        c.image,
        l[VERSION_LABEL] || '',
        l['com.docker.compose.project'] || '',
        l['com.docker.compose.project.working_dir'] || '',
        l['com.docker.compose.project.config_files'] || '',
        c.imageId
      ].join('|') + '\n'
    );
  }
  if (tpl.startsWith('{{range .Mounts}}{{.Type}}')) {
    return lines((c.mounts || []).map((m) => [m.type, m.name || '', m.source || '', m.dest].join('|')));
  }
  if (tpl.startsWith('{{range .Mounts}}{{if eq .Destination')) {
    const m = (c.mounts || []).find((mount) => mount.dest === REM);
    return m ? (m.name || m.source) : '';
  }
  if (tpl === '{{range .Config.Env}}{{println .}}{{end}}') return lines(c.env || []);
  throw new Error(`fake docker: unknown container template ${tpl}`);
}

function inspectImage(tpl, img) {
  if (tpl === '{{.Id}}') return `${img.id}\n`;
  if (tpl === `{{index .Config.Labels "${VERSION_LABEL}"}}`) return `${img.version || ''}\n`;
  if (tpl === '{{range .Config.Env}}{{println .}}{{end}}') return lines(img.env || []);
  throw new Error(`fake docker: unknown image template ${tpl}`);
}

// A command meant for the Manager's data folder, run in the folder standing
// for the volume.
function inData(volume, command, input) {
  const dir = state.volumes[volume];
  if (!dir) fail(`No such volume: ${volume}`);
  const r = spawnSync('/bin/sh', ['-c', command.split(`cd ${REM}`).join(`cd '${dir}'`)], {
    input: input ? fs.readFileSync(0) : '',
    encoding: 'utf8'
  });
  out(r.stdout);
  process.stderr.write(r.stderr);
  process.exit(r.status);
}

// docker run's options this program passes, then the image and its arguments.
function parseRun(list) {
  const o = { flags: [], mounts: [], env: [], name: null, entrypoint: null, detach: false, rm: false, input: false };
  let i = 0;
  const withValue = new Set(['--name', '--network', '--restart', '--log-driver', '--log-opt', '--memory', '--security-opt', '--cap-drop', '-v', '-e', '--entrypoint']);
  for (; i < list.length && list[i].startsWith('-'); i += 1) {
    const flag = list[i];
    if (withValue.has(flag)) {
      const value = list[(i += 1)];
      if (flag === '--name') o.name = value;
      else if (flag === '-v') {
        const [src, dest] = value.split(':');
        o.mounts.push(src.startsWith('/') ? { type: 'bind', source: src, dest } : { type: 'volume', name: src, dest });
      } else if (flag === '-e') o.env.push(value);
      else if (flag === '--entrypoint') o.entrypoint = value;
      o.flags.push(flag, value);
    } else {
      if (flag === '-d') o.detach = true;
      if (flag === '--rm') o.rm = true;
      if (flag === '-i') o.input = true;
      o.flags.push(flag);
    }
  }
  o.image = list[i];
  o.rest = list.slice(i + 1);
  return o;
}

function run(list) {
  const o = parseRun(list);
  const img = image(o.image);
  if (o.entrypoint === 'sh' && o.rest[1] === 'test -d /data') process.exit(img.hasData ? 0 : 1);
  if (o.entrypoint === 'node') return out(`${img.pkgVersion || img.version}\n`);
  if (o.entrypoint === 'sh') {
    const data = o.mounts.find((m) => m.dest === REM);
    return inData(data.name || data.source, o.rest[1], o.input);
  }
  if (!o.detach) throw new Error(`fake docker: unexpected run ${list.join(' ')}`);
  if (state.containers[o.name]) fail(`Conflict. The container name "/${o.name}" is already in use`, 125);
  for (const m of o.mounts) {
    if (m.type === 'volume' && !state.volumes[m.name]) state.volumes[m.name] = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-volume-'));
  }
  state.containers[o.name] = {
    status: (state.failRun || []).includes(o.name) ? 'created' : 'running',
    image: o.image,
    imageId: img.id,
    labels: img.version ? { [VERSION_LABEL]: img.version } : {},
    mounts: o.mounts,
    env: (img.env || []).concat(o.env),
    log: '[PartyMode] Party Mode listening on port 8338\n',
    options: o.flags
  };
  save();
  if ((state.failRun || []).includes(o.name)) fail('driver failed programming external connectivity', 125);
  out('0123456789ab\n');
}

function ps() {
  return lines(
    Object.entries(state.containers).map(([name, c]) => {
      const img = Object.values(state.images).find((i) => i.id === c.imageId) || {};
      return `${name}|${c.image}|${c.source || img.source || ''}`;
    })
  );
}

function dangling() {
  const used = new Set();
  for (const c of Object.values(state.containers)) for (const m of c.mounts || []) if (m.type === 'volume') used.add(m.name);
  return Object.keys(state.volumes).filter((v) => !used.has(v));
}

function main() {
  const [command, ...rest] = args;
  if (command !== 'version' && command !== 'compose' && state.daemon !== 'ok') fail('daemon not running');
  switch (command) {
    case 'version':
      if (state.daemon === 'permission denied') {
        process.stderr.write('permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock\n');
        process.exit(1);
      }
      if (state.daemon === 'down') {
        process.stderr.write('Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n');
        process.exit(1);
      }
      return out('27.0.0\n');
    case 'info':
      return out(`${state.memoryLimit ? 'true' : 'false'}\n`);
    case 'ps':
      return out(ps());
    case 'inspect': {
      const [tpl, names] = template(rest);
      return out(inspectContainer(tpl, container(names[0])));
    }
    case 'image': {
      const [sub, ...more] = rest;
      if (sub === 'inspect') {
        const [tpl, refs] = template(more);
        return out(inspectImage(tpl, image(refs[0])));
      }
      if (sub === 'rm') {
        const ref = more[0];
        const key = Object.keys(state.images).find((k) => k === ref || state.images[k].id === ref);
        if (!key) fail(`No such image: ${ref}`);
        if (Object.values(state.containers).some((c) => c.imageId === state.images[key].id)) fail('image is being used by a container', 1);
        delete state.images[key];
        return save();
      }
      break;
    }
    case 'pull': {
      const ref = rest[0];
      if (!state.registry[ref]) fail(`manifest for ${ref} not found`);
      state.images[ref] = Object.assign({}, state.registry[ref]);
      save();
      return out(`Status: Downloaded newer image for ${ref}\n`);
    }
    case 'run':
      return run(rest);
    case 'exec': {
      const input = rest[0] === '-i';
      const list = input ? rest.slice(1) : rest;
      const c = container(list[0]);
      if (c.status !== 'running') fail(`container ${list[0]} is not running`);
      if (list[1] === 'node') {
        const img = image(c.imageId);
        return out(`${img.pkgVersion || img.version}\n`);
      }
      const data = c.mounts.find((m) => m.dest === REM);
      return inData(data.name || data.source, list[3], input);
    }
    case 'logs':
      return out(container(rest[rest.length - 1]).log || '');
    case 'stop':
      container(rest[0]).status = 'exited';
      return save();
    case 'start':
    case 'restart':
      container(rest[0]).status = 'running';
      return save();
    case 'rename':
      state.containers[rest[1]] = container(rest[0]);
      delete state.containers[rest[0]];
      return save();
    case 'rm': {
      const force = rest[0] === '-f';
      const name = force ? rest[1] : rest[0];
      const c = container(name);
      if (c.status === 'running' && !force) fail(`cannot remove container "/${name}": container is running`);
      delete state.containers[name];
      return save();
    }
    case 'volume': {
      const [sub, ...more] = rest;
      if (sub === 'ls') return out(lines(dangling()));
      if (sub === 'rm') {
        if (!state.volumes[more[0]]) fail(`get ${more[0]}: no such volume`);
        delete state.volumes[more[0]];
        return save();
      }
      break;
    }
    case 'compose':
      if (!state.compose) {
        process.stderr.write("docker: 'compose' is not a docker command.\n");
        process.exit(1);
      }
      return;
  }
  throw new Error(`fake docker: unknown command ${args.join(' ')}`);
}

main();
