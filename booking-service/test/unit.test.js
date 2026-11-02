// Unit tests for configuration and auth middleware (no database or network needed).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');
const jwt = require('jsonwebtoken');

const SRC = path.join(__dirname, '..', 'src');

// config.js validates the environment at load time, so it is loaded in a child process.
function loadConfig(env) {
  return spawnSync(process.execPath, ['-e', `console.log(JSON.stringify(require(${JSON.stringify(path.join(SRC, 'config'))})))`],
    { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });
}

describe('config', () => {
  const base = { JWT_SECRET: 'a', SERVICE_TOKEN: 'b', DB_PASSWORD: 'c' };

  for (const missing of Object.keys(base)) {
    it(`BS-U1 refuses to start without ${missing}`, () => {
      const env = { ...base };
      delete env[missing];
      const result = loadConfig(env);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, new RegExp(`Missing required environment variable ${missing}`));
    });
  }

  it('BS-U2 uses sensible defaults', () => {
    const result = loadConfig(base);
    assert.equal(result.status, 0, result.stderr);
    const config = JSON.parse(result.stdout);
    assert.equal(config.port, 3000);
    assert.equal(config.gatewayUrl, 'http://gateway/api');
    assert.equal(config.upstreamTimeoutMs, 5000);
    assert.equal(config.db.database, 'bookings_db');
  });
});

describe('auth middleware', () => {
  process.env.JWT_SECRET ||= 'unit-secret';
  process.env.SERVICE_TOKEN ||= 'unit-token';
  process.env.DB_PASSWORD ||= 'unit-db';
  const { requireJwt, requireRole } = require('../src/auth');

  const run = (mw, req) => {
    const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    let nextCalled = false;
    mw(req, res, () => { nextCalled = true; });
    return { res, nextCalled };
  };
  const reqWith = (header) => ({ get: (name) => (name === 'Authorization' ? header : undefined) });

  it('BS-U3 valid token sets req.user and calls next()', () => {
    const req = reqWith(`Bearer ${jwt.sign({ userId: 7, username: 'x', role: 'customer', extra: 1 }, process.env.JWT_SECRET)}`);
    const { nextCalled } = run(requireJwt, req);
    assert.ok(nextCalled);
    assert.deepEqual(req.user, { userId: 7, username: 'x', role: 'customer' });
  });

  for (const [name, header] of [['missing header', undefined], ['wrong scheme', 'Basic abc'], ['empty token', 'Bearer '], ['garbage token', 'Bearer abc.def']]) {
    it(`BS-U4 ${name} → 401`, () => {
      const { res, nextCalled } = run(requireJwt, reqWith(header));
      assert.equal(nextCalled, false);
      assert.equal(res.code, 401);
    });
  }

  it('BS-U5 expired token → 401', () => {
    const expired = jwt.sign({ userId: 1, role: 'customer', exp: Math.floor(Date.now() / 1000) - 60 }, process.env.JWT_SECRET);
    assert.equal(run(requireJwt, reqWith(`Bearer ${expired}`)).res.code, 401);
  });

  it('BS-U6 requireRole lets the right role through and blocks others with 403', () => {
    assert.ok(run(requireRole('customer'), { user: { role: 'customer' } }).nextCalled);
    const blocked = run(requireRole('customer'), { user: { role: 'organizer' } });
    assert.equal(blocked.nextCalled, false);
    assert.equal(blocked.res.code, 403);
  });
});
