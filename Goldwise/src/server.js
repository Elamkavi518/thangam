import env from './config/env.js';
import logger from './utils/logger.js';
import pool from './db/pool.js';
import { migrate } from './scripts/migrate.js';
import { createApp } from './app.js';
import { startPoller, stopPoller } from './services/metals/metalsService.js';
import { requiredConfig } from './services/metals/providers/goldapi.js';
import { placesConfigRequired } from './services/places/googlePlaces.js';

await migrate((m) => logger.info(m));
const app = createApp();
const server = app.listen(env.PORT, () => logger.info(`GoldWise API listening on :${env.PORT} (${env.NODE_ENV})`));

const missing = [...requiredConfig(), ...placesConfigRequired()];
if (missing.length) logger.warn({ missing }, 'External API configuration missing — affected features will report errors until these are set');
startPoller();

const shutdown = (sig) => {
  logger.info({ sig }, 'shutting down');
  stopPoller();
  server.close(() => pool.end().then(() => process.exit(0)));
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
