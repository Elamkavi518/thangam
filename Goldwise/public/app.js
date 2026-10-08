import { h, api, money, when, toast, errBox, state, main, $ } from './core.js';
import { t, LANGS, getLang, setLang, catName } from './i18n.js';
import { viewStorePanel, viewAdmin } from './staff.js';

const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let timer = null;
let current = 'rates';
const cart = { items: JSON.parse(localStorage.getItem('gw_cart') || '[]'), save() { localStorage.setItem('gw_cart', JSON.stringify(this.items)); } };

// ---------- scroll reveal ----------
const io = 'IntersectionObserver' in window ? new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { threshold: 0.08 }) : null;
const reveal = () => document.querySelectorAll('.reveal:not(.in)').forEach((el) => (io && !reduced ? io.observe(el) : el.classList.add('in')));

// ---------- views registry ----------
const customerViews = { rates: viewRates, calc: viewCalc, products: viewProducts, stores: viewStores, loans: viewLoans, team: viewTeam, feedback: viewFeedback, orders: viewOrders };
const staffViews = { 'store-panel': viewStorePanel, admin: viewAdmin };

async function go(view) {
  clearInterval(timer);
  if (!state.user) return renderWall();
  current = view; location.hash = view;
  drawNav();
  if (main.firstChild && !reduced) { main.classList.add('turn-out'); await sleep(200); }
  main.replaceChildren(h('p', { class: 'meta' }, t('loading')));
  main.classList.remove('turn-out');
  try { await (customerViews[view] || staffViews[view] || viewRates)(); } catch (e) { main.replaceChildren(errBox(e)); }
  if (!reduced) { main.classList.add('turn-in'); setTimeout(() => main.classList.remove('turn-in'), 450); }
  reveal(); main.focus({ preventScroll: true });
}

function drawNav() {
  const items = Object.keys(customerViews).map((v) => [v, { rates: 'rates', calc: 'calc', products: 'jewellery', stores: 'stores', loans: 'loans', team: 'team', feedback: 'feedback', orders: 'orders' }[v]]);
  if (['store', 'admin'].includes(state.user?.role)) items.push(['store-panel', 'store_panel']);
  if (state.user?.role === 'admin') items.push(['admin', 'admin']);
  $('#nav').replaceChildren(...items.map(([v, k]) => h('button', { 'aria-current': v === current ? 'page' : null, onclick: () => go(v) }, t(k) + (v === 'orders' && cart.items.length ? ` (${cart.items.length})` : ''))));
}

function drawAccount() {
  const sel = h('select', { 'aria-label': t('language'), onchange: async (e) => {
    setLang(e.target.value);
    if (state.user) api('/api/auth/me', { method: 'PATCH', body: { language: e.target.value } }).catch(() => {});
    drawAccount(); state.user ? go(current) : renderWall();
  } }, Object.entries(LANGS).map(([k, v]) => h('option', { value: k, selected: k === getLang() }, v)));
  $('#account').replaceChildren(sel, state.user ? [h('span', { class: 'who' }, state.user.name), h('button', { onclick: signOut }, t('sign_out'))] : h('button', { onclick: openAuth }, t('sign_in')));
}
function signOut() { state.token = null; state.user = null; localStorage.removeItem('gw_token'); drawAccount(); $('#nav').replaceChildren(); renderWall(); }

