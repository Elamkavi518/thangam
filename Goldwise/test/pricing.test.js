import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.DATABASE_URL ||= 'postgres://x:x@127.0.0.1:5432/x';
process.env.JWT_SECRET ||= 'x'.repeat(40);
const { calculate, unitPrices } = await import('../src/services/pricing.js');

test('gold unit prices derive exactly from per-gram', () => {
  assert.deepEqual(unitPrices('gold', 10000), { per_gram: 10000, per_8_gram: 80000, per_10_gram: 100000 });
});
test('silver unit prices', () => {
  assert.deepEqual(unitPrices('silver', 100), { per_gram: 100, per_10_gram: 1000, per_100_gram: 10000, per_kilogram: 100000 });
});
test('calculate: metal + wastage + making + tax', () => {
  const c = calculate({ pricePerGram: 10000, netWeight: 10, wastagePercent: 8, makingType: 'percent_of_metal', makingValue: 12,
    taxes: [{ name: 'GST', rate_percent: 3, applies_to: 'all' }] });
  assert.equal(c.metal_value, 100000);
  assert.equal(c.wastage_weight_g, 0.8);
  assert.equal(c.wastage_value, 8000);
  assert.equal(c.making_charge.amount, 12000);
  assert.equal(c.subtotal, 120000);
  assert.equal(c.tax_total, 3600);
  assert.equal(c.estimated_final_price, 123600);
});
test('calculate: per-gram making, fixed making, tax bases', () => {
  const a = calculate({ pricePerGram: 100, netWeight: 5, wastagePercent: 10, makingType: 'per_gram', makingValue: 20,
    taxes: [{ name: 'M', rate_percent: 5, applies_to: 'making_only' }, { name: 'MW', rate_percent: 3, applies_to: 'metal_and_wastage' }] });
  assert.equal(a.making_charge.amount, 100);
  assert.equal(a.tax_total, 5 + 16.5);
  const f = calculate({ pricePerGram: 100, netWeight: 5, wastagePercent: 0, makingType: 'fixed', makingValue: 250 });
  assert.equal(f.estimated_final_price, 500 + 250);
});
test('missing wastage withholds the final price instead of guessing', () => {
  const c = calculate({ pricePerGram: 100, netWeight: 5, wastagePercent: null, makingType: 'fixed', makingValue: 10 });
  assert.equal(c.estimated_final_price, null);
  assert.equal(c.complete, false);
});
