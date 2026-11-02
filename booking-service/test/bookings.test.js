// Integration tests for the Booking Service: real PostgreSQL, mock gateway for the other services.
// Test IDs (BS-xx) match the test definition in docs/testing-karol.md.
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp, token, waitFor, SERVICE_TOKEN } = require('./helpers');

let t;
const anna = token(2);
const ben = token(3);
const organizer = token(1, 'organizer');
const book = (body, auth = anna) => t.request('POST', '/bookings', { auth, body });
const valid = { eventId: 1, quantity: 2, paymentToken: 'tok_ok' };
const statusInDb = async (id) => (await t.db.pool.query('SELECT status FROM bookings WHERE id = $1', [id])).rows[0].status;

before(async () => { t = await startTestApp(); });
after(async () => { await t.stop(); });
beforeEach(async () => {
  t.gateway.reset();
  await t.db.pool.query('TRUNCATE bookings RESTART IDENTITY');
});

describe('health and routing', () => {
  it('BS-01 GET /health returns 200 when the database is reachable', async () => {
    const res = await t.request('GET', '/health');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { status: 'ok' });
  });

  it('BS-02 unknown routes return 404 JSON', async () => {
    const res = await t.request('GET', '/nope');
    assert.equal(res.status, 404);
    assert.equal(res.body.error, 'Not found');
  });
});

describe('authentication and authorization', () => {
  it('BS-03 request without token is rejected with 401', async () => {
    const res = await t.request('POST', '/bookings', { body: valid });
    assert.equal(res.status, 401);
  });

  it('BS-04 token signed with a wrong secret is rejected with 401', async () => {
    const res = await book(valid, token(2, 'customer', 'wrong-secret'));
    assert.equal(res.status, 401);
  });

  it('BS-05 organizer cannot book (403)', async () => {
    const res = await book(valid, organizer);
    assert.equal(res.status, 403);
    assert.equal(t.gateway.state.calls.length, 0, 'no service may be called');
  });
});

describe('input validation', () => {
  const cases = [
    ['BS-06a missing body', undefined],
    ['BS-06b quantity 0', { ...valid, quantity: 0 }],
    ['BS-06c quantity 11', { ...valid, quantity: 11 }],
    ['BS-06d quantity not an integer', { ...valid, quantity: 1.5 }],
    ['BS-06e eventId as string', { ...valid, eventId: '1' }],
    ['BS-06f negative eventId', { ...valid, eventId: -1 }],
    ['BS-06g empty paymentToken', { ...valid, paymentToken: '' }],
  ];
  for (const [name, body] of cases) {
    it(`${name} → 400 and nothing is stored`, async () => {
      const res = await book(body);
      assert.equal(res.status, 400);
      const { rows } = await t.db.pool.query('SELECT count(*)::int AS n FROM bookings');
      assert.equal(rows[0].n, 0);
    });
  }

  it('BS-07 malformed JSON → 400', async () => {
    const res = await t.request('POST', '/bookings', { auth: anna, raw: '{"eventId": 1,' });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'Invalid JSON body');
  });

  it('BS-08 quantity 1 and 10 (boundaries) are accepted', async () => {
    assert.equal((await book({ ...valid, quantity: 1 })).status, 201);
    assert.equal((await book({ ...valid, quantity: 10 - 1 })).status, 201);
    t.gateway.state.events[1].available = 10;
    assert.equal((await book({ ...valid, quantity: 10 })).status, 201);
  });
});

