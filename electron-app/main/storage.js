// Persistent key/value store — API-compatible with chrome.storage.local.
// Backed by electron-store (JSON file under userData).

let Store;
try { Store = require("electron-store"); } catch (_) { Store = null; }

let store = null;
let readyP = null;

function ready() {
  if (readyP) return readyP;
  readyP = (async () => {
    if (!Store) {
      // Minimal in-memory fallback for the case electron-store isn't installed
      // (dev-time only; the packaged app always includes it).
      const mem = new Map();
      store = {
        get: (k) => mem.get(k),
        set: (k, v) => mem.set(k, v),
        delete: (k) => mem.delete(k),
        has: (k) => mem.has(k),
      };
      return;
    }
    store = new Store({ name: "clockwork" });
  })();
  return readyP;
}

function get(keys) {
  const out = {};
  if (keys == null) {
    // return everything (mirrors chrome behaviour)
    if (store && store.store) return { ...store.store };
    return out;
  }
  const arr = Array.isArray(keys) ? keys : typeof keys === "string" ? [keys] : Object.keys(keys);
  const defaults = (typeof keys === "object" && !Array.isArray(keys)) ? keys : {};
  for (const k of arr) {
    const v = store.get(k);
    if (v !== undefined) out[k] = v;
    else if (defaults[k] !== undefined) out[k] = defaults[k];
  }
  return out;
}

function setMany(items) {
  for (const k of Object.keys(items || {})) store.set(k, items[k]);
}

function remove(keys) {
  const arr = Array.isArray(keys) ? keys : [keys];
  for (const k of arr) store.delete(k);
}

module.exports = { ready, get, setMany, remove };
