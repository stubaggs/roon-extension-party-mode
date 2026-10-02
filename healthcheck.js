'use strict';

// Docker HEALTHCHECK: is the web server answering? It listens on the port saved
// in config.json (else PARTY_PORT, else 8338, the order the extension uses), or
// on one of the next few ports if that one was busy at startup.

const fs = require('fs');
const http = require('http');
const { FALLBACK_PORTS } = require('./lib/ports');

function configuredPort() {
  try {
    const saved = JSON.parse(fs.readFileSync('config.json', 'utf8'));
    const port = Number(saved.settings && saved.settings.port);
    if (Number.isInteger(port) && port > 0) return port;
  } catch (err) {
    /* no settings saved yet */
  }
  return Number(process.env.PARTY_PORT) || 8338;
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
