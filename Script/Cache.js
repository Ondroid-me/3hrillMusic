// cache.js
const store = new Map();
const TTL_MS = 5 * 60 * 1000;

module.exports = {
  get(key) {
    const e = store.get(key);
    if (!e) return null;
    if (Date.now() - e.t > TTL_MS) { store.delete(key); return null; }
    return e.v;
  },
  set(key, value) { store.set(key, { v: value, t: Date.now() }); },
  clear() { store.clear(); }
};