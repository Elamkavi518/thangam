import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { validate } from '../middleware/validate.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncHandler, notFound, badRequest, conflict } from '../utils/errors.js';
import { audit } from '../services/access.js';
import { metalStatus, refreshAll } from '../services/metals/metalsService.js';
import { placesConfigRequired, probe } from '../services/places/googlePlaces.js';
import { recordApiEvent } from '../services/events.js';
import env from '../config/env.js';

const r = Router();
r.use(requireAuth, requireRole('admin')); // every admin route is admin-only
const uuid = z.string().uuid();
const idp = z.object({ id: uuid });

// ---- Live status monitor ----
r.get('/status', validate({ query: z.object({ probe: z.enum(['true', 'false']).default('false') }) }), asyncHandler(async (req, res) => {
  const label = (ok) => (ok ? '🟢 Connected' : '🔴 Error');
  let db = { ok: false, message: null, latency_ms: null };
  const t0 = Date.now();
  try { await query('SELECT 1'); db = { ok: true, message: 'OK', latency_ms: Date.now() - t0 }; } catch (e) { db.message = e.message; }

  const [gold, silver] = await Promise.all([metalStatus('gold'), metalStatus('silver')]);

  let store = { ok: false, message: null, config_required: placesConfigRequired(), last_checked: null };
  if (store.config_required.length) store.message = `Missing configuration: ${store.config_required.join(', ')}`;
  else {
    if (req.query.probe === 'true') await probe().catch(() => {});
    const ev = (await query(`SELECT ok, message, created_at FROM api_events WHERE service IN ('places','geocoding') ORDER BY created_at DESC, id DESC LIMIT 1`)).rows[0];
    store = { ...store, ok: !!ev?.ok, message: ev ? ev.message : 'No calls made yet — use ?probe=true to test', last_checked: ev?.created_at ?? null };
  }

  res.json({
    gold_api: { status: label(gold.connected), connected: gold.connected, message: gold.message, config_required: gold.config_required, last_attempt: gold.last_attempt },
    silver_api: { status: label(silver.connected), connected: silver.connected, message: silver.message, config_required: silver.config_required, last_attempt: silver.last_attempt },
    database: { status: label(db.ok), connected: db.ok, message: db.message, latency_ms: db.latency_ms },
    store_api: { status: label(store.ok), connected: store.ok, message: store.message, config_required: store.config_required, last_checked: store.last_checked },
    last_gold_update: gold.last_successful_update,
    last_silver_update: silver.last_successful_update,
    poll_interval_seconds: env.METALS_POLL_INTERVAL_SECONDS,
    checked_at: new Date().toISOString(),
  });
}));

