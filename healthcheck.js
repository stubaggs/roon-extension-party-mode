'use strict';

// Docker HEALTHCHECK: is the web server answering on the port it was set to?
// The port lives in config.json once saved in Roon; until then PARTY_PORT or
// 8080, the same order the extension uses at startup.

const fs = require('fs');
const http = require('http');

function configuredPort() {
  try {
    const saved = JSON.parse(fs.readFileSync('config.json', 'utf8'));
    const port = Number(saved.settings && saved.settings.port);
    if (Number.isInteger(port) && port > 0) return port;
  } catch (err) {
    /* no settings saved yet */
  }
  return Number(process.env.PARTY_PORT) || 8080;
}

const req = http.get(
  { host: '127.0.0.1', port: configuredPort(), path: '/api/roonparty', timeout: 4000 },
  (res) => {
    res.resume();
    process.exit(res.statusCode === 200 ? 0 : 1);
  }
);
req.on('timeout', () => req.destroy(new Error('timeout')));
req.on('error', () => process.exit(1));
