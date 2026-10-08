import pino from 'pino';
import env from '../config/env.js';

export default pino({
  level: env.NODE_ENV === 'test' ? 'silent' : env.LOG_LEVEL,
  redact: ['req.headers.authorization', 'req.headers.cookie', '*.password', '*.password_hash', '*.apiKey'],
});
