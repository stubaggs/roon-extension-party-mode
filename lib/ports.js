'use strict';

/** How many ports after the configured one to try when it is busy at startup. */
const FALLBACK_PORTS = 9;

/**
 * Listen on `port`, or on the next free port after it when it is already in
 * use, trying up to FALLBACK_PORTS more. `listen(port)` must return a promise
 * that rejects with the server error. Resolves with the port actually used;
 * rejects with the last error when none is free, or straight away for any
 * error other than "in use" (no permission, bad port).
 */
async function listenWithFallback(listen, port, tries = FALLBACK_PORTS) {
  let lastError = null;
  for (let candidate = port; candidate <= Math.min(port + tries, 65535); candidate += 1) {
    try {
      await listen(candidate);
      return candidate;
    } catch (err) {
      if (err.code !== 'EADDRINUSE') throw err;
      lastError = err;
    }
  }
  throw lastError;
}

module.exports = { listenWithFallback, FALLBACK_PORTS };
