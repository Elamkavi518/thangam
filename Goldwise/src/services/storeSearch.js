import { query } from '../db/pool.js';
import { haversineKm, directionsUrl } from '../utils/geo.js';
import { findJewelryStores } from './places/googlePlaces.js';

const W = { distance: 0.35, verification: 0.25, relevance: 0.2, rating: 0.15, availability: 0.05 };

async function registeredNear(lat, lng, radiusKm) {
  const dLat = radiusKm / 111;
  const dLng = radiusKm / (111 * Math.max(0.01, Math.cos((lat * Math.PI) / 180)));
  const { rows } = await query(
    `SELECT s.id, s.name, s.google_place_id, s.address, s.city, s.latitude, s.longitude, s.phone, s.website, s.opening_hours,
            s.verification_status, s.verified_at, s.updated_at,
            COALESCE((SELECT json_agg(json_build_object('slug', jt.slug, 'name', jt.name) ORDER BY jt.sort_order)
                        FROM store_jewelry_types sjt JOIN jewelry_types jt ON jt.id = sjt.jewelry_type_id WHERE sjt.store_id = s.id AND jt.is_active), '[]') AS categories,
            COALESCE((SELECT json_agg(DISTINCT jt.slug) FROM products p JOIN jewelry_types jt ON jt.id = p.jewelry_type_id
                       WHERE p.store_id = s.id AND p.is_active AND p.stock_status IN ('in_stock','low_stock','made_to_order') AND p.stock_quantity >= 0), '[]') AS in_stock_slugs,
            COALESCE((SELECT json_agg(x) FROM (
                SELECT DISTINCT ON (sp.metal, sp.purity_code) sp.metal, sp.purity_code AS purity, sp.price_per_gram, sp.currency, sp.submitted_at, sp.reviewed_at AS verified_at
                  FROM store_price_submissions sp WHERE sp.store_id = s.id AND sp.status = 'approved'
                 ORDER BY sp.metal, sp.purity_code, sp.reviewed_at DESC) x), '[]') AS store_prices,
            EXISTS (SELECT 1 FROM sponsored_listings sl WHERE sl.store_id = s.id AND sl.is_active AND now() BETWEEN sl.starts_at AND sl.ends_at) AS is_sponsored
       FROM stores s
      WHERE s.is_active AND s.verification_status = 'verified'
        AND s.latitude BETWEEN $1 AND $2 AND s.longitude BETWEEN $3 AND $4`,
    [lat - dLat, lat + dLat, lng - dLng, lng + dLng],
  );
  return rows.filter((s) => haversineKm(lat, lng, s.latitude, s.longitude) <= radiusKm);
}

function relevance(q, item) {
  if (!q) return null;
  const hay = `${item.name} ${item.address} ${(item.categories || []).map((c) => c.name).join(' ')}`.toLowerCase();
  const toks = q.toLowerCase().split(/\s+/).filter(Boolean);
  return toks.length ? toks.filter((t) => hay.includes(t)).length / toks.length : null;
}

function hoursOf(reg, g) {
  if (g?.weekday_text) return { open_now: g.open_now, weekday_text: g.weekday_text, source: 'google_places' };
  if (reg?.opening_hours) return { open_now: null, hours: reg.opening_hours, source: 'store' };
  return null;
}

