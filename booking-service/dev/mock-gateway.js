// Local stand-in for the gateway + event/payment/notification services,
// so the booking service can be tried out before the other services exist.
//
//   node dev/mock-gateway.js
//
// Env: MOCK_PORT (8080), JWT_SECRET (dev-secret), SERVICE_TOKEN (dev-token)
const http = require('http');
const jwt = require('jsonwebtoken');

const port = Number(process.env.MOCK_PORT || 8080);
const jwtSecret = process.env.JWT_SECRET || 'dev-secret';
const serviceToken = process.env.SERVICE_TOKEN || 'dev-token';

// Event 1 has 10 tickets. Change these while running via POST /mock/state.
const state = {
  events: { 1: { available: 10, price: 49.9 } },
  paymentDown: false,
  notificationsDown: false,
  notifications: [],
};

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function handle(req, res, body) {
  // Inspect / change the fake state: GET or POST /mock/state
  if (req.url === '/mock/state') {
    if (req.method === 'POST') Object.assign(state, body);
    return send(res, 200, state);
  }

  if (req.headers['x-service-token'] !== serviceToken) {
    return send(res, 401, { error: 'Invalid service token' });
  }

  let match;
  if ((match = req.url.match(/^\/api\/events\/(\d+)\/(reserve|release)$/))) {
    const event = state.events[match[1]];
    if (!event) return send(res, 404, { error: 'Event not found' });
    if (match[2] === 'reserve') {
      if (event.available < body.quantity) return send(res, 409, { error: 'Sold out' });
      event.available -= body.quantity;
      return send(res, 200, { available: event.available, price: event.price });
    }
    event.available += body.quantity;
    return send(res, 200, { available: event.available });
  }

  if (req.url === '/api/payments') {
    if (state.paymentDown) return send(res, 502, { error: 'Bad gateway' });
    const status = body.paymentToken === 'tok_ok' ? 'SUCCESS' : 'FAILED';
    return send(res, 200, { paymentId: Date.now(), status });
  }

  if (req.url === '/api/notifications') {
    if (state.notificationsDown) return send(res, 502, { error: 'Bad gateway' });
    state.notifications.push(body);
    console.log(`Notification for user ${body.userId}: ${body.message}`);
    return send(res, 201, {});
  }

  send(res, 404, { error: 'Not found' });
}

http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => (raw += chunk));
  req.on('end', () => {
    try {
      handle(req, res, raw ? JSON.parse(raw) : {});
    } catch {
      send(res, 400, { error: 'Invalid JSON body' });
    }
  });
}).listen(port, () => {
  const sign = (userId, username, role) => jwt.sign({ userId, username, role }, jwtSecret);
  console.log(`Mock gateway on http://localhost:${port}`);
  console.log(`\nCustomer token:\n${sign(2, 'anna', 'customer')}`);
  console.log(`\nOrganizer token:\n${sign(1, 'org', 'organizer')}\n`);
});
