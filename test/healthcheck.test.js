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

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

const SCRIPT = path.join(__dirname, '..', 'healthcheck.js');

/** Runs the health check as Docker does, from a folder whose config.json names `port`. */
function healthcheck(port) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-health-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ settings: { port } }));
  const env = { ...process.env };
  delete env.ROON_EXTENSION_PARTY_MODE_PORT;
  delete env['ROON-EXTENSION-PARTY-MODE_PORT'];
  return new Promise((resolve) => {
    spawn(process.execPath, [SCRIPT], { cwd: dir, env, stdio: 'ignore' }).on('exit', (code) => {
      fs.rmSync(dir, { recursive: true, force: true });
      resolve(code);
    });
  });
}

/** A Party Hub stand-in that answers /api/hub after `delayMs`. */
function slowHub(delayMs) {
  const server = http.createServer((req, res) => {
    setTimeout(() => res.end(req.url === '/api/hub' ? '{}' : ''), delayMs);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

(async () => {
  console.log('healthcheck');

  await check('healthy when the Party Hub takes 3 seconds to answer (a busy Pi 1)', async () => {
    const server = await slowHub(3000);
    try {
      assert.strictEqual(await healthcheck(server.address().port), 0);
    } finally {
      server.close();
    }
  });

  await check('unhealthy when nothing answers', async () => {
    const server = await slowHub(0);
    const { port } = server.address();
    await new Promise((r) => server.close(r));
    assert.strictEqual(await healthcheck(port), 1);
  });

  await check('a saved port counts alone: a Party Hub on the next port is not this copy', async () => {
    const server = await slowHub(0);
    try {
      assert.strictEqual(await healthcheck(server.address().port - 1), 1);
    } finally {
      server.close();
    }
  });

  console.log(failures ? `\n${failures} failing` : '\nall passing');
  process.exit(failures ? 1 : 0);
})();
