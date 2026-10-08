import { Router } from 'express';
import { z } from 'zod';
import { apiCache } from '../middleware/cacheControl.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/errors.js';
import { metalSnapshot } from '../services/pricing.js';
import { ensureFresh, metalStatus, priceHistory } from '../services/metals/metalsService.js';
import env from '../config/env.js';

export const metalsRouter = Router();
const cache = apiCache(15);

metalsRouter.get('/latest', cache, asyncHandler(async (_req, res) => {
  await ensureFresh();
  const [gold, silver] = await Promise.all([metalSnapshot('gold'), metalSnapshot('silver')]);
  res.json({ gold, silver });
}));

metalsRouter.get('/status', asyncHandler(async (_req, res) => {
  const [gold, silver] = await Promise.all([metalStatus('gold'), metalStatus('silver')]);
  res.json({ gold, silver, poll_interval_seconds: env.METALS_POLL_INTERVAL_SECONDS });
}));

const histQuery = z.object({
  purity: z.string().max(4).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
  from: z.string().datetime().optional(),
});

function metalRouter(metal) {
  const r = Router();
  r.get('/', cache, asyncHandler(async (_req, res) => {
    await ensureFresh();
    res.json(await metalSnapshot(metal));
  }));
  r.get('/history', validate({ query: histQuery }), asyncHandler(async (req, res) => {
    res.json({ metal, history: await priceHistory({ metal, ...req.query }) });
  }));
  return r;
}
export const goldRouter = metalRouter('gold');
export const silverRouter = metalRouter('silver');