// ---------- mandatory login wall ----------
function renderWall() {
  main.replaceChildren(h('section', { class: 'panel wall reveal' }, h('h1', {}, 'GoldWise'), h('p', { class: 'sub' }, t('login_note')), h('button', { class: 'btn', onclick: openAuth }, t('sign_in'))));
  reveal(); openAuth();
}
function openAuth() {
  const d = $('#auth-dialog'); if (d.open) return;
  let mode = 'login';
  const draw = () => {
    const err = h('div');
    d.replaceChildren(h('form', { method: 'dialog', onsubmit: async (e) => {
      e.preventDefault(); const f = Object.fromEntries(new FormData(e.target));
      try {
        const r = await api(`/api/auth/${mode}`, { method: 'POST', body: mode === 'login' ? { email: f.email, password: f.password } : { email: f.email, password: f.password, name: f.name, account_type: f.account_type } });
        state.token = r.token; state.user = r.user; localStorage.setItem('gw_token', r.token);
        if (r.user.language && r.user.language !== getLang() && !localStorage.getItem('gw_lang')) setLang(r.user.language);
        d.close(); drawAccount(); go(location.hash.slice(1) || 'rates');
      } catch (er) { err.replaceChildren(errBox(er)); }
    } },
      h('h2', {}, mode === 'login' ? t('sign_in') : t('create_account')),
      mode === 'register' && h('label', {}, t('name'), h('input', { name: 'name', required: true, maxlength: 100 })),
      h('label', {}, t('email'), h('input', { name: 'email', type: 'email', required: true, autocomplete: 'email' })),
      h('label', {}, t('password'), h('input', { name: 'password', type: 'password', required: true, minlength: mode === 'register' ? 10 : 1, autocomplete: mode === 'login' ? 'current-password' : 'new-password' })),
      mode === 'register' && h('label', {}, t('i_am'), h('select', { name: 'account_type' }, h('option', { value: 'customer' }, t('customer')), h('option', { value: 'store' }, t('store_owner')))),
      err, h('button', { class: 'btn', type: 'submit' }, mode === 'login' ? t('sign_in') : t('create_account')),
      h('button', { class: 'btn alt', type: 'button', onclick: () => { mode = mode === 'login' ? 'register' : 'login'; draw(); } }, mode === 'login' ? t('create_account') : t('have_account'))));
  };
  draw(); d.showModal();
}

// ---------- Rates ----------
function ratesTable(snap, cols) {
  return h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, t('purity')), cols.map(([, l]) => h('th', {}, t(l))))),
    h('tbody', {}, snap.purities.map((p) => h('tr', {}, h('th', { scope: 'row' }, p.purity + (p.is_derived ? ' *' : '')), cols.map(([k]) => h('td', { class: 'price' }, money(p[k], snap.currency)))))));
}
function metalPanel(title, snap, cols) {
  const bad = !snap.live;
  return h('section', { class: 'panel reveal' },
    h('div', { class: 'row between' }, h('h2', {}, title), h('span', { class: `badge ${bad ? 'bad' : 'ok'}` }, bad ? t('unavailable') : t('live'))),
    bad && h('div', { class: 'alert warn' }, snap.purities.length ? t('last_verified_note') + ' ' : '', snap.status_message, snap.config_required?.length ? ` (${snap.config_required.join(', ')})` : ''),
    snap.purities.length ? ratesTable(snap, cols) : h('p', {}, '—'),
    h('p', { class: 'meta' }, h('strong', {}, t('last_updated') + ': '), when(snap.last_updated), snap.purities[0] ? ` · ${t('source')}: ${snap.purities[0].source}` : '', snap.purities.some((p) => p.is_derived) ? ` · ${t('derived_note')}` : ''));
}
async function viewRates() {
  const draw = async () => {
    const d = await api('/api/metals/latest');
    main.replaceChildren(h('h1', {}, t('rates_title')), h('p', { class: 'sub' }, t('rates_sub')),
      metalPanel(t('gold'), d.gold, [['per_gram', 'per_gram'], ['per_8_gram', 'per_8g'], ['per_10_gram', 'per_10g']]),
      metalPanel(t('silver'), d.silver, [['per_gram', 'per_gram'], ['per_10_gram', 'per_10g'], ['per_100_gram', 'per_100g'], ['per_kilogram', 'per_kg']]));
    reveal();
  };
  await draw();
  timer = setInterval(() => draw().catch(() => {}), 60_000);
}

