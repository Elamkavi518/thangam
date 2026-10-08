import { h, api, money, when, toast, errBox, actionBtn, main } from './core.js';
const ab = (label, fn, cls = '') => actionBtn(label, fn, cls, () => viewAdmin());
// ---------- Store panel ----------
export async function viewStorePanel() {
  const { stores } = await api('/api/stores/mine');
  const types = (await api('/api/jewelry/types')).types;
  const taxes = (await api('/api/jewelry/taxes')).taxes;
  const form = (fields, onSubmit, label) => {
    const f = h('form', { class: 'row', onsubmit: async (e) => { e.preventDefault(); try { await onSubmit(Object.fromEntries(new FormData(f))); toast('Saved'); viewStorePanel(); } catch (er) { toast(er.message); } } },
      fields.map(([name, text, attrs]) => h('label', {}, text, attrs?.options ? h('select', { name }, attrs.options.map(([v, l]) => h('option', { value: v }, l))) : h('input', { name, ...attrs }))), h('button', { class: 'btn', type: 'submit' }, label));
    return f;
  };
  const num = (v) => (v === '' || v == null ? undefined : +v);
  const parts = [h('h1', {}, 'My store'), h('p', { class: 'sub' }, 'Your products appear publicly after GoldWise verifies your business. Wastage you enter is shown to customers with its update time. You cannot change the market gold/silver price.')];
  parts.push(h('details', { class: 'panel', open: stores.length === 0 }, h('summary', {}, 'Register a store'), form([
    ['name', 'Store name', { required: true }], ['address', 'Address', { required: true }], ['latitude', 'Latitude', { type: 'number', step: 'any', required: true }], ['longitude', 'Longitude', { type: 'number', step: 'any', required: true }],
    ['phone', 'Phone'], ['website', 'Website (https://…)', { type: 'url' }], ['google_place_id', 'Google Place ID (optional)'], ['business_registration', 'GSTIN / licence number'],
  ], (f) => api('/api/stores', { method: 'POST', body: Object.fromEntries(Object.entries({ ...f, latitude: +f.latitude, longitude: +f.longitude }).filter(([, v]) => v !== '')) }), 'Register store')));
  for (const s of stores) {
    const { designs } = await api(`/api/stores/${s.id}/designs`);
    parts.push(h('section', { class: 'panel' }, h('h2', {}, s.name), h('span', { class: `badge ${s.verification_status === 'verified' ? 'ok' : 'warn'}` }, s.verification_status),
      s.verification_status !== 'verified' && s.verification_status !== 'pending' && h('button', { class: 'btn small', onclick: async () => { try { await api(`/api/stores/${s.id}/request-verification`, { method: 'POST' }); toast('Verification requested'); viewStorePanel(); } catch (e) { toast(e.message); } } }, 'Request verification'),
      h('h3', {}, 'Categories you sell'),
      h('form', { class: 'row', onsubmit: async (e) => { e.preventDefault(); const cats = [...e.target.querySelectorAll('input:checked')].map((i) => i.value); try { await api(`/api/stores/${s.id}/categories`, { method: 'PUT', body: { categories: cats } }); toast('Saved'); } catch (er) { toast(er.message); } } },
        types.map((t) => h('label', { style: 'flex-direction:row;gap:6px' }, h('input', { type: 'checkbox', value: t.slug }), t.name)), h('button', { class: 'btn small', type: 'submit' }, 'Save categories')),
      h('h3', {}, 'Designs and wastage'),
      h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Type / design'), h('th', {}, 'Wastage %'), h('th', {}, 'Updated'), h('th', {}, ''))),
        h('tbody', {}, designs.map((d) => { const inp = h('input', { type: 'number', step: '0.01', min: '0', max: '100', value: d.wastage_percent ?? '', style: 'width:90px' });
          return h('tr', {}, h('td', {}, `${d.jewelry_type_name} → ${d.name}`), h('td', {}, inp), h('td', { class: 'meta' }, d.wastage_updated_at ? when(d.wastage_updated_at) : 'not set'),
            h('td', {}, h('button', { class: 'btn small', onclick: async () => { try { await api(`/api/stores/${s.id}/designs/${d.id}/wastage`, { method: 'PUT', body: { wastage_percent: +inp.value } }); toast('Wastage saved'); viewStorePanel(); } catch (e) { toast(e.message); } } }, 'Save'))); }))),
      form([['jewelry_type', 'Type', { options: types.map((t) => [t.slug, t.name]) }], ['name', 'Design name', { required: true }], ['wastage_percent', 'Wastage % (optional)', { type: 'number', step: '0.01', min: '0', max: '100' }]],
        (f) => api(`/api/stores/${s.id}/designs`, { method: 'POST', body: { jewelry_type: f.jewelry_type, name: f.name, wastage_percent: num(f.wastage_percent) } }), 'Add design'),
      h('h3', {}, 'Submit your metal rate for review'),
      form([['metal', 'Metal', { options: [['gold', 'Gold'], ['silver', 'Silver']] }], ['purity', 'Purity (24K/22K/18K or 999/925)', { required: true }], ['price_per_gram', 'Price per gram', { type: 'number', step: '0.01', min: '0.01', required: true }]],
        (f) => api(`/api/stores/${s.id}/price-submissions`, { method: 'POST', body: { metal: f.metal, purity: f.purity, price_per_gram: +f.price_per_gram } }), 'Submit for approval'),
      h('h3', {}, 'Add a product'),
      form([['jewelry_type', 'Type', { options: types.map((t) => [t.slug, t.name]) }], ['name', 'Product name', { required: true }], ['design_id', 'Design', { options: [['', 'No design'], ...designs.map((d) => [d.id, `${d.jewelry_type_name} → ${d.name}`])] }],
        ['metal', 'Metal', { options: [['gold', 'Gold'], ['silver', 'Silver']] }], ['purity', 'Purity', { required: true }], ['gross_weight_g', 'Gross weight (g)', { type: 'number', step: '0.001', required: true }], ['net_weight_g', 'Net metal weight (g)', { type: 'number', step: '0.001', required: true }],
        ['making_charge_type', 'Making charge type', { options: [['percent_of_metal', '% of metal'], ['per_gram', 'Per gram'], ['fixed', 'Fixed']] }], ['making_charge_value', 'Making charge value', { type: 'number', step: '0.01', min: '0', required: true }],
        ['hallmark_standard', 'Hallmark standard'], ['hallmark_huid', 'HUID'], ['stock_quantity', 'Stock quantity', { type: 'number', min: '0', value: '1' }], ['image', 'Image URL (https)', { type: 'url' }],
        ...(taxes.length ? [['tax_rule_id', 'Tax', { options: [['', 'None'], ...taxes.map((t) => [t.id, `${t.name} ${t.rate_percent}%`])] }]] : [])],
      (f) => api('/api/products', { method: 'POST', body: { store_id: s.id, jewelry_type: f.jewelry_type, name: f.name, design_id: f.design_id || undefined, metal: f.metal, purity: f.purity, gross_weight_g: +f.gross_weight_g, net_weight_g: +f.net_weight_g,
        making_charge_type: f.making_charge_type, making_charge_value: +f.making_charge_value, hallmark_standard: f.hallmark_standard || undefined, hallmark_huid: f.hallmark_huid || undefined, stock_quantity: +f.stock_quantity, images: f.image ? [f.image] : [], tax_rule_ids: f.tax_rule_id ? [+f.tax_rule_id] : [] } }), 'Add product')));
  }
  main.replaceChildren(...parts);
}

