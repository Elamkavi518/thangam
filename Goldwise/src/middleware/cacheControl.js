import { TTLCache } from '../utils/cache.js';

/** Response cache for public GETs (keyed by URL). Private per-user responses must not use this. */
export function apiCache(ttlSeconds) {
  const cache = new TTLCache({ ttlMs: ttlSeconds * 1000, max: 300 });
  return (req, res, next) => {
    if (req.method !== 'GET') return next();
    const key = req.originalUrl;
    const hit = cache.get(key);
    res.set('Cache-Control', `public, max-age=${ttlSeconds}`);
    if (hit) {
      res.set('X-Cache', 'HIT');
      return res.status(hit.status).json(hit.body);
    }
    res.set('X-Cache', 'MISS');
    const json = res.json.bind(res);
    res.json = (body) => {
      if (res.statusCode === 200) cache.set(key, { status: 200, body });
      return json(body);
    };
    next();
  };
}
