import logger from '../utils/logger.js';
import { HttpError } from '../utils/errors.js';

export const notFoundHandler = (req, _res, next) => next(new HttpError(404, 'NOT_FOUND', `No route for ${req.method} ${req.originalUrl}`));

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, _next) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
  }
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'BAD_JSON', message: 'Malformed JSON body' } });
  if (err?.code === '23505') return res.status(409).json({ error: { code: 'CONFLICT', message: 'A record with these values already exists' } });
  if (err?.code === '23503') return res.status(409).json({ error: { code: 'CONFLICT', message: 'Referenced record does not exist or is still in use' } });
  if (err?.code === '23514' || err?.code === '22P02') return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Value rejected by database constraints' } });
  (req.log || logger).error({ err }, 'unhandled error');
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal server error' } });
}
