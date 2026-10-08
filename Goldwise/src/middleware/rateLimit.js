import rateLimit from 'express-rate-limit';

const make = (windowMs, limit, message) =>
  rateLimit({ windowMs, limit, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: { code: 'RATE_LIMITED', message } } });

export const globalLimiter = make(15 * 60_000, 600, 'Too many requests, please slow down');
export const authLimiter = make(15 * 60_000, 30, 'Too many authentication attempts, try again later');
export const placesLimiter = make(60_000, 30, 'Too many location/search requests, try again in a minute');
