const express = require('express');
const { pool } = require('./db');
const { requireJwt, requireRole } = require('./auth');
const { events, payments, notifications } = require('./clients');

const router = express.Router();
router.use(requireJwt);

function toJson(row) {
  return {
    id: row.id,
    userId: row.user_id,
    eventId: row.event_id,
    quantity: row.quantity,
    totalPrice: row.total_price === null ? null : Number(row.total_price),
    status: row.status,
    createdAt: row.created_at,
  };
}

async function setStatus(id, status, totalPrice) {
  const { rows } = await pool.query(
    `UPDATE bookings
        SET status = $2, total_price = COALESCE($3, total_price), updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [id, status, totalPrice ?? null],
  );
  return rows[0];
}

// Compensation: give reserved tickets back. Never throws, the booking is failed either way.
async function releaseTickets(booking) {
  try {
    const { status } = await events.release(booking.event_id, booking.quantity);
    if (status !== 200) throw new Error(`release returned ${status}`);
  } catch (err) {
    console.error(`Booking ${booking.id}: could not release ${booking.quantity} tickets ` +
      `for event ${booking.event_id}: ${err.message}`);
  }
}

// Best effort: a notification outage must not affect the booking.
function notify(booking) {
  const message = `Your booking #${booking.id} for ${booking.quantity} ticket(s) is confirmed.`;
  notifications.send(booking.user_id, message)
    .then(({ status }) => {
      if (status >= 300) console.warn(`Booking ${booking.id}: notification returned ${status}`);
    })
    .catch((err) => console.warn(`Booking ${booking.id}: notification failed: ${err.message}`));
}

function isPositiveInt(value) {
  return Number.isInteger(value) && value > 0;
}

// POST /bookings: the booking saga (reserve → pay → confirm → notify)
router.post('/', requireRole('customer'), async (req, res, next) => {
  const { eventId, quantity, paymentToken } = req.body ?? {};
  if (!isPositiveInt(eventId) || !Number.isInteger(quantity) || quantity < 1 || quantity > 10
      || typeof paymentToken !== 'string' || !paymentToken) {
    return res.status(400).json({
      error: 'Body must be { eventId: positive integer, quantity: 1-10, paymentToken: string }',
    });
  }

  let booking;
  let reserved = false;

  const fail = async (httpStatus, error) => {
    if (reserved) await releaseTickets(booking);
    const failed = await setStatus(booking.id, 'FAILED');
    res.status(httpStatus).json({ error, booking: toJson(failed) });
  };

  try {
    const { rows } = await pool.query(
      `INSERT INTO bookings (user_id, event_id, quantity) VALUES ($1, $2, $3) RETURNING *`,
      [req.user.userId, eventId, quantity],
    );
    booking = rows[0];

    // 1. Reserve tickets (atomic in the event service)
    let reservation;
    try {
      reservation = await events.reserve(eventId, quantity);
    } catch (err) {
      return await fail(503, `Event service unavailable: ${err.message}`);
    }
    if (reservation.status === 404) return await fail(404, 'Event not found');
    if (reservation.status === 409) return await fail(409, 'Not enough tickets available');
    if (reservation.status !== 200) {
      return await fail(503, `Event service error (${reservation.status})`);
    }
    reserved = true;

    const totalPrice = Math.round(Number(reservation.data.price) * quantity * 100) / 100;
    booking = await setStatus(booking.id, 'PENDING', totalPrice);

    // 2. Pay
    let payment;
    try {
      payment = await payments.pay(booking.id, totalPrice, paymentToken);
    } catch (err) {
      return await fail(503, `Payment service unavailable: ${err.message}`);
    }
    if (payment.status >= 500 || !payment.data.status) {
      return await fail(503, `Payment service error (${payment.status})`);
    }
    if (payment.data.status !== 'SUCCESS') return await fail(402, 'Payment failed');

    // 3. Confirm, then 4. notify (fire and forget)
    booking = await setStatus(booking.id, 'CONFIRMED');
    notify(booking);
    res.status(201).json(toJson(booking));
  } catch (err) {
    // Unexpected error (e.g. database down mid-saga): compensate if we can.
    if (booking) {
      if (reserved) await releaseTickets(booking);
      await setStatus(booking.id, 'FAILED').catch(() => {});
    }
    next(err);
  }
});

// GET /bookings: own bookings
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM bookings WHERE user_id = $1 ORDER BY created_at DESC',
      [req.user.userId],
    );
    res.json(rows.map(toJson));
  } catch (err) {
    next(err);
  }
});

// GET /bookings/:id: one own booking
router.get('/:id', async (req, res, next) => {
  const id = Number(req.params.id);
  if (!isPositiveInt(id)) return res.status(404).json({ error: 'Booking not found' });
  try {
    const { rows } = await pool.query(
      'SELECT * FROM bookings WHERE id = $1 AND user_id = $2',
      [id, req.user.userId],
    );
    if (!rows[0]) return res.status(404).json({ error: 'Booking not found' });
    res.json(toJson(rows[0]));
  } catch (err) {
    next(err);
  }
});

// POST /bookings/:id/cancel: cancel a confirmed booking and release the tickets (optional, F8)
router.post('/:id/cancel', async (req, res, next) => {
  const id = Number(req.params.id);
  if (!isPositiveInt(id)) return res.status(404).json({ error: 'Booking not found' });
  try {
    // Atomic status switch, so a booking can only be cancelled (and released) once.
    const { rows } = await pool.query(
      `UPDATE bookings SET status = 'CANCELLED', updated_at = now()
        WHERE id = $1 AND user_id = $2 AND status = 'CONFIRMED'
        RETURNING *`,
      [id, req.user.userId],
    );
    const booking = rows[0];
    if (!booking) {
      const existing = await pool.query(
        'SELECT status FROM bookings WHERE id = $1 AND user_id = $2', [id, req.user.userId]);
      if (!existing.rows[0]) return res.status(404).json({ error: 'Booking not found' });
      return res.status(409).json({
        error: `Only CONFIRMED bookings can be cancelled (status is ${existing.rows[0].status})`,
      });
    }

    let released;
    try {
      released = await events.release(booking.event_id, booking.quantity);
    } catch {
      released = null;
    }
    if (released?.status !== 200) {
      // Roll back so the user can retry and the tickets aren't lost.
      await setStatus(booking.id, 'CONFIRMED');
      return res.status(503).json({ error: 'Event service unavailable, please retry' });
    }
    res.json(toJson(booking));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
