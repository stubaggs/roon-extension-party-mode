'use strict';

const { RoonService } = require('./lib/roon-service');
const { GuestStore } = require('./lib/guests');
const { createServer } = require('./lib/server');

const roon = new RoonService();
const guests = new GuestStore();
const server = createServer(roon, guests);

function publishLinks() {
  roon.setWebsite(server.roonpartyUrl());
  roon.setStatusLine(`RoonParty at ${server.roonpartyUrl()}`);
}

function logLinks() {
  console.log(`Party Mode listening on port ${server.port}`);
  console.log(`Guest link: ${server.guestUrl()}`);
  console.log(`RoonParty:  ${server.roonpartyUrl()}`);
}

roon.on('core_paired', publishLinks);

// A new web port in the extension settings moves the web server there, then
// reconnects to the Core so Roon shows the new link.
roon.on('settings_changed', (settings) => {
  if (settings.port === server.port) return;
  const previous = server.port;
  server.listen(settings.port).then(
    () => {
      publishLinks();
      logLinks();
      roon.reconnect();
    },
    (err) => {
      console.error(`Could not move to port ${settings.port}: ${err.message}`);
      roon.setStatusLine(`Port ${settings.port} is not available, still on ${previous}`);
    }
  );
});

// Start Roon discovery once the web server knows its port, so the link Roon
// shows for the extension points at the RoonParty screen from the first pairing.
server.listen(roon.settings.port).then(() => {
  publishLinks();
  logLinks();
  roon.start();
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
