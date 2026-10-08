import { Router } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../db/pool.js';
import { validate } from '../middleware/validate.js';
import { requireAuth, requireRole, optionalAuth } from '../middleware/auth.js';
import { placesLimiter } from '../middleware/rateLimit.js';
import { asyncHandler, notFound, badRequest } from '../utils/errors.js';
import { getStoreForWrite, audit } from '../services/access.js';
import { storeSearchQuery, storeSearchHandler } from './search.js';

const r = Router();
const uuid = z.string().uuid();
const id = z.object({ id: uuid });

// Customer GPS → real nearby stores (same engine as /api/search/stores)
r.get('/nearby', placesLimiter, validate({ query: storeSearchQuery }), storeSearchHandler);

const storeBody = z.object({
  name: z.string().trim().min(2).max(150),
  address: z.string().trim().min(5).max(300),
  city: z.string().trim().max(100).optional(),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  phone: z.string().trim().max(30).optional(),
  website: z.string().url().max(300).optional(),
  google_place_id: z.string().trim().max(300).optional(),
  opening_hours: z.record(z.string()).optional(),
  business_registration: z.string().trim().max(100).optional(),
});
// Changing these on an already-verified store sends it back to review.
const VERIFIED_FIELDS = ['name', 'address', 'latitude', 'longitude', 'google_place_id', 'business_registration'];

r.post('/', requireAuth, requireRole('store', 'admin'), validate({ body: storeBody }), asyncHandler(async (req, res) => {
  const b = req.body;
  const { rows } = await query(
    `INSERT INTO stores (owner_id, name, address, city, latitude, longitude, phone, website, google_place_id, opening_hours, business_registration)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [req.user.id, b.name, b.address, b.city ?? null, b.latitude, b.longitude, b.phone ?? null, b.website ?? null, b.google_place_id ?? null, b.opening_hours ? JSON.stringify(b.opening_hours) : null, b.business_registration ?? null],
  );
  res.status(201).json({ store: rows[0] });
}));

r.get('/mine', requireAuth, requireRole('store', 'admin'), asyncHandler(async (req, res) => {
  const { rows } = await query('SELECT * FROM stores WHERE owner_id = $1 ORDER BY created_at DESC', [req.user.id]);
  res.json({ stores: rows });
}));

r.get('/:id', validate({ params: id }), optionalAuth, asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT s.*, COALESCE((SELECT json_agg(json_build_object('slug', jt.slug, 'name', jt.name)) FROM store_jewelry_types x JOIN jewelry_types jt ON jt.id = x.jewelry_type_id WHERE x.store_id = s.id), '[]') AS categories
       FROM stores s WHERE s.id = $1`, [req.params.id]);
  const s = rows[0];
  const mine = s && req.user && (req.user.role === 'admin' || s.owner_id === req.user.id);
  if (!s || (!mine && (!s.is_active || s.verification_status !== 'verified'))) throw notFound('Store not found');
  if (!mine) { delete s.business_registration; delete s.owner_id; }
  res.json({ store: s });
}));

r.patch('/:id', requireAuth, requireRole('store', 'admin'), validate({ params: id, body: storeBody.partial().strict() }), asyncHandler(async (req, res) => {
  const cur = await getStoreForWrite(req.user, req.params.id);
  const b = req.body;
  const sensitiveChanged = VERIFIED_FIELDS.some((f) => b[f] !== undefined && b[f] !== cur[f]);
  const reverify = sensitiveChanged && cur.verification_status === 'verified' && req.user.role !== 'admin';
  const { rows } = await query(
    `UPDATE stores SET name=COALESCE($2,name), address=COALESCE($3,address), city=COALESCE($4,city), latitude=COALESCE($5,latitude), longitude=COALESCE($6,longitude),
       phone=COALESCE($7,phone), website=COALESCE($8,website), google_place_id=COALESCE($9,google_place_id), opening_hours=COALESCE($10,opening_hours),
       business_registration=COALESCE($11,business_registration),
       verification_status = CASE WHEN $12 THEN 'pending'::verification_status ELSE verification_status END, updated_at=now()
     WHERE id=$1 RETURNING *`,
    [cur.id, b.name ?? null, b.address ?? null, b.city ?? null, b.latitude ?? null, b.longitude ?? null, b.phone ?? null, b.website ?? null, b.google_place_id ?? null,
      b.opening_hours ? JSON.stringify(b.opening_hours) : null, b.business_registration ?? null, reverify],
  );
  res.json({ store: rows[0], re_verification_required: reverify });
}));

r.post('/:id/request-verification', requireAuth, requireRole('store', 'admin'), validate({ params: id }), asyncHandler(async (req, res) => {
  const cur = await getStoreForWrite(req.user, req.params.id);
  if (!cur.business_registration) throw badRequest('Add your business registration (e.g. GSTIN/licence number) before requesting verification');
  const { rows } = await query(`UPDATE stores SET verification_status='pending', updated_at=now() WHERE id=$1 AND verification_status IN ('unverified','rejected') RETURNING *`, [cur.id]);
  res.json({ store: rows[0] ?? cur });
}));

