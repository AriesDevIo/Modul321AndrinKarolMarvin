const express = require('express');
const { pool } = require('./db');
const { requireJwt, requireServiceToken } = require('./auth');

const router = express.Router();

function toJson(row) {
  return {
    id: row.id,
    userId: Number(row.user_id),
    message: row.message,
    createdAt: row.created_at,
  };
}

router.post('/', requireServiceToken, async (req, res, next) => {
  const rawUserId = req.body?.userId;
  const userId = typeof rawUserId === 'number'
    ? rawUserId
    : typeof rawUserId === 'string' && /^\d+$/.test(rawUserId)
      ? Number(rawUserId)
      : NaN;
  const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  if (!Number.isSafeInteger(userId) || userId < 1 || message.length < 1 || message.length > 1000) {
    return res.status(400).json({
      error: 'Body must be { userId: positive integer, message: non-empty string up to 1000 characters }',
    });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO notifications (user_id, message)
       VALUES ($1, $2)
       RETURNING id, user_id, message, created_at`,
      [userId, message],
    );
    res.status(201).json(toJson(rows[0]));
  } catch (error) {
    next(error);
  }
});

router.get('/', requireJwt, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, user_id, message, created_at
         FROM notifications
        WHERE user_id = $1
        ORDER BY created_at DESC, id DESC
        LIMIT 100`,
      [req.user.userId],
    );
    res.json(rows.map(toJson));
  } catch (error) {
    next(error);
  }
});

module.exports = router;