describe('booking saga', () => {
  it('BS-09 successful booking → 201 CONFIRMED, price from the event service', async () => {
    const res = await book(valid);
    assert.equal(res.status, 201);
    assert.equal(res.body.status, 'CONFIRMED');
    assert.equal(res.body.totalPrice, 99.8);
    assert.equal(res.body.userId, 2);
    assert.equal(res.body.eventId, 1);
    assert.equal(await statusInDb(res.body.id), 'CONFIRMED');
    assert.equal(t.gateway.state.events[1].available, 8);
  });

  it('BS-10 internal calls carry the service token and the right payloads', async () => {
    const res = await book(valid);
    const [reserve] = t.gateway.callsTo(/reserve$/);
    const [payment] = t.gateway.callsTo(/payments$/);
    assert.deepEqual(reserve.body, { quantity: 2 });
    assert.deepEqual(payment.body, { bookingId: res.body.id, amount: 99.8, paymentToken: 'tok_ok' });
    for (const call of t.gateway.state.calls) assert.equal(call.serviceToken, SERVICE_TOKEN);
  });

  it('BS-11 a confirmation notification is sent to the customer', async () => {
    const res = await book(valid);
    assert.ok(await waitFor(() => t.gateway.callsTo(/notifications$/).length === 1));
    const [note] = t.gateway.callsTo(/notifications$/);
    assert.equal(note.body.userId, 2);
    assert.match(note.body.message, new RegExp(`#${res.body.id}`));
  });

  it('BS-12 price is rounded to 2 decimals', async () => {
    t.gateway.state.events[1].price = 0.1;
    const res = await book({ ...valid, quantity: 3 });
    assert.equal(res.body.totalPrice, 0.3);
  });

  it('BS-13 declined payment → 402, booking FAILED, tickets released', async () => {
    const res = await book({ ...valid, paymentToken: 'tok_fail' });
    assert.equal(res.status, 402);
    assert.equal(res.body.booking.status, 'FAILED');
    assert.equal(await statusInDb(res.body.booking.id), 'FAILED');
    assert.equal(t.gateway.callsTo(/release$/).length, 1);
    assert.equal(t.gateway.state.events[1].available, 10);
  });

  it('BS-14 not enough tickets → 409, FAILED, no payment attempted', async () => {
    const res = await book({ ...valid, quantity: 9, eventId: 1 }, anna);
    assert.equal(res.status, 201);
    const second = await book({ ...valid, quantity: 2 });
    assert.equal(second.status, 409);
    assert.equal(second.body.booking.status, 'FAILED');
    assert.equal(t.gateway.callsTo(/payments$/).length, 1, 'only the first booking was paid');
    assert.equal(t.gateway.callsTo(/release$/).length, 0, 'nothing reserved, nothing to release');
  });

  it('BS-15 unknown event → 404, FAILED', async () => {
    const res = await book({ ...valid, eventId: 999 });
    assert.equal(res.status, 404);
    assert.equal(res.body.booking.status, 'FAILED');
  });

  it('BS-16 event service unreachable → 503, no release needed', async () => {
    t.gateway.state.reserve = 'down';
    const res = await book(valid);
    assert.equal(res.status, 503);
    assert.equal(res.body.booking.status, 'FAILED');
    assert.equal(t.gateway.callsTo(/release$/).length, 0);
  });

  it('BS-17 event service returns 500 → 503', async () => {
    t.gateway.state.reserve = 'error';
    const res = await book(valid);
    assert.equal(res.status, 503);
    assert.equal(res.body.booking.status, 'FAILED');
  });

  it('BS-18 payment service returns 500 → 503, tickets released (T11)', async () => {
    t.gateway.state.payment = 'error';
    const res = await book(valid);
    assert.equal(res.status, 503);
    assert.equal(t.gateway.callsTo(/release$/).length, 1);
    assert.equal(t.gateway.state.events[1].available, 10);
  });

  it('BS-19 payment service unreachable → 503, tickets released', async () => {
    t.gateway.state.payment = 'down';
    const res = await book(valid);
    assert.equal(res.status, 503);
    assert.equal(t.gateway.state.events[1].available, 10);
  });

  it('BS-20 payment service hangs → timeout → 503, tickets released', async () => {
    t.gateway.state.payment = 'slow';
    const started = Date.now();
    const res = await book(valid);
    assert.equal(res.status, 503);
    assert.ok(Date.now() - started < 2000, 'request must not hang');
    assert.equal(t.gateway.state.events[1].available, 10);
  });

  it('BS-21 notification service down → booking still CONFIRMED (T12)', async () => {
    t.gateway.state.notify = 'down';
    const res = await book(valid);
    assert.equal(res.status, 201);
    assert.equal(res.body.status, 'CONFIRMED');
  });

  it('BS-22 release fails after declined payment → still 402 FAILED, error logged', async () => {
    t.gateway.state.release = 'error';
    const res = await book({ ...valid, paymentToken: 'tok_fail' });
    assert.equal(res.status, 402);
    assert.equal(res.body.booking.status, 'FAILED');
  });

  it('BS-23 50 parallel bookings for 10 tickets → exactly 10 confirmed (no overselling)', async () => {
    const results = await Promise.all(Array.from({ length: 50 }, () => book({ ...valid, quantity: 1 })));
    const created = results.filter((r) => r.status === 201).length;
    const rejected = results.filter((r) => r.status === 409).length;
    assert.equal(created, 10);
    assert.equal(rejected, 40);
    const { rows } = await t.db.pool.query("SELECT status, count(*)::int AS n FROM bookings GROUP BY status ORDER BY status");
    assert.deepEqual(rows, [{ status: 'CONFIRMED', n: 10 }, { status: 'FAILED', n: 40 }]);
    assert.equal(t.gateway.state.events[1].available, 0);
  });
});

describe('reading bookings', () => {
  it('BS-24 GET /bookings returns only own bookings, newest first', async () => {
    const first = await book(valid);
    const second = await book({ ...valid, quantity: 1 });
    await book(valid, ben);
    const res = await t.request('GET', '/bookings', { auth: anna });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.map((b) => b.id), [second.body.id, first.body.id]);
  });

  it('BS-25 GET /bookings/:id returns own booking', async () => {
    const created = await book(valid);
    const res = await t.request('GET', `/bookings/${created.body.id}`, { auth: anna });
    assert.equal(res.status, 200);
    assert.equal(res.body.id, created.body.id);
  });

  it('BS-26 other user\'s booking and invalid ids → 404', async () => {
    const created = await book(valid);
    assert.equal((await t.request('GET', `/bookings/${created.body.id}`, { auth: ben })).status, 404);
    assert.equal((await t.request('GET', '/bookings/abc', { auth: anna })).status, 404);
    assert.equal((await t.request('GET', '/bookings/999', { auth: anna })).status, 404);
  });
});

