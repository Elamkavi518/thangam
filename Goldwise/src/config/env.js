import 'dotenv/config';
import { z } from 'zod';

const bool = (d) => z.preprocess((v) => (v === undefined || v === '' ? d : String(v).toLowerCase() === 'true'), z.boolean());

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_SSL: bool(false),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_EXPIRES_IN: z.string().default('12h'),
  CORS_ORIGINS: z.string().default(''),
  TRUST_PROXY: z.coerce.number().default(1),
  LOG_LEVEL: z.string().default('info'),

  // Metals provider (GoldAPI.io). Optional at boot so the admin dashboard can report exactly what is missing.
  METALS_PROVIDER: z.enum(['goldapi']).default('goldapi'),
  GOLDAPI_KEY: z.string().optional().default(''),
  METALS_CURRENCY: z.string().length(3).default('INR'),
  METALS_POLL_INTERVAL_SECONDS: z.coerce.number().default(300),
  METALS_POLLER_ENABLED: bool(true),
  METALS_LAZY_REFRESH: bool(true),
  METALS_MAX_STALE_MINUTES: z.coerce.number().default(60),
  METALS_PROVIDER_BASE_URL: z.string().optional().default(''), // honoured outside production only (tests)

  REQUIRE_LOGIN: bool(true),
  RAZORPAY_KEY_ID: z.string().optional().default(''),
  RAZORPAY_KEY_SECRET: z.string().optional().default(''),
  RAZORPAY_BASE_URL: z.string().optional().default(''),

  // Maps / Places (Google Maps Platform: Places API (New) + Geocoding API)
  GOOGLE_MAPS_API_KEY: z.string().optional().default(''),
  PLACES_CACHE_TTL_SECONDS: z.coerce.number().default(300),
  PLACES_BASE_URL: z.string().optional().default(''),
  GEOCODE_BASE_URL: z.string().optional().default(''),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
  console.error(`\nInvalid or missing environment configuration:\n${lines.join('\n')}\n`);
  process.exit(1);
}

const env = parsed.data;
// Provider polling is limited to 1–5 minutes as specified.
env.METALS_POLL_INTERVAL_SECONDS = Math.min(300, Math.max(60, env.METALS_POLL_INTERVAL_SECONDS));
env.isProd = env.NODE_ENV === 'production';
env.corsOrigins = env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);

if (env.isProd) {
  if (/change-me|secret|password/i.test(env.JWT_SECRET)) {
    console.error('JWT_SECRET looks like a placeholder. Generate one with: openssl rand -hex 48');
    process.exit(1);
  }
}

export default env;
