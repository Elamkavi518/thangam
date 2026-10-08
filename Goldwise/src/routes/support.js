import { Router } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../db/pool.js';
import { validate } from '../middleware/validate.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncHandler, notFound, forbidden, conflict } from '../utils/errors.js';

const r = Router();
r.use(requireAuth);
const uuid = z.string().uuid();
const isStaff = (u) => u.role === 'admin';

async function loadThread(req) {
  const t = (await query(`SELECT t.*, u.name AS customer_name, u.email AS customer_email FROM support_threads t JOIN users u ON u.id = t.user_id WHERE t.id = $1`, [req.params.id])).rows[0];
  if (!t) throw notFound('Conversation not found');
  if (t.user_id !== req.user.id && !isStaff(req.user)) throw forbidden();
  return t;
}

// Start a conversation with the team
r.post('/threads', validate({ body: z.object({ subject: z.string().trim().min(2).max(150), message: z.string().trim().min(1).max(2000) }) }), asyncHandler(async (req, res) => {
  const out = await withTransaction(async (c) => {
    const t = (await c.query('INSERT INTO support_threads (user_id, subject) VALUES ($1,$2) RETURNING *', [req.user.id, req.body.subject])).rows[0];
    await c.query('INSERT INTO support_messages (thread_id, sender_id, sender_role, body) VALUES ($1,$2,$3,$4)', [t.id, req.user.id, req.user.role, req.body.message]);
    return t;
  });
  res.status(201).json({ thread: out });
}));

// My conversations (admins: all, optionally filtered by status)
r.get('/threads', validate({ query: z.object({ status: z.enum(['open', 'closed']).optional() }) }), asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT t.id, t.subject, t.status, t.created_at, t.last_message_at, u.name AS customer_name, u.email AS customer_email,
            (SELECT body FROM support_messages m WHERE m.thread_id = t.id ORDER BY m.id DESC LIMIT 1) AS last_message,
            (SELECT sender_role FROM support_messages m WHERE m.thread_id = t.id ORDER BY m.id DESC LIMIT 1) AS last_sender_role
       FROM support_threads t JOIN users u ON u.id = t.user_id
      WHERE ($1::boolean OR t.user_id = $2) AND ($3::text IS NULL OR t.status = $3)
      ORDER BY t.last_message_at DESC LIMIT 200`,
    [isStaff(req.user), req.user.id, req.query.status ?? null]);
  res.json({ threads: rows });
}));

// Messages in a conversation; ?after=<id> returns only newer ones (used for polling)
r.get('/threads/:id', validate({ params: z.object({ id: uuid }), query: z.object({ after: z.coerce.number().int().min(0).default(0) }) }), asyncHandler(async (req, res) => {
  const t = await loadThread(req);
  const { rows } = await query(
    `SELECT m.id, m.sender_role, m.body, m.created_at, u.name AS sender_name FROM support_messages m JOIN users u ON u.id = m.sender_id WHERE m.thread_id = $1 AND m.id > $2 ORDER BY m.id`, [t.id, req.query.after]);
  res.json({ thread: { id: t.id, subject: t.subject, status: t.status, customer_name: t.customer_name }, messages: rows });
}));

r.post('/threads/:id/messages', validate({ params: z.object({ id: uuid }), body: z.object({ message: z.string().trim().min(1).max(2000) }) }), asyncHandler(async (req, res) => {
  const t = await loadThread(req);
  if (t.status === 'closed') throw conflict('This conversation is closed');
  const out = await withTransaction(async (c) => {
    const m = (await c.query('INSERT INTO support_messages (thread_id, sender_id, sender_role, body) VALUES ($1,$2,$3,$4) RETURNING id, sender_role, body, created_at', [t.id, req.user.id, req.user.role, req.body.message])).rows[0];
    await c.query('UPDATE support_threads SET last_message_at = now() WHERE id = $1', [t.id]);
    return m;
  });
  res.status(201).json({ message: out });
}));

r.patch('/threads/:id', requireRole('admin'), validate({ params: z.object({ id: uuid }), body: z.object({ status: z.enum(['open', 'closed']) }) }), asyncHandler(async (req, res) => {
  const { rows } = await query('UPDATE support_threads SET status = $2 WHERE id = $1 RETURNING id, status', [req.params.id, req.body.status]);
  if (!rows[0]) throw notFound('Conversation not found');
  res.json({ thread: rows[0] });
}));
export default r;