r.put('/:id/categories', requireAuth, requireRole('store', 'admin'), validate({ params: id, body: z.object({ categories: z.array(z.string()).max(20) }) }), asyncHandler(async (req, res) => {
  await getStoreForWrite(req.user, req.params.id);
  await withTransaction(async (c) => {
    const types = (await c.query('SELECT id, slug FROM jewelry_types WHERE slug = ANY($1) AND is_active', [req.body.categories])).rows;
    if (types.length !== new Set(req.body.categories).size) throw badRequest('One or more categories are unknown');
    await c.query('DELETE FROM store_jewelry_types WHERE store_id = $1', [req.params.id]);
    for (const t of types) await c.query('INSERT INTO store_jewelry_types (store_id, jewelry_type_id) VALUES ($1,$2)', [req.params.id, t.id]);
  });
  res.json({ ok: true });
}));

// ----- Designs + wastage: Store → Jewelry type → Design → wastage -----
r.get('/:id/designs', validate({ params: id }), optionalAuth, asyncHandler(async (req, res) => {
  const s = (await query('SELECT owner_id, verification_status, is_active FROM stores WHERE id = $1', [req.params.id])).rows[0];
  const mine = s && req.user && (req.user.role === 'admin' || s.owner_id === req.user.id);
  if (!s || (!mine && (!s.is_active || s.verification_status !== 'verified'))) throw notFound('Store not found');
  const { rows } = await query(
    `SELECT d.id, d.name, jt.slug AS jewelry_type, jt.name AS jewelry_type_name, d.wastage_percent, d.wastage_updated_at
       FROM designs d JOIN jewelry_types jt ON jt.id = d.jewelry_type_id WHERE d.store_id = $1 ORDER BY jt.sort_order, d.name`, [req.params.id]);
  res.json({ designs: rows.map((d) => ({ ...d, wastage_note: d.wastage_percent == null ? 'Wastage not supplied by the store' : null })) });
}));

r.post('/:id/designs', requireAuth, requireRole('store', 'admin'), validate({
  params: id, body: z.object({ jewelry_type: z.string(), name: z.string().trim().min(1).max(150), wastage_percent: z.number().min(0).max(100).optional() }),
}), asyncHandler(async (req, res) => {
  await getStoreForWrite(req.user, req.params.id);
  const t = (await query('SELECT id FROM jewelry_types WHERE slug = $1 AND is_active', [req.body.jewelry_type])).rows[0];
  if (!t) throw badRequest('Unknown jewelry_type');
  const wp = req.body.wastage_percent;
  const { rows } = await query(
    `INSERT INTO designs (store_id, jewelry_type_id, name, wastage_percent, wastage_updated_at, wastage_updated_by)
     VALUES ($1,$2,$3,$4, CASE WHEN $4::numeric IS NULL THEN NULL ELSE now() END, CASE WHEN $4::numeric IS NULL THEN NULL ELSE $5::uuid END) RETURNING *`,
    [req.params.id, t.id, req.body.name, wp ?? null, req.user.id]);
  if (wp != null) await query(`INSERT INTO wastage_history (scope, scope_id, old_percent, new_percent, changed_by) VALUES ('design',$1,NULL,$2,$3)`, [rows[0].id, wp, req.user.id]);
  res.status(201).json({ design: rows[0] });
}));

r.put('/:id/designs/:designId/wastage', requireAuth, requireRole('store', 'admin'), validate({
  params: z.object({ id: uuid, designId: uuid }), body: z.object({ wastage_percent: z.number().min(0).max(100) }),
}), asyncHandler(async (req, res) => {
  await getStoreForWrite(req.user, req.params.id);
  const out = await withTransaction(async (c) => {
    const cur = (await c.query('SELECT wastage_percent FROM designs WHERE id = $1 AND store_id = $2 FOR UPDATE', [req.params.designId, req.params.id])).rows[0];
    if (!cur) throw notFound('Design not found');
    const u = await c.query('UPDATE designs SET wastage_percent=$2, wastage_updated_at=now(), wastage_updated_by=$3 WHERE id=$1 RETURNING *', [req.params.designId, req.body.wastage_percent, req.user.id]);
    await c.query(`INSERT INTO wastage_history (scope, scope_id, old_percent, new_percent, changed_by) VALUES ('design',$1,$2,$3,$4)`, [req.params.designId, cur.wastage_percent, req.body.wastage_percent, req.user.id]);
    return u.rows[0];
  });
  res.json({ design: out });
}));

// ----- Store-supplied metal rates (reviewed by admin; never alters the global market price) -----
r.post('/:id/price-submissions', requireAuth, requireRole('store', 'admin'), validate({
  params: id,
  body: z.object({ metal: z.enum(['gold', 'silver']), purity: z.string(), price_per_gram: z.number().positive().max(10_000_000), currency: z.string().length(3).default('INR') }),
}), asyncHandler(async (req, res) => {
  await getStoreForWrite(req.user, req.params.id);
  const b = req.body;
  if (!(b.metal === 'gold' ? ['24K', '22K', '18K'] : ['999', '925']).includes(b.purity)) throw badRequest('Invalid purity for metal');
  const { rows } = await query(
    `INSERT INTO store_price_submissions (store_id, metal, purity_code, price_per_gram, currency, submitted_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [req.params.id, b.metal, b.purity, b.price_per_gram, b.currency.toUpperCase(), req.user.id]);
  res.status(201).json({ submission: rows[0], status_note: 'Pending admin review. It will appear publicly only after approval.' });
}));

r.get('/:id/price-submissions', requireAuth, requireRole('store', 'admin'), validate({ params: id }), asyncHandler(async (req, res) => {
  await getStoreForWrite(req.user, req.params.id);
  const { rows } = await query('SELECT * FROM store_price_submissions WHERE store_id = $1 ORDER BY submitted_at DESC LIMIT 100', [req.params.id]);
  res.json({ submissions: rows });
}));

export default r;
