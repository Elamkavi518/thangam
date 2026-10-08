import { Router } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../db/pool.js';
import { validate } from '../middleware/validate.js';
import { requireAuth, requireRole, optionalAuth } from '../middleware/auth.js';
import { asyncHandler, notFound, badRequest, forbidden } from '../utils/errors.js';
import { productSelect, priceProducts } from '../services/pricing.js';
import { ensureFresh } from '../services/metals/metalsService.js';
import { getStoreForWrite, audit } from '../services/access.js';

const r = Router();
const uuid = z.string().uuid();
const GOLD = ['24K', '22K', '18K'];
const SILVER = ['999', '925'];

const productFields = {
  store_id: uuid,
  jewelry_type: z.string().min(1), // slug
  design_id: uuid.nullable().optional(),
  name: z.string().trim().min(2).max(200),
  description: z.string().max(2000).optional(),
  metal: z.enum(['gold', 'silver']),
  purity: z.string(),
  gross_weight_g: z.number().positive().max(100000),
  net_weight_g: z.number().positive().max(100000),
  making_charge_type: z.enum(['fixed', 'per_gram', 'percent_of_metal']),
  making_charge_value: z.number().min(0),
  hallmark_standard: z.string().max(100).optional(),
  hallmark_huid: z.string().max(50).optional(),
  certification: z.string().max(200).optional(),
  stock_status: z.enum(['in_stock', 'low_stock', 'out_of_stock', 'made_to_order']).default('in_stock'),
  stock_quantity: z.number().int().min(0).default(1),
  images: z.array(z.string().url().max(500)).max(10).default([]),
  attributes: z.record(z.any()).default({}),
  tax_rule_ids: z.array(z.number().int()).max(10).default([]),
};
const createBody = z.object(productFields);

async function resolveAndCheck(b, storeId) {
  const t = (await query('SELECT id, metals FROM jewelry_types WHERE slug = $1 AND is_active', [b.jewelry_type])).rows[0];
  if (!t) throw badRequest('Unknown jewelry_type');
  if (!t.metals.includes(b.metal)) throw badRequest(`${b.jewelry_type} cannot be made of ${b.metal}`);
  if (!(b.metal === 'gold' ? GOLD : SILVER).includes(b.purity)) throw badRequest(`purity for ${b.metal} must be one of ${(b.metal === 'gold' ? GOLD : SILVER).join(', ')}`);
  if (b.net_weight_g > b.gross_weight_g) throw badRequest('net_weight_g cannot exceed gross_weight_g');
  if (b.design_id) {
    const d = (await query('SELECT 1 FROM designs WHERE id = $1 AND store_id = $2 AND jewelry_type_id = $3', [b.design_id, storeId, t.id])).rows[0];
    if (!d) throw badRequest('design_id must belong to this store and jewelry type');
  }
  return t.id;
}

// Public listing: only active products of verified stores.
r.get('/', validate({
  query: z.object({
    category: z.string().optional(), metal: z.enum(['gold', 'silver']).optional(), purity: z.string().optional(), store_id: uuid.optional(),
    in_stock: z.enum(['true', 'false']).optional(), q: z.string().trim().max(100).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(24), offset: z.coerce.number().int().min(0).default(0),
  }),
}), asyncHandler(async (req, res) => {
  const x = req.query;
  await ensureFresh();
  const { rows } = await query(
    `${productSelect}
      WHERE p.is_active AND s.is_active AND s.verification_status = 'verified'
        AND ($1::text IS NULL OR jt.slug = $1) AND ($2::metal_kind IS NULL OR p.metal = $2) AND ($3::text IS NULL OR p.purity_code = $3)
        AND ($4::uuid IS NULL OR p.store_id = $4) AND ($5::boolean IS NOT TRUE OR p.stock_status <> 'out_of_stock')
        AND ($6::text IS NULL OR p.name ILIKE '%' || $6 || '%')
      ORDER BY p.created_at DESC LIMIT $7 OFFSET $8`,
    [x.category ?? null, x.metal ?? null, x.purity ?? null, x.store_id ?? null, x.in_stock ?? null, x.q ?? null, x.limit, x.offset],
  );
  res.json({ products: await priceProducts(rows) });
}));

r.get('/:id', validate({ params: z.object({ id: uuid }) }), optionalAuth, asyncHandler(async (req, res) => {
  await ensureFresh();
  const { rows } = await query(`${productSelect} WHERE p.id = $1`, [req.params.id]);
  const p = rows[0];
  const canSee = p && ((p.is_active && p.verification_status === 'verified') || req.user?.role === 'admin' || (req.user && (await query('SELECT 1 FROM stores WHERE id = $1 AND owner_id = $2', [p.store_id, req.user.id])).rows[0]));
  if (!canSee) throw notFound('Product not found');
  res.json({ product: (await priceProducts([p]))[0] });
}));

