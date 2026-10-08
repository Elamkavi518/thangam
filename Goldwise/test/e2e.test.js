import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startStub } from './helpers.js';

// ---- stub providers (test fixtures; formats follow GoldAPI.io and Google Places API (New)) ----
const metals = { fail: false, calls: 0 };
const nowSec = () => Math.floor(Date.now() / 1000);
const metalsStub = await startStub((req) => {
  metals.calls++;
  if (req.headers['x-access-token'] !== 'test-gold-key') return { status: 403, json: { error: 'Invalid API key' } };
  if (metals.fail) return { status: 500, json: { error: 'upstream down' } };
  if (req.url.startsWith('/XAU/INR')) return { json: { metal: 'XAU', currency: 'INR', timestamp: nowSec(), price: 349000, price_gram_24k: 11000, price_gram_22k: 10083.33, price_gram_18k: 8250 } };
  if (req.url.startsWith('/XAG/INR')) return { json: { metal: 'XAG', currency: 'INR', timestamp: nowSec(), price: 3110.34768 } }; // => 100 per gram
  return { status: 404, json: {} };
});
const rzp = { orders: 0 };
const rzpStub = await startStub((req, body) => {
  if (req.url === '/orders' && req.headers.authorization === 'Basic ' + Buffer.from('rzp_test_key:rzp_test_secret').toString('base64')) { rzp.orders++; return { json: { id: 'order_TEST' + rzp.orders, amount: body.amount, currency: body.currency } }; }
  return { status: 401, json: { error: { description: 'Authentication failed' } } };
});
const places = { fail: false };
const placesStub = await startStub((req) => {
  if (req.url.startsWith('/geocode')) return { json: { status: 'OK', results: [{ formatted_address: 'Chennai, Tamil Nadu, India', geometry: { location: { lat: 13.0827, lng: 80.2707 } }, place_id: 'geo1', address_components: [{ long_name: 'Chennai', types: ['locality'] }] }] } };
  if (places.fail) return { status: 403, json: { error: { message: 'API key not valid' } } };
  if (req.url.endsWith('places:searchNearby')) return { json: { places: [
    { id: 'PLACE_REG', displayName: { text: 'Registered Jewellers' }, formattedAddress: '1 Main St', location: { latitude: 13.09, longitude: 80.27 }, nationalPhoneNumber: '044 111', rating: 4.4, userRatingCount: 120, regularOpeningHours: { openNow: true, weekdayDescriptions: ['Mon: 10-8'] }, websiteUri: 'https://reg.example' },
    { id: 'PLACE_LOCAL', displayName: { text: 'Local Independent Gold' }, formattedAddress: '9 Side Rd', location: { latitude: 13.1, longitude: 80.28 } },
  ] } };
  if (req.url.endsWith('places:searchText')) return { json: { places: [
    { id: 'PLACE_BIG', displayName: { text: 'Big Chain Jewellers' }, formattedAddress: '5 Mall Rd', location: { latitude: 13.12, longitude: 80.3 }, rating: 4.8, userRatingCount: 5000 },
    { id: 'PLACE_REG', displayName: { text: 'Registered Jewellers' }, formattedAddress: '1 Main St', location: { latitude: 13.09, longitude: 80.27 } },
  ] } };
  return { status: 404, json: {} };
});

Object.assign(process.env, {
  NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL || 'postgres://goldwise:goldwise_test@127.0.0.1:5432/goldwise_test',
  JWT_SECRET: 'e2e-test-secret-e2e-test-secret-e2e-test', GOLDAPI_KEY: 'test-gold-key', GOOGLE_MAPS_API_KEY: 'test-maps-key',
  METALS_PROVIDER_BASE_URL: metalsStub.url, PLACES_BASE_URL: placesStub.url, GEOCODE_BASE_URL: `${placesStub.url}/geocode`,
  METALS_POLLER_ENABLED: 'false', REQUIRE_LOGIN: 'false', RAZORPAY_BASE_URL: rzpStub.url, METALS_LAZY_REFRESH: 'true', METALS_POLL_INTERVAL_SECONDS: '60', PLACES_CACHE_TTL_SECONDS: '1',
});
const { default: pool } = await import('../src/db/pool.js');
const { migrate } = await import('../src/scripts/migrate.js');
const { createApp } = await import('../src/app.js');
const { default: env } = await import('../src/config/env.js');
const { refreshAll } = await import('../src/services/metals/metalsService.js');

