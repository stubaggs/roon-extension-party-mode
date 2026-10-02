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

// Docker HEALTHCHECK: is the web server answering? It listens on the port saved
// in config.json (else ROON_EXTENSION_PARTY_MODE_PORT, else 8338, the order the extension uses), or
// on one of the next few ports if that one was busy at startup.

const fs = require('fs');
const http = require('http');
const { FALLBACK_PORTS } = require('./lib/ports');
const { startPort } = require('./lib/env');

function configuredPort() {
  try {
    const saved = JSON.parse(fs.readFileSync('config.json', 'utf8'));
    const port = Number(saved.settings && saved.settings.port);
    if (Number.isInteger(port) && port > 0) return port;
  } catch (err) {
    /* no settings saved yet */
  }
  return startPort();
}

function answers(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/roonparty', timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
  });
}

(async () => {
  const first = configuredPort();
  for (let port = first; port <= Math.min(first + FALLBACK_PORTS, 65535); port += 1) {
    if (await answers(port)) process.exit(0);
  }
  process.exit(1);
})();
