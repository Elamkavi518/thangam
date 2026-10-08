import { query } from '../db/pool.js';
import { notFound, forbidden } from '../utils/errors.js';

export async function getStoreForWrite(user, storeId) {
  const { rows } = await query('SELECT * FROM stores WHERE id = $1', [storeId]);
  const s = rows[0];
  if (!s) throw notFound('Store not found');
  if (user.role !== 'admin' && s.owner_id !== user.id) throw forbidden('You do not manage this store');
  return s;
}

export async function audit(actor, action, entity, entityId, details = null) {
  await query('INSERT INTO audit_log (actor_id, action, entity, entity_id, details) VALUES ($1,$2,$3,$4,$5)', [actor?.id ?? null, action, entity, String(entityId ?? ''), details]);
}
