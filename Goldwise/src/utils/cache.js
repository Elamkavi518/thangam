/** Tiny TTL cache with max size (oldest-first eviction). */
export class TTLCache {
  constructor({ ttlMs, max = 500 }) {
    this.ttlMs = ttlMs;
    this.max = max;
    this.map = new Map();
  }
  get(key) {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.exp < Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    return hit.value;
  }
  set(key, value, ttlMs = this.ttlMs) {
    if (this.map.size >= this.max) this.map.delete(this.map.keys().next().value);
    this.map.set(key, { value, exp: Date.now() + ttlMs });
  }
  delete(key) { this.map.delete(key); }
  clear() { this.map.clear(); }
}