// ---------- Calculator ----------
function breakdown(c) {
  const cur = c.currency || 'INR';
  return h('dl', { class: 'parts' },
    h('dt', {}, `${t('metal')}: ${c.net_weight_g} g × ${money(c.price_per_gram, cur)}`), h('dd', {}, money(c.metal_value, cur)),
    h('dt', {}, c.wastage_percent == null ? t('wastage') : `${t('wastage')}: ${c.wastage_percent}% = ${c.wastage_weight_g} g`), h('dd', {}, c.wastage_percent == null ? t('not_supplied') : money(c.wastage_value, cur)),
    h('dt', {}, `${t('making')} (${c.making_charge.rate})`), h('dd', {}, money(c.making_charge.amount, cur)),
    h('dt', {}, t('subtotal')), h('dd', {}, money(c.subtotal, cur)),
    c.taxes.map((x) => [h('dt', {}, `${x.name} (${x.rate_percent}%)`), h('dd', {}, money(x.amount, cur))]),
    h('dt', { class: 'total' }, t('final_price')), h('dd', { class: 'total price' }, c.estimated_final_price == null ? t('needs_wastage') : money(c.estimated_final_price, cur)));
}
async function viewCalc() {
  const taxes = (await api('/api/jewelry/taxes')).taxes;
  const out = h('div'); const purity = h('select', { name: 'purity' });
  const fill = (m) => purity.replaceChildren(...(m === 'gold' ? ['24K', '22K', '18K'] : ['999', '925']).map((p) => h('option', { value: p }, p)));
  fill('gold');
  const form = h('form', { class: 'row', onsubmit: async (e) => {
    e.preventDefault(); const f = Object.fromEntries(new FormData(form));
    const body = { metal: f.metal, purity: f.purity, net_weight_g: +f.net_weight_g, making_charge_type: f.making_charge_type, making_charge_value: +f.making_charge_value || 0, tax_rule_ids: [...form.querySelectorAll('input[name=tax]:checked')].map((i) => +i.value) };
    if (f.wastage_percent !== '') body.wastage_percent = +f.wastage_percent;
    try { const c = await api('/api/jewelry/calculate', { method: 'POST', body }); out.replaceChildren(c.stale && h('div', { class: 'alert warn' }, t('unavailable')), h('div', { class: 'panel' }, breakdown(c), h('p', { class: 'meta' }, `${t('source')}: ${c.metal_price.source} · ${when(c.metal_price.fetched_at)}`))); } catch (er) { out.replaceChildren(errBox(er)); }
  } },
    h('label', {}, t('metal'), h('select', { name: 'metal', onchange: (e) => fill(e.target.value) }, h('option', { value: 'gold' }, t('gold')), h('option', { value: 'silver' }, t('silver')))), h('label', {}, t('purity'), purity),
    h('label', {}, t('net_weight'), h('input', { name: 'net_weight_g', type: 'number', step: '0.001', min: '0.001', required: true })),
    h('label', {}, t('wastage_pct'), h('input', { name: 'wastage_percent', type: 'number', step: '0.01', min: '0', max: '100' })),
    h('label', {}, t('making_type'), h('select', { name: 'making_charge_type' }, h('option', { value: 'percent_of_metal' }, t('making_pct')), h('option', { value: 'per_gram' }, t('making_gram')), h('option', { value: 'fixed' }, t('making_fixed')))),
    h('label', {}, t('making_value'), h('input', { name: 'making_charge_value', type: 'number', step: '0.01', min: '0' })),
    taxes.length ? h('fieldset', {}, h('legend', { class: 'meta' }, t('taxes')), taxes.map((x) => h('label', { class: 'inline' }, h('input', { type: 'checkbox', name: 'tax', value: x.id }), `${x.name} ${x.rate_percent}%`))) : h('p', { class: 'meta' }, `${t('taxes')}: ${t('no_taxes')}`),
    h('button', { class: 'btn', type: 'submit' }, t('calculate')));
  main.replaceChildren(h('h1', {}, t('calc_title')), h('p', { class: 'sub' }, t('calc_sub')), h('div', { class: 'panel' }, form), out);
}