let base; let server;
const api = async (method, path, { token, body } = {}) => {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
};
const S = {}; // shared state across ordered tests

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(() => {});
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.close(); metalsStub.server.close(); placesStub.server.close(); rzpStub.server.close(); await pool.end(); });

test('no price exists before the first provider fetch: clear error, nothing invented', async () => {
  env.METALS_LAZY_REFRESH = false; env.GOLDAPI_KEY = '';
  await refreshAll();
  const r = await api('GET', '/api/gold?nocache=1');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.purities, []);
  assert.equal(r.body.live, false);
  assert.match(r.body.status_message, /Live update unavailable/);
  assert.deepEqual(r.body.config_required, ['GOLDAPI_KEY']);
  const calc = await api('POST', '/api/jewelry/calculate', { body: { metal: 'gold', purity: '22K', net_weight_g: 10 } });
  assert.equal(calc.status, 503);
  assert.deepEqual(calc.body.error.details.config_required, ['GOLDAPI_KEY']);
  env.GOLDAPI_KEY = 'test-gold-key'; env.METALS_LAZY_REFRESH = true;
});

test('live fetch stores gold + silver with full provenance and unit conversions', async () => {
  const out = await refreshAll();
  assert.equal(out.gold.ok, true); assert.equal(out.silver.ok, true);
  const gold = (await api('GET', '/api/gold?t=2')).body;
  assert.equal(gold.live, true);
  const by = Object.fromEntries(gold.purities.map((p) => [p.purity, p]));
  assert.equal(by['24K'].per_gram, 11000); assert.equal(by['24K'].per_8_gram, 88000); assert.equal(by['24K'].per_10_gram, 110000);
  assert.equal(by['22K'].is_derived, false); assert.equal(by['22K'].per_gram, 10083.33);
  assert.equal(by['24K'].source, 'goldapi.io');
  assert.ok(gold.last_updated);
  const silver = (await api('GET', '/api/silver?t=2')).body;
  const sp = Object.fromEntries(silver.purities.map((p) => [p.purity, p]));
  assert.equal(sp['999'].per_gram, 100); assert.equal(sp['999'].per_kilogram, 100000); assert.equal(sp['999'].per_100_gram, 10000);
  assert.equal(sp['925'].per_gram, 92.5); assert.equal(sp['925'].is_derived, true); assert.equal(sp['925'].derived_from, '999 x 0.925');
  const { rows } = await pool.query(`SELECT metal, purity_code, price, currency, unit, source, provider_timestamp, fetched_at, raw_payload FROM metal_prices`);
  assert.equal(rows.length, 5);
  for (const r of rows) { assert.equal(r.currency, 'INR'); assert.equal(r.unit, 'gram'); assert.ok(r.provider_timestamp && r.fetched_at && r.raw_payload); }
});

test('provider outage: last verified price kept, "Live update unavailable" shown, error logged', async () => {
  metals.fail = true;
  const out = await refreshAll();
  assert.equal(out.gold.ok, false);
  const st = (await api('GET', '/api/metals/status')).body;
  assert.equal(st.gold.live, false);
  assert.equal(st.gold.last_attempt.ok, false);
  const gold = (await api('GET', '/api/gold?t=3')).body;
  assert.equal(gold.live, false);
  assert.match(gold.status_message, /Live update unavailable/);
  assert.equal(gold.purities.find((p) => p.purity === '24K').per_gram, 11000); // last verified price still served
  const errs = await pool.query(`SELECT message FROM api_events WHERE NOT ok AND service='gold' AND http_status = 500`);
  assert.ok(errs.rows.length >= 1);
  metals.fail = false; await refreshAll();
});

