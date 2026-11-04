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

const { listenWithFallback, FALLBACK_PORTS } = require('./ports');

/** "Port 8340 is in use", or why else it couldn't be opened. */
function portProblem(port, err) {
  return err.code === 'EADDRINUSE' ? `Port ${port} is in use` : `Could not open port ${port} (${err.code || err.message})`;
}

/**
 * Wires the Roon service to the web server (app.js): opens the web port, then
 * starts Roon discovery, and keeps Roon's links current. Resolves once
 * discovery has started.
 */
function start(roon, server) {
  // Set when no port could be opened at startup; the host fixes it in Roon.
  let startError = '';

  function publishLinks() {
    if (!server.port) {
      // No web server, so no playlist address either.
      roon.setPlaylistUrl(null);
      roon.setStatusLine(startError, true);
      return;
    }
    // Roon's link for the extension: the About page, which says what Party Mode
    // is and who makes it, with the Party Hub one click on.
    roon.setWebsite(server.aboutUrl());
    roon.setPlaylistUrl(() => server.playlistUrl());
    roon.setStatusLine(`Hub: ${server.hubUrl()}`);
  }

  function logLinks() {
    console.log(`[PartyMode] ${roon.api.extension_reginfo.display_name} listening on port ${server.port}`);
    console.log(`[PartyMode] Guest link: ${server.guestUrl()}`);
    console.log(`[PartyMode] Party Hub:  ${server.hubUrl()}`);
  }

  // The website link goes to Roon only with the registration, sent before the
  // Core pairs. Started before the network was up (after a reboot), the address
  // in it was 127.0.0.1: if the link has changed since, register again so Roon
  // shows the new one. Checked again when the party zone arrives, as a Core on
  // this computer pairs with no network at all. The next check finds it unchanged.
  function registerNewLink() {
    const registered = roon.api.extension_reginfo.website;
    publishLinks();
    if (roon.api.extension_reginfo.website !== registered) roon.reconnect();
  }
  roon.on('core_paired', registerNewLink);
  roon.on('zone_arrived', registerNewLink);

  // The port last asked for in the settings. Compared with this rather than the
  // port in use, so saving other settings while on a fallback port doesn't retry.
  let configuredPort = roon.settings.port;

  // A new web port in the extension settings moves the web server there, then
  // reconnects to the Core so Roon shows the new link. The host chose this port,
  // so one that can't be opened is refused rather than replaced: the port in use
  // goes back into the settings, so they always say where Party Mode is. With no
  // web server running (the port at startup couldn't be opened), saving the same
  // port again tries it again.
  roon.on('settings_changed', (settings) => {
    if (settings.port === configuredPort && server.port) return;
    const previous = server.port;
    server.listen(settings.port).then(
      () => {
        configuredPort = settings.port;
        startError = '';
        publishLinks();
        logLinks();
        roon.reconnect();
      },
      (err) => {
        console.error(`[PartyMode] Could not move to port ${settings.port}: ${err.message}`);
        if (previous) {
          const why = err.code === 'EADDRINUSE' ? `${settings.port} is in use` : `could not open ${settings.port} (${err.code || err.message})`;
          roon.refusePort(previous, `Web port not changed: ${why}, still on ${previous}`);
          return;
        }
        configuredPort = settings.port;
        startError = `${portProblem(settings.port, err)}. Pick another web port in the settings.`;
        publishLinks();
      }
    );
  });

  // Start Roon discovery once the web server knows its port, so the link Roon
  // shows for the extension points at the Party Hub from the first pairing.
  // A port the host chose (saved in the settings, or in the environment) is used
  // or nothing: if it's taken, the status says so. Before one is chosen, a taken
  // 8338 (another app, or another copy of Party Mode) gives way to the next free
  // port, logged rather than a warning, as a second copy relies on it; the port
  // in use goes into the settings, so the first Save keeps it. If none is free,
  // still connect to Roon, so the host can pick another port in the settings.
  const tries = roon.portChosen ? 0 : FALLBACK_PORTS;
  return listenWithFallback((port) => server.listen(port), configuredPort, tries).then(
    (port) => {
      if (port !== configuredPort) {
        console.log(`[PartyMode] Port ${configuredPort} is in use, using ${port} instead`);
        roon.settings.port = port;
        configuredPort = port;
      }
      publishLinks();
      logLinks();
      roon.start();
    },
    (err) => {
      const problem =
        tries && err.code === 'EADDRINUSE'
          ? `Ports ${configuredPort}-${configuredPort + tries} are all in use`
          : portProblem(configuredPort, err);
      startError = `${problem}. Pick another web port in the settings.`;
      console.error(`[PartyMode] ${startError}`);
      publishLinks();
      roon.start();
    }
  );
}

module.exports = { start };