// ---------- Jewellery: search + cart ----------
function productCard(p) {
  const pr = p.price; const inCart = cart.items.some((i) => i.id === p.id);
  return h('article', { class: 'card reveal' },
    p.images?.[0] && h('img', { src: p.images[0], alt: p.name, loading: 'lazy', class: 'pimg' }),
    h('h3', {}, p.name), h('div', { class: 'meta' }, `${catName(p.category)} · ${t(p.metal)} ${p.purity} · ${t('net')} ${p.net_weight_g} g (${t('gross')} ${p.gross_weight_g} g)`),
    h('div', { class: 'meta' }, p.store.name, ' ', h('span', { class: `badge ${p.store.verification_status === 'verified' ? 'ok' : 'mute'}` }, p.store.verification_status === 'verified' ? t('verified') : t('not_verified'))),
    h('div', { class: 'price big' }, pr.estimated_final_price == null ? t('price_needs_wastage') : money(pr.estimated_final_price, pr.currency)),
    pr.stale && h('div', { class: 'badge warn' }, t('unavailable')),
    h('div', { class: 'meta' }, p.wastage.percent == null ? t('not_supplied') : t('wastage_store', { p: p.wastage.percent }) + ` · ${when(p.wastage.updated_at)}`),
    h('div', { class: 'meta' }, [p.hallmark.standard, p.hallmark.huid && `HUID ${p.hallmark.huid}`, p.hallmark.certification].filter(Boolean).join(' · ') || t('hallmark_none')),
    h('div', { class: 'meta' }, `${t('stock')}: ${p.stock_status.replace(/_/g, ' ')}`),
    pr.metal_value != null && h('details', {}, h('summary', {}, t('how_calc')), breakdown(pr)),
    p.stock_status !== 'out_of_stock' && pr.complete && h('button', { class: 'btn small', disabled: inCart, onclick: (e) => {
      if (cart.items.length && cart.items[0].store_id !== p.store.id) return toast(t('one_store'));
      cart.items.push({ id: p.id, name: p.name, store_id: p.store.id, store_name: p.store.name, price: pr.estimated_final_price, currency: pr.currency }); cart.save(); e.target.disabled = true; drawNav();
    } }, t('add_to_cart')));
}
async function viewProducts() {
  const types = (await api('/api/jewelry/types')).types;
  const list = h('div', { class: 'grid' }); const f = {};
  const inp = (k, el) => (f[k] = el);
  const run = async () => {
    list.replaceChildren(h('p', { class: 'meta' }, t('loading')));
    const qs = new URLSearchParams({ sort: f.sort.value, in_stock: f.stock.checked });
    for (const [k, el] of [['q', f.q], ['category', f.cat], ['metal', f.metal], ['min_price', f.min], ['max_price', f.max]]) if (el.value.trim()) qs.set(k, el.value.trim());
    try {
      const d = await api(`/api/search/products?${qs}`);
      list.replaceChildren(...(d.products.length ? d.products.map(productCard) : [h('p', {}, f.q.value || f.cat.value || f.metal.value ? t('no_results') : t('no_products'))])); reveal();
    } catch (e) { list.replaceChildren(errBox(e)); }
  };
  main.replaceChildren(h('h1', {}, t('jewellery')),
    h('form', { class: 'panel row', onsubmit: (e) => { e.preventDefault(); run(); } },
      h('label', { class: 'grow' }, t('search'), inp('q', h('input', { type: 'search', placeholder: t('search_ph'), lang: getLang() }))),
      h('label', {}, t('category'), inp('cat', h('select', {}, h('option', { value: '' }, t('all_cats')), types.map((x) => h('option', { value: x.slug }, catName(x)))))),
      h('label', {}, t('metal'), inp('metal', h('select', {}, h('option', { value: '' }, t('any_metal')), h('option', { value: 'gold' }, t('gold')), h('option', { value: 'silver' }, t('silver'))))),
      h('label', {}, t('min_price'), inp('min', h('input', { type: 'number', min: '0', style: 'width:110px' }))), h('label', {}, t('max_price'), inp('max', h('input', { type: 'number', min: '0', style: 'width:110px' }))),
      h('label', {}, t('sort_by'), inp('sort', h('select', {}, [['relevance', 'relevance'], ['price_asc', 'price_low'], ['price_desc', 'price_high'], ['weight_asc', 'weight_low'], ['weight_desc', 'weight_high'], ['newest', 'newest']].map(([v, k]) => h('option', { value: v }, t(k)))))),
      h('label', { class: 'inline' }, inp('stock', h('input', { type: 'checkbox' })), t('in_stock')), h('button', { class: 'btn', type: 'submit' }, t('search'))), list);
  run();
}