test('auth + RBAC: store users cannot touch admin or global market price', async () => {
  const reg = (email, account_type) => api('POST', '/api/auth/register', { body: { email, password: 'longpassword123', name: email.split('@')[0], account_type } });
  S.cust = (await reg('cust@example.com', 'customer')).body.token;
  const st = await reg('store@example.com', 'store');
  S.store = st.body.token;
  assert.equal((await reg('cust@example.com', 'customer')).status, 409);
  assert.equal((await api('POST', '/api/auth/register', { body: { email: 'a@b.co', password: 'longpassword123', name: 'x', account_type: 'admin' } })).status, 400);
  assert.equal((await api('POST', '/api/auth/login', { body: { email: 'cust@example.com', password: 'wrong-password' } })).status, 401);
  assert.equal((await api('GET', '/api/admin/status')).status, 401);
  assert.equal((await api('GET', '/api/admin/status', { token: S.store })).status, 403);
  assert.equal((await api('GET', '/api/admin/status', { token: S.cust })).status, 403);
  for (const m of ['POST', 'PUT', 'PATCH']) assert.equal((await api(m, '/api/metals', { token: S.store, body: { price: 1 } })).status, 404);
  assert.equal((await api('POST', '/api/admin/metals/prices', { token: S.store, body: { price: 1 } })).status, 403);
  // promote an admin directly in the DB (production uses `npm run create-admin`)
  const bcrypt = (await import('bcryptjs')).default;
  await pool.query(`INSERT INTO users (email, password_hash, name, role) VALUES ('admin@example.com', $1, 'Admin', 'admin')`, [await bcrypt.hash('adminpassword123', 4)]);
  S.admin = (await api('POST', '/api/auth/login', { body: { email: 'admin@example.com', password: 'adminpassword123' } })).body.token;
  assert.ok(S.admin);
});

test('store onboarding, verification, wastage per Store → Type → Design, live product price', async () => {
  const mk = await api('POST', '/api/stores', { token: S.store, body: { name: 'Registered Jewellers', address: '1 Main St', latitude: 13.09, longitude: 80.27, google_place_id: 'PLACE_REG', phone: '044 111', business_registration: 'GSTIN-TEST' } });
  assert.equal(mk.status, 201); S.storeId = mk.body.store.id;
  assert.equal((await api('PUT', `/api/stores/${S.storeId}/categories`, { token: S.store, body: { categories: ['chain', 'ring', 'bangle'] } })).status, 200);
  // unverified store's products are not public
  const chainDesign = (await api('POST', `/api/stores/${S.storeId}/designs`, { token: S.store, body: { jewelry_type: 'chain', name: 'Design A' } })).body.design;
  const ringDesign = (await api('POST', `/api/stores/${S.storeId}/designs`, { token: S.store, body: { jewelry_type: 'ring', name: 'Design B', wastage_percent: 12 } })).body.design;
  S.chainDesign = chainDesign.id;
  assert.equal(chainDesign.wastage_percent, null);
  const tax = (await api('POST', '/api/admin/tax-rules', { token: S.admin, body: { name: 'Test tax 3%', rate_percent: 3, applies_to: 'all' } })).body.tax;
  const p = await api('POST', '/api/products', { token: S.store, body: {
    store_id: S.storeId, jewelry_type: 'chain', design_id: chainDesign.id, name: '22K Rope Chain', metal: 'gold', purity: '22K', gross_weight_g: 10.2, net_weight_g: 10,
    making_charge_type: 'percent_of_metal', making_charge_value: 10, hallmark_standard: 'BIS 916', hallmark_huid: 'AB1234', stock_quantity: 2, tax_rule_ids: [tax.id] } });
  assert.equal(p.status, 201); S.productId = p.body.product.id;
  assert.equal(p.body.product.price.estimated_final_price, null);       // no wastage supplied -> no guessed total
  assert.equal(p.body.product.wastage.note, 'Wastage not supplied by the store');
  assert.equal((await api('PUT', `/api/stores/${S.storeId}/designs/${chainDesign.id}/wastage`, { token: S.store, body: { wastage_percent: 8 } })).status, 200);
  assert.equal((await api('GET', `/api/products/${S.productId}`)).status, 404); // store not verified yet
  // validation
  assert.equal((await api('POST', '/api/products', { token: S.store, body: { store_id: S.storeId, jewelry_type: 'gold-coin', name: 'Bad', metal: 'silver', purity: '999', gross_weight_g: 1, net_weight_g: 1, making_charge_type: 'fixed', making_charge_value: 0 } })).status, 400);
  assert.equal((await api('POST', '/api/products', { token: S.store, body: { store_id: S.storeId, jewelry_type: 'ring', name: 'Bad', metal: 'gold', purity: '22K', gross_weight_g: 1, net_weight_g: 2, making_charge_type: 'fixed', making_charge_value: 0 } })).status, 400);
  // admin verifies
  const v = await api('POST', `/api/admin/stores/${S.storeId}/verify`, { token: S.admin, body: { status: 'verified' } });
  assert.equal(v.body.store.verification_status, 'verified');
  const prod = (await api('GET', `/api/products/${S.productId}`)).body.product;
  // 22K = 10083.33/g ; metal 100833.30 ; wastage 8% of 10g = 0.8g -> 8066.66 ; making 10% of metal = 10083.33 ; subtotal ; tax 3%
  assert.equal(prod.price.metal_value, 100833.3);
  assert.equal(prod.price.wastage_weight_g, 0.8);
  assert.equal(prod.price.wastage_value, 8066.66);
  assert.equal(prod.price.making_charge.amount, 10083.33);
  assert.equal(prod.price.subtotal, 118983.29);
  assert.equal(prod.price.tax_total, 3569.5);
  assert.equal(prod.price.estimated_final_price, 122552.79);
  assert.equal(prod.price.metal_price.source, 'goldapi.io');
  assert.ok(prod.price.last_price_update && prod.wastage.updated_at);
  assert.equal(prod.wastage.source, 'store');
  // changing a verified store's address sends it back to review
  const edit = await api('PATCH', `/api/stores/${S.storeId}`, { token: S.store, body: { address: '1 Main Street, Annex' } });
  assert.equal(edit.body.re_verification_required, true);
  await api('POST', `/api/admin/stores/${S.storeId}/verify`, { token: S.admin, body: { status: 'verified' } });
});

