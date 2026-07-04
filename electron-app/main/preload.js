// ClockWork Desktop — preload shim.
// Exposes a `chrome`-shaped surface on window so the extension's popup.js /
// options.js can run without modification. Everything goes through IPC.

const { contextBridge, ipcRenderer } = require("electron");

function get(keys) { return ipcRenderer.invoke("wt-storage-get", keys); }
function set(items) { return ipcRenderer.invoke("wt-storage-set", items); }
function remove(keys) { return ipcRenderer.invoke("wt-storage-remove", keys); }

// storage callback signatures match chrome.storage.local exactly.
const storageLocal = {
  get(keys, cb) {
    const p = get(keys);
    if (typeof cb === "function") { p.then((v) => cb(v)); return; }
    return p;
  },
  set(items, cb) {
    const p = set(items);
    if (typeof cb === "function") { p.then(() => cb()); return; }
    return p;
  },
  remove(keys, cb) {
    const p = remove(keys);
    if (typeof cb === "function") { p.then(() => cb()); return; }
    return p;
  },
};

const runtime = {
  // (msg, cb) → the background reply
  sendMessage(msg, cb) {
    const p = ipcRenderer.invoke("wt-msg", msg);
    if (typeof cb === "function") { p.then((v) => cb(v)).catch(() => cb(undefined)); return; }
    return p;
  },
  openOptionsPage() { ipcRenderer.invoke("wt-open-options"); },
  // no-op listener; renderer wiring uses sendMessage return values only.
  onMessage: { addListener: () => {} },
  lastError: null,
  getManifest() { return { version: window.__CW_VERSION__ || "0.0.0" }; },
  id: "clockwork-desktop",
};

const tabs = {
  create({ url }) { ipcRenderer.invoke("wt-open-external", url); },
};

contextBridge.exposeInMainWorld("chrome", {
  runtime,
  storage: { local: storageLocal },
  tabs,
});

// Version injection
ipcRenderer.invoke("wt-app-version").then((v) => {
  window.__CW_VERSION__ = v;
});