// ---------- Admin ----------
export async function viewAdmin() {
  const tabs = { Status: adminStatus, 'Store verification': adminStores, 'Store prices': adminPrices, 'Gold loans': adminLoans, 'Team inbox': adminInbox, Feedback: adminFeedback, 'API errors': adminErrors, Users: adminUsers, Taxes: adminTaxes };
  const body = h('div');
  const bar = h('div', { class: 'tabs', role: 'tablist' });
  const show = async (name) => {
    bar.querySelectorAll('button').forEach((b) => b.setAttribute('aria-selected', b.textContent === name));
    body.replaceChildren(h('p', { class: 'meta' }, 'Loading…'));
    try { body.replaceChildren(await tabs[name]()); } catch (e) { body.replaceChildren(errBox(e)); }
  };
  for (const n of Object.keys(tabs)) bar.append(h('button', { role: 'tab', onclick: () => show(n) }, n));
  main.replaceChildren(h('h1', {}, 'Admin'), bar, body);
  await show('Status');
}
async function adminStatus() {
  const s = await api('/api/admin/status?probe=true');
  const row = (label, o, extra) => h('tr', {}, h('th', { scope: 'row' }, label), h('td', {}, o.status), h('td', { style: 'text-align:left' }, [o.message, o.config_required?.length ? `Required configuration: ${o.config_required.join(', ')}` : '', extra].filter(Boolean).join(' · ')));
  return h('div', {}, h('div', { class: 'panel' }, h('table', {}, h('tbody', {},
    row('Gold API', s.gold_api), row('Silver API', s.silver_api), row('Database', s.database, s.database.latency_ms != null ? `${s.database.latency_ms} ms` : ''), row('Store API', s.store_api),
    h('tr', {}, h('th', { scope: 'row' }, 'Last Gold Update'), h('td', { colspan: 2, style: 'text-align:left' }, when(s.last_gold_update))),
    h('tr', {}, h('th', { scope: 'row' }, 'Last Silver Update'), h('td', { colspan: 2, style: 'text-align:left' }, when(s.last_silver_update))))),
    h('p', { class: 'meta' }, `Provider polling every ${s.poll_interval_seconds} s · checked ${when(s.checked_at)}`)),
    h('button', { class: 'btn', onclick: async () => { try { await api('/api/admin/metals/refresh', { method: 'POST' }); toast('Fetched from provider'); } catch (e) { toast(e.message); } viewAdmin(); } }, 'Fetch prices from provider now'));
}
async function adminStores() {
  const { stores } = await api('/api/admin/stores');
  return h('div', { class: 'panel' }, h('table', {}, h('thead', {}, h('tr', {}, ['Store', 'Owner', 'Registration', 'Status', ''].map((t) => h('th', {}, t)))),
    h('tbody', {}, stores.map((s) => h('tr', {}, h('td', {}, s.name), h('td', {}, s.owner_email), h('td', {}, s.business_registration || '—'), h('td', {}, s.verification_status),
      h('td', {}, ab('Verify', () => api(`/api/admin/stores/${s.id}/verify`, { method: 'POST', body: { status: 'verified' } })), ' ', ab('Reject', () => api(`/api/admin/stores/${s.id}/verify`, { method: 'POST', body: { status: 'rejected' } }), 'danger')))))));
}
async function adminPrices() {
  const { submissions } = await api('/api/admin/price-submissions?status=pending');
  return h('div', { class: 'panel' }, submissions.length ? h('table', {}, h('tbody', {}, submissions.map((p) => h('tr', {}, h('td', {}, p.store_name), h('td', {}, `${p.metal} ${p.purity_code}`), h('td', {}, money(p.price_per_gram, p.currency)), h('td', {}, when(p.submitted_at)),
    h('td', {}, ab('Approve', () => api(`/api/admin/price-submissions/${p.id}/review`, { method: 'POST', body: { decision: 'approved' } })), ' ', ab('Reject', () => api(`/api/admin/price-submissions/${p.id}/review`, { method: 'POST', body: { decision: 'rejected' } }), 'danger')))))) : h('p', {}, 'No store prices waiting for review.'));
}
async function adminErrors() {
  const { errors } = await api('/api/admin/api-errors');
  return h('div', { class: 'panel' }, errors.length ? h('table', {}, h('thead', {}, h('tr', {}, ['When', 'Service', 'HTTP', 'Message'].map((t) => h('th', {}, t)))), h('tbody', {}, errors.map((e) => h('tr', {}, h('td', {}, when(e.created_at)), h('td', {}, e.service), h('td', {}, e.http_status ?? '—'), h('td', { style: 'text-align:left' }, e.message))))) : h('p', {}, 'No API errors recorded.'));
}
async function adminUsers() {
  const { users } = await api('/api/admin/users');
  return h('div', { class: 'panel' }, h('table', {}, h('thead', {}, h('tr', {}, ['Name', 'Email', 'Role', 'Active', ''].map((t) => h('th', {}, t)))), h('tbody', {}, users.map((u) => {
    const sel = h('select', {}, ['customer', 'store', 'admin'].map((r) => h('option', { value: r, selected: r === u.role }, r)));
    return h('tr', {}, h('td', {}, u.name), h('td', {}, u.email), h('td', {}, sel), h('td', {}, u.is_active ? 'yes' : 'no'),
      h('td', {}, ab('Set role', () => api(`/api/admin/users/${u.id}`, { method: 'PATCH', body: { role: sel.value } })), ' ', ab(u.is_active ? 'Disable' : 'Enable', () => api(`/api/admin/users/${u.id}`, { method: 'PATCH', body: { is_active: !u.is_active } }), 'alt')));
  }))));
}
async function adminTaxes() {
  const { taxes } = await api('/api/admin/tax-rules');
  const f = h('form', { class: 'row', onsubmit: async (e) => { e.preventDefault(); const x = Object.fromEntries(new FormData(f)); try { await api('/api/admin/tax-rules', { method: 'POST', body: { name: x.name, rate_percent: +x.rate_percent, applies_to: x.applies_to } }); toast('Added'); viewAdmin(); } catch (er) { toast(er.message); } } },
    h('label', {}, 'Name', h('input', { name: 'name', required: true })), h('label', {}, 'Rate %', h('input', { name: 'rate_percent', type: 'number', step: '0.001', min: '0', max: '100', required: true })),
    h('label', {}, 'Applies to', h('select', { name: 'applies_to' }, [['all', 'Whole subtotal'], ['metal_and_wastage', 'Metal + wastage'], ['making_only', 'Making charge only']].map(([v, l]) => h('option', { value: v }, l)))), h('button', { class: 'btn', type: 'submit' }, 'Add tax rule'));
  return h('div', { class: 'panel' }, h('p', { class: 'meta' }, 'Taxes are defined by you; nothing is pre-filled. Confirm applicable rates with your accountant.'), taxes.length ? h('ul', {}, taxes.map((t) => h('li', {}, `${t.name}: ${t.rate_percent}% on ${t.applies_to.replace(/_/g, ' ')}${t.is_active ? '' : ' (inactive)'}`))) : h('p', {}, 'No tax rules yet.'), f);
}