test('calculator uses latest stored provider price and shows every component', async () => {
  const c = (await api('POST', '/api/jewelry/calculate', { body: { metal: 'silver', purity: '925', net_weight_g: 50, wastage_percent: 10, making_charge_type: 'per_gram', making_charge_value: 5 } })).body;
  assert.equal(c.price_per_gram, 92.5);
  assert.equal(c.metal_value, 4625);
  assert.equal(c.wastage_value, 462.5);
  assert.equal(c.making_charge.amount, 250);
  assert.equal(c.estimated_final_price, 5337.5);
  assert.equal(c.metal_price.is_derived, true);
  assert.equal((await api('POST', '/api/jewelry/calculate', { body: { metal: 'gold', purity: '999', net_weight_g: 1 } })).status, 400);
});

test('store prices need admin approval; never alter the market price', async () => {
  const sub = await api('POST', `/api/stores/${S.storeId}/price-submissions`, { token: S.store, body: { metal: 'gold', purity: '22K', price_per_gram: 10150 } });
  assert.equal(sub.status, 201);
  const before = (await pool.query('SELECT count(*)::int AS n FROM metal_prices')).rows[0].n;
  assert.equal((await api('POST', `/api/admin/price-submissions/${sub.body.submission.id}/review`, { token: S.store, body: { decision: 'approved' } })).status, 403);
  assert.equal((await api('POST', `/api/admin/price-submissions/${sub.body.submission.id}/review`, { token: S.admin, body: { decision: 'approved' } })).status, 200);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM metal_prices')).rows[0].n, before);
});

