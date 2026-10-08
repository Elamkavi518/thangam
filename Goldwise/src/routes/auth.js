import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { validate } from '../middleware/validate.js';
import { requireAuth, signToken } from '../middleware/auth.js';
import { authLimiter } from '../middleware/rateLimit.js';
import { asyncHandler, conflict, unauthorized } from '../utils/errors.js';

const r = Router();
const pub = (u) => ({ id: u.id, email: u.email, name: u.name, role: u.role, language: u.language || 'en' });

r.post('/register', authLimiter, validate({
  body: z.object({
    email: z.string().email().max(254).transform((s) => s.toLowerCase()),
    password: z.string().min(10).max(128),
    name: z.string().trim().min(1).max(100),
    phone: z.string().max(30).optional(),
    account_type: z.enum(['customer', 'store']).default('customer'), // admin can never be self-registered
  }),
}), asyncHandler(async (req, res) => {
  const { email, password, name, phone, account_type } = req.body;
  const hash = await bcrypt.hash(password, 12);
  try {
    const { rows } = await query(
      `INSERT INTO users (email, password_hash, name, phone, role) VALUES ($1,$2,$3,$4,$5) RETURNING id, email, name, role, language`,
      [email, hash, name, phone || null, account_type],
    );
    res.status(201).json({ token: signToken(rows[0]), user: pub(rows[0]) });
  } catch (e) {
    if (e.code === '23505') throw conflict('An account with this email already exists');
    throw e;
  }
}));

r.post('/login', authLimiter, validate({
  body: z.object({ email: z.string().email().transform((s) => s.toLowerCase()), password: z.string().min(1).max(128) }),
}), asyncHandler(async (req, res) => {
  const { rows } = await query('SELECT * FROM users WHERE email = $1', [req.body.email]);
  const u = rows[0];
  // Same work + same message whether the user exists or not.
  const ok = await bcrypt.compare(req.body.password, u?.password_hash || '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvali');
  if (!u || !ok || !u.is_active) throw unauthorized('Invalid email or password');
  res.json({ token: signToken(u), user: pub(u) });
}));

r.get('/me', requireAuth, (req, res) => res.json({ user: pub(req.user) }));
r.patch('/me', requireAuth, validate({ body: z.object({ language: z.enum(['en', 'hi', 'ta', 'te', 'kn', 'ml']) }) }), asyncHandler(async (req, res) => {
  const { rows } = await query('UPDATE users SET language = $2, updated_at = now() WHERE id = $1 RETURNING id, email, name, role, language', [req.user.id, req.body.language]);
  res.json({ user: pub(rows[0]) });
}));

export default r;
