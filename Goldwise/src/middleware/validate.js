import { ZodError } from 'zod';
import { badRequest } from '../utils/errors.js';

/** validate({ body, query, params }) with zod schemas; parsed values replace the originals. */
export const validate = (schemas) => (req, _res, next) => {
  try {
    for (const part of ['params', 'query', 'body']) {
      if (schemas[part]) {
        const parsed = schemas[part].parse(req[part]);
        if (part === 'query') Object.defineProperty(req, 'query', { value: parsed, writable: true, configurable: true });
        else req[part] = parsed;
      }
    }
    next();
  } catch (e) {
    if (e instanceof ZodError) return next(badRequest('Validation failed', e.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))));
    next(e);
  }
};
