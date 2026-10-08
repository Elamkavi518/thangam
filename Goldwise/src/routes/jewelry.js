import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { validate } from '../middleware/validate.js';
import { apiCache } from '../middleware/cacheControl.js';
import { asyncHandler, notFound, badRequest } from '../utils/errors.js';
import { calculate, requirePrice } from '../services/pricing.js';
import { ensureFresh } from '../services/metals/metalsService.js';

const r = Router();

r.get('/types', apiCache(60), asyncHandler(async (_req, res) => {
  const { rows } = await query(`SELECT id, slug, name, name_i18n, metals, sort_order FROM jewelry_types WHERE is_active ORDER BY sort_order`);
  res.json({ types: rows });
}));

r.get('/types/:slug', asyncHandler(async (req, res) => {
  const { rows } = await query(`SELECT id, slug, name, metals FROM jewelry_types WHERE slug = $1 AND is_active`, [req.params.slug]);
  if (!rows[0]) throw notFound('Jewelry type not found');
  res.json({ type: rows[0] });
}));

const calcBody = z.object({
  metal: z.enum(['gold', 'silver']),
  purity: z.string(),
  net_weight_g: z.number().positive().max(100000),
  wastage_percent: z.number().min(0).max(100).optional(),
  product_id: z.string().uuid().optional(),
  making_charge_type: z.enum(['fixed', 'per_gram', 'percent_of_metal']).default('fixed'),
  making_charge_value: z.number().min(0).default(0),
  tax_rule_ids: z.array(z.number().int()).max(10).default([]),
});

// Calculator on user-supplied inputs, always using the latest stored provider price.
// A product-specific price (with store-supplied wastage) comes from GET /api/products/:id.
r.post('/calculate', validate({ body: calcBody }), asyncHandler(async (req, res) => {
  const b = req.body;
  const valid = b.metal === 'gold' ? ['24K', '22K', '18K'] : ['999', '925'];
  if (!valid.includes(b.purity)) throw badRequest(`purity for ${b.metal} must be one of ${valid.join(', ')}`);
  await ensureFresh();
  const { row, stale } = await requirePrice(b.metal, b.purity);
  let taxes = [];
  if (b.tax_rule_ids.length) {
    taxes = (await query(`SELECT name, rate_percent, applies_to FROM tax_rules WHERE id = ANY($1) AND is_active`, [b.tax_rule_ids])).rows;
  }
  res.json({
    ...calculate({ pricePerGram: row.price, netWeight: b.net_weight_g, wastagePercent: b.wastage_percent ?? null, makingType: b.making_charge_type, makingValue: b.making_charge_value, taxes }),
    currency: row.currency,
    wastage_note: b.wastage_percent == null ? 'Provide wastage_percent (the store-supplied value) to get a final price' : 'Wastage entered by you; actual wastage is set by each store',
    metal_price: { id: row.id, source: row.source, is_derived: row.is_derived, provider_timestamp: row.provider_timestamp, fetched_at: row.fetched_at },
    last_price_update: row.fetched_at,
    stale,
    stale_message: stale ? 'Live update unavailable — using last verified price' : null,
  });
}));

r.get('/taxes', apiCache(60), asyncHandler(async (_req, res) => {
  const { rows } = await query(`SELECT id, name, rate_percent, applies_to FROM tax_rules WHERE is_active ORDER BY name`);
  res.json({ taxes: rows });
}));

export default r;