r.get('/api-errors', validate({ query: z.object({ service: z.enum(['gold', 'silver', 'places', 'geocoding', 'database']).optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }) }), asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT id, service, http_status, message, config_required, created_at FROM api_events WHERE NOT ok AND ($1::text IS NULL OR service = $1) ORDER BY created_at DESC, id DESC LIMIT $2`,
    [req.query.service ?? null, req.query.limit]);
  res.json({ errors: rows });
}));

// Triggers a fetch from the provider. There is deliberately no endpoint that lets anyone type in a market price.
r.post('/metals/refresh', asyncHandler(async (_req, res) => res.json(await refreshAll())));

// ---- Users ----
r.get('/users', asyncHandler(async (_req, res) => {
  const { rows } = await query('SELECT id, email, name, phone, role, is_active, created_at FROM users ORDER BY created_at DESC LIMIT 500');
  res.json({ users: rows });
}));
r.patch('/users/:id', validate({ params: idp, body: z.object({ role: z.enum(['customer', 'store', 'admin']).optional(), is_active: z.boolean().optional() }).refine((b) => Object.keys(b).length, 'Nothing to update') }), asyncHandler(async (req, res) => {
  if (req.params.id === req.user.id && (req.body.is_active === false || (req.body.role && req.body.role !== 'admin'))) throw conflict('You cannot demote or disable your own admin account');
  const { rows } = await query('UPDATE users SET role=COALESCE($2,role), is_active=COALESCE($3,is_active), updated_at=now() WHERE id=$1 RETURNING id,email,name,role,is_active', [req.params.id, req.body.role ?? null, req.body.is_active ?? null]);
  if (!rows[0]) throw notFound('User not found');
  await audit(req.user, 'user.update', 'user', req.params.id, req.body);
  res.json({ user: rows[0] });
}));

// ---- Stores / verification ----
r.get('/stores', validate({ query: z.object({ status: z.enum(['unverified', 'pending', 'verified', 'rejected']).optional() }) }), asyncHandler(async (req, res) => {
  const { rows } = await query(`SELECT s.*, u.email AS owner_email FROM stores s JOIN users u ON u.id = s.owner_id WHERE ($1::verification_status IS NULL OR s.verification_status = $1) ORDER BY s.created_at DESC LIMIT 500`, [req.query.status ?? null]);
  res.json({ stores: rows });
}));
r.post('/stores/:id/verify', validate({ params: idp, body: z.object({ status: z.enum(['verified', 'rejected', 'unverified']), note: z.string().max(500).optional() }) }), asyncHandler(async (req, res) => {
  const v = req.body.status === 'verified';
  const { rows } = await query(
    `UPDATE stores SET verification_status=$2, verification_note=$3, verified_by=CASE WHEN $4 THEN $5::uuid ELSE NULL END, verified_at=CASE WHEN $4 THEN now() ELSE NULL END, updated_at=now() WHERE id=$1 RETURNING *`,
    [req.params.id, req.body.status, req.body.note ?? null, v, req.user.id]);
  if (!rows[0]) throw notFound('Store not found');
  await audit(req.user, 'store.verify', 'store', req.params.id, req.body);
  res.json({ store: rows[0] });
}));
r.patch('/stores/:id', validate({ params: idp, body: z.object({ is_active: z.boolean() }) }), asyncHandler(async (req, res) => {
  const { rows } = await query('UPDATE stores SET is_active=$2, updated_at=now() WHERE id=$1 RETURNING *', [req.params.id, req.body.is_active]);
  if (!rows[0]) throw notFound('Store not found');
  await audit(req.user, 'store.active', 'store', req.params.id, req.body);
  res.json({ store: rows[0] });
}));

// ---- Jewelry categories ----
r.get('/jewelry-types', asyncHandler(async (_req, res) => res.json({ types: (await query('SELECT * FROM jewelry_types ORDER BY sort_order')).rows })));
r.post('/jewelry-types', validate({ body: z.object({ slug: z.string().regex(/^[a-z0-9-]{2,40}$/), name: z.string().min(2).max(60), metals: z.array(z.enum(['gold', 'silver'])).min(1), sort_order: z.number().int().default(100) }) }), asyncHandler(async (req, res) => {
  const b = req.body;
  const { rows } = await query('INSERT INTO jewelry_types (slug, name, metals, sort_order) VALUES ($1,$2,$3,$4) RETURNING *', [b.slug, b.name, b.metals, b.sort_order]);
  await audit(req.user, 'type.create', 'jewelry_type', rows[0].id, b);
  res.status(201).json({ type: rows[0] });
}));
r.patch('/jewelry-types/:id', validate({ params: z.object({ id: z.coerce.number().int() }), body: z.object({ name: z.string().min(2).max(60).optional(), is_active: z.boolean().optional(), sort_order: z.number().int().optional(), metals: z.array(z.enum(['gold', 'silver'])).min(1).optional() }) }), asyncHandler(async (req, res) => {
  const b = req.body;
  const { rows } = await query('UPDATE jewelry_types SET name=COALESCE($2,name), is_active=COALESCE($3,is_active), sort_order=COALESCE($4,sort_order), metals=COALESCE($5,metals) WHERE id=$1 RETURNING *', [req.params.id, b.name ?? null, b.is_active ?? null, b.sort_order ?? null, b.metals ?? null]);
  if (!rows[0]) throw notFound('Jewelry type not found');
  await audit(req.user, 'type.update', 'jewelry_type', req.params.id, b);
  res.json({ type: rows[0] });
}));

// ---- Store-submitted prices ----
r.get('/price-submissions', validate({ query: z.object({ status: z.enum(['pending', 'approved', 'rejected']).default('pending') }) }), asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT sp.*, s.name AS store_name FROM store_price_submissions sp JOIN stores s ON s.id = sp.store_id WHERE sp.status = $1 ORDER BY sp.submitted_at DESC LIMIT 200`, [req.query.status]);
  res.json({ submissions: rows });
}));
r.post('/price-submissions/:id/review', validate({ params: z.object({ id: z.coerce.number().int() }), body: z.object({ decision: z.enum(['approved', 'rejected']), note: z.string().max(500).optional() }) }), asyncHandler(async (req, res) => {
  const { rows } = await query(
    `UPDATE store_price_submissions SET status=$2, reviewed_by=$3, reviewed_at=now(), review_note=$4 WHERE id=$1 AND status='pending' RETURNING *`,
    [req.params.id, req.body.decision, req.user.id, req.body.note ?? null]);
  if (!rows[0]) throw conflict('Submission not found or already reviewed');
  await audit(req.user, 'price.review', 'store_price_submission', req.params.id, req.body);
  res.json({ submission: rows[0] });
}));