// ---------- Orders, cart and payment ----------
let rzp = null;
async function payOnline(order) {
  try {
    const cfg = await api('/api/payments/config');
    if (!cfg.razorpay_enabled) return toast(t('pay_not_set'));
    const o = await api('/api/payments/razorpay/order', { method: 'POST', body: { order_id: order.id } });
    rzp ||= await new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'https://checkout.razorpay.com/v1/checkout.js'; s.onload = () => res(true); s.onerror = () => rej(new Error('Could not load the payment window')); document.head.append(s); });
    new window.Razorpay({ key: o.key_id, amount: o.amount, currency: o.currency, order_id: o.razorpay_order_id, name: 'GoldWise',
      prefill: { name: state.user.name, email: state.user.email },
      handler: async (r) => { try { await api('/api/payments/razorpay/verify', { method: 'POST', body: { order_id: order.id, ...r } }); toast(t('paid')); go('orders'); } catch (e) { toast(e.message); } } }).open();
  } catch (e) { toast(e.message); }
}
async function viewOrders() {
  const mine = (await api('/api/orders/mine')).orders;
  const placeOrder = async () => {
    try { await api('/api/orders', { method: 'POST', body: { items: cart.items.map((i) => ({ product_id: i.id, quantity: 1 })) } }); cart.items = []; cart.save(); toast(t('order_placed')); go('orders'); } catch (e) { toast(e.message); }
  };
  const cartRows = cart.items.map((i, ix) => {
    const del = h('button', { class: 'btn small alt', onclick: () => { cart.items.splice(ix, 1); cart.save(); go('orders'); } }, t('remove'));
    return h('tr', {}, h('td', {}, `${i.name} (${i.store_name})`), h('td', { class: 'price' }, money(i.price, i.currency)), h('td', {}, del));
  });
  const cartTotal = cart.items.reduce((s, i) => s + i.price, 0);
  const cartBox = h('section', { class: 'panel reveal' }, h('h2', {}, t('cart')),
    cart.items.length
      ? h('div', {}, h('table', {}, h('tbody', {}, cartRows)), h('p', {}, h('strong', {}, `${t('total')}: ${money(cartTotal, cart.items[0].currency)}`)), h('button', { class: 'btn', onclick: placeOrder }, t('order_now')))
      : h('p', { class: 'meta' }, t('empty_cart')));
  main.replaceChildren(h('h1', {}, t('orders')), cartBox,
    mine.length ? mine.map((o) => h('section', { class: 'panel reveal' }, h('div', { class: 'row between' }, h('strong', {}, o.store_name), h('span', { class: `badge ${o.payment_status === 'paid' ? 'ok' : 'warn'}` }, o.payment_status === 'paid' ? t('paid') : t('unpaid'))),
      o.items.map((i) => h('div', { class: 'meta' }, `${i.name} × ${i.quantity} — ${money(i.unit_total, o.currency)}`)), h('p', {}, `${t('total')}: `, h('span', { class: 'price' }, money(o.total, o.currency)), ` · ${t('status')}: ${o.status}`),
      o.payment_status !== 'paid' && o.status !== 'cancelled' && h('button', { class: 'btn small', onclick: () => payOnline(o) }, t('pay_online')))) : h('p', { class: 'meta' }, t('no_orders')));
  reveal();
}