test('location search: real Places data merged with registered stores, honest ranking', async () => {
  const geo = await api('GET', '/api/location/geocode?address=Chennai');
  assert.equal(geo.body.results[0].latitude, 13.0827);
  const r = await api('GET', '/api/search/stores?lat=13.0827&lng=80.2707&radius_km=15');
  assert.equal(r.status, 200);
  const byId = Object.fromEntries(r.body.stores.map((s) => [s.place_id, s]));
  assert.deepEqual(Object.keys(byId).sort(), ['PLACE_BIG', 'PLACE_LOCAL', 'PLACE_REG']);
  assert.equal(byId.PLACE_REG.verification.status, 'verified');
  assert.equal(byId.PLACE_REG.registered, true);
  assert.equal(byId.PLACE_REG.store_prices[0].price_per_gram, 10150);
  assert.deepEqual(byId.PLACE_REG.categories.map((c) => c.slug).sort(), ['bangle', 'chain', 'ring']);
  assert.equal(byId.PLACE_LOCAL.rating, null);               // no rating invented
  assert.equal(byId.PLACE_LOCAL.categories, null);
  assert.equal(byId.PLACE_LOCAL.verification.status, 'unverified');
  assert.equal(byId.PLACE_BIG.rating, 4.8);
  assert.ok(byId.PLACE_REG.directions_url.includes('destination=') && byId.PLACE_REG.distance_km > 0);
  // sorting + filters
  const byDist = (await api('GET', '/api/search/stores?lat=13.0827&lng=80.2707&sort=distance')).body.stores.map((s) => s.distance_km);
  assert.deepEqual(byDist, [...byDist].sort((a, b) => a - b));
  assert.deepEqual((await api('GET', '/api/search/stores?lat=13.0827&lng=80.2707&verified_only=true')).body.stores.map((s) => s.place_id), ['PLACE_REG']);
  assert.deepEqual((await api('GET', '/api/search/stores?lat=13.0827&lng=80.2707&min_rating=4.5')).body.stores.map((s) => s.place_id), ['PLACE_BIG']);
  assert.deepEqual((await api('GET', '/api/search/stores?lat=13.0827&lng=80.2707&category=ring&in_stock=true')).body.stores.map((s) => s.place_id), []); // no ring in stock
  assert.deepEqual((await api('GET', '/api/search/stores?lat=13.0827&lng=80.2707&category=chain&in_stock=true')).body.stores.map((s) => s.place_id), ['PLACE_REG']);
  assert.equal((await api('GET', '/api/search/stores?lat=999&lng=80')).status, 400);
});

test('sponsored listings are separate, labelled, and never change organic order', async () => {
  const q = '/api/search/stores?lat=13.0827&lng=80.2707&sort=distance';
  const organicBefore = (await api('GET', q)).body.stores.map((s) => s.id);
  const t0 = new Date(Date.now() - 3600e3).toISOString(); const t1 = new Date(Date.now() + 3600e3).toISOString();
  assert.equal((await api('POST', '/api/admin/sponsored', { token: S.admin, body: { store_id: S.storeId, starts_at: t0, ends_at: t1 } })).status, 201);
  await new Promise((r) => setTimeout(r, 1100)); // places cache ttl
  const after_ = (await api('GET', q)).body;
  assert.deepEqual(after_.stores.map((s) => s.id), organicBefore);
  assert.equal(after_.sponsored.length, 1);
  assert.equal(after_.sponsored[0].sponsored_label, 'Sponsored');
});

test('Places provider failure / missing key: explicit error, registered stores still returned', async () => {
  places.fail = true; await new Promise((r) => setTimeout(r, 1100));
  const r = await api('GET', '/api/search/stores?lat=13.0827&lng=80.2707');
  assert.equal(r.status, 200);
  assert.equal(r.body.sources.google_places.ok, false);
  assert.deepEqual(r.body.stores.map((s) => s.place_id), ['PLACE_REG']);
  places.fail = false;
  env.GOOGLE_MAPS_API_KEY = ''; await new Promise((r2) => setTimeout(r2, 1100));
  const g = await api('GET', '/api/location/geocode?address=Chennai');
  assert.equal(g.status, 503); assert.deepEqual(g.body.error.details.config_required, ['GOOGLE_MAPS_API_KEY']);
  env.GOOGLE_MAPS_API_KEY = 'test-maps-key';
});

