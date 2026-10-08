import { query } from '../db/pool.js';
import logger from '../utils/logger.js';

/** Record the outcome of an external-service call. Never throws. */
export async function recordApiEvent({ service, ok, httpStatus = null, message = null, configRequired = null }) {
  try {
    await query(
      `INSERT INTO api_events (service, ok, http_status, message, config_required) VALUES ($1,$2,$3,$4,$5)`,
      [service, ok, httpStatus, message ? String(message).slice(0, 500) : null, configRequired],
    );
  } catch (err) {
    logger.error({ err }, 'failed to record api event');
  }
}
