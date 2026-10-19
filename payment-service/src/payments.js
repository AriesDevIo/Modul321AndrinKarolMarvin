const express = require('express');
const { pool } = require('./db');
const { requireServiceToken } = require('./auth');

const router = express.Router();

function parsePositiveInt(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

router.post('/', requireServiceToken, async (req, res, next) => {
  const { bookingId, amount, paymentToken } = req.body ?? {};
  const parsedBookingId = parsePositiveInt(bookingId);
  if (parsedBookingId === null || typeof amount !== 'number' || !Number.isFinite(amount)
      || amount < 0 || amount > 9999999999.99
      || !['tok_ok', 'tok_fail'].includes(paymentToken)) {
    return res.status(400).json({
      error: 'Body must be { bookingId: positive integer, amount: non-negative number, paymentToken: tok_ok|tok_fail }',
    });
  }

  try {
    const status = paymentToken === 'tok_ok' ? 'SUCCESS' : 'FAILED';
    const inserted = await pool.query(
      `INSERT INTO payments (booking_id, amount, status)
       VALUES ($1, $2, $3)
       ON CONFLICT (booking_id) DO NOTHING
       RETURNING id, status`,
      [parsedBookingId, amount, status],
    );

    let payment = inserted.rows[0];
    if (!payment) {
      const existing = await pool.query(
        'SELECT id, status FROM payments WHERE booking_id = $1',
        [parsedBookingId],
      );
      payment = existing.rows[0];
    }
    if (!payment) throw new Error('Could not read the stored payment result');

    res.json({ paymentId: payment.id, status: payment.status });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