// ---------- Stores near me ----------
let here = null;
async function viewStores() {
  const results = h('div'); const status = h('p', { class: 'meta', role: 'status' }, t('loc_hint'));
  const F = { radius: h('select', {}, [5, 10, 25, 50].map((v) => h('option', { value: v, selected: v === 10 }, `${v} km`))), sort: h('select', {}, [['best_match', 'relevance'], ['distance', 'radius'], ['rating', 'rating'], ['verified', 'verified_only']].map(([v, k]) => h('option', { value: v }, t(k)))),
    cat: h('select', {}, h('option', { value: '' }, t('any'))), q: h('input', { type: 'search' }), ver: h('input', { type: 'checkbox' }), open: h('input', { type: 'checkbox' }), stock: h('input', { type: 'checkbox' }),
    rating: h('select', {}, h('option', { value: '' }, t('any')), [3, 4, 4.5].map((v) => h('option', { value: v }, `${v}+`))) };
  api('/api/jewelry/types').then(({ types }) => types.forEach((x) => F.cat.append(h('option', { value: x.slug }, catName(x))))).catch(() => {});
  const search = async () => {
    if (!here) return; results.replaceChildren(h('p', { class: 'meta' }, t('loading')));
    const qs = new URLSearchParams({ lat: here.lat, lng: here.lng, radius_km: F.radius.value, sort: F.sort.value, verified_only: F.ver.checked, open_now: F.open.checked, in_stock: F.stock.checked });
    if (F.cat.value) qs.set('category', F.cat.value); if (F.q.value.trim()) qs.set('q', F.q.value.trim()); if (F.rating.value) qs.set('min_rating', F.rating.value);
    try {
      const d = await api(`/api/search/stores?${qs}`); const g = d.sources.google_places;
      results.replaceChildren(!g.ok && h('div', { class: 'alert warn', role: 'alert' }, `${t('google_down')}: ${g.message}`, g.config_required?.length ? ` (${g.config_required.join(', ')})` : ''),
        d.sponsored.length > 0 && h('section', {}, h('h2', {}, t('sponsored')), h('p', { class: 'meta' }, t('sponsored_note')), h('div', { class: 'grid' }, d.sponsored.map(storeCard))),
        h('h2', {}, `${d.count} · ${t('stores_title')}`), h('p', { class: 'meta' }, d.ranking_note), h('div', { class: 'grid' }, d.stores.map(storeCard))); reveal();
    } catch (e) { results.replaceChildren(errBox(e)); }
  };
  const setHere = async (lat, lng, label) => { here = { lat, lng }; status.textContent = label || '…'; if (!label) api(`/api/location/reverse?lat=${lat}&lng=${lng}`).then(({ location }) => { if (location) status.textContent = location.formatted_address; }).catch(() => {}); await search(); };
  const manual = h('input', { type: 'text', placeholder: t('place_ph'), 'aria-label': t('change_location') });
  const gps = () => {
    if (!navigator.geolocation) return (status.textContent = t('loc_denied'));
    status.textContent = t('loc_wait');
    navigator.geolocation.getCurrentPosition((p) => setHere(p.coords.latitude, p.coords.longitude), () => (status.textContent = t('loc_denied')), { timeout: 15000, maximumAge: 300000 });
  };
  const geocode = async () => { if (manual.value.trim().length < 2) return; try { const { results: rs } = await api(`/api/location/geocode?address=${encodeURIComponent(manual.value.trim())}`); if (rs.length) await setHere(rs[0].latitude, rs[0].longitude, rs[0].formatted_address); else status.textContent = t('no_results'); } catch (e) { status.replaceChildren(errBox(e)); } };
  main.replaceChildren(h('h1', {}, t('stores_title')), h('div', { class: 'panel' }, h('div', { class: 'row' }, h('button', { class: 'btn', onclick: gps }, t('use_location')), h('label', {}, t('change_location'), manual), h('button', { class: 'btn alt', onclick: geocode }, t('search_place'))), status),
    h('div', { class: 'panel row' }, h('label', {}, t('radius'), F.radius), h('label', {}, t('sort_by'), F.sort), h('label', {}, t('category'), F.cat), h('label', {}, t('search'), F.q), h('label', {}, t('min_rating'), F.rating),
      h('label', { class: 'inline' }, F.ver, t('verified_only')), h('label', { class: 'inline' }, F.open, t('open_now')), h('label', { class: 'inline' }, F.stock, t('in_stock')), h('button', { class: 'btn alt', onclick: search }, t('apply'))), results);
}
function storeCard(s) {
  const v = s.verification.status === 'verified';
  return h('article', { class: `card reveal${s.sponsored ? ' sponsored' : ''}` }, s.sponsored && h('span', { class: 'badge warn' }, t('sponsored')), h('h3', {}, s.name),
    h('span', { class: `badge ${v ? 'ok' : 'mute'}`, title: s.verification.note }, v ? t('verified') : t('not_verified')), h('div', {}, s.address), h('div', { class: 'meta' }, `${s.distance_km} ${t('km_away')}`),
    s.rating != null ? h('div', {}, `★ ${s.rating} (${s.rating_count ?? 0})`) : h('div', { class: 'meta' }, t('no_rating')),
    s.phone ? h('div', {}, h('a', { href: `tel:${s.phone.replace(/[^\d+]/g, '')}` }, s.phone)) : h('div', { class: 'meta' }, t('phone_na')),
    s.opening_hours ? h('details', {}, h('summary', {}, s.opening_hours.open_now === true ? `${t('open_now')}` : 'Hours'), (s.opening_hours.weekday_text || Object.entries(s.opening_hours.hours || {}).map(([d, x]) => `${d}: ${x}`)).map((l) => h('div', { class: 'meta' }, l))) : h('div', { class: 'meta' }, t('hours_na')),
    s.website ? h('a', { href: s.website, target: '_blank', rel: 'noopener noreferrer' }, t('website')) : null, h('a', { href: s.directions_url, target: '_blank', rel: 'noopener noreferrer' }, t('directions')),
    s.categories?.length ? h('div', { class: 'meta' }, s.categories.map((c) => c.name).join(', ')) : null,
    s.store_prices.length ? h('details', {}, h('summary', {}, t('store_rates')), s.store_prices.map((p) => h('div', { class: 'meta' }, `${p.metal} ${p.purity}: ${money(p.price_per_gram, p.currency)} · ${when(p.verified_at)}`))) : h('div', { class: 'meta' }, t('no_store_rates')));
}