test('orders: locks live price, decrements stock, blocks when price is stale, cancel restocks', async () => {
  const o = await api('POST', '/api/orders', { token: S.cust, body: { items: [{ product_id: S.productId, quantity: 1 }] } });
  assert.equal(o.status, 201);
  assert.equal(o.body.order.total, 122552.79);
  const item = (await api('GET', `/api/orders/${o.body.order.id}`, { token: S.cust })).body.order.items[0];
  assert.ok(item.metal_price_id && item.breakdown.metal_value);
  assert.equal((await pool.query('SELECT stock_quantity FROM products WHERE id=$1', [S.productId])).rows[0].stock_quantity, 1);
  assert.equal((await api('GET', `/api/orders/${o.body.order.id}`, { token: S.store })).status, 200);       // store owner may view
  assert.equal((await api('PATCH', `/api/orders/${o.body.order.id}/status`, { token: S.cust, body: { status: 'cancelled' } })).status, 200);
  assert.equal((await pool.query('SELECT stock_quantity FROM products WHERE id=$1', [S.productId])).rows[0].stock_quantity, 2);
  await pool.query(`UPDATE metal_prices SET fetched_at = now() - interval '3 hours'`);
  metals.fail = true; env.METALS_LAZY_REFRESH = false;
  const blocked = await api('POST', '/api/orders', { token: S.cust, body: { items: [{ product_id: S.productId, quantity: 1 }] } });
  assert.equal(blocked.status, 409); assert.equal(blocked.body.error.code, 'PRICE_STALE');
  const prod = (await api('GET', `/api/products/${S.productId}`)).body.product;
  assert.equal(prod.price.stale, true); assert.match(prod.price.stale_message, /Live update unavailable/);
  assert.ok(prod.price.estimated_final_price > 0);   // last verified price still displayed
  metals.fail = false; env.METALS_LAZY_REFRESH = true;
});

test('admin status monitor + error log', async () => {
  await refreshAll();
  const s = (await api('GET', '/api/admin/status?probe=true', { token: S.admin })).body;
  assert.equal(s.gold_api.status, '🟢 Connected'); assert.equal(s.silver_api.status, '🟢 Connected');
  assert.equal(s.database.status, '🟢 Connected'); assert.equal(s.store_api.status, '🟢 Connected');
  assert.ok(s.last_gold_update && s.last_silver_update);
  metals.fail = true; await refreshAll();
  const bad = (await api('GET', '/api/admin/status', { token: S.admin })).body;
  assert.equal(bad.gold_api.status, '🔴 Error');
  metals.fail = false;
  const errs = (await api('GET', '/api/admin/api-errors?service=gold', { token: S.admin })).body.errors;
  assert.ok(errs.length >= 1);
  assert.equal((await api('PATCH', '/api/admin/users/' + (await pool.query(`SELECT id FROM users WHERE email='admin@example.com'`)).rows[0].id, { token: S.admin, body: { role: 'customer' } })).status, 409);
});

test('404s, bad JSON, security headers', async () => {
  assert.equal((await api('GET', '/api/nope')).status, 404);
  const res = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad' });
  assert.equal(res.status, 400);
  assert.ok(res.headers.get('x-content-type-options'));
  assert.equal((await api('GET', '/health')).status, 200);
});


// ======================= new features =======================
test('mandatory login: data routes reject anonymous visitors, auth routes stay open', async () => {
  env.REQUIRE_LOGIN = true;
  for (const p of ['/api/gold', '/api/silver', '/api/metals/latest', '/api/products', '/api/search/products?q=ring', '/api/search/stores?lat=13&lng=80', '/api/jewelry/types', '/api/location/geocode?address=chennai']) {
    assert.equal((await api('GET', p)).status, 401, p);
  }
  assert.equal((await api('GET', '/health')).status, 200);
  assert.equal((await api('GET', '/api/gold', { token: S.cust })).status, 200);
  assert.equal((await api('POST', '/api/auth/login', { body: { email: 'cust@example.com', password: 'longpassword123' } })).status, 200);
});

test('language preference is saved per user', async () => {
  assert.equal((await api('PATCH', '/api/auth/me', { token: S.cust, body: { language: 'ta' } })).body.user.language, 'ta');
  assert.equal((await api('PATCH', '/api/auth/me', { token: S.cust, body: { language: 'fr' } })).status, 400);
  assert.equal((await api('GET', '/api/auth/me', { token: S.cust })).body.user.language, 'ta');
  const types = (await api('GET', '/api/jewelry/types', { token: S.cust })).body.types;
  assert.equal(types.length, 16);
  for (const t of types) for (const l of ['hi', 'ta', 'te', 'kn', 'ml']) assert.ok(t.name_i18n[l], `${t.slug} missing ${l}`);
});

