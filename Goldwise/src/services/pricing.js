import { query } from '../db/pool.js';
import env from '../config/env.js';
import { latestPrices, metalStatus } from './metals/metalsService.js';
import { HttpError, ServiceUnavailable } from '../utils/errors.js';

const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const r3 = (n) => Math.round((n + Number.EPSILON) * 1000) / 1000;

/** Unit conversions from the stored per-gram price. */
export function unitPrices(metal, perGram) {
  const base = { per_gram: r2(perGram) };
  if (metal === 'gold') return { ...base, per_8_gram: r2(perGram * 8), per_10_gram: r2(perGram * 10) };
  return { ...base, per_10_gram: r2(perGram * 10), per_100_gram: r2(perGram * 100), per_kilogram: r2(perGram * 1000) };
}

export async function metalSnapshot(metal) {
  const [rows, status] = await Promise.all([latestPrices(metal), metalStatus(metal)]);
  const lastUpdated = rows.reduce((m, r) => (!m || r.fetched_at > m ? r.fetched_at : m), null);
  return {
    metal,
    currency: env.METALS_CURRENCY,
    unit: 'gram',
    live: status.live,
    status_message: status.live ? 'Live' : status.message,
    config_required: status.config_required,
    last_updated: lastUpdated, // exact time GoldWise stored the price (ISO 8601, UTC)
    last_attempt: status.last_attempt,
    purities: rows.map((r) => ({
      purity: r.purity_code,
      price_id: r.id,
      ...unitPrices(metal, r.price),
      source: r.source,
      is_derived: r.is_derived,
      derived_from: r.derived_from,
      provider_timestamp: r.provider_timestamp,
      fetched_at: r.fetched_at,
    })),
  };
}

/** Latest verified per-gram price for a purity, with provenance. Throws if none exists (never invents). */
export async function requirePrice(metal, purity, { allowStale = true } = {}) {
  const rows = await latestPrices(metal);
  const row = rows.find((r) => r.purity_code === String(purity));
  if (!row) {
    const status = await metalStatus(metal);
    throw new ServiceUnavailable(
      metal,
      `No verified ${metal} price is stored yet.${status.config_required.length ? ` Required configuration: ${status.config_required.join(', ')}.` : ' The metals provider has not returned data.'}`,
      status.config_required,
    );
  }
  const ageMin = (Date.now() - new Date(row.fetched_at).getTime()) / 60000;
  const stale = ageMin > env.METALS_MAX_STALE_MINUTES;
  if (stale && !allowStale) {
    throw new HttpError(409, 'PRICE_STALE', `Last verified ${metal} price is ${Math.round(ageMin)} minutes old (limit ${env.METALS_MAX_STALE_MINUTES}). Live update unavailable.`);
  }
  return { row, stale };
}

/**
 * Metal value + wastage + making + taxes = estimated final price.
 * Weights in grams, money in currency units. Wastage is applied to NET metal weight.
 */
export function calculate({ pricePerGram, netWeight, wastagePercent, makingType, makingValue, taxes = [] }) {
  const metalValue = r2(netWeight * pricePerGram);
  const wastageWeight = wastagePercent == null ? null : r3((netWeight * wastagePercent) / 100);
  const wastageValue = wastageWeight == null ? null : r2(wastageWeight * pricePerGram);
  const making = r2(makingType === 'fixed' ? makingValue : makingType === 'per_gram' ? makingValue * netWeight : (metalValue * makingValue) / 100);
  const subtotal = r2(metalValue + (wastageValue ?? 0) + making);
  const bases = { all: subtotal, metal_and_wastage: r2(metalValue + (wastageValue ?? 0)), making_only: making };
  const taxLines = taxes.map((t) => ({
    name: t.name,
    rate_percent: t.rate_percent,
    applies_to: t.applies_to,
    base: bases[t.applies_to],
    amount: r2((bases[t.applies_to] * t.rate_percent) / 100),
  }));
  const taxTotal = r2(taxLines.reduce((s, t) => s + t.amount, 0));
  return {
    price_per_gram: r2(pricePerGram),
    net_weight_g: netWeight,
    metal_value: metalValue,
    wastage_percent: wastagePercent,
    wastage_weight_g: wastageWeight,
    wastage_value: wastageValue,
    making_charge: { type: makingType, rate: makingValue, amount: making },
    subtotal,
    taxes: taxLines,
    tax_total: taxTotal,
    // Without a store-supplied wastage value the total would be incomplete, so it is withheld rather than guessed.
    estimated_final_price: wastagePercent == null ? null : r2(subtotal + taxTotal),
    complete: wastagePercent != null,
  };
}

