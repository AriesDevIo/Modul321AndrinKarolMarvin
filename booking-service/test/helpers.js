// Shared test setup: a programmable mock gateway, JWT helpers and app/DB bootstrap.
const http = require('http');
const jwt = require('jsonwebtoken');

const JWT_SECRET = 'test-jwt-secret';
const SERVICE_TOKEN = 'test-service-token';

// Stands in for the gateway + Event, Payment and Notification services.
// Each endpoint has a mode: 'ok' | 'error' (HTTP 500) | 'down' (connection dropped) | 'slow' (never answers in time).
function createMockGateway() {
  const state = {};
  const reset = () => Object.assign(state, {
    events: { 1: { available: 10, price: 49.9 } },
    reserve: 'ok',
    release: 'ok',
    payment: 'ok',
    notify: 'ok',
    calls: [],
  });
  reset();

  const send = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      const call = { method: req.method, url: req.url, body, serviceToken: req.headers['x-service-token'] };
      state.calls.push(call);

      let match;
      const reserveOrRelease = req.url.match(/^\/api\/events\/(\d+)\/(reserve|release)$/);
      const endpoint = reserveOrRelease ? reserveOrRelease[2]
        : req.url === '/api/payments' ? 'payment'
          : req.url === '/api/notifications' ? 'notify' : null;
      const mode = endpoint ? state[endpoint] : 'ok';

      if (mode === 'down') return req.socket.destroy();
      if (mode === 'slow') return; // never answer, the client times out
      if (mode === 'error') return send(res, 500, { error: 'boom' });
      if (req.headers['x-service-token'] !== SERVICE_TOKEN) return send(res, 401, { error: 'bad service token' });

      if ((match = reserveOrRelease)) {
        const event = state.events[match[1]];
        if (!event) return send(res, 404, { error: 'event not found' });
        if (match[2] === 'reserve') {
          if (event.available < body.quantity) return send(res, 409, { error: 'sold out' });
          event.available -= body.quantity;
          return send(res, 200, { available: event.available, price: event.price });
        }
        event.available += body.quantity;
        return send(res, 200, { available: event.available });
      }
      if (endpoint === 'payment') {
        return send(res, 200, { paymentId: state.calls.length, status: body.paymentToken === 'tok_ok' ? 'SUCCESS' : 'FAILED' });
      }
      if (endpoint === 'notify') return send(res, 201, { id: 1, ...body });
      send(res, 404, { error: 'not found' });
    });
  });

  return {
    state,
    reset,
    callsTo: (pattern) => state.calls.filter((c) => pattern.test(c.url)),
    listen: () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port))),
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }),
  };
}

function token(userId, role = 'customer', secret = JWT_SECRET) {
  return jwt.sign({ userId, username: `user${userId}`, role }, secret);
}

// Starts the mock gateway, configures the environment and loads the app.
// Must run before anything requires src/config.js.
async function startTestApp() {
  const gateway = createMockGateway();
  const gatewayPort = await gateway.listen();

  Object.assign(process.env, {
    JWT_SECRET,
    SERVICE_TOKEN,
    GATEWAY_URL: `http://127.0.0.1:${gatewayPort}/api`,
    UPSTREAM_TIMEOUT_MS: '300',
    DB_HOST: process.env.TEST_DB_HOST || '127.0.0.1',
    DB_PORT: process.env.TEST_DB_PORT || '55433',
    DB_USER: 'postgres',
    DB_PASSWORD: process.env.TEST_DB_PASSWORD || 'test',
    DB_NAME: 'bookings_test',
  });

  const db = require('../src/db');
  await db.waitForDb(5, 500);
  await db.migrate();
  const app = require('../src/app');
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;

  async function request(method, path, { auth, body, raw } = {}) {
    const headers = {};
    if (auth) headers.Authorization = `Bearer ${auth}`;
    if (body !== undefined || raw !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(base + path, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }

  return {
    gateway,
    db,
    request,
    async stop() {
      await new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); });
      await gateway.close();
      await db.pool.end();
    },
  };
}

// Polls until fn() is truthy (for fire-and-forget effects like notifications).
async function waitFor(fn, timeoutMs = 2000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

module.exports = { createMockGateway, startTestApp, token, waitFor, JWT_SECRET, SERVICE_TOKEN };