test('search: any language, typos, filters, live-price sorting', async () => {
  const s = (qs) => api('GET', '/api/search/products?' + qs, { token: S.cust });
  assert.equal((await s('q=chain')).body.products.length, 1);
  assert.equal((await s('q=' + encodeURIComponent('சங்கிலி'))).body.products.length, 1);   // Tamil for chain
  assert.equal((await s('q=' + encodeURIComponent('గొలుసు'))).body.products.length, 1);    // Telugu
  assert.equal((await s('q=' + encodeURIComponent('मंगलसूत्र'))).body.products.length, 0); // no such product, no fake result
  assert.equal((await s('q=rope')).body.products.length, 1);
  assert.equal((await s('q=chian')).body.products.length, 1);                            // typo
  assert.equal((await s('q=bangle')).body.products.length, 0);
  assert.equal((await s('metal=silver')).body.products.length, 0);
  assert.equal((await s('metal=gold&min_price=1000000')).body.products.length, 0);
  assert.equal((await s('metal=gold&max_price=1000000&min_weight=5')).body.products.length, 1);
  const r = (await s('q=chain&sort=price_asc')).body.products[0];
  assert.ok(r.price.estimated_final_price > 0 && r.relevance > 0);
});

test('gold-loan comparison: only admin-entered lenders, real EMI maths, source shown', async () => {
  const empty = (await api('GET', '/api/loans/compare?weight_g=10&purity=22K', { token: S.cust })).body;
  assert.deepEqual(empty.offers, []); assert.match(empty.note, /No lenders/);
  const mk = (b) => api('POST', '/api/loans/providers', { token: S.admin, body: { provider_type: 'bank', processing_fee_percent: 0, source_url: 'https://example.com/lender-terms', source_checked_at: new Date().toISOString(), ...b } });
  assert.equal((await api('POST', '/api/loans/providers', { token: S.store, body: {} })).status, 403);
  assert.equal((await mk({ name: 'Lender A', interest_rate_percent: 9, ltv_percent: 75, processing_fee_percent: 1, max_tenure_months: 36 })).status, 201);
  assert.equal((await mk({ name: 'Lender B', interest_rate_percent: 12, ltv_percent: 80, accepted_purities: ['24K'] })).status, 201);
  assert.equal((await mk({ name: 'Lender C', interest_rate_percent: 0, ltv_percent: 50, min_loan_amount: 50000000 })).status, 201);
  assert.equal((await api('POST', '/api/loans/providers', { token: S.admin, body: { name: 'No source', provider_type: 'bank', interest_rate_percent: 5, ltv_percent: 70 } })).status, 400);
  const r = (await api('GET', '/api/loans/compare?weight_g=10&purity=22K&tenure_months=12', { token: S.cust })).body;
  assert.equal(r.gold.value, 100833.3);                  // 10 g x 10083.33
  assert.equal(r.offers.length, 1);
  const a = r.offers[0];
  assert.equal(a.provider.name, 'Lender A'); assert.equal(a.loan_amount, 75624.98);   // 75% LTV
  assert.equal(a.processing_fee, 756.25);
  assert.ok(Math.abs(a.emi - 6614.5) < 1);               // 75,624.98 @ 9% p.a., 12 months
  assert.equal(a.total_cost, Math.round((a.total_interest + a.processing_fee) * 100) / 100);
  assert.ok(a.provider.source_url && a.provider.source_checked_at);
  assert.equal(r.not_eligible.length, 2);
  assert.match(r.not_eligible.map((x) => x.reason).join('|'), /does not accept 22K/i);
});

