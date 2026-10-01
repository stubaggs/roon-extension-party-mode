'use strict';

const { RoonService } = require('./lib/roon-service');
const { GuestStore } = require('./lib/guests');
const { createServer } = require('./lib/server');

const roon = new RoonService();
const guests = new GuestStore();
const server = createServer(roon, guests);

const port = Number(process.env.PARTY_PORT) || roon.settings.port || 8080;

server.listen(port).then(() => {
  roon.setStatusLine(`RoonParty at ${server.roonpartyUrl()}`);
  console.log(`Party Mode listening on port ${port}`);
  console.log(`Guest link: ${server.guestUrl()}`);
  console.log(`RoonParty:  ${server.roonpartyUrl()}`);
});

roon.on('core_paired', () => {
  roon.setStatusLine(`RoonParty at ${server.roonpartyUrl()}`);
});

roon.start();

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
