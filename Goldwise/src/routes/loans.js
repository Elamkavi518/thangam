import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { validate } from '../middleware/validate.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncHandler, notFound, badRequest } from '../utils/errors.js';
import { requirePrice } from '../services/pricing.js';
import { ensureFresh } from '../services/metals/metalsService.js';
import { audit } from '../services/access.js';

const r = Router();
const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Standard EMI: P*r*(1+r)^n / ((1+r)^n - 1), r = monthly rate. */
export function emi(principal, annualPercent, months) {
  const m = annualPercent / 12 / 100;
  if (m === 0) return r2(principal / months);
  const f = (1 + m) ** months;
  return r2((principal * m * f) / (f - 1));
}

export function evaluate(p, { goldValue, purity, tenure }) {
  const notes = [];
  if (!p.accepted_purities.includes(purity)) return { eligible: false, reason: `Does not accept ${purity} gold` };
  let loan = r2((goldValue * p.ltv_percent) / 100);
  if (p.max_loan_amount != null && loan > p.max_loan_amount) { loan = p.max_loan_amount; notes.push('capped_at_max_loan'); }
  if (p.min_loan_amount != null && loan < p.min_loan_amount) return { eligible: false, reason: `Eligible amount is below this lender's minimum of ${p.min_loan_amount}` };
  if ((p.min_tenure_months != null && tenure < p.min_tenure_months) || (p.max_tenure_months != null && tenure > p.max_tenure_months)) {
    return { eligible: false, reason: `Tenure must be ${p.min_tenure_months ?? 1}–${p.max_tenure_months ?? '∞'} months` };
  }
  const fee = r2((loan * p.processing_fee_percent) / 100);
  const monthly = emi(loan, p.interest_rate_percent, tenure);
  const totalInterest = r2(monthly * tenure - loan);
  return {
    eligible: true, loan_amount: loan, processing_fee: fee, emi: monthly, total_interest: totalInterest,
    total_cost: r2(totalInterest + fee), total_repayment: r2(monthly * tenure + fee), notes,
  };
}

// Compare lenders for the customer's gold, using the latest stored live gold price
r.get('/compare', requireAuth, validate({
  query: z.object({ weight_g: z.coerce.number().positive().max(100000), purity: z.enum(['24K', '22K', '18K']), tenure_months: z.coerce.number().int().min(1).max(120).default(12) }),
}), asyncHandler(async (req, res) => {
  const { weight_g, purity, tenure_months } = req.query;
  await ensureFresh();
  const { row, stale } = await requirePrice('gold', purity);
  const goldValue = r2(weight_g * row.price);
  const { rows } = await query('SELECT * FROM loan_providers WHERE is_active ORDER BY name');
  const results = rows.map((p) => ({
    provider: { id: p.id, name: p.name, type: p.provider_type, interest_rate_percent: p.interest_rate_percent, ltv_percent: p.ltv_percent, processing_fee_percent: p.processing_fee_percent, source_url: p.source_url, source_checked_at: p.source_checked_at },
    ...evaluate(p, { goldValue, purity, tenure: tenure_months }),
  }));
  const ok = results.filter((x) => x.eligible).sort((a, b) => a.total_cost - b.total_cost);
  res.json({
    gold: { weight_g, purity, price_per_gram: r2(row.price), value: goldValue, currency: row.currency, price_fetched_at: row.fetched_at, stale },
    tenure_months,
    offers: ok, not_eligible: results.filter((x) => !x.eligible),
    note: rows.length ? 'Estimates only. Lender terms change; confirm with the lender before applying. Each lender shows where and when its terms were checked.' : 'No lenders have been added by the GoldWise team yet.',
  });
}));

// ---- admin: manage providers ----
const body = z.object({
  name: z.string().trim().min(2).max(100),
  provider_type: z.enum(['bank', 'nbfc', 'cooperative', 'other']),
  interest_rate_percent: z.number().min(0).max(60),
  ltv_percent: z.number().gt(0).max(100),
  processing_fee_percent: z.number().min(0).max(20).default(0),
  min_loan_amount: z.number().positive().nullable().optional(),
  max_loan_amount: z.number().positive().nullable().optional(),
  min_tenure_months: z.number().int().positive().nullable().optional(),
  max_tenure_months: z.number().int().positive().nullable().optional(),
  accepted_purities: z.array(z.enum(['24K', '22K', '18K'])).min(1).default(['22K', '24K', '18K']),
  source_url: z.string().url().max(500),
  source_checked_at: z.string().datetime(),
  is_active: z.boolean().default(true),
});
r.get('/providers', requireAuth, requireRole('admin'), asyncHandler(async (_q, res) => res.json({ providers: (await query('SELECT * FROM loan_providers ORDER BY name')).rows })));
r.post('/providers', requireAuth, requireRole('admin'), validate({ body }), asyncHandler(async (req, res) => {
  const b = req.body;
  const { rows } = await query(
    `INSERT INTO loan_providers (name, provider_type, interest_rate_percent, ltv_percent, processing_fee_percent, min_loan_amount, max_loan_amount, min_tenure_months, max_tenure_months, accepted_purities, source_url, source_checked_at, is_active, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
    [b.name, b.provider_type, b.interest_rate_percent, b.ltv_percent, b.processing_fee_percent, b.min_loan_amount ?? null, b.max_loan_amount ?? null, b.min_tenure_months ?? null, b.max_tenure_months ?? null, b.accepted_purities, b.source_url, b.source_checked_at, b.is_active, req.user.id]);
  await audit(req.user, 'loan.create', 'loan_provider', rows[0].id, b);
  res.status(201).json({ provider: rows[0] });
}));
r.patch('/providers/:id', requireAuth, requireRole('admin'), validate({ params: z.object({ id: z.coerce.number().int() }), body: body.partial() }), asyncHandler(async (req, res) => {
  const cur = (await query('SELECT * FROM loan_providers WHERE id = $1', [req.params.id])).rows[0];
  if (!cur) throw notFound('Provider not found');
  const m = { ...cur, ...req.body };
  if (req.body.interest_rate_percent !== undefined || req.body.ltv_percent !== undefined) {
    if (!req.body.source_checked_at) throw badRequest('Changing rates needs a new source_checked_at date');
  }
  const { rows } = await query(
    `UPDATE loan_providers SET name=$2, provider_type=$3, interest_rate_percent=$4, ltv_percent=$5, processing_fee_percent=$6, min_loan_amount=$7, max_loan_amount=$8, min_tenure_months=$9, max_tenure_months=$10,
       accepted_purities=$11, source_url=$12, source_checked_at=$13, is_active=$14, updated_by=$15, updated_at=now() WHERE id=$1 RETURNING *`,
    [cur.id, m.name, m.provider_type, m.interest_rate_percent, m.ltv_percent, m.processing_fee_percent, m.min_loan_amount, m.max_loan_amount, m.min_tenure_months, m.max_tenure_months, m.accepted_purities, m.source_url, m.source_checked_at, m.is_active, req.user.id]);
  await audit(req.user, 'loan.update', 'loan_provider', cur.id, req.body);
  res.json({ provider: rows[0] });
}));
export default r;