test('Talk to Thangam Team: real two-way conversation, private per customer', async () => {
  const t = await api('POST', '/api/support/threads', { token: S.cust, body: { subject: 'Question about a chain', message: 'Is the 22K chain available?' } });
  assert.equal(t.status, 201); const id = t.body.thread.id;
  const reg = await api('POST', '/api/auth/register', { body: { email: 'other@example.com', password: 'longpassword123', name: 'Other' } });
  assert.equal((await api('GET', `/api/support/threads/${id}`, { token: reg.body.token })).status, 403);   // another customer cannot read it
  assert.equal((await api('GET', '/api/support/threads', { token: reg.body.token })).body.threads.length, 0);
  assert.equal((await api('GET', '/api/support/threads', { token: S.admin })).body.threads.length, 1);       // admin inbox
  assert.equal((await api('POST', `/api/support/threads/${id}/messages`, { token: S.admin, body: { message: 'Yes, it is in stock.' } })).status, 201);
  const m = (await api('GET', `/api/support/threads/${id}`, { token: S.cust })).body.messages;
  assert.deepEqual(m.map((x) => x.sender_role), ['customer', 'admin']);
  const later = (await api('GET', `/api/support/threads/${id}?after=${m[0].id}`, { token: S.cust })).body.messages;   // polling
  assert.equal(later.length, 1);
  assert.equal((await api('PATCH', `/api/support/threads/${id}`, { token: S.cust, body: { status: 'closed' } })).status, 403);
  assert.equal((await api('PATCH', `/api/support/threads/${id}`, { token: S.admin, body: { status: 'closed' } })).status, 200);
  assert.equal((await api('POST', `/api/support/threads/${id}/messages`, { token: S.cust, body: { message: 'thanks' } })).status, 409);
});

test('feedback: customers submit, only admins read', async () => {
  assert.equal((await api('POST', '/api/feedback', { token: S.cust, body: { rating: 5, topic: 'prices', message: 'Clear price breakdown' } })).status, 201);
  assert.equal((await api('POST', '/api/feedback', { token: S.cust, body: { rating: 9, message: 'x' } })).status, 400);
  assert.equal((await api('GET', '/api/feedback', { token: S.cust })).status, 403);
  const f = (await api('GET', '/api/feedback', { token: S.admin })).body;
  assert.equal(f.count, 1); assert.equal(f.average_rating, 5);
});

test('payments: honest when Razorpay is not configured; signature-verified when it is', async () => {
  const order = (await api('POST', '/api/orders', { token: S.cust, body: { items: [{ product_id: S.productId, quantity: 1 }] } })).body.order;
  assert.equal(order.payment_status, 'unpaid');
  const noKeys = await api('POST', '/api/payments/razorpay/order', { token: S.cust, body: { order_id: order.id } });
  assert.equal(noKeys.status, 503); assert.deepEqual(noKeys.body.error.details.config_required, ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET']);
  assert.equal((await api('GET', '/api/payments/config', { token: S.cust })).body.razorpay_enabled, false);
  env.RAZORPAY_KEY_ID = 'rzp_test_key'; env.RAZORPAY_KEY_SECRET = 'rzp_test_secret';
  const rz = (await api('POST', '/api/payments/razorpay/order', { token: S.cust, body: { order_id: order.id } })).body;
  assert.equal(rz.amount, Math.round(order.total * 100)); assert.equal(rz.key_id, 'rzp_test_key');
  const crypto = await import('node:crypto');
  const sig = (oid, pid) => crypto.createHmac('sha256', 'rzp_test_secret').update(`${oid}|${pid}`).digest('hex');
  const bad = await api('POST', '/api/payments/razorpay/verify', { token: S.cust, body: { order_id: order.id, razorpay_order_id: rz.razorpay_order_id, razorpay_payment_id: 'pay_1', razorpay_signature: 'f'.repeat(64) } });
  assert.equal(bad.status, 409);
  assert.equal((await pool.query('SELECT payment_status FROM orders WHERE id=$1', [order.id])).rows[0].payment_status, 'failed');
  const ok = await api('POST', '/api/payments/razorpay/verify', { token: S.cust, body: { order_id: order.id, razorpay_order_id: rz.razorpay_order_id, razorpay_payment_id: 'pay_1', razorpay_signature: sig(rz.razorpay_order_id, 'pay_1') } });
  assert.equal(ok.status, 200); assert.equal(ok.body.order.payment_status, 'paid'); assert.equal(ok.body.order.status, 'confirmed');
  const other = (await api('POST', '/api/auth/login', { body: { email: 'other@example.com', password: 'longpassword123' } })).body.token;
  assert.equal((await api('POST', '/api/payments/razorpay/order', { token: other, body: { order_id: order.id } })).status, 403);
});