// ---------- Gold loan comparison ----------
async function viewLoans() {
  const out = h('div');
  const form = h('form', { class: 'row', onsubmit: async (e) => {
    e.preventDefault(); const f = Object.fromEntries(new FormData(form));
    try {
      const d = await api(`/api/loans/compare?weight_g=${f.weight}&purity=${f.purity}&tenure_months=${f.tenure}`);
      out.replaceChildren(h('div', { class: 'panel' }, `${t('gold_value')}: `, h('span', { class: 'price big' }, money(d.gold.value, d.gold.currency)), h('div', { class: 'meta' }, `${d.gold.weight_g} g ${d.gold.purity} × ${money(d.gold.price_per_gram, d.gold.currency)} · ${when(d.gold.price_fetched_at)}`)),
        d.offers.map((o, ix) => h('section', { class: 'panel reveal' }, h('div', { class: 'row between' }, h('h3', {}, o.provider.name), ix === 0 && h('span', { class: 'badge ok' }, t('best'))),
          h('dl', { class: 'parts' }, h('dt', {}, t('loan_amount')), h('dd', {}, money(o.loan_amount, d.gold.currency)), h('dt', {}, t('interest_pa')), h('dd', {}, `${o.provider.interest_rate_percent}%`), h('dt', {}, t('emi')), h('dd', {}, money(o.emi, d.gold.currency)),
            h('dt', {}, t('proc_fee')), h('dd', {}, money(o.processing_fee, d.gold.currency)), h('dt', { class: 'total' }, t('total_cost')), h('dd', { class: 'total price' }, money(o.total_cost, d.gold.currency))),
          h('p', { class: 'meta' }, `${t('terms_checked')}: ${when(o.provider.source_checked_at)} · `, h('a', { href: o.provider.source_url, target: '_blank', rel: 'noopener noreferrer' }, t('source'))))),
        d.not_eligible.length > 0 && h('details', {}, h('summary', {}, `${t('not_eligible')} (${d.not_eligible.length})`), d.not_eligible.map((x) => h('div', { class: 'meta' }, `${x.provider.name}: ${x.reason}`))),
        !d.offers.length && !d.not_eligible.length && h('p', { class: 'meta' }, d.note), h('p', { class: 'meta' }, t('loan_disclaimer'))); reveal();
    } catch (er) { out.replaceChildren(errBox(er)); }
  } }, h('label', {}, t('weight'), h('input', { name: 'weight', type: 'number', step: '0.01', min: '0.01', required: true })), h('label', {}, t('purity'), h('select', { name: 'purity' }, ['22K', '24K', '18K'].map((p) => h('option', { value: p }, p)))),
    h('label', {}, t('tenure'), h('input', { name: 'tenure', type: 'number', min: '1', max: '120', value: '12', required: true })), h('button', { class: 'btn', type: 'submit' }, t('compare')));
  main.replaceChildren(h('h1', {}, t('loan_title')), h('p', { class: 'sub' }, t('loan_sub')), h('div', { class: 'panel' }, form), out);
}

// ---------- Talk to Thangam Team ----------
async function viewTeam() {
  const open = async (id) => {
    let last = 0; const log = h('div', { class: 'chat', 'aria-live': 'polite' }); const input = h('input', { placeholder: t('type_msg'), maxlength: 2000, required: true, class: 'grow' });
    const pull = async () => {
      const d = await api(`/api/support/threads/${id}?after=${last}`);
      for (const m of d.messages) { last = m.id; log.append(h('div', { class: `bubble ${m.sender_role === 'admin' ? 'team' : 'mine'}` }, h('div', { class: 'meta' }, `${m.sender_role === 'admin' ? t('team_label') : t('you')} · ${when(m.created_at)}`), m.body)); }
      if (d.messages.length) log.scrollTop = log.scrollHeight; return d.thread;
    };
    const th = await pull();
    main.replaceChildren(h('button', { class: 'btn small alt', onclick: () => go('team') }, t('back')), h('h2', {}, th.subject), log,
      th.status === 'open' ? h('form', { class: 'row', onsubmit: async (e) => { e.preventDefault(); try { await api(`/api/support/threads/${id}/messages`, { method: 'POST', body: { message: input.value } }); input.value = ''; await pull(); } catch (er) { toast(er.message); } } }, input, h('button', { class: 'btn', type: 'submit' }, t('send'))) : h('p', { class: 'meta' }, t('closed')));
    timer = setInterval(() => pull().catch(() => {}), 8000);
  };
  const { threads } = await api('/api/support/threads');
  const subj = h('input', { required: true, maxlength: 150 }); const msg = h('textarea', { required: true, rows: 3, maxlength: 2000 });
  main.replaceChildren(h('h1', {}, t('team_title')), h('p', { class: 'sub' }, t('team_sub')),
    h('form', { class: 'panel', onsubmit: async (e) => { e.preventDefault(); try { const r = await api('/api/support/threads', { method: 'POST', body: { subject: subj.value, message: msg.value } }); open(r.thread.id); } catch (er) { toast(er.message); } } },
      h('h3', {}, t('new_chat')), h('label', {}, t('subject'), subj), h('label', {}, t('message'), msg), h('button', { class: 'btn', type: 'submit' }, t('send'))),
    h('h2', {}, t('my_chats')), threads.length ? threads.map((x) => h('button', { class: 'panel thread', onclick: () => open(x.id) }, h('strong', {}, x.subject), h('span', { class: 'meta' }, ` · ${when(x.last_message_at)}${x.status === 'closed' ? ` · ${t('closed')}` : ''}`))) : h('p', { class: 'meta' }, t('no_chats')));
}

