'use strict';

const os = require('os');
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const QRCode = require('qrcode');

const COOKIE = 'party_sid';

function lanAddress() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const entry of interfaces[name] || []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return '127.0.0.1';
}

function queueItem(item) {
  const lines = item.three_line || item.two_line || item.one_line || {};
  return {
    id: item.queue_item_id,
    title: lines.line1 || '',
    artist: lines.line2 || '',
    album: lines.line3 || '',
    length: item.length || null,
    image_key: item.image_key || null
  };
}

function nowPlaying(zone) {
  if (!zone || !zone.now_playing) return null;
  const lines = zone.now_playing.three_line || zone.now_playing.two_line || {};
  return {
    title: lines.line1 || '',
    artist: lines.line2 || '',
    album: lines.line3 || '',
    image_key: zone.now_playing.image_key || null,
    length: zone.now_playing.length || null,
    seek_position: zone.now_playing.seek_position || 0,
    state: zone.state
  };
}

function createServer(roon, guests) {
  const app = express();
  const clients = new Set();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));
  app.use(cookieParser());
  app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html' }));

  const settings = () => roon.settings;

  // The port the server is actually on. PARTY_PORT can differ from the setting,
  // and a changed setting only applies after a restart.
  let listeningPort = null;

  function baseUrl() {
    const port = listeningPort || settings().port;
    const override = (settings().guest_host || '').trim();
    const host = override || lanAddress();
    const withPort = host.includes(':') ? host : `${host}:${port}`;
    return `http://${withPort}`;
  }

  function guestUrl() {
    return `${baseUrl()}/j/${guests.joinCode}`;
  }

  function roonpartyUrl() {
    return `${baseUrl()}/roonparty`;
  }

  function broadcast(event, payload) {
    const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const res of clients) res.write(frame);
  }

  function queueSnapshot() {
    return {
      zone: roon.zone ? roon.zone.display_name : null,
      party_name: settings().party_name || '',
      now_playing: nowPlaying(roon.zone),
      upcoming: roon.queue.map(queueItem).map((item) => {
        const attribution = guests.lookup(item.title, item.artist);
        return attribution
          ? Object.assign({}, item, { requested_by: attribution.name || 'a guest', kind: attribution.kind })
          : item;
      })
    };
  }

  roon.on('queue_changed', () => broadcast('queue', queueSnapshot()));
  roon.on('now_playing_changed', () => broadcast('queue', queueSnapshot()));
  roon.on('settings_changed', () => broadcast('party', { enabled: settings().enabled }));
  roon.on('access_changed', (enabled) => {
    if (!enabled) {
      guests.clear();
    } else {
      guests.rotateJoinCode();
    }
    broadcast('party', { enabled });
  });

  // ------------------------------------------------------------ guest entry

  app.get('/j/:code', (req, res) => {
    if (!settings().enabled) return res.status(403).send('The party is closed.');
    if (req.params.code !== guests.joinCode) {
      return res.status(403).send('That code has expired. Scan the code on the screen again.');
    }
    const session = guests.create();
    res.cookie(COOKIE, session.id, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 8 * 60 * 60 * 1000
    });
    res.redirect('/');
  });

  function requireGuest(req, res, next) {
    if (!settings().enabled) return res.status(403).json({ error: 'closed' });
    const session = guests.get(req.cookies[COOKIE]);
    if (!session) return res.status(401).json({ error: 'no_session' });
    req.guest = session;
    next();
  }

  // -------------------------------------------------------------- guest API

  app.get('/api/party', requireGuest, (req, res) => {
    res.json({
      party_name: settings().party_name || '',
      zone: roon.zone ? roon.zone.display_name : null,
      ready: roon.ready,
      guest_name: req.guest.name,
      allowances: guests.allowances(req.guest, settings()),
      capabilities: {
        add: settings().allow_add,
        next: settings().allow_next,
        skip: settings().allow_skip
      }
    });
  });

  app.post('/api/name', requireGuest, (req, res) => {
    const name = String(req.body.name || '').trim().slice(0, 24);
    req.guest.name = name;
    res.json({ guest_name: name });
  });

  app.get('/api/search', requireGuest, async (req, res) => {
    const query = String(req.query.q || '').trim();
    if (query.length < 2) return res.json({ results: [] });
    if (!roon.ready) return res.status(503).json({ error: 'not_ready' });

    try {
      const items = await roon.search(req.guest.id, query);
      req.guest.lastSearch = { query, items };

      const queued = new Set(
        roon.queue.map((item) => {
          const lines = item.three_line || item.two_line || {};
          return `${(lines.line1 || '').toLowerCase()}|${(lines.line2 || '').toLowerCase()}`;
        })
      );

      res.json({
        results: items.map((item) => ({
          key: item.item_key,
          title: item.title,
          subtitle: item.subtitle || '',
          image_key: item.image_key || null,
          in_queue:
            settings().prevent_duplicates &&
            queued.has(`${(item.title || '').toLowerCase()}|${(item.subtitle || '').toLowerCase()}`)
        }))
      });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  app.post('/api/request', requireGuest, async (req, res) => {
    const mode = req.body.mode === 'next' ? 'next' : 'add';
    const bucket = mode;
    if (!roon.ready) return res.status(503).json({ error: 'not_ready' });

    const status = guests.check(req.guest, bucket, settings());
    if (!status.allowed) {
      return res.status(429).json({ error: status.reason, next_in: status.nextIn });
    }

    const title = String(req.body.title || '');
    const subtitle = String(req.body.subtitle || '');

    if (settings().prevent_duplicates) {
      const key = `${title.toLowerCase()}|${subtitle.toLowerCase()}`;
      const duplicate = roon.queue.some((item) => {
        const lines = item.three_line || item.two_line || {};
        return `${(lines.line1 || '').toLowerCase()}|${(lines.line2 || '').toLowerCase()}` === key;
      });
      if (duplicate) return res.status(409).json({ error: 'already_queued' });
    }

    try {
      await performWithRetry(req.guest, req.body.key, mode, title, subtitle);
      guests.consume(req.guest, bucket, settings());
      guests.attribute(req.guest, title, subtitle, mode);
      res.json({ ok: true, allowances: guests.allowances(req.guest, settings()) });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  /**
   * Browse item keys expire when the guest's browse session moves on. If the
   * action fails, the search is replayed once and the track matched by title.
   */
  async function performWithRetry(session, itemKey, mode, title, subtitle) {
    try {
      return await roon.performAction(session.id, itemKey, mode);
    } catch (err) {
      const last = session.lastSearch;
      if (!last) throw err;
      const items = await roon.search(session.id, last.query);
      session.lastSearch = { query: last.query, items };
      const match = items.find(
        (item) =>
          (item.title || '').toLowerCase() === title.toLowerCase() &&
          (item.subtitle || '').toLowerCase() === subtitle.toLowerCase()
      );
      if (!match) throw err;
      return roon.performAction(session.id, match.item_key, mode);
    }
  }

  app.post('/api/skip', requireGuest, async (req, res) => {
    const status = guests.check(req.guest, 'skip', settings());
    if (!status.allowed) {
      return res.status(429).json({ error: status.reason, next_in: status.nextIn });
    }
    try {
      await roon.skip();
      guests.consume(req.guest, 'skip', settings());
      res.json({ ok: true, allowances: guests.allowances(req.guest, settings()) });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  app.get('/api/queue', requireGuest, (req, res) => res.json(queueSnapshot()));

  // ---------------------------------------------------------- host displays

  app.get('/api/roonparty', (req, res) => {
    res.json(
      Object.assign(queueSnapshot(), {
        enabled: settings().enabled,
        join_url: guestUrl(),
        ready: roon.ready
      })
    );
  });

  app.get('/api/qr.svg', async (req, res) => {
    try {
      const svg = await QRCode.toString(guestUrl(), {
        type: 'svg',
        margin: 1,
        errorCorrectionLevel: 'M',
        color: { dark: '#160E24', light: '#FFFFFF' }
      });
      res.type('image/svg+xml').set('Cache-Control', 'no-store').send(svg);
    } catch (err) {
      res.status(500).end();
    }
  });

  app.get('/api/image/:key', async (req, res) => {
    const size = Math.min(1024, Math.max(48, parseInt(req.query.size, 10) || 200));
    try {
      const { contentType, body } = await roon.getImage(req.params.key, size);
      res.type(contentType || 'image/jpeg').set('Cache-Control', 'public, max-age=86400').send(body);
    } catch (err) {
      res.status(404).end();
    }
  });

  app.get('/api/events', (req, res) => {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });
    res.flushHeaders();
    res.write(`event: queue\ndata: ${JSON.stringify(queueSnapshot())}\n\n`);
    clients.add(res);

    const heartbeat = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => {
      clearInterval(heartbeat);
      clients.delete(res);
      res.end();
    });
  });

  app.get('/roonparty', (req, res) =>
    res.sendFile(path.join(__dirname, '..', 'public', 'roonparty.html'))
  );

  return {
    app,
    guestUrl,
    roonpartyUrl,
    listen(port) {
      return new Promise((resolve) => {
        const server = app.listen(port, '0.0.0.0', () => {
          listeningPort = server.address().port;
          resolve(server);
        });
      });
    }
  };
}

module.exports = { createServer, lanAddress };