const PRODUCT_SQL = `
  SELECT p.*, jt.slug AS type_slug, jt.name AS type_name, jt.name_i18n AS type_i18n,
         s.name AS store_name, s.verification_status, s.verified_at,
         d.name AS design_name, d.wastage_percent AS design_wastage_percent, d.wastage_updated_at AS design_wastage_updated_at,
         COALESCE((SELECT json_agg(json_build_object('id', t.id, 'name', t.name, 'rate_percent', t.rate_percent, 'applies_to', t.applies_to))
                     FROM product_taxes pt JOIN tax_rules t ON t.id = pt.tax_rule_id WHERE pt.product_id = p.id AND t.is_active), '[]') AS taxes
    FROM products p
    JOIN jewelry_types jt ON jt.id = p.jewelry_type_id
    JOIN stores s ON s.id = p.store_id
    LEFT JOIN designs d ON d.id = p.design_id`;
export const productSelect = PRODUCT_SQL;

/** Attach the live price calculation to product rows (rows from PRODUCT_SQL). */
export async function priceProducts(rows) {
  const cache = {};
  const out = [];
  for (const p of rows) {
    const key = `${p.metal}:${p.purity_code}`;
    if (!(key in cache)) {
      const all = await latestPrices(p.metal);
      cache[key] = all.find((r) => r.purity_code === p.purity_code) || null;
    }
    const mp = cache[key];
    const wastagePercent = p.wastage_override_percent ?? p.design_wastage_percent ?? null;
    const wastageUpdatedAt = p.wastage_override_percent != null ? p.wastage_override_updated_at : p.design_wastage_updated_at;
    const stale = mp ? (Date.now() - new Date(mp.fetched_at).getTime()) / 60000 > env.METALS_MAX_STALE_MINUTES : null;
    out.push({
      id: p.id,
      name: p.name,
      description: p.description,
      category: { slug: p.type_slug, name: p.type_name, names: p.type_i18n || undefined },
      metal: p.metal,
      purity: p.purity_code,
      gross_weight_g: p.gross_weight_g,
      net_weight_g: p.net_weight_g,
      design: p.design_name,
      hallmark: { standard: p.hallmark_standard, huid: p.hallmark_huid, certification: p.certification },
      stock_status: p.stock_status,
      stock_quantity: p.stock_quantity,
      images: p.images,
      attributes: p.type_attributes,
      store: { id: p.store_id, name: p.store_name, verification_status: p.verification_status, verified_at: p.verified_at },
      wastage: wastagePercent == null
        ? { percent: null, note: 'Wastage not supplied by the store', updated_at: null }
        : { percent: wastagePercent, source: 'store', updated_at: wastageUpdatedAt },
      price: mp
        ? {
            ...calculate({ pricePerGram: mp.price, netWeight: p.net_weight_g, wastagePercent, makingType: p.making_charge_type, makingValue: p.making_charge_value, taxes: p.taxes }),
            currency: mp.currency,
            metal_price: { id: mp.id, source: mp.source, is_derived: mp.is_derived, provider_timestamp: mp.provider_timestamp, fetched_at: mp.fetched_at },
            last_price_update: mp.fetched_at,
            stale,
            stale_message: stale ? 'Live update unavailable — showing last verified price' : null,
            tax_note: p.taxes.length ? null : 'No taxes configured for this product',
          }
        : { estimated_final_price: null, complete: false, error: `No verified ${p.metal} ${p.purity_code} price available yet` },
    });
  }
  return out;
}
