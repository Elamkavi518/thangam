import env from '../../config/env.js';
import { TTLCache } from '../../utils/cache.js';
import { recordApiEvent } from '../events.js';
import { ServiceUnavailable } from '../../utils/errors.js';

const PLACES = (!env.isProd && env.PLACES_BASE_URL) || 'https://places.googleapis.com/v1';
const GEOCODE = (!env.isProd && env.GEOCODE_BASE_URL) || 'https://maps.googleapis.com/maps/api/geocode/json';
const FIELDS = [
  'places.id', 'places.displayName', 'places.formattedAddress', 'places.location', 'places.nationalPhoneNumber',
  'places.websiteUri', 'places.rating', 'places.userRatingCount', 'places.regularOpeningHours', 'places.googleMapsUri', 'places.businessStatus',
].join(',');

const cache = new TTLCache({ ttlMs: env.PLACES_CACHE_TTL_SECONDS * 1000, max: 300 });
export const placesConfigRequired = () => (env.GOOGLE_MAPS_API_KEY ? [] : ['GOOGLE_MAPS_API_KEY']);

function assertConfigured(service) {
  const missing = placesConfigRequired();
  if (missing.length) {
    recordApiEvent({ service, ok: false, message: `Missing configuration: ${missing.join(', ')}`, configRequired: missing });
    throw new ServiceUnavailable(service, `Maps/Places is not configured. Required configuration: ${missing.join(', ')}.`, missing);
  }
}

async function googlePost(path, body) {
  assertConfigured('places');
  let res;
  try {
    res = await fetch(`${PLACES}/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': env.GOOGLE_MAPS_API_KEY, 'X-Goog-FieldMask': FIELDS },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    await recordApiEvent({ service: 'places', ok: false, message: `unreachable: ${e.message}` });
    throw new ServiceUnavailable('places', 'The Places provider could not be reached.');
  }
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = json?.error?.message || `HTTP ${res.status}`;
    await recordApiEvent({ service: 'places', ok: false, httpStatus: res.status, message: msg });
    throw new ServiceUnavailable('places', `Places provider error: ${msg}`);
  }
  await recordApiEvent({ service: 'places', ok: true, httpStatus: res.status, message: path });
  return json;
}

function normalize(p) {
  return {
    place_id: p.id,
    name: p.displayName?.text ?? null,
    address: p.formattedAddress ?? null,
    latitude: p.location?.latitude ?? null,
    longitude: p.location?.longitude ?? null,
    phone: p.nationalPhoneNumber ?? null,
    website: p.websiteUri ?? null,
    rating: typeof p.rating === 'number' ? p.rating : null,           // passed through from Google only; never computed
    rating_count: typeof p.userRatingCount === 'number' ? p.userRatingCount : null,
    open_now: typeof p.regularOpeningHours?.openNow === 'boolean' ? p.regularOpeningHours.openNow : null,
    weekday_text: p.regularOpeningHours?.weekdayDescriptions ?? null,
    google_maps_uri: p.googleMapsUri ?? null,
    business_status: p.businessStatus ?? null,
  };
}

const keyOf = (...a) => a.join('|');
const circle = (lat, lng, radiusM) => ({ circle: { center: { latitude: lat, longitude: lng }, radius: Math.min(50000, radiusM) } });

/**
 * Real jewelry stores around a point. Two complementary Google queries are merged:
 *  - nearby search ranked by distance → finds genuine local independents
 *  - text search ranked by relevance/prominence → surfaces popular/major stores
 * Results are cached briefly (coordinates rounded to ~110 m) to control cost.
 */
export async function findJewelryStores({ lat, lng, radiusM, q }) {
  const key = keyOf('stores', lat.toFixed(3), lng.toFixed(3), radiusM, q || '');
  const hit = cache.get(key);
  if (hit) return { ...hit, cached: true };

  const calls = [
    googlePost('places:searchNearby', {
      includedTypes: ['jewelry_store'], maxResultCount: 20, rankPreference: 'DISTANCE',
      locationRestriction: circle(lat, lng, radiusM),
    }),
    googlePost('places:searchText', {
      textQuery: q ? `${q} jewellery` : 'gold jewellery store', includedType: 'jewelry_store', strictTypeFiltering: true,
      pageSize: 20, locationBias: circle(lat, lng, radiusM),
    }),
  ];
  const settled = await Promise.allSettled(calls);
  const ok = settled.filter((s) => s.status === 'fulfilled');
  if (!ok.length) throw settled[0].reason;
  const map = new Map();
  for (const s of ok) for (const p of s.value.places || []) if (p.id && !map.has(p.id)) map.set(p.id, normalize(p));
  const value = { places: [...map.values()].filter((p) => p.latitude != null && p.business_status !== 'CLOSED_PERMANENTLY'), partial: ok.length < settled.length };
  cache.set(key, value);
  return { ...value, cached: false };
}

async function geocodeCall(params, service = 'geocoding') {
  assertConfigured(service);
  const url = new URL(GEOCODE);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('key', env.GOOGLE_MAPS_API_KEY);
  let json;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    json = await res.json();
  } catch (e) {
    await recordApiEvent({ service, ok: false, message: `unreachable: ${e.message}` });
    throw new ServiceUnavailable(service, 'The Geocoding provider could not be reached.');
  }
  if (!['OK', 'ZERO_RESULTS'].includes(json.status)) {
    await recordApiEvent({ service, ok: false, message: `${json.status}: ${json.error_message || ''}` });
    throw new ServiceUnavailable(service, `Geocoding provider error: ${json.status}${json.error_message ? ` — ${json.error_message}` : ''}`);
  }
  await recordApiEvent({ service, ok: true, message: json.status });
  return json.results || [];
}

export async function geocodeAddress(address) {
  const key = keyOf('geo', address.toLowerCase());
  const hit = cache.get(key);
  if (hit) return hit;
  const results = (await geocodeCall({ address })).slice(0, 5).map((r) => ({
    formatted_address: r.formatted_address, latitude: r.geometry.location.lat, longitude: r.geometry.location.lng, place_id: r.place_id,
  }));
  cache.set(key, results);
  return results;
}

export async function reverseGeocode(lat, lng) {
  const key = keyOf('rev', lat.toFixed(3), lng.toFixed(3));
  const hit = cache.get(key);
  if (hit) return hit;
  const r = (await geocodeCall({ latlng: `${lat},${lng}` }))[0];
  const comp = (t) => r?.address_components?.find((c) => c.types.includes(t))?.long_name ?? null;
  const out = r
    ? { formatted_address: r.formatted_address, locality: comp('locality') || comp('administrative_area_level_2'), state: comp('administrative_area_level_1'), country: comp('country'), postal_code: comp('postal_code') }
    : null;
  cache.set(key, out);
  return out;
}

/** Cheap live probe used by the admin monitor (one geocode request). */
export async function probe() {
  await geocodeCall({ address: 'Chennai, India' });
  return true;
}
