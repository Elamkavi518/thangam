import bcrypt from 'bcryptjs';
import pool from '../db/pool.js';

const email = process.env.ADMIN_EMAIL;
const password = process.env.ADMIN_PASSWORD;
const name = process.env.ADMIN_NAME || 'Administrator';
if (!email || !password || password.length < 12) {
  console.error('Set ADMIN_EMAIL and ADMIN_PASSWORD (min 12 chars) in the environment, then run: npm run create-admin');
  process.exit(1);
}
const hash = await bcrypt.hash(password, 12);
await pool.query(
  `INSERT INTO users (email, password_hash, name, role) VALUES (lower($1), $2, $3, 'admin')
   ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = 'admin', is_active = TRUE`,
  [email, hash, name],
);
console.log(`Admin ready: ${email.toLowerCase()}`);
await pool.end();
