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

// Docker HEALTHCHECK: is the web server answering? It listens on the port saved
// in config.json (else ROON_EXTENSION_PARTY_MODE_PORT, else 8338, the order the extension uses), or,
// with neither set, on one of the next few if 8338 was busy at startup.

const fs = require('fs');
const http = require('http');
const { FALLBACK_PORTS } = require('./lib/ports');
const { startPort, portChosen } = require('./lib/env');

// How long the Party Hub's data may take. A Pi 1 serving a busy party took over 1.5
// seconds at times; Docker allows the whole check 15, Node's start included.
const ANSWER_MS = 5000;

function savedSettings() {
  try {
    return JSON.parse(fs.readFileSync('config.json', 'utf8')).settings || {};
  } catch (err) {
    return {}; // no settings saved yet
  }
}

function configuredPort(saved) {
  const port = Number(saved.port);
  return Number.isInteger(port) && port > 0 ? port : startPort();
}

function answers(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/hub', timeout: ANSWER_MS }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
  });
}

(async () => {
  const saved = savedSettings();
  const first = configuredPort(saved);
  const tries = portChosen(saved) ? 0 : FALLBACK_PORTS;
  for (let port = first; port <= Math.min(first + tries, 65535); port += 1) {
    if (await answers(port)) process.exit(0);
  }
  process.exit(1);
})();