// ---- gold-loan lenders: every entry needs a source link and the date it was checked ----
async function adminLoans() {
  const { providers } = await api('/api/loans/providers');
  const f = h('form', { class: 'row', onsubmit: async (e) => {
    e.preventDefault(); const x = Object.fromEntries(new FormData(f)); const n = (v) => (v === '' ? undefined : +v);
    try {
      await api('/api/loans/providers', { method: 'POST', body: { name: x.name, provider_type: x.provider_type, interest_rate_percent: +x.rate, ltv_percent: +x.ltv, processing_fee_percent: n(x.fee) ?? 0,
        min_loan_amount: n(x.min_amt), max_loan_amount: n(x.max_amt), min_tenure_months: n(x.min_ten), max_tenure_months: n(x.max_ten), source_url: x.source_url, source_checked_at: new Date(x.checked + 'T00:00:00').toISOString() } });
      toast('Lender added'); viewAdmin();
    } catch (er) { toast(er.message); }
  } },
    ...[['name', 'Lender name', { required: true }], ['rate', 'Interest % p.a.', { type: 'number', step: '0.01', required: true }], ['ltv', 'Loan-to-value %', { type: 'number', step: '0.01', required: true }], ['fee', 'Processing fee %', { type: 'number', step: '0.01' }],
      ['min_amt', 'Min loan', { type: 'number' }], ['max_amt', 'Max loan', { type: 'number' }], ['min_ten', 'Min months', { type: 'number' }], ['max_ten', 'Max months', { type: 'number' }],
      ['source_url', 'Source page (https://…)', { type: 'url', required: true }], ['checked', 'Terms checked on', { type: 'date', required: true }]].map(([n, l, a]) => h('label', {}, l, h('input', { name: n, ...a }))),
    h('label', {}, 'Type', h('select', { name: 'provider_type' }, ['bank', 'nbfc', 'cooperative', 'other'].map((v) => h('option', { value: v }, v)))), h('button', { class: 'btn', type: 'submit' }, 'Add lender'));
  return h('div', { class: 'panel' }, h('p', { class: 'meta' }, 'Enter only terms you have read from the lender’s own page. Nothing is pre-filled. Customers see the source link and the date you checked.'),
    providers.length ? h('table', {}, h('thead', {}, h('tr', {}, ['Lender', 'Rate', 'LTV', 'Checked', 'Active', ''].map((t) => h('th', {}, t)))), h('tbody', {}, providers.map((p) => h('tr', {}, h('td', {}, p.name), h('td', {}, `${p.interest_rate_percent}%`), h('td', {}, `${p.ltv_percent}%`), h('td', {}, when(p.source_checked_at)), h('td', {}, p.is_active ? 'yes' : 'no'),
      h('td', {}, ab(p.is_active ? 'Disable' : 'Enable', () => api(`/api/loans/providers/${p.id}`, { method: 'PATCH', body: { is_active: !p.is_active } }), 'alt')))))) : h('p', {}, 'No lenders yet.'), f);
}
// ---- team inbox: reply to customers ----
async function adminInbox() {
  const { threads } = await api('/api/support/threads');
  const pane = h('div');
  const open = async (id) => {
    const draw = async () => {
      const d = await api(`/api/support/threads/${id}`);
      const input = h('input', { placeholder: 'Reply…', style: 'flex:1' });
      pane.replaceChildren(h('h3', {}, `${d.thread.subject} — ${d.thread.customer_name}`), h('div', { class: 'chat' }, d.messages.map((m) => h('div', { class: `bubble ${m.sender_role === 'admin' ? 'mine' : ''}` }, h('div', { class: 'meta' }, `${m.sender_name} · ${when(m.created_at)}`), m.body))),
        d.thread.status === 'open' ? h('form', { class: 'row', onsubmit: async (e) => { e.preventDefault(); try { await api(`/api/support/threads/${id}/messages`, { method: 'POST', body: { message: input.value } }); draw(); } catch (er) { toast(er.message); } } }, input, h('button', { class: 'btn small', type: 'submit' }, 'Send'),
          h('button', { class: 'btn small alt', type: 'button', onclick: async () => { await api(`/api/support/threads/${id}`, { method: 'PATCH', body: { status: 'closed' } }); viewAdmin(); } }, 'Close')) : h('p', { class: 'meta' }, 'Closed'));
    };
    draw();
  };
  return h('div', { class: 'panel' }, threads.length ? h('table', {}, h('tbody', {}, threads.map((t) => h('tr', {}, h('td', {}, t.customer_name), h('td', {}, t.subject), h('td', {}, t.status + (t.last_sender_role === 'customer' && t.status === 'open' ? ' · awaiting reply' : '')), h('td', {}, when(t.last_message_at)), h('td', {}, h('button', { class: 'btn small', onclick: () => open(t.id) }, 'Open')))))) : h('p', {}, 'No conversations yet.'), pane);
}
async function adminFeedback() {
  const d = await api('/api/feedback');
  return h('div', { class: 'panel' }, h('p', {}, d.count ? `${d.count} responses · average ${d.average_rating} / 5` : 'No feedback yet.'),
    d.feedback.length ? h('table', {}, h('tbody', {}, d.feedback.map((f) => h('tr', {}, h('td', {}, '★'.repeat(f.rating)), h('td', {}, f.topic), h('td', { style: 'text-align:left' }, f.message), h('td', {}, f.user_name), h('td', {}, when(f.created_at)))))) : '');
}
