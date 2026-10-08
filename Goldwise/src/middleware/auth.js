import jwt from 'jsonwebtoken';
import env from '../config/env.js';
import { query } from '../db/pool.js';
import { unauthorized, forbidden } from '../utils/errors.js';

export const signToken = (user) => jwt.sign({ sub: user.id, role: user.role }, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN, algorithm: 'HS256' });

async function load(req, required) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) {
    if (required) throw unauthorized();
    return;
  }
  let payload;
  try {
    payload = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] });
  } catch {
    throw unauthorized('Invalid or expired token');
  }
  const { rows } = await query('SELECT id, email, name, role, language, is_active FROM users WHERE id = $1', [payload.sub]);
  const user = rows[0];
  if (!user || !user.is_active) throw unauthorized('Account not found or disabled');
  req.user = user; // role comes from the database, not the token
}

export const requireAuth = (req, _res, next) => load(req, true).then(() => next(), next);
export const optionalAuth = (req, _res, next) => load(req, false).then(() => next(), next);
export const requireRole = (...roles) => (req, _res, next) => (roles.includes(req.user?.role) ? next() : next(forbidden()));
