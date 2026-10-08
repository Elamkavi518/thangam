import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import pinoHttp from 'pino-http';
import env from './config/env.js';
import logger from './utils/logger.js';
import { query } from './db/pool.js';
import { globalLimiter } from './middleware/rateLimit.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import authRoutes from './routes/auth.js';
import { metalsRouter, goldRouter, silverRouter } from './routes/metals.js';
import jewelryRoutes from './routes/jewelry.js';
import productRoutes from './routes/products.js';
import storeRoutes from './routes/stores.js';
import locationRoutes from './routes/location.js';
import searchRoutes from './routes/search.js';
import orderRoutes from './routes/orders.js';
import adminRoutes from './routes/admin.js';
import loanRoutes from './routes/loans.js';
import supportRoutes from './routes/support.js';
import feedbackRoutes from './routes/feedback.js';
import paymentRoutes from './routes/payments.js';
import { requireAuth } from './middleware/auth.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', env.TRUST_PROXY); // behind the platform's HTTPS proxy
  app.disable('x-powered-by');
  app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/health' } }));
  app.use(helmet());
  app.use(cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true); // curl / server-to-server
      return cb(null, env.corsOrigins.includes(origin) || (!env.isProd && /^http:\/\/localhost(:\d+)?$/.test(origin)));
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    maxAge: 600,
  }));
  app.use(compression());
  app.use(express.json({ limit: '100kb' }));
  app.use(globalLimiter);

  app.get('/health', async (_req, res) => {
    try { await query('SELECT 1'); res.json({ ok: true }); } catch { res.status(503).json({ ok: false }); }
  });

  app.use('/api/auth', authRoutes);
  // Mandatory login: every data route below needs a signed-in Customer/Admin (switch off only with REQUIRE_LOGIN=false)
  const gate = (req, res, next) => (env.REQUIRE_LOGIN ? requireAuth(req, res, next) : next());
  app.use(['/api/metals', '/api/gold', '/api/silver', '/api/jewelry', '/api/products', '/api/stores', '/api/location', '/api/search'], gate);
  app.use('/api/metals', metalsRouter);
  app.use('/api/gold', goldRouter);
  app.use('/api/silver', silverRouter);
  app.use('/api/jewelry', jewelryRoutes);
  app.use('/api/products', productRoutes);
  app.use('/api/stores', storeRoutes);
  app.use('/api/location', locationRoutes);
  app.use('/api/search', searchRoutes);
  app.use('/api/orders', orderRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/loans', loanRoutes);
  app.use('/api/support', supportRoutes);
  app.use('/api/feedback', feedbackRoutes);
  app.use('/api/payments', paymentRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
