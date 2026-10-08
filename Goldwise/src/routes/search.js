import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { placesLimiter } from '../middleware/rateLimit.js';
import { asyncHandler } from '../utils/errors.js';
import { searchStores } from '../services/storeSearch.js';
import { query } from '../db/pool.js';
import { productSelect, priceProducts } from '../services/pricing.js';
import { ensureFresh } from '../services/metals/metalsService.js';

export const storeSearchQuery = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  radius_km: z.coerce.number().min(0.5).max(50).default(10),
  q: z.string().trim().max(100).optional(),
  category: z.string().trim().max(50).optional(),
  verified_only: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  min_rating: z.coerce.number().min(0).max(5).optional(),
  open_now: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  in_stock: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  sort: z.enum(['best_match', 'distance', 'relevance', 'verified', 'rating']).default('best_match'),
  limit: z.coerce.number().int().min(1).max(60).default(30),
});

export const storeSearchHandler = asyncHandler(async (req, res) => {
  const x = req.query;
  res.json(await searchStores({
    lat: x.lat, lng: x.lng, radiusKm: x.radius_km, q: x.q, category: x.category, verifiedOnly: x.verified_only,
    minRating: x.min_rating, openNow: x.open_now, inStock: x.in_stock, sort: x.sort, limit: x.limit,
  }));
});

const r = Router();
r.get('/stores', placesLimiter, validate({ query: storeSearchQuery }), storeSearchHandler);

// Product search: matches names, descriptions, store names and category names in all six languages,
// tolerates spelling mistakes (pg_trgm), and filters/sorts on the live-calculated price.
const productQuery = z.object({
  q: z.string().trim().max(100).optional(),
  category: z.string().trim().max(50).optional(),
  metal: z.enum(['gold', 'silver']).optional(),
  purity: z.string().max(4).optional(),
  min_price: z.coerce.number().min(0).optional(),
  max_price: z.coerce.number().min(0).optional(),
  min_weight: z.coerce.number().min(0).optional(),
  max_weight: z.coerce.number().min(0).optional(),
  in_stock: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  store_id: z.string().uuid().optional(),
  sort: z.enum(['relevance', 'price_asc', 'price_desc', 'weight_asc', 'weight_desc', 'newest']).default('relevance'),
  limit: z.coerce.number().int().min(1).max(60).default(24),
  offset: z.coerce.number().int().min(0).default(0),
});
r.get('/products', validate({ query: productQuery }), asyncHandler(async (req, res) => {
  const x = req.query;
  await ensureFresh();
  const q = x.q || null;
  const { rows } = await query(
    `WITH base AS (
       ${productSelect.replace('SELECT p.*,', `SELECT p.*, (
          CASE WHEN $1::text IS NULL THEN 1 ELSE GREATEST(
            similarity(p.name, $1), word_similarity($1, p.name), similarity(jt.name, $1), similarity(s.name, $1),
            COALESCE((SELECT max(similarity(v.value, $1)) FROM jsonb_each_text(jt.name_i18n) v), 0),
            CASE WHEN p.name ILIKE '%' || $1 || '%' OR jt.name ILIKE '%' || $1 || '%' OR s.name ILIKE '%' || $1 || '%' OR p.description ILIKE '%' || $1 || '%'
                   OR EXISTS (SELECT 1 FROM jsonb_each_text(jt.name_i18n) v WHERE v.value ILIKE '%' || $1 || '%') THEN 1 ELSE 0 END) END) AS match_rank,`)}
        WHERE p.is_active AND s.is_active AND s.verification_status = 'verified'
          AND ($2::text IS NULL OR jt.slug = $2) AND ($3::metal_kind IS NULL OR p.metal = $3) AND ($4::text IS NULL OR p.purity_code = $4)
          AND ($5::numeric IS NULL OR p.net_weight_g >= $5) AND ($6::numeric IS NULL OR p.net_weight_g <= $6)
          AND ($7::boolean IS NOT TRUE OR p.stock_status <> 'out_of_stock') AND ($8::uuid IS NULL OR p.store_id = $8))
     SELECT * FROM base WHERE ($1::text IS NULL OR match_rank >= 0.3) ORDER BY match_rank DESC, created_at DESC LIMIT 400`,
    [q, x.category ?? null, x.metal ?? null, x.purity ?? null, x.min_weight ?? null, x.max_weight ?? null, x.in_stock, x.store_id ?? null]);
  let items = (await priceProducts(rows)).map((p, i) => ({ ...p, relevance: Math.round(rows[i].match_rank * 100) / 100 }));
  if (x.min_price != null) items = items.filter((p) => p.price.estimated_final_price != null && p.price.estimated_final_price >= x.min_price);
  if (x.max_price != null) items = items.filter((p) => p.price.estimated_final_price != null && p.price.estimated_final_price <= x.max_price);
  const by = {
    relevance: (a, b) => b.relevance - a.relevance,
    price_asc: (a, b) => (a.price.estimated_final_price ?? Infinity) - (b.price.estimated_final_price ?? Infinity),
    price_desc: (a, b) => (b.price.estimated_final_price ?? -1) - (a.price.estimated_final_price ?? -1),
    weight_asc: (a, b) => a.net_weight_g - b.net_weight_g,
    weight_desc: (a, b) => b.net_weight_g - a.net_weight_g,
    newest: () => 0,
  }[x.sort];
  items.sort(by);
  res.json({ total: items.length, products: items.slice(x.offset, x.offset + x.limit), sort: x.sort });
}));

export default r;
