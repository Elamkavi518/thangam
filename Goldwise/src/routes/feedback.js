import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { validate } from '../middleware/validate.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncHandler } from '../utils/errors.js';

const r = Router();
r.use(requireAuth);
r.post('/', validate({ body: z.object({ rating: z.number().int().min(1).max(5), topic: z.enum(['general', 'prices', 'stores', 'jewellery', 'loans', 'app']).default('general'), message: z.string().trim().min(1).max(2000) }) }), asyncHandler(async (req, res) => {
  const { rows } = await query('INSERT INTO feedback (user_id, rating, topic, message) VALUES ($1,$2,$3,$4) RETURNING id, created_at', [req.user.id, req.body.rating, req.body.topic, req.body.message]);
  res.status(201).json({ feedback: rows[0] });
}));
// Staff view. Nothing from here is shown publicly, so no invented or cherry-picked ratings.
r.get('/', requireRole('admin'), asyncHandler(async (_q, res) => {
  const { rows } = await query(`SELECT f.id, f.rating, f.topic, f.message, f.created_at, u.name AS user_name, u.email AS user_email FROM feedback f JOIN users u ON u.id = f.user_id ORDER BY f.created_at DESC LIMIT 300`);
  res.json({ feedback: rows, count: rows.length, average_rating: rows.length ? Math.round((rows.reduce((s, x) => s + x.rating, 0) / rows.length) * 100) / 100 : null });
}));
export default r;