describe('cancelling (F8)', () => {
  it('BS-27 cancel a confirmed booking → CANCELLED, tickets released', async () => {
    const created = await book(valid);
    const res = await t.request('POST', `/bookings/${created.body.id}/cancel`, { auth: anna });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'CANCELLED');
    assert.equal(t.gateway.state.events[1].available, 10);
  });

  it('BS-28 cancelling twice → 409, tickets released only once', async () => {
    const created = await book(valid);
    await t.request('POST', `/bookings/${created.body.id}/cancel`, { auth: anna });
    const again = await t.request('POST', `/bookings/${created.body.id}/cancel`, { auth: anna });
    assert.equal(again.status, 409);
    assert.equal(t.gateway.callsTo(/release$/).length, 1);
  });

  it('BS-29 parallel double cancel releases only once', async () => {
    const created = await book(valid);
    const results = await Promise.all([1, 2, 3].map(() => t.request('POST', `/bookings/${created.body.id}/cancel`, { auth: anna })));
    assert.equal(results.filter((r) => r.status === 200).length, 1);
    assert.equal(t.gateway.callsTo(/release$/).length, 1);
    assert.equal(t.gateway.state.events[1].available, 10);
  });

  it('BS-30 cannot cancel other user\'s, failed or unknown bookings', async () => {
    const created = await book(valid);
    const failed = await book({ ...valid, paymentToken: 'tok_fail' });
    assert.equal((await t.request('POST', `/bookings/${created.body.id}/cancel`, { auth: ben })).status, 404);
    assert.equal((await t.request('POST', `/bookings/${failed.body.booking.id}/cancel`, { auth: anna })).status, 409);
    assert.equal((await t.request('POST', '/bookings/999/cancel', { auth: anna })).status, 404);
    assert.equal((await t.request('POST', '/bookings/x/cancel', { auth: anna })).status, 404);
  });

  it('BS-31 release fails during cancel → 503, booking stays CONFIRMED', async () => {
    const created = await book(valid);
    t.gateway.state.release = 'down';
    const res = await t.request('POST', `/bookings/${created.body.id}/cancel`, { auth: anna });
    assert.equal(res.status, 503);
    assert.equal(await statusInDb(created.body.id), 'CONFIRMED');
  });
});

describe('database failures', () => {
  // Temporarily replaces pool.query so that queries matching `pattern` fail.
  function breakDb(pattern = /./) {
    const real = t.db.pool.query.bind(t.db.pool);
    t.db.pool.query = (text, ...args) => (pattern.test(String(text))
      ? Promise.reject(new Error('simulated database outage'))
      : real(text, ...args));
    return () => { t.db.pool.query = real; };
  }

  it('BS-34 database down → /health returns 503', async () => {
    const restore = breakDb();
    try {
      const res = await t.request('GET', '/health');
      assert.equal(res.status, 503);
    } finally { restore(); }
  });

  it('BS-35 database fails mid-saga (after reserve) → 500, tickets released', async () => {
    const restore = breakDb(/SET status = \$2/);
    try {
      const res = await book(valid);
      assert.equal(res.status, 500);
      assert.equal(t.gateway.callsTo(/release$/).length, 1);
      assert.equal(t.gateway.state.events[1].available, 10);
    } finally { restore(); }
  });

  it('BS-36 database down → read and cancel endpoints return 500 instead of crashing', async () => {
    const created = await book(valid);
    const restore = breakDb();
    try {
      assert.equal((await t.request('GET', '/bookings', { auth: anna })).status, 500);
      assert.equal((await t.request('GET', `/bookings/${created.body.id}`, { auth: anna })).status, 500);
      assert.equal((await t.request('POST', `/bookings/${created.body.id}/cancel`, { auth: anna })).status, 500);
    } finally { restore(); }
    assert.equal((await t.request('GET', '/health')).status, 200, 'service recovers when the DB is back');
  });

  it('BS-37 startup waits for the database (retries until it is reachable)', async () => {
    let failures = 2;
    const real = t.db.pool.query.bind(t.db.pool);
    t.db.pool.query = (...args) => (failures-- > 0 ? Promise.reject(new Error('starting up')) : real(...args));
    try {
      await assert.doesNotReject(t.db.waitForDb(5, 10));
    } finally { t.db.pool.query = real; }
  });

  it('BS-38 startup gives up after the configured number of retries', async () => {
    const restore = breakDb();
    try {
      await assert.rejects(t.db.waitForDb(3, 10), /simulated database outage/);
    } finally { restore(); }
  });
});

describe('database', () => {
  it('BS-32 migration can run in parallel (two replicas starting at once)', async () => {
    await assert.doesNotReject(Promise.all([t.db.migrate(), t.db.migrate(), t.db.migrate()]));
  });

  it('BS-33 database constraint rejects invalid quantity even if validation is bypassed', async () => {
    await assert.rejects(t.db.pool.query('INSERT INTO bookings (user_id, event_id, quantity) VALUES (1, 1, 11)'));
  });
});
