import pool, { query } from '../../db/pool.js';
import env from '../../config/env.js';
import logger from '../../utils/logger.js';
import { recordApiEvent } from '../events.js';
import * as goldapi from './providers/goldapi.js';

const provider = goldapi; // single adapter today; interface = {fetchGold, fetchSilver, requiredConfig, PROVIDER_ID}
const LOCK_KEY = 727002;
let inflight = null;
let timer = null;

export const GOLD_PURITIES = { '24K': 24 / 24, '22K': 22 / 24, '18K': 18 / 24 };
export const SILVER_PURITIES = { 999: 1, 925: 0.925 };

async function storeRows(client, metal, result, derivations) {
  const rows = [];
  for (const [code, price, derived, from] of derivations) {
    rows.push(
      (await client.query(
        `INSERT INTO metal_prices (metal, purity_code, price, currency, unit, source, is_derived, derived_from, provider_timestamp, raw_payload)
         VALUES ($1,$2,$3,$4,'gram',$5,$6,$7,$8,$9) RETURNING id`,
        [metal, String(code), Math.round(price * 10000) / 10000, env.METALS_CURRENCY, result.source, derived, from, result.providerTimestamp, result.raw],
      )).rows[0].id,
    );
  }
  return rows;
}

async function refreshMetal(metal) {
  const service = metal; // 'gold' | 'silver'
  try {
    const result = metal === 'gold' ? await provider.fetchGold() : await provider.fetchSilver();
    const rows = [];
    if (metal === 'gold') {
      const p = result.prices;
      for (const [code, ratio] of Object.entries(GOLD_PURITIES)) {
        const supplied = code === '24K' ? p['24K'] : p[code];
        if (supplied) rows.push([code, supplied, false, null]);
        else rows.push([code, p['24K'] * ratio, true, `24K x ${code.replace('K', '')}/24`]);
      }
    } else {
      rows.push(['999', result.prices[999], false, null]);
      rows.push(['925', result.prices[999] * SILVER_PURITIES[925], true, '999 x 0.925']);
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await storeRows(client, metal, result, rows);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
    await recordApiEvent({ service, ok: true, message: 'price stored' });
    return { metal, ok: true };
  } catch (err) {
    const configRequired = err.configRequired?.length ? err.configRequired : null;
    logger.error({ err: err.message, metal }, 'metal price refresh failed');
    await recordApiEvent({ service, ok: false, httpStatus: err.httpStatus ?? null, message: err.message, configRequired });
    return { metal, ok: false, error: err.message, config_required: configRequired || [] };
  }
}

/** Refresh gold+silver once. A Postgres advisory lock stops multiple instances polling the provider at the same time. */
export function refreshAll() {
  if (inflight) return inflight;
  inflight = (async () => {
    const lockClient = await pool.connect();
    try {
      const got = (await lockClient.query('SELECT pg_try_advisory_lock($1) AS got', [LOCK_KEY])).rows[0].got;
      if (!got) return { skipped: true, reason: 'another instance is refreshing' };
      // Sequential, not parallel: keeps us inside provider rate limits.
      const gold = await refreshMetal('gold');
      const silver = await refreshMetal('silver');
      return { skipped: false, gold, silver };
    } finally {
      await lockClient.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
      lockClient.release();
      inflight = null;
    }
  })();
  return inflight;
}

export function startPoller() {
  if (!env.METALS_POLLER_ENABLED || timer) return;
  const ms = env.METALS_POLL_INTERVAL_SECONDS * 1000;
  logger.info({ intervalSeconds: env.METALS_POLL_INTERVAL_SECONDS }, 'metals poller started');
  refreshAll().catch((e) => logger.error({ err: e }, 'initial refresh failed'));
  timer = setInterval(() => refreshAll().catch((e) => logger.error({ err: e }, 'refresh failed')), ms);
  timer.unref();
}
export function stopPoller() { clearInterval(timer); timer = null; }

/** Latest stored price rows for a metal (one per purity). */
export async function latestPrices(metal) {
  const { rows } = await query(
    `SELECT DISTINCT ON (purity_code) id, metal, purity_code, price, currency, unit, source, is_derived, derived_from, provider_timestamp, fetched_at
       FROM metal_prices WHERE metal = $1 AND currency = $2
      ORDER BY purity_code, fetched_at DESC, id DESC`,
    [metal, env.METALS_CURRENCY],
  );
  return rows;
}

/** Status of a metal's feed: whether the latest attempt succeeded, and whether stored data is fresh enough to call "live". */
export async function metalStatus(metal) {
  const [{ rows: ev }, prices] = await Promise.all([
    query(`SELECT ok, message, http_status, config_required, created_at FROM api_events WHERE service = $1 ORDER BY created_at DESC, id DESC LIMIT 1`, [metal]),
    latestPrices(metal),
  ]);
  const last = ev[0] || null;
  const lastFetched = prices.reduce((m, r) => (!m || r.fetched_at > m ? r.fetched_at : m), null);
  const missing = provider.requiredConfig();
  const staleMs = 3 * env.METALS_POLL_INTERVAL_SECONDS * 1000;
  const fresh = !!lastFetched && Date.now() - new Date(lastFetched).getTime() <= staleMs;
  const connected = !missing.length && !!last?.ok && fresh;
  return {
    connected,
    live: connected,
    config_required: missing,
    last_attempt: last && { ok: last.ok, at: last.created_at, message: last.message, http_status: last.http_status },
    last_successful_update: lastFetched,
    message: connected ? 'Live' : missing.length ? `Live update unavailable — missing configuration: ${missing.join(', ')}` : 'Live update unavailable',
    has_data: prices.length > 0,
  };
}

/**
 * Called on reads. If the background poller isn't running (e.g. serverless), refresh when data is older than the interval.
 * Failures are swallowed here; they are recorded and surfaced through metalStatus().
 */
export async function ensureFresh() {
  if (env.METALS_POLLER_ENABLED || !env.METALS_LAZY_REFRESH) return;
  const { rows } = await query(`SELECT max(fetched_at) AS t FROM metal_prices`);
  const t = rows[0].t;
  if (!t || Date.now() - new Date(t).getTime() > env.METALS_POLL_INTERVAL_SECONDS * 1000) {
    await refreshAll().catch(() => {});
  }
}

export async function priceHistory({ metal, purity, limit = 200, from }) {
  const { rows } = await query(
    `SELECT id, purity_code, price, currency, unit, source, is_derived, provider_timestamp, fetched_at
       FROM metal_prices WHERE metal = $1 AND ($2::text IS NULL OR purity_code = $2) AND ($3::timestamptz IS NULL OR fetched_at >= $3)
      ORDER BY fetched_at DESC LIMIT $4`,
    [metal, purity || null, from || null, limit],
  );
  return rows;
}
