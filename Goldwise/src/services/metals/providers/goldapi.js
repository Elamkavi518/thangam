import env from '../../../config/env.js';

const TROY_OZ_G = 31.1034768;
const BASE = (!env.isProd && env.METALS_PROVIDER_BASE_URL) || 'https://www.goldapi.io/api';

export const PROVIDER_ID = 'goldapi.io';
export const requiredConfig = () => (env.GOLDAPI_KEY ? [] : ['GOLDAPI_KEY']);

export class ProviderError extends Error {
  constructor(message, { httpStatus = null, configRequired = [] } = {}) {
    super(message);
    this.httpStatus = httpStatus;
    this.configRequired = configRequired;
  }
}

async function call(symbol) {
  const missing = requiredConfig();
  if (missing.length) throw new ProviderError(`Missing configuration: ${missing.join(', ')}`, { configRequired: missing });
  let res;
  try {
    res = await fetch(`${BASE}/${symbol}/${env.METALS_CURRENCY}`, {
      headers: { 'x-access-token': env.GOLDAPI_KEY, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    throw new ProviderError(`Provider unreachable: ${e.message}`);
  }
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = null; }
  if (!res.ok) {
    throw new ProviderError(`Provider returned HTTP ${res.status}${body?.error ? `: ${body.error}` : ''}`, { httpStatus: res.status });
  }
  if (!body || typeof body !== 'object') throw new ProviderError('Provider returned an unreadable response', { httpStatus: res.status });
  return body;
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
const ts = (v) => (num(v) ? new Date(v * 1000) : null);

/**
 * Gold: returns per-gram prices as supplied by the provider. 24K comes from price_gram_24k
 * (or price per troy ounce / 31.1034768). 22K/18K are taken from the provider when present;
 * otherwise the caller derives them (and flags them as derived).
 */
export async function fetchGold() {
  const b = await call('XAU');
  const g24 = num(b.price_gram_24k) ?? (num(b.price) ? b.price / TROY_OZ_G : null);
  if (!g24) throw new ProviderError('Provider response did not contain a usable gold price');
  return {
    source: PROVIDER_ID,
    providerTimestamp: ts(b.timestamp),
    prices: { '24K': g24, '22K': num(b.price_gram_22k), '18K': num(b.price_gram_18k) },
    raw: b,
  };
}

/** Silver: spot silver is pure (999) metal; per-gram = price per troy ounce / 31.1034768. */
export async function fetchSilver() {
  const b = await call('XAG');
  const p = num(b.price) ? b.price / TROY_OZ_G : num(b.price_gram_24k);
  if (!p) throw new ProviderError('Provider response did not contain a usable silver price');
  return { source: PROVIDER_ID, providerTimestamp: ts(b.timestamp), prices: { 999: p }, raw: b };
}
