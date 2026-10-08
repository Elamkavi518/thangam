// Shared helpers. DOM is built with textContent only: names, addresses and messages are never injected as HTML.
export const API = (window.GOLDWISE_API_URL || '').replace(/\/$/, '');
export const state = { user: null, token: localStorage.getItem('gw_token') };
export const $ = (s, r = document) => r.querySelector(s);
export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (['checked', 'selected', 'disabled', 'hidden', 'value'].includes(k)) el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}
export const money = (n, cur = 'INR') => (n == null ? '—' : new Intl.NumberFormat('en-IN', { style: 'currency', currency: cur, maximumFractionDigits: 2 }).format(n));
export const when = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' }) : '—');
export function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 3500); }
export async function api(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(API + path, { method, headers: { 'Content-Type': 'application/json', ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  } catch { throw Object.assign(new Error('Cannot reach the GoldWise server. Check your internet connection.'), { network: true }); }
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const e = data?.error || {};
    throw Object.assign(new Error(e.message || `Request failed (${res.status})`), { status: res.status, code: e.code, details: e.details });
  }
  return data;
}
export const errBox = (e) => h('div', { class: 'alert bad', role: 'alert' }, e.message, e.details?.config_required?.length ? ` Required configuration: ${e.details.config_required.join(', ')}.` : '');
export const actionBtn = (label, fn, cls = '', after = () => {}) => h('button', { class: `btn small ${cls}`, onclick: async (e) => { e.target.disabled = true; try { await fn(); toast('Done'); after(); } catch (er) { toast(er.message); e.target.disabled = false; } } }, label);
export const main = document.getElementById('main');