// ---- Wastage (admin override on behalf of a store) ----
r.get('/designs', validate({ query: z.object({ store_id: uuid.optional() }) }), asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT d.*, jt.slug AS jewelry_type, s.name AS store_name FROM designs d JOIN jewelry_types jt ON jt.id = d.jewelry_type_id JOIN stores s ON s.id = d.store_id
      WHERE ($1::uuid IS NULL OR d.store_id = $1) ORDER BY s.name, jt.sort_order, d.name LIMIT 500`, [req.query.store_id ?? null]);
  res.json({ designs: rows });
}));
r.put('/designs/:id/wastage', validate({ params: idp, body: z.object({ wastage_percent: z.number().min(0).max(100) }) }), asyncHandler(async (req, res) => {
  const cur = (await query('SELECT wastage_percent FROM designs WHERE id = $1', [req.params.id])).rows[0];
  if (!cur) throw notFound('Design not found');
  const { rows } = await query('UPDATE designs SET wastage_percent=$2, wastage_updated_at=now(), wastage_updated_by=$3 WHERE id=$1 RETURNING *', [req.params.id, req.body.wastage_percent, req.user.id]);
  await query(`INSERT INTO wastage_history (scope, scope_id, old_percent, new_percent, changed_by) VALUES ('design',$1,$2,$3,$4)`, [req.params.id, cur.wastage_percent, req.body.wastage_percent, req.user.id]);
  res.json({ design: rows[0] });
}));

// ---- Products ----
r.get('/products', validate({ query: z.object({ store_id: uuid.optional() }) }), asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT p.id, p.name, p.metal, p.purity_code, p.stock_status, p.is_active, s.name AS store_name, jt.name AS category
       FROM products p JOIN stores s ON s.id = p.store_id JOIN jewelry_types jt ON jt.id = p.jewelry_type_id
      WHERE ($1::uuid IS NULL OR p.store_id = $1) ORDER BY p.created_at DESC LIMIT 500`, [req.query.store_id ?? null]);
  res.json({ products: rows });
}));
r.patch('/products/:id', validate({ params: idp, body: z.object({ is_active: z.boolean() }) }), asyncHandler(async (req, res) => {
  const { rows } = await query('UPDATE products SET is_active=$2, updated_at=now() WHERE id=$1 RETURNING id,name,is_active', [req.params.id, req.body.is_active]);
  if (!rows[0]) throw notFound('Product not found');
  await audit(req.user, 'product.active', 'product', req.params.id, req.body);
  res.json({ product: rows[0] });
}));

// ---- Taxes / fees ----
r.get('/tax-rules', asyncHandler(async (_req, res) => res.json({ taxes: (await query('SELECT * FROM tax_rules ORDER BY name')).rows })));
const taxBody = z.object({ name: z.string().min(2).max(80), rate_percent: z.number().min(0).max(100), applies_to: z.enum(['all', 'metal_and_wastage', 'making_only']).default('all'), is_active: z.boolean().default(true) });
r.post('/tax-rules', validate({ body: taxBody }), asyncHandler(async (req, res) => {
  const b = req.body;
  const { rows } = await query('INSERT INTO tax_rules (name, rate_percent, applies_to, is_active, updated_by) VALUES ($1,$2,$3,$4,$5) RETURNING *', [b.name, b.rate_percent, b.applies_to, b.is_active, req.user.id]);
  await audit(req.user, 'tax.create', 'tax_rule', rows[0].id, b);
  res.status(201).json({ tax: rows[0] });
}));
r.patch('/tax-rules/:id', validate({ params: z.object({ id: z.coerce.number().int() }), body: taxBody.partial() }), asyncHandler(async (req, res) => {
  const b = req.body;
  const { rows } = await query('UPDATE tax_rules SET name=COALESCE($2,name), rate_percent=COALESCE($3,rate_percent), applies_to=COALESCE($4,applies_to), is_active=COALESCE($5,is_active), updated_by=$6, updated_at=now() WHERE id=$1 RETURNING *', [req.params.id, b.name ?? null, b.rate_percent ?? null, b.applies_to ?? null, b.is_active ?? null, req.user.id]);
  if (!rows[0]) throw notFound('Tax rule not found');
  await audit(req.user, 'tax.update', 'tax_rule', req.params.id, b);
  res.json({ tax: rows[0] });
}));

// ---- Sponsored placements (clearly labelled publicly; never affects organic order) ----
r.get('/sponsored', asyncHandler(async (_req, res) => res.json({ listings: (await query('SELECT sl.*, s.name AS store_name FROM sponsored_listings sl JOIN stores s ON s.id = sl.store_id ORDER BY sl.created_at DESC LIMIT 200')).rows })));
r.post('/sponsored', validate({ body: z.object({ store_id: uuid, starts_at: z.string().datetime(), ends_at: z.string().datetime() }) }), asyncHandler(async (req, res) => {
  const b = req.body;
  if (new Date(b.ends_at) <= new Date(b.starts_at)) throw badRequest('ends_at must be after starts_at');
  const { rows } = await query('INSERT INTO sponsored_listings (store_id, starts_at, ends_at, created_by) VALUES ($1,$2,$3,$4) RETURNING *', [b.store_id, b.starts_at, b.ends_at, req.user.id]);
  res.status(201).json({ listing: rows[0] });
}));
r.delete('/sponsored/:id', validate({ params: z.object({ id: z.coerce.number().int() }) }), asyncHandler(async (req, res) => {
  await query('UPDATE sponsored_listings SET is_active = FALSE WHERE id = $1', [req.params.id]);
  res.status(204).end();
}));

export default r;