// ---------- Feedback ----------
async function viewFeedback() {
  let rating = 0; const stars = h('div', { class: 'stars', role: 'radiogroup', 'aria-label': t('rating') });
  const paint = () => stars.replaceChildren(...[1, 2, 3, 4, 5].map((n) => h('button', { type: 'button', role: 'radio', 'aria-checked': n === rating, 'aria-label': `${n}`, class: n <= rating ? 'on' : '', onclick: () => { rating = n; paint(); } }, '★')));
  paint();
  const msg = h('textarea', { required: true, rows: 4, maxlength: 2000 });
  const topic = h('select', {}, [['general', 'general'], ['prices', 'prices'], ['stores', 'stores'], ['jewellery', 'jewellery_t'], ['loans', 'loans'], ['app', 'app']].map(([v, k]) => h('option', { value: v }, t(k))));
  main.replaceChildren(h('h1', {}, t('fb_title')), h('p', { class: 'sub' }, t('fb_sub')), h('form', { class: 'panel', onsubmit: async (e) => {
    e.preventDefault(); if (!rating) return toast(t('rating'));
    try { await api('/api/feedback', { method: 'POST', body: { rating, topic: topic.value, message: msg.value } }); msg.value = ''; rating = 0; paint(); toast(t('thanks')); } catch (er) { toast(er.message); }
  } }, h('label', {}, t('rating'), stars), h('label', {}, t('topic'), topic), h('label', {}, t('message'), msg), h('button', { class: 'btn', type: 'submit' }, t('send'))));
}

// ---------- Shop entrance ----------
function entrance() {
  if (sessionStorage.getItem('gw_entered')) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => { sessionStorage.setItem('gw_entered', '1'); door.classList.add('open'); setTimeout(() => { door.remove(); resolve(); }, reduced ? 0 : 1400); };
    const door = h('div', { class: 'door', role: 'dialog', 'aria-label': 'GoldWise' },
      h('div', { class: 'leaf left' }, h('span', { class: 'handle' })), h('div', { class: 'leaf right' }, h('span', { class: 'handle' })),
      h('div', { class: 'sign' }, h('div', { class: 'welcome' }, t('door_welcome')), h('div', { class: 'name' }, 'GoldWise'), h('div', { class: 'tag' }, t('door_tag')),
        h('button', { class: 'btn gold', onclick: finish }, t('door_enter')), h('button', { class: 'skip-btn', onclick: () => { door.remove(); sessionStorage.setItem('gw_entered', '1'); resolve(); } }, t('door_skip'))));
    document.body.append(door); door.querySelector('.btn').focus();
  });
}

// ---------- boot ----------
(async function boot() {
  document.documentElement.lang = getLang();
  if ('serviceWorker' in navigator) addEventListener('load', () => navigator.serviceWorker.register('/sw.js'));
  if (state.token) { try { state.user = (await api('/api/auth/me')).user; if (!localStorage.getItem('gw_lang') && state.user.language) setLang(state.user.language); } catch { state.token = null; localStorage.removeItem('gw_token'); } }
  drawAccount();
  await entrance();
  const v = location.hash.slice(1);
  state.user ? go(customerViews[v] || staffViews[v] ? v : 'rates') : renderWall();
})();
