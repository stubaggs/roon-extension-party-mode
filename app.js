'use strict';

const { RoonService } = require('./lib/roon-service');
const { GuestStore } = require('./lib/guests');
const { createServer } = require('./lib/server');
const { listenWithFallback, FALLBACK_PORTS } = require('./lib/ports');

const roon = new RoonService();
const guests = new GuestStore();
const server = createServer(roon, guests);

// Set when the configured port was busy at startup and a later one is in use.
let portNote = '';
// Set when no port could be opened at startup; the host fixes it in Roon.
let startError = '';

function publishLinks() {
  if (!server.port) {
    roon.setStatusLine(startError);
    return;
  }
  roon.setWebsite(server.roonpartyUrl());
  roon.setStatusLine(`RoonParty at ${server.roonpartyUrl()}${portNote}`);
}

function logLinks() {
  console.log(`Party Mode listening on port ${server.port}`);
  console.log(`Guest link: ${server.guestUrl()}`);
  console.log(`RoonParty:  ${server.roonpartyUrl()}`);
}

roon.on('core_paired', publishLinks);

// The port last asked for in the settings. Compared with this rather than the
// port in use, so saving other settings while on a fallback port doesn't retry.
let configuredPort = roon.settings.port;

// A new web port in the extension settings moves the web server there, then
// reconnects to the Core so Roon shows the new link. The host chose this port,
// so a busy one is refused rather than replaced.
roon.on('settings_changed', (settings) => {
  if (settings.port === configuredPort) return;
  const previous = server.port;
  server.listen(settings.port).then(
    () => {
      configuredPort = settings.port;
      portNote = '';
      startError = '';
      publishLinks();
      logLinks();
      roon.reconnect();
    },
    (err) => {
      console.error(`Could not move to port ${settings.port}: ${err.message}`);
      roon.setStatusLine(
        previous
          ? `Port ${settings.port} is not available, still on ${previous}`
          : `Port ${settings.port} is not available either. Pick another web port in the settings.`
      );
    }
  );
});

// Start Roon discovery once the web server knows its port, so the link Roon
// shows for the extension points at the RoonParty screen from the first pairing.
// If the configured port is taken (another app, or an old copy still running),
// use the next free one rather than failing, and say so. If none is free, still
// connect to Roon, so the host can pick another port in the settings.
listenWithFallback((port) => server.listen(port), configuredPort).then(
  (port) => {
    if (port !== configuredPort) {
      portNote = ` (port ${configuredPort} was busy)`;
      console.warn(`Port ${configuredPort} is in use, using ${port} instead`);
    }
    publishLinks();
    logLinks();
    roon.start();
  },
  (err) => {
    const range = `${configuredPort}-${configuredPort + FALLBACK_PORTS}`;
    startError =
      err.code === 'EADDRINUSE'
        ? `Ports ${range} are all in use. Pick another web port in the settings.`
        : `Could not open port ${configuredPort} (${err.code || err.message}). Pick another web port in the settings.`;
    console.error(startError);
    publishLinks();
    roon.start();
  }
);

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
