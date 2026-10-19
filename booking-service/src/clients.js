const config = require('./config');

// Calls an internal endpoint through the gateway.
// Resolves with { status, data } for any HTTP response; rejects on network errors / timeouts.
async function callService(path, body) {
  const res = await fetch(`${config.gatewayUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Service-Token': config.serviceToken,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.upstreamTimeoutMs),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

const events = {
  reserve: (eventId, quantity) => callService(`/events/${eventId}/reserve`, { quantity }),
  release: (eventId, quantity) => callService(`/events/${eventId}/release`, { quantity }),
};

const payments = {
  pay: (bookingId, amount, paymentToken) =>
    callService('/payments', { bookingId, amount, paymentToken }),
};

const notifications = {
  send: (userId, message) => callService('/notifications', { userId, message }),
};

module.exports = { events, payments, notifications };
