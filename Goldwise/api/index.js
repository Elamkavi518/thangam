// Vercel serverless entry point. Vercel cannot run the background poller, so metals are refreshed
// on read (METALS_POLLER_ENABLED=false + METALS_LAZY_REFRESH=true): when someone loads prices and the
// stored price is older than METALS_POLL_INTERVAL_SECONDS, one request fetches a fresh one.
import bcrypt from 'bcryptjs';
import { createApp } from '../src/app.js';
import { migrate } from '../src/scripts/migrate.js';
import { query } from '../src/db/pool.js';

const app = createApp();

async function setup() {
  await migrate(() => {});
  // First-run convenience (no shell on Vercel): create an admin ONLY if none exists yet.
  const { ADMIN_EMAIL, ADMIN_PASSWORD } = process.env;
  if (ADMIN_EMAIL && ADMIN_PASSWORD && ADMIN_PASSWORD.length >= 12) {
    const { rows } = await query(`SELECT 1 FROM users WHERE role = 'admin' LIMIT 1`);
    if (!rows.length) {
      await query(
        `INSERT INTO users (email, password_hash, name, role) VALUES (lower($1), $2, 'Administrator', 'admin') ON CONFLICT (email) DO UPDATE SET role='admin', password_hash=EXCLUDED.password_hash`,
        [ADMIN_EMAIL, await bcrypt.hash(ADMIN_PASSWORD, 12)],
      );
    }
  }
}
let ready;

// Vercel may hand the function either the original URL or the rewritten one (/api). The rewrite in
// vercel.json carries the real path in ?__path=..., so the Express app always sees the right URL.
function restoreUrl(req) {
  const u = new URL(req.url, 'http://x');
  if (!u.searchParams.has('__path')) return;
  const path = u.searchParams.get('__path');
  u.searchParams.delete('__path');
  const rest = u.searchParams.toString();
  req.url = '/' + path.replace(/^\/+/, '') + (rest ? `?${rest}` : '');
}

export default async function handler(req, res) {
  restoreUrl(req);
  try {
    ready ||= setup();
    await ready;
  } catch (err) {
    ready = undefined;
    console.error('startup failed', err);
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ error: { code: 'STARTUP_FAILED', message: 'Database not reachable. Check DATABASE_URL and DATABASE_SSL in Vercel environment variables.' } }));
  }
  return app(req, res);
}