export async function searchStores(p) {
  const { lat, lng, radiusKm, q, category, verifiedOnly, minRating, openNow, inStock, sort, limit } = p;
  const radiusM = radiusKm * 1000;

  const [registered, googleResult] = await Promise.all([
    registeredNear(lat, lng, radiusKm),
    findJewelryStores({ lat, lng, radiusM, q }).then((r) => ({ ...r, error: null })).catch((e) => ({ places: [], error: e })),
  ]);
  const byPlace = new Map(registered.filter((s) => s.google_place_id).map((s) => [s.google_place_id, s]));
  const seenReg = new Set();
  const items = [];

  for (const g of googleResult.places) {
    const reg = byPlace.get(g.place_id);
    if (reg) seenReg.add(reg.id);
    items.push(build({ g, reg, lat, lng }));
  }
  for (const reg of registered) if (!seenReg.has(reg.id)) items.push(build({ g: null, reg, lat, lng }));

  const passes = (it) =>
    (!verifiedOnly || it.verification.status === 'verified') &&
    (minRating == null || (it.rating != null && it.rating >= minRating)) &&
    (!openNow || it.opening_hours?.open_now === true) &&
    (!category || it.categories?.some((c) => c.slug === category)) &&
    (!inStock || (it.registered && it.in_stock_categories.length > 0 && (!category || it.in_stock_categories.includes(category))));

  const filtered = items.filter(passes);
  for (const it of filtered) it.ranking = score(it, { radiusKm, q, category });

  const cmp = {
    distance: (a, b) => a.distance_km - b.distance_km,
    rating: (a, b) => (b.rating ?? -1) - (a.rating ?? -1) || a.distance_km - b.distance_km,
    verified: (a, b) => (b.verification.status === 'verified') - (a.verification.status === 'verified') || a.distance_km - b.distance_km,
    relevance: (a, b) => (b.ranking.components.relevance ?? -1) - (a.ranking.components.relevance ?? -1) || a.distance_km - b.distance_km,
    best_match: (a, b) => b.ranking.score - a.ranking.score || a.distance_km - b.distance_km,
  }[sort];
  const organic = filtered.sort(cmp).slice(0, limit);

  // Sponsored listings: separate list, clearly labelled, never affects organic ordering.
  const sponsored = items.filter((it) => it.registered && it.sponsored && passes(it)).map((it) => ({ ...it, sponsored: true, sponsored_label: 'Sponsored' }));

  return {
    location: { latitude: lat, longitude: lng, radius_km: radiusKm },
    sort,
    ranking_note: sort === 'best_match'
      ? 'Best match combines distance, verification, text relevance (when searching), Google rating (only where one exists) and stock availability (registered stores). Missing signals are left out, never estimated. Payment does not affect order.'
      : `Sorted by ${sort}.`,
    count: organic.length,
    stores: organic,
    sponsored,
    sources: { google_places: googleResult.error ? { ok: false, message: googleResult.error.message, config_required: googleResult.error.details?.config_required ?? [] } : { ok: true, cached: !!googleResult.cached, partial: !!googleResult.partial }, goldwise_registered: { ok: true } },
  };
}

function build({ g, reg, lat, lng }) {
  const sLat = g?.latitude ?? reg.latitude;
  const sLng = g?.longitude ?? reg.longitude;
  const verified = reg?.verification_status === 'verified';
  return {
    id: reg ? reg.id : g.place_id,
    place_id: g?.place_id ?? reg?.google_place_id ?? null,
    registered: !!reg,
    sponsored: !!reg?.is_sponsored,
    name: reg?.name ?? g.name,
    address: g?.address ?? reg?.address,
    latitude: sLat,
    longitude: sLng,
    distance_km: Math.round(haversineKm(lat, lng, sLat, sLng) * 100) / 100,
    phone: reg?.phone ?? g?.phone ?? null,
    website: reg?.website ?? g?.website ?? null,
    opening_hours: hoursOf(reg, g),
    directions_url: directionsUrl(sLat, sLng, g?.place_id),
    rating: g?.rating ?? null,
    rating_count: g?.rating_count ?? null,
    rating_source: g?.rating != null ? 'Google' : null,
    verification: {
      status: verified ? 'verified' : 'unverified',
      verified_at: verified ? reg.verified_at : null,
      note: verified ? 'Business verified by GoldWise admin' : 'Listed from Google Places; not verified by GoldWise',
    },
    categories: reg ? reg.categories : null,
    categories_note: reg ? null : 'Not provided by this business',
    in_stock_categories: reg ? reg.in_stock_slugs : [],
    store_prices: reg ? reg.store_prices : [],
    store_prices_note: reg && reg.store_prices.length ? 'Store-supplied rates, approved by GoldWise admin' : 'No store-provided prices available',
  };
}

function score(it, { radiusKm, q, category }) {
  const c = {
    distance: Math.max(0, 1 - it.distance_km / radiusKm),
    verification: it.verification.status === 'verified' ? 1 : 0,
    relevance: relevance(q, it),
    rating: it.rating != null ? it.rating / 5 : null,
    availability: it.registered ? (it.in_stock_categories.length && (!category || it.in_stock_categories.includes(category)) ? 1 : 0) : null,
  };
  let num = 0;
  let den = 0;
  for (const k of Object.keys(W)) if (c[k] != null) { num += W[k] * c[k]; den += W[k]; }
  return { score: den ? Math.round((num / den) * 1000) / 1000 : 0, components: Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v == null ? null : Math.round(v * 1000) / 1000])) };
}
