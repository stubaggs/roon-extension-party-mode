'use strict';

const { RoonService } = require('./lib/roon-service');
const { GuestStore } = require('./lib/guests');
const { createServer } = require('./lib/server');

const roon = new RoonService();
const guests = new GuestStore();
const server = createServer(roon, guests);

const port = Number(process.env.PARTY_PORT) || roon.settings.port || 8080;

function publishLinks() {
  roon.setWebsite(server.roonpartyUrl());
  roon.setStatusLine(`RoonParty at ${server.roonpartyUrl()}`);
}

roon.on('core_paired', publishLinks);
// A new guest address override changes the links. Roon picks up the new website
// on its next registration; the status line updates straight away.
roon.on('settings_changed', publishLinks);

// Start Roon discovery once the web server knows its port, so the link Roon
// shows for the extension points at the RoonParty screen from the first pairing.
server.listen(port).then(() => {
  publishLinks();
  console.log(`Party Mode listening on port ${port}`);
  console.log(`Guest link: ${server.guestUrl()}`);
  console.log(`RoonParty:  ${server.roonpartyUrl()}`);
  roon.start();
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
