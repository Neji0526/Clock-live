// ClockWork Desktop — Electron main process entry.
// Owns the tray, single popup window, and boots the ported background logic.

const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, shell, screen } = require("electron");
const path = require("path");

const bg = require("./background");
const store = require("./storage");

let win = null;
let tray = null;

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
  process.exit(0);
}
app.on("second-instance", () => showPopup());

function createPopup() {
  const display = screen.getPrimaryDisplay().workAreaSize;
  win = new BrowserWindow({
    width: 380,
    height: 620,
    show: false,
    frame: true,
    resizable: false,
    fullscreenable: false,
    maximizable: false,
    minimizable: true,
    title: "ClockWork",
    backgroundColor: "#0b0d12",
    icon: path.join(__dirname, "..", "build", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, "..", "renderer", "popup.html"));
  win.on("close", (e) => {
    if (!app.isQuiting) {
      e.preventDefault();
      win.hide();
    }
  });
}

function showPopup() {
  if (!win) createPopup();
  win.show();
  win.focus();
}

function createTray() {
  const iconPath = path.join(__dirname, "..", "build", "icon.png");
  const img = nativeImage.createFromPath(iconPath);
  tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img.resize({ width: 18, height: 18 }));
  tray.setToolTip("ClockWork");
  const menu = Menu.buildFromTemplate([
    { label: "Open ClockWork", click: () => showPopup() },
    { label: "Settings…", click: () => openOptions() },
    { type: "separator" },
    { label: "Quit", click: () => { app.isQuiting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.on("click", () => showPopup());
}

let optionsWin = null;
function openOptions() {
  if (optionsWin && !optionsWin.isDestroyed()) { optionsWin.show(); optionsWin.focus(); return; }
  optionsWin = new BrowserWindow({
    width: 560, height: 640, title: "ClockWork Settings", backgroundColor: "#ffffff",
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true },
  });
  optionsWin.setMenuBarVisibility(false);
  optionsWin.loadFile(path.join(__dirname, "..", "renderer", "options.html"));
}

// ---------- IPC bridge for renderer (popup.js runs unchanged) ----------

// Every extension message goes through here.
ipcMain.handle("wt-msg", async (_e, msg) => {
  return await bg.handleMessage(msg);
});

// chrome.storage.local shim
ipcMain.handle("wt-storage-get", async (_e, keys) => store.get(keys));
ipcMain.handle("wt-storage-set", async (_e, items) => store.setMany(items));
ipcMain.handle("wt-storage-remove", async (_e, keys) => store.remove(keys));

// chrome.tabs.create({ url }) → open in default browser
ipcMain.handle("wt-open-external", async (_e, url) => {
  if (typeof url === "string" && /^https?:\/\//i.test(url)) await shell.openExternal(url);
});

// chrome.runtime.openOptionsPage()
ipcMain.handle("wt-open-options", async () => openOptions());

// app version
ipcMain.handle("wt-app-version", async () => app.getVersion());

// Badge / tray status updates from background
bg.on("badge", (state) => {
  try {
    if (state === "rec") { tray && tray.setToolTip("ClockWork · Recording"); }
    else if (state === "paused") { tray && tray.setToolTip("ClockWork · On break"); }
    else { tray && tray.setToolTip("ClockWork"); }
    if (process.platform === "darwin") {
      app.dock && app.dock.setBadge(state === "rec" ? "●" : state === "paused" ? "‖" : "");
    }
  } catch (_) {}
});

app.whenReady().then(async () => {
  await store.ready();
  await bg.init({ appVersion: app.getVersion() });
  createTray();
  createPopup();
  // Show popup on first launch
  win.once("ready-to-show", () => win.show());
});

app.on("window-all-closed", (e) => {
  // Keep running in tray — do NOT quit.
  e && e.preventDefault && e.preventDefault();
});

app.on("before-quit", () => { app.isQuiting = true; bg.shutdown(); });
