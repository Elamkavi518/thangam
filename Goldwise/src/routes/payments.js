import { Router } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { query } from '../db/pool.js';
import env from '../config/env.js';
import { validate } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler, notFound, forbidden, conflict, ServiceUnavailable } from '../utils/errors.js';
import { recordApiEvent } from '../services/events.js';

const r = Router();
r.use(requireAuth);
const BASE = (!env.isProd && env.RAZORPAY_BASE_URL) || 'https://api.razorpay.com/v1';
const missing = () => ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET'].filter((k) => !env[k]);

export const signatureOk = (orderId, paymentId, signature, secret) => {
  const expected = crypto.createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');
  const a = Buffer.from(expected); const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

r.get('/config', (_req, res) => res.json({ razorpay_enabled: missing().length === 0, config_required: missing() }));

// Create a Razorpay order for one of my GoldWise orders
r.post('/razorpay/order', validate({ body: z.object({ order_id: z.string().uuid() }) }), asyncHandler(async (req, res) => {
  if (missing().length) throw new ServiceUnavailable('payments', `Online payment is not set up. Required configuration: ${missing().join(', ')}.`, missing());
  const o = (await query('SELECT * FROM orders WHERE id = $1', [req.body.order_id])).rows[0];
  if (!o) throw notFound('Order not found');
  if (o.user_id !== req.user.id) throw forbidden();
  if (o.payment_status === 'paid') throw conflict('Order is already paid');
  if (o.status === 'cancelled') throw conflict('Order is cancelled');
  const auth = Buffer.from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`).toString('base64');
  let resp; let json;
  try {
    resp = await fetch(`${BASE}/orders`, { method: 'POST', headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: Math.round(o.total * 100), currency: o.currency, receipt: o.id.slice(0, 40) }), signal: AbortSignal.timeout(10_000) });
    json = await resp.json();
  } catch (e) {
    await recordApiEvent({ service: 'payments', ok: false, message: `unreachable: ${e.message}` });
    throw new ServiceUnavailable('payments', 'The payment gateway could not be reached.');
  }
  if (!resp.ok) {
    await recordApiEvent({ service: 'payments', ok: false, httpStatus: resp.status, message: json?.error?.description });
    throw new ServiceUnavailable('payments', `Payment gateway error: ${json?.error?.description || resp.status}`);
  }
  await recordApiEvent({ service: 'payments', ok: true, httpStatus: resp.status, message: 'order created' });
  await query('UPDATE orders SET razorpay_order_id = $2, updated_at = now() WHERE id = $1', [o.id, json.id]);
  res.json({ key_id: env.RAZORPAY_KEY_ID, razorpay_order_id: json.id, amount: json.amount, currency: json.currency });
}));

// Confirm a payment: the signature proves Razorpay (not the browser) says it was paid
r.post('/razorpay/verify', validate({ body: z.object({ order_id: z.string().uuid(), razorpay_order_id: z.string(), razorpay_payment_id: z.string(), razorpay_signature: z.string() }) }), asyncHandler(async (req, res) => {
  if (missing().length) throw new ServiceUnavailable('payments', `Required configuration: ${missing().join(', ')}.`, missing());
  const b = req.body;
  const o = (await query('SELECT * FROM orders WHERE id = $1', [b.order_id])).rows[0];
  if (!o) throw notFound('Order not found');
  if (o.user_id !== req.user.id) throw forbidden();
  if (o.razorpay_order_id !== b.razorpay_order_id) throw conflict('Payment does not belong to this order');
  if (!signatureOk(b.razorpay_order_id, b.razorpay_payment_id, b.razorpay_signature, env.RAZORPAY_KEY_SECRET)) {
    await query(`UPDATE orders SET payment_status = 'failed', updated_at = now() WHERE id = $1 AND payment_status <> 'paid'`, [o.id]);
    throw conflict('Payment signature could not be verified');
  }
  const { rows } = await query(`UPDATE orders SET payment_status='paid', razorpay_payment_id=$2, paid_at=now(), status = CASE WHEN status='pending' THEN 'confirmed'::order_status ELSE status END, updated_at=now() WHERE id=$1 RETURNING *`, [o.id, b.razorpay_payment_id]);
  res.json({ order: rows[0] });
}));
export default r;
