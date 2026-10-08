import { Router } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../db/pool.js';
import { validate } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler, notFound, badRequest, conflict, forbidden, HttpError } from '../utils/errors.js';
import { productSelect, priceProducts } from '../services/pricing.js';
import { ensureFresh } from '../services/metals/metalsService.js';
import { getStoreForWrite } from '../services/access.js';
import env from '../config/env.js';

const r = Router();
r.use(requireAuth);
const uuid = z.string().uuid();

r.post('/', validate({
  body: z.object({
    items: z.array(z.object({ product_id: uuid, quantity: z.number().int().min(1).max(20) })).min(1).max(30),
    notes: z.string().max(500).optional(),
  }),
}), asyncHandler(async (req, res) => {
  await ensureFresh();
  const order = await withTransaction(async (c) => {
    const ids = req.body.items.map((i) => i.product_id);
    if (new Set(ids).size !== ids.length) throw badRequest('Duplicate products in order; combine them into one line');
    // Lock product rows so concurrent orders cannot oversell
    const locked = (await c.query('SELECT id FROM products WHERE id = ANY($1) FOR UPDATE', [ids])).rows;
    if (locked.length !== ids.length) throw notFound('One or more products not found');
    const { rows } = await c.query(`${productSelect} WHERE p.id = ANY($1)`, [ids]);
    const priced = await priceProducts(rows);
    const stores = new Set(rows.map((p) => p.store_id));
    if (stores.size !== 1) throw badRequest('An order can only contain products from one store');
    let total = 0;
    const lines = [];
    for (const item of req.body.items) {
      const row = rows.find((p) => p.id === item.product_id);
      const p = priced.find((x) => x.id === item.product_id);
      if (!row.is_active || row.verification_status !== 'verified') throw conflict(`"${row.name}" is not available`);
      if (row.stock_status === 'out_of_stock' || (row.stock_status !== 'made_to_order' && row.stock_quantity < item.quantity)) throw conflict(`"${row.name}" does not have enough stock`);
      if (!p.price.complete) throw new HttpError(409, 'PRICE_INCOMPLETE', `"${row.name}" cannot be priced: ${p.price.error || 'the store has not supplied wastage'}`);
      const age = (Date.now() - new Date(p.price.metal_price.fetched_at).getTime()) / 60000;
      if (age > env.METALS_MAX_STALE_MINUTES) throw new HttpError(409, 'PRICE_STALE', 'Live update unavailable — orders are paused until a fresh metal price is received');
      lines.push({ item, row, p });
      total += p.price.estimated_final_price * item.quantity;
    }
    total = Math.round(total * 100) / 100;
    const o = (await c.query('INSERT INTO orders (user_id, store_id, currency, total, notes) VALUES ($1,$2,$3,$4,$5) RETURNING *', [req.user.id, [...stores][0], lines[0].p.price.currency, total, req.body.notes ?? null])).rows[0];
    for (const { item, row, p } of lines) {
      await c.query(
        `INSERT INTO order_items (order_id, product_id, product_name, quantity, unit_total, price_breakdown, metal_price_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [o.id, row.id, row.name, item.quantity, p.price.estimated_final_price, JSON.stringify(p.price), p.price.metal_price.id]);
      if (row.stock_status !== 'made_to_order') {
        const left = row.stock_quantity - item.quantity;
        await c.query(`UPDATE products SET stock_quantity=$2, stock_status = CASE WHEN $2 = 0 THEN 'out_of_stock'::stock_status ELSE stock_status END, updated_at=now() WHERE id=$1`, [row.id, left]);
      }
    }
    return o;
  });
  res.status(201).json({ order, note: 'Estimated price locked from the stored provider price shown in each line. Payment is arranged with the store.' });
}));

const withItems = `SELECT o.*, s.name AS store_name,
  COALESCE((SELECT json_agg(json_build_object('product_id', i.product_id, 'name', i.product_name, 'quantity', i.quantity, 'unit_total', i.unit_total, 'breakdown', i.price_breakdown, 'metal_price_id', i.metal_price_id)) FROM order_items i WHERE i.order_id = o.id), '[]') AS items
  FROM orders o JOIN stores s ON s.id = o.store_id`;

r.get('/mine', asyncHandler(async (req, res) => {
  const { rows } = await query(`${withItems} WHERE o.user_id = $1 ORDER BY o.created_at DESC LIMIT 100`, [req.user.id]);
  res.json({ orders: rows });
}));

r.get('/store/:storeId', validate({ params: z.object({ storeId: uuid }) }), asyncHandler(async (req, res) => {
  await getStoreForWrite(req.user, req.params.storeId);
  const { rows } = await query(`${withItems} WHERE o.store_id = $1 ORDER BY o.created_at DESC LIMIT 200`, [req.params.storeId]);
  res.json({ orders: rows });
}));

r.get('/:id', validate({ params: z.object({ id: uuid }) }), asyncHandler(async (req, res) => {
  const { rows } = await query(`${withItems} WHERE o.id = $1`, [req.params.id]);
  const o = rows[0];
  if (!o) throw notFound('Order not found');
  if (o.user_id !== req.user.id) await getStoreForWrite(req.user, o.store_id).catch(() => { throw forbidden(); });
  res.json({ order: o });
}));

r.patch('/:id/status', validate({ params: z.object({ id: uuid }), body: z.object({ status: z.enum(['confirmed', 'ready', 'completed', 'cancelled']) }) }), asyncHandler(async (req, res) => {
  const o = (await query('SELECT * FROM orders WHERE id = $1', [req.params.id])).rows[0];
  if (!o) throw notFound('Order not found');
  const isOwner = o.user_id === req.user.id;
  if (isOwner) {
    if (req.body.status !== 'cancelled' || o.status !== 'pending') throw forbidden('Customers can only cancel pending orders');
  } else {
    await getStoreForWrite(req.user, o.store_id);
  }
  if (['completed', 'cancelled'].includes(o.status)) throw conflict(`Order is already ${o.status}`);
  const out = await withTransaction(async (c) => {
    const u = (await c.query('UPDATE orders SET status=$2, updated_at=now() WHERE id=$1 RETURNING *', [o.id, req.body.status])).rows[0];
    if (req.body.status === 'cancelled') {
      await c.query(
        `UPDATE products p SET stock_quantity = p.stock_quantity + i.quantity,
            stock_status = CASE WHEN p.stock_status = 'out_of_stock' THEN 'in_stock'::stock_status ELSE p.stock_status END, updated_at=now()
          FROM order_items i WHERE i.order_id = $1 AND i.product_id = p.id AND p.stock_status <> 'made_to_order'`, [o.id]);
    }
    return u;
  });
  res.json({ order: out });
}));

export default r;
