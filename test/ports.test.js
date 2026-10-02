'use strict';

const assert = require('assert');
const http = require('http');
const net = require('net');
const { listenWithFallback, FALLBACK_PORTS } = require('../lib/ports');

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

// Listens like lib/server.js does: resolves on 'listening', rejects on error.
const opened = [];
function listen(port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      opened.push(server);
      resolve(server);
    });
  });
}

/** A run of `count` consecutive free ports, found by asking the OS. */
async function freeRun(count) {
  for (;;) {
    const probe = net.createServer().listen(0, '127.0.0.1');
    await new Promise((r) => probe.once('listening', r));
    const start = probe.address().port;
    probe.close();
    if (start + count > 65535) continue;
    const held = [];
    try {
      for (let p = start; p < start + count; p += 1) held.push(await listen(p));
      held.forEach((s) => s.close());
      return start;
    } catch (err) {
      held.forEach((s) => s.close());
    }
  }
}

(async () => {
  console.log('listenWithFallback');

  await check('uses the configured port when it is free', async () => {
    const start = await freeRun(2);
    assert.strictEqual(await listenWithFallback(listen, start), start);
  });

  await check('moves to the next port when the configured one is busy', async () => {
    const start = await freeRun(3);
    await listen(start);
    assert.strictEqual(await listenWithFallback(listen, start), start + 1);
  });

  await check('skips several busy ports', async () => {
    const start = await freeRun(4);
    await listen(start);
    await listen(start + 1);
    await listen(start + 2);
    assert.strictEqual(await listenWithFallback(listen, start), start + 3);
  });

  await check('gives up with EADDRINUSE when every port in range is busy', async () => {
    const start = await freeRun(3);
    await listen(start);
    await listen(start + 1);
    await listen(start + 2);
    await assert.rejects(listenWithFallback(listen, start, 2), { code: 'EADDRINUSE' });
  });

  await check(`tries the configured port plus ${FALLBACK_PORTS} more by default`, async () => {
    const tried = [];
    const busy = (port) => {
      tried.push(port);
      return Promise.reject(Object.assign(new Error('busy'), { code: 'EADDRINUSE' }));
    };
    await assert.rejects(listenWithFallback(busy, 8338), { code: 'EADDRINUSE' });
    assert.deepStrictEqual(tried, Array.from({ length: FALLBACK_PORTS + 1 }, (_, i) => 8338 + i));
  });

  await check('other errors are not retried on another port', async () => {
    const tried = [];
    const denied = (port) => {
      tried.push(port);
      return Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' }));
    };
    await assert.rejects(listenWithFallback(denied, 8338), { code: 'EACCES' });
    assert.deepStrictEqual(tried, [8338]);
  });

  await check('never goes past 65535', async () => {
    const tried = [];
    const busy = (port) => {
      tried.push(port);
      return Promise.reject(Object.assign(new Error('busy'), { code: 'EADDRINUSE' }));
    };
    await assert.rejects(listenWithFallback(busy, 65533));
    assert.deepStrictEqual(tried, [65533, 65534, 65535]);
  });

  opened.forEach((server) => server.close());
  console.log(failures ? `\n${failures} failing` : '\nall passing');
  process.exit(failures ? 1 : 0);
})();