r.post('/', requireAuth, requireRole('store', 'admin'), validate({ body: createBody }), asyncHandler(async (req, res) => {
  const b = req.body;
  await getStoreForWrite(req.user, b.store_id);
  const typeId = await resolveAndCheck(b, b.store_id);
  const id = await withTransaction(async (c) => {
    const ins = await c.query(
      `INSERT INTO products (store_id, jewelry_type_id, design_id, name, description, metal, purity_code, gross_weight_g, net_weight_g,
         making_charge_type, making_charge_value, hallmark_standard, hallmark_huid, certification, stock_status, stock_quantity, images, type_attributes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id`,
      [b.store_id, typeId, b.design_id ?? null, b.name, b.description ?? null, b.metal, b.purity, b.gross_weight_g, b.net_weight_g, b.making_charge_type, b.making_charge_value,
        b.hallmark_standard ?? null, b.hallmark_huid ?? null, b.certification ?? null, b.stock_status, b.stock_quantity, JSON.stringify(b.images), JSON.stringify(b.attributes)],
    );
    for (const tid of b.tax_rule_ids) await c.query('INSERT INTO product_taxes (product_id, tax_rule_id) VALUES ($1,$2)', [ins.rows[0].id, tid]);
    return ins.rows[0].id;
  });
  const { rows } = await query(`${productSelect} WHERE p.id = $1`, [id]);
  res.status(201).json({ product: (await priceProducts(rows))[0] });
}));

const patchBody = z.object(Object.fromEntries(Object.entries(productFields).filter(([k]) => k !== 'store_id').map(([k, v]) => [k, v.optional()]))).strict();
r.patch('/:id', requireAuth, requireRole('store', 'admin'), validate({ params: z.object({ id: uuid }), body: patchBody }), asyncHandler(async (req, res) => {
  const cur = (await query('SELECT * FROM products WHERE id = $1', [req.params.id])).rows[0];
  if (!cur) throw notFound('Product not found');
  await getStoreForWrite(req.user, cur.store_id);
  const b = req.body;
  const merged = {
    jewelry_type: b.jewelry_type ?? (await query('SELECT slug FROM jewelry_types WHERE id = $1', [cur.jewelry_type_id])).rows[0].slug,
    metal: b.metal ?? cur.metal, purity: b.purity ?? cur.purity_code,
    gross_weight_g: b.gross_weight_g ?? cur.gross_weight_g, net_weight_g: b.net_weight_g ?? cur.net_weight_g,
    design_id: b.design_id === undefined ? cur.design_id : b.design_id,
  };
  const typeId = await resolveAndCheck(merged, cur.store_id);
  await withTransaction(async (c) => {
    await c.query(
      `UPDATE products SET jewelry_type_id=$2, design_id=$3, name=COALESCE($4,name), description=COALESCE($5,description), metal=$6, purity_code=$7,
         gross_weight_g=$8, net_weight_g=$9, making_charge_type=COALESCE($10,making_charge_type), making_charge_value=COALESCE($11,making_charge_value),
         hallmark_standard=COALESCE($12,hallmark_standard), hallmark_huid=COALESCE($13,hallmark_huid), certification=COALESCE($14,certification),
         stock_status=COALESCE($15,stock_status), stock_quantity=COALESCE($16,stock_quantity), images=COALESCE($17,images), type_attributes=COALESCE($18,type_attributes), updated_at=now()
       WHERE id=$1`,
      [cur.id, typeId, merged.design_id, b.name ?? null, b.description ?? null, merged.metal, merged.purity, merged.gross_weight_g, merged.net_weight_g, b.making_charge_type ?? null, b.making_charge_value ?? null,
        b.hallmark_standard ?? null, b.hallmark_huid ?? null, b.certification ?? null, b.stock_status ?? null, b.stock_quantity ?? null,
        b.images ? JSON.stringify(b.images) : null, b.attributes ? JSON.stringify(b.attributes) : null],
    );
    if (b.tax_rule_ids) {
      await c.query('DELETE FROM product_taxes WHERE product_id = $1', [cur.id]);
      for (const tid of b.tax_rule_ids) await c.query('INSERT INTO product_taxes (product_id, tax_rule_id) VALUES ($1,$2)', [cur.id, tid]);
    }
  });
  const { rows } = await query(`${productSelect} WHERE p.id = $1`, [cur.id]);
  res.json({ product: (await priceProducts(rows))[0] });
}));

// Product-level wastage override (store-supplied), with history
r.put('/:id/wastage', requireAuth, requireRole('store', 'admin'), validate({
  params: z.object({ id: uuid }), body: z.object({ wastage_percent: z.number().min(0).max(100).nullable() }),
}), asyncHandler(async (req, res) => {
  const cur = (await query('SELECT id, store_id, wastage_override_percent FROM products WHERE id = $1', [req.params.id])).rows[0];
  if (!cur) throw notFound('Product not found');
  await getStoreForWrite(req.user, cur.store_id);
  await withTransaction(async (c) => {
    await c.query('UPDATE products SET wastage_override_percent=$2, wastage_override_updated_at=now(), updated_at=now() WHERE id=$1', [cur.id, req.body.wastage_percent]);
    await c.query(`INSERT INTO wastage_history (scope, scope_id, old_percent, new_percent, changed_by) VALUES ('product',$1,$2,$3,$4)`, [cur.id, cur.wastage_override_percent, req.body.wastage_percent, req.user.id]);
  });
  const { rows } = await query(`${productSelect} WHERE p.id = $1`, [cur.id]);
  res.json({ product: (await priceProducts(rows))[0] });
}));

r.delete('/:id', requireAuth, requireRole('store', 'admin'), validate({ params: z.object({ id: uuid }) }), asyncHandler(async (req, res) => {
  const cur = (await query('SELECT id, store_id FROM products WHERE id = $1', [req.params.id])).rows[0];
  if (!cur) throw notFound('Product not found');
  await getStoreForWrite(req.user, cur.store_id);
  await query('UPDATE products SET is_active = FALSE, updated_at = now() WHERE id = $1', [cur.id]); // soft delete keeps order history intact
  await audit(req.user, 'product.deactivate', 'product', cur.id);
  res.status(204).end();
}));

export default r;
