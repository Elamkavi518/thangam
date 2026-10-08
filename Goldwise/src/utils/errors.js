export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
export const badRequest = (m, d) => new HttpError(400, 'BAD_REQUEST', m, d);
export const unauthorized = (m = 'Authentication required') => new HttpError(401, 'UNAUTHORIZED', m);
export const forbidden = (m = 'You do not have permission to do this') => new HttpError(403, 'FORBIDDEN', m);
export const notFound = (m = 'Not found') => new HttpError(404, 'NOT_FOUND', m);
export const conflict = (m, d) => new HttpError(409, 'CONFLICT', m, d);

/** A required external service is not configured/available. Never answered with substitute data. */
export class ServiceUnavailable extends HttpError {
  constructor(service, message, configRequired = []) {
    super(503, 'SERVICE_UNAVAILABLE', message, { service, config_required: configRequired });
  }
}

export const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
