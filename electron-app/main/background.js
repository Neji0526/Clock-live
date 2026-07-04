// ClockWork Desktop — background logic (ported from extension/background.js).
//
// Preserves the extension's business rules exactly:
//   - auth (Supabase password + refresh token)
//   - offline queue (bounded, retry with attempt-cap)
//   - session lifecycle (session_start, activity, idle, break_start/end, session_end)
//   - engagement sampling (1-min windows)
//   - screenshot cadence (default 5 min) + self-heal
//   - capture requests (poll pending → screenshot → mark fulfilled/failed)
//   - session commands (web → desktop clock_out / break_start / break_end)
//   - sleep/wake gap recovery
//   - version check
//
// Migrated primitives:
//   chrome.storage.local  → ./storage
//   chrome.alarms         → setInterval-based ensureAlarm / clearAlarm
//   chrome.idle           → electron powerMonitor + getSystemIdleTime()
//   chrome.tabs.*         → active-win polling (OS-level active window)
//   chrome.tabs.captureVisibleTab → electron desktopCapturer (primary screen)
//   chrome.runtime.onMessage → ipcMain via main.js
//   chrome.scripting.executeScript → not applicable (cross-app DOM injection is
//     impossible from user-space Electron without native accessibility hooks;
//     click-trail workflows are recorded at OS window granularity via active-win)

const { EventEmitter } = require("events");
const { powerMonitor, desktopCapturer, screen, nativeImage } = require("electron");
const store = require("./storage");

const bus = new EventEmitter();

// ---------- config ----------
const SUPABASE_URL = "https://johibfayobgerhzjbisu.supabase.co";
const SUPABASE_ANON =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpvaGliZmF5b2JnZXJoempiaXN1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEyOTk3NjcsImV4cCI6MjA5Njg3NTc2N30.L_U3HWFg6bp3ZIKtrJfvKtUYeEofgmV3j9aKm5U713E";
const INGEST_URL = `${SUPABASE_URL}/functions/v1/track-ingest`;
const AUTH_URL = `${SUPABASE_URL}/auth/v1/token`;

const DEFAULTS = {
  idleSeconds: 300,
  shotMinutes: 5,
  workflowGapSec: 30,
  workflowMaxSteps: 25,
  sessionTimeoutMin: 10,
  blocklist: ["johibfayobgerhzjbisu.supabase.co", "accounts.google.com"],
};

const QUEUE_MAX = 500;
const QUEUE_KEY = "wt-queue";
const SYNC_KEY = "wt-last-sync";
const REAUTH_KEY = "wt-needs-reauth";
const VERSION_KEY = "wt-version-info";
const DEFAULT_VERSION_HOST = "https://clockwork.aiforbusiness.com";

let APP_VERSION = "0.0.0";
let onlineFlag = true;
let currentBadge = "off";

// ---------- helpers ----------
function getSettings() {
  const { settings } = store.get("settings");
  return { ...DEFAULTS, ...(settings || {}) };
}
function hostOf(url) { try { return new URL(url).hostname.toLowerCase(); } catch (e) { return ""; } }
function isBlocked(url, blocklist) {
  const h = hostOf(url);
  if (!h) return true;
  return (blocklist || []).some((d) => h === d || h.endsWith("." + d));
}
function setBadge(state) {
  currentBadge = state;
  bus.emit("badge", state);
}

// ---------- auth ----------
function getAuth() { return store.get("auth").auth || null; }
function setAuth(auth) { auth ? store.setMany({ auth }) : store.remove("auth"); }
function setNeedsReauth(v) { v ? store.setMany({ [REAUTH_KEY]: true }) : store.remove(REAUTH_KEY); }
function getNeedsReauth() { return !!store.get(REAUTH_KEY)[REAUTH_KEY]; }

async function login(email, password) {
  try {
    const res = await fetch(`${AUTH_URL}?grant_type=password`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) return { ok: false, error: data.error_description || data.msg || data.error || "Login failed" };
    setAuth({
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + (data.expires_in || 3600) * 1000,
      email: data.user?.email || email,
      user_id: data.user?.id || null,
    });
    setNeedsReauth(false);
    flushQueue().catch(() => {});
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e).slice(0, 200) }; }
}

async function refreshToken(auth) {
  const res = await fetch(`${AUTH_URL}?grant_type=refresh_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON },
    body: JSON.stringify({ refresh_token: auth.refresh_token }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const hard = res.status >= 400 && res.status < 500;
    const err = new Error(data.error_description || "refresh failed");
    err.hardAuthFail = hard;
    throw err;
  }
  const next = { ...auth,
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + (data.expires_in || 3600) * 1000 };
  setAuth(next);
  return next;
}

async function getToken() {
  let auth = getAuth();
  if (!auth) return null;
  if (auth.expires_at - Date.now() < 60_000) {
    try { auth = await refreshToken(auth); }
    catch (e) { if (e && e.hardAuthFail) setNeedsReauth(true); return null; }
  }
  return auth.access_token;
}

// ---------- queue ----------
function getQueue() { const v = store.get(QUEUE_KEY)[QUEUE_KEY]; return Array.isArray(v) ? v : []; }
function setQueue(q) { store.setMany({ [QUEUE_KEY]: q }); }
function queueLength() { return getQueue().length; }
function enqueue(payload) {
  const q = getQueue();
  q.push({ payload, queuedAt: Date.now(), attempts: 0 });
  if (q.length > QUEUE_MAX) {
    const dropped = q.length - QUEUE_MAX;
    q.splice(0, dropped);
    console.warn(`[ClockWork] queue overflow, dropped ${dropped} oldest events`);
  }
  setQueue(q);
}

let _flushing = false;
async function flushQueue() {
  if (_flushing) return;
  _flushing = true;
  try {
    let q = getQueue();
    if (!q.length) return;
    const auth = getAuth();
    if (!auth || getNeedsReauth()) return;
    const token = await getToken();
    if (!token) return;
    while (q.length) {
      const head = q[0];
      const r = await rawIngest(head.payload, token);
      if (r.ok) {
        q.shift(); setQueue(q);
        store.setMany({ [SYNC_KEY]: Date.now() });
        continue;
      }
      if (r.status === 401) { setNeedsReauth(true); break; }
      head.attempts = (head.attempts || 0) + 1;
      if (head.attempts > 8) { console.warn("[ClockWork] dropping event", head.payload?.kind); q.shift(); }
      setQueue(q); break;
    }
  } finally { _flushing = false; }
}

// ---------- ingest ----------
async function rawIngest(payload, token) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 20_000);
    const res = await fetch(INGEST_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON, Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    let data = null; try { data = await res.json(); } catch (_) {}
    return { ok: res.ok, status: res.status, data };
  } catch (e) { return { ok: false, error: String(e).slice(0, 200) }; }
}

async function ingest(payload, opts) {
  const inlineOnly = !!(opts && opts.inlineOnly);
  const auth = getAuth();
  if (!auth || getNeedsReauth()) {
    if (inlineOnly) return { ok: false, error: "needs_reauth" };
    enqueue(payload); return { ok: false, queued: true, error: "needs_reauth" };
  }
  const token = await getToken();
  if (!token) {
    if (inlineOnly) return { ok: false, error: "no_token" };
    enqueue(payload); return { ok: false, queued: true, error: "no_token" };
  }
  const r = await rawIngest(payload, token);
  if (r.ok) {
    store.setMany({ [SYNC_KEY]: Date.now() });
    if (queueLength() > 0) flushQueue().catch(() => {});
    return r;
  }
  if (r.status === 401) setNeedsReauth(true);
  if (inlineOnly) return r;
  enqueue(payload);
  return { ok: false, queued: true, status: r.status, error: r.error };
}

// ---------- recording state ----------
function getRec() { return store.get("rec").rec || null; }
function setRec(rec) { rec ? store.setMany({ rec }) : store.remove("rec"); }
function bumpLocalActivity() {
  const rec = getRec(); if (!rec) return;
  rec.lastActivityAt = Date.now(); setRec(rec);
}

async function listClients() {
  const token = await getToken(); if (!token) return [];
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/clients?select=id,name&archived=eq.false&order=name.asc`,
      { headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) return [];
    return await res.json();
  } catch (e) { return []; }
}

// ---------- alarms (setInterval-backed) ----------
const alarms = new Map(); // name → { handle, periodMin }
function ensureAlarm(name, periodInMinutes, cb) {
  const existing = alarms.get(name);
  if (existing && Math.abs(existing.periodMin - periodInMinutes) < 0.001) return;
  if (existing) { clearInterval(existing.handle); alarms.delete(name); }
  const ms = Math.max(1000, Math.round(periodInMinutes * 60_000));
  const handle = setInterval(() => cb(name).catch(() => {}), ms);
  // fire once soon so first tick doesn't wait a full period
  const first = setTimeout(() => cb(name).catch(() => {}), Math.min(60_000, ms));
  alarms.set(name, { handle, periodMin: periodInMinutes, first });
}
function clearAlarm(name) {
  const a = alarms.get(name);
  if (!a) return;
  clearInterval(a.handle); if (a.first) clearTimeout(a.first);
  alarms.delete(name);
}
function armAlarms() {
  const s = getSettings();
  const shotMin = Math.max(1, Number(s.shotMinutes) || 5);
  ensureAlarm("wt-heartbeat", 1, onAlarm);
  ensureAlarm("wt-shot", shotMin, onAlarm);
  ensureAlarm("wt-capreq", 0.5, onAlarm);
  ensureAlarm("wt-engage", 1, onAlarm);
  ensureAlarm("wt-flush-queue", 0.5, onAlarm);
  ensureAlarm("wt-version-check", 360, onAlarm);
}
function clearRecordingAlarms() {
  clearAlarm("wt-heartbeat"); clearAlarm("wt-shot"); clearAlarm("wt-capreq");
  clearAlarm("wt-engage"); clearAlarm("wt-flush");
}

// ---------- clock in/out ----------
async function clockIn(clientId) {
  if (getNeedsReauth()) return { error: "Please sign in again." };
  const token = await getToken(); if (!token) return { error: "Please log in first." };
  const body = { kind: "session_start", source: "desktop" };
  if (clientId) body.client_id = clientId;
  const r = await ingest(body, { inlineOnly: true });
  if (!r.ok || !r.data || !r.data.session_id) {
    return { error: "Could not start session (" + (r.status || r.error || "?") + ")." };
  }
  setRec({
    sessionId: r.data.session_id,
    paused: false,
    startedAt: Date.now(),
    lastActivityAt: Date.now(),
    activity: null,
    idleStart: null,
    clientId: clientId || null,
  });
  store.remove("clickBuffer");
  armAlarms();
  resetEngagementWindow();
  setBadge("rec");
  await startActivityFromActiveTab();
  pollCaptureRequests().catch(() => {});
  pollSessionCommands().catch(() => {});
  return await status();
}

async function clockOut() {
  const rec = getRec();
  clearRecordingAlarms();
  setRec(null); setBadge("off");
  (async () => {
    try {
      if (rec) {
        if (rec.activity) {
          const a = rec.activity;
          const dur = Math.round((Date.now() - a.startedAt) / 1000);
          if (dur >= 1) await ingest({ kind: "activity", session_id: rec.sessionId,
            app: a.app, title: a.title, url: a.url,
            started_at: new Date(a.startedAt).toISOString(), duration_sec: dur });
        }
        await flushWorkflowFor(rec.sessionId);
        try { await ingest({ kind: "break_end", session_id: rec.sessionId }); } catch (e) {}
        await ingest({ kind: "session_end", session_id: rec.sessionId });
      }
      await flushQueue();
    } catch (e) {}
  })();
  return await status();
}

async function togglePause(breakType) {
  const rec = getRec(); if (!rec) return await status();
  if (!rec.paused) {
    const bt = breakType === "lunch" ? "lunch" : "short_break";
    const sessionId = rec.sessionId;
    const activity = rec.activity;
    rec.paused = true; rec.pausedAt = Date.now(); rec.activity = null;
    setRec(rec); setBadge("paused");
    (async () => {
      try {
        if (activity) {
          const dur = Math.round((Date.now() - activity.startedAt) / 1000);
          if (dur >= 1) await ingest({ kind: "activity", session_id: sessionId,
            app: activity.app, title: activity.title, url: activity.url,
            started_at: new Date(activity.startedAt).toISOString(), duration_sec: dur });
        }
        await flushWorkflowFor(sessionId);
        await ingest({ kind: bt === "lunch" ? "lunch_start" : "break_start",
          session_id: sessionId, started_at: new Date().toISOString() });
      } catch (e) {}
    })();
  } else {
    rec.paused = false; rec.pausedAt = null; setRec(rec); setBadge("rec");
    try { await ingest({ kind: "break_end", session_id: rec.sessionId }); } catch (e) {}
    await startActivityFromActiveTab();
  }
  return await status();
}

// ---------- activity tracking (active-win polling) ----------
let _activeWin = null;
async function getActiveWindow() {
  if (_activeWin === false) return null;
  if (_activeWin) {
    try { return await _activeWin(); } catch (e) { return null; }
  }
  try {
    // active-win v8 is ESM-only. Load via dynamic import.
    const mod = await import("active-win");
    _activeWin = mod.default || mod.activeWindow || mod;
    return await _activeWin();
  } catch (e) {
    console.warn("[ClockWork] active-win unavailable:", e && e.message);
    _activeWin = false;
    return null;
  }
}

// Synthesize a tab-like object from the OS active window so downstream code
// (which was written for chrome.tabs) works unchanged.
function synthTabFromWindow(w) {
  if (!w) return null;
  const appName = (w.owner && w.owner.name) || w.platform || "app";
  const title = (w.title || appName).toString();
  const host = String(appName).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "app";
  const url = w.url && /^https?:\/\//i.test(w.url) ? w.url : `https://${host}.desktop/${encodeURIComponent(title).slice(0, 200)}`;
  return { url, title, app: host, windowId: w.id || 0 };
}

async function activeTab() {
  const w = await getActiveWindow();
  return synthTabFromWindow(w);
}

async function startActivityFromActiveTab() {
  const rec = getRec(); if (!rec || rec.paused) return;
  const tab = await activeTab();
  if (!tab || !/^https?:\/\//i.test(tab.url || "")) { rec.activity = null; setRec(rec); return; }
  const s = getSettings();
  if (isBlocked(tab.url, s.blocklist)) { rec.activity = null; setRec(rec); return; }
  rec.activity = {
    app: hostOf(tab.url), title: (tab.title || "").slice(0, 500),
    url: tab.url.slice(0, 1000), startedAt: Date.now(),
  };
  rec.lastActivityAt = Date.now();
  setRec(rec);
}

async function finalizeActivity(restart = false) {
  const rec = getRec(); if (!rec || !rec.activity) return;
  const a = rec.activity;
  const dur = Math.round((Date.now() - a.startedAt) / 1000);
  if (dur >= 1) await ingest({ kind: "activity", session_id: rec.sessionId,
    app: a.app, title: a.title, url: a.url,
    started_at: new Date(a.startedAt).toISOString(), duration_sec: dur });
  if (restart) { a.startedAt = Date.now(); rec.activity = a; }
  else rec.activity = null;
  rec.lastActivityAt = Date.now();
  setRec(rec);
}

async function onActiveTabChanged() {
  const rec = getRec(); if (!rec || rec.paused) return;
  const tab = await activeTab();
  const newUrl = tab && tab.url ? tab.url : "";
  if (rec.activity && rec.activity.url === newUrl) return;
  await finalizeActivity();
  await startActivityFromActiveTab();
}

let _activePollHandle = null;
function startActivePolling() {
  if (_activePollHandle) return;
  _activePollHandle = setInterval(() => { onActiveTabChanged().catch(() => {}); }, 5000);
}

// ---------- idle (powerMonitor) ----------
let _idleState = "active"; // "active" | "idle" | "locked"
function pollIdle() {
  try {
    const s = getSettings();
    const threshold = Math.max(15, Number(s.idleSeconds) || 300);
    const idleSec = powerMonitor.getSystemIdleTime();
    const nextState = idleSec >= threshold ? "idle" : "active";
    if (nextState !== _idleState) {
      const prev = _idleState;
      _idleState = nextState;
      onIdleStateChanged(prev, nextState).catch(() => {});
    }
  } catch (e) {}
}

async function onIdleStateChanged(prev, state) {
  const rec = getRec(); if (!rec || rec.paused) return;
  if (state === "idle" || state === "locked") {
    await finalizeActivity();
    rec.idleStart = Date.now(); setRec(rec);
  } else if (state === "active") {
    if (rec.idleStart) {
      const dur = Math.round((Date.now() - rec.idleStart) / 1000);
      if (dur >= 1) await ingest({ kind: "idle", session_id: rec.sessionId,
        started_at: new Date(rec.idleStart).toISOString(), duration_sec: dur });
      rec.idleStart = null; setRec(rec);
    }
    await recoverFromGapIfNeeded();
    if (getRec()) await startActivityFromActiveTab();
  }
}

// ---------- sleep/wake recovery ----------
async function recoverFromGapIfNeeded() {
  const rec = getRec(); if (!rec) return;
  const s = getSettings();
  const timeoutMs = Math.max(60, Number(s.sessionTimeoutMin) || 10) * 60_000;
  const last = rec.lastActivityAt || rec.startedAt || Date.now();
  const gap = Date.now() - last;
  if (gap <= timeoutMs) return;
  clearRecordingAlarms();
  const sessionId = rec.sessionId;
  setRec(null); setBadge("off");
  try { await ingest({ kind: "session_end", session_id: sessionId }); } catch (e) {}
}

// ---------- alarm handler ----------
async function onAlarm(name) {
  if (name === "wt-flush-queue") { await flushQueue(); return; }
  if (name === "wt-version-check") { await checkForUpdate().catch(() => {}); return; }

  await recoverFromGapIfNeeded();
  if (name === "wt-heartbeat" || name === "wt-capreq") {
    await pollSessionCommands().catch(() => {});
  }
  const rec = getRec(); if (!rec) return;
  if (rec.paused && name !== "wt-flush-queue") return;

  if (name === "wt-heartbeat") {
    await ingest({ kind: "heartbeat", session_id: rec.sessionId });
    bumpLocalActivity();
    if (!rec.idleStart) await finalizeActivity(true);
    pollCaptureRequests().catch(() => {});
    await flushQueue();
    await maybeSelfHealScreenshot("heartbeat");
  } else if (name === "wt-shot") {
    await takeScreenshot({ trigger: "alarm" });
  } else if (name === "wt-flush") {
    await flushWorkflow();
  } else if (name === "wt-capreq") {
    pollCaptureRequests().catch(() => {});
  } else if (name === "wt-engage") {
    flushEngagementSample().catch(() => {});
    maybeSelfHealScreenshot("engage").catch(() => {});
  }
}

async function maybeSelfHealScreenshot(trigger) {
  const rec = getRec(); if (!rec || rec.paused) return;
  const s = getSettings();
  const shotMin = Math.max(1, Number(s.shotMinutes) || 5);
  const staleMs = Math.round(1.5 * shotMin * 60_000);
  const last = Number(store.get("wt-last-shot-at")["wt-last-shot-at"]) || 0;
  const ref = Math.max(last, rec.startedAt || 0);
  if (Date.now() - ref < staleMs) return;
  await takeScreenshot({ trigger: "self-heal:" + trigger });
}

// ---------- engagement ----------
function resetEngagementWindow() {
  store.setMany({ engageWin: { startedAt: Date.now(), click: 0, key: 0, scroll: 0 } });
}
function noteInteraction(kind) {
  const rec = getRec(); if (!rec || rec.paused) return;
  const w = store.get("engageWin").engageWin || { startedAt: Date.now(), click: 0, key: 0, scroll: 0 };
  if (kind === "click") w.click++;
  else if (kind === "key") w.key++;
  else if (kind === "scroll") w.scroll++;
  store.setMany({ engageWin: w });
  bumpLocalActivity();
}
async function flushEngagementSample() {
  const rec = getRec(); if (!rec || !rec.sessionId || rec.paused) return;
  const w = store.get("engageWin").engageWin || { startedAt: Date.now() - 60_000, click: 0, key: 0, scroll: 0 };
  const elapsed = Math.max(1, Math.min(600, Math.round((Date.now() - w.startedAt) / 1000)));
  resetEngagementWindow();
  const interacted = (w.click + w.key + w.scroll) > 0;
  try {
    await ingest({ kind: "engagement", session_id: rec.sessionId, window_sec: elapsed,
      interacted, click_count: w.click, key_count: w.key, scroll_count: w.scroll });
  } catch (e) {}
}

// ---------- screenshots (electron desktopCapturer) ----------
async function captureScreenDataUrl() {
  const primary = screen.getPrimaryDisplay();
  const size = primary.size;
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width: Math.min(1920, size.width), height: Math.min(1080, size.height) },
  });
  if (!sources.length) return null;
  const img = sources[0].thumbnail;
  if (!img || img.isEmpty()) return null;
  return img.toDataURL(); // PNG data URL
}

async function takeScreenshot(opts) {
  const rec = getRec();
  if (!rec || rec.paused) return { ok: false, reason: "not_recording" };
  let dataUrl = null;
  try { dataUrl = await captureScreenDataUrl(); }
  catch (e) { return { ok: false, reason: "capture_failed" }; }
  if (!dataUrl) return { ok: false, reason: "capture_failed" };
  const payload = { kind: "screenshot", session_id: rec.sessionId, data_url: dataUrl };
  if (opts && opts.captureRequestId) payload.capture_request_id = opts.captureRequestId;
  const r = await ingest(payload);
  if (r.ok || r.queued) store.setMany({ "wt-last-shot-at": Date.now() });
  return { ok: !!r.ok, reason: r.ok ? null : (r.queued ? "queued" : "upload_failed") };
}

// ---------- capture requests ----------
async function pollCaptureRequests() {
  const rec = getRec(); if (!rec || rec.paused) return;
  const auth = getAuth(); if (!auth || !auth.user_id) return;
  const token = await getToken(); if (!token) return;
  let rows;
  try {
    const url = `${SUPABASE_URL}/rest/v1/capture_requests?select=id,expires_at,status`
      + `&va_id=eq.${encodeURIComponent(auth.user_id)}&status=eq.pending&order=created_at.asc&limit=5`;
    const res = await fetch(url, { headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${token}` } });
    if (!res.ok) return;
    rows = await res.json();
  } catch (e) { return; }
  if (!Array.isArray(rows) || !rows.length) return;
  for (const row of rows) {
    if (Date.parse(row.expires_at) < Date.now()) {
      await markCaptureRequest(row.id, { status: "expired", reason: "expired_before_fulfillment" });
      continue;
    }
    const r = await takeScreenshot({ captureRequestId: row.id });
    if (!r.ok && r.reason !== "queued") {
      await markCaptureRequest(row.id, { status: "failed", reason: r.reason || "capture_failed" });
    }
  }
}
async function markCaptureRequest(id, patch) {
  const token = await getToken(); if (!token) return;
  const body = { ...patch };
  if (patch.status === "fulfilled" || patch.status === "failed" || patch.status === "expired") {
    body.fulfilled_at = new Date().toISOString();
  }
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/capture_requests?id=eq.${encodeURIComponent(id)}&status=eq.pending`,
      { method: "PATCH", headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${token}`,
        "Content-Type": "application/json", Prefer: "return=minimal" }, body: JSON.stringify(body) });
  } catch (e) {}
}

// ---------- session commands ----------
async function pollSessionCommands() {
  const auth = getAuth(); if (!auth || !auth.user_id) return;
  const token = await getToken(); if (!token) return;
  let rows;
  try {
    const url = `${SUPABASE_URL}/rest/v1/session_commands?select=id,command,session_id,expires_at,status`
      + `&va_id=eq.${encodeURIComponent(auth.user_id)}&status=eq.pending&order=created_at.asc&limit=10`;
    const res = await fetch(url, { headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${token}` } });
    if (!res.ok) return;
    rows = await res.json();
  } catch (e) { return; }
  if (!Array.isArray(rows) || !rows.length) return;
  for (const row of rows) {
    if (Date.parse(row.expires_at) < Date.now()) {
      await markSessionCommand(row.id, "expired"); continue;
    }
    try { await applySessionCommandLocally(row.command, row.session_id);
      await markSessionCommand(row.id, "applied");
    } catch (e) {}
  }
}
async function markSessionCommand(id, status) {
  const token = await getToken(); if (!token) return;
  const body = { status, applied_at: new Date().toISOString() };
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/session_commands?id=eq.${encodeURIComponent(id)}&status=eq.pending`,
      { method: "PATCH", headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${token}`,
        "Content-Type": "application/json", Prefer: "return=minimal" }, body: JSON.stringify(body) });
  } catch (e) {}
}
async function applySessionCommandLocally(command, sessionId) {
  const rec = getRec(); if (!rec) return;
  if (sessionId && rec.sessionId && sessionId !== rec.sessionId && command !== "clock_out") return;

  if (command === "clock_out") {
    clearRecordingAlarms();
    try {
      if (rec.activity) {
        const a = rec.activity;
        const dur = Math.round((Date.now() - a.startedAt) / 1000);
        if (dur >= 1) await ingest({ kind: "activity", session_id: rec.sessionId,
          app: a.app, title: a.title, url: a.url,
          started_at: new Date(a.startedAt).toISOString(), duration_sec: dur });
      }
      await flushWorkflowFor(rec.sessionId);
    } catch (e) {}
    setRec(null); setBadge("off"); store.remove("clickBuffer");
    flushQueue().catch(() => {});
  } else if (command === "break_start") {
    if (rec.paused) return;
    const activity = rec.activity;
    rec.paused = true; rec.pausedAt = Date.now(); rec.activity = null;
    setRec(rec); setBadge("paused");
    try {
      if (activity) {
        const dur = Math.round((Date.now() - activity.startedAt) / 1000);
        if (dur >= 1) await ingest({ kind: "activity", session_id: rec.sessionId,
          app: activity.app, title: activity.title, url: activity.url,
          started_at: new Date(activity.startedAt).toISOString(), duration_sec: dur });
      }
      await flushWorkflowFor(rec.sessionId);
    } catch (e) {}
  } else if (command === "break_end") {
    if (!rec.paused) return;
    rec.paused = false; rec.pausedAt = null; rec.lastActivityAt = Date.now();
    setRec(rec); setBadge("rec");
    await startActivityFromActiveTab();
  }
}

// ---------- workflow (window-title granularity) ----------
async function flushWorkflow() { const rec = getRec(); await flushWorkflowFor(rec ? rec.sessionId : null); }
async function flushWorkflowFor(sessionId) {
  const buf = store.get("clickBuffer").clickBuffer || null;
  if (!buf || !buf.items.length) { store.remove("clickBuffer"); return; }
  if (!sessionId) { store.remove("clickBuffer"); return; }
  const labels = buf.items.map((i) => i.label).filter(Boolean);
  for (let i = 0; i < buf.items.length; i++) {
    const it = buf.items[i];
    const last = i === buf.items.length - 1;
    try {
      await ingest({ kind: "step", session_id: sessionId, step_index: i,
        label: it.label, tag: it.tag, url: it.url, rect: it.rect, dpr: it.dpr,
        viewport: it.viewport, screenshot: it.shot || null,
        ...(last ? { workflow_end: true, workflow_labels: labels } : {}) });
    } catch (e) {}
  }
  store.remove("clickBuffer");
}

// ---------- version check ----------
function cmpVer(a, b) {
  const pa = String(a || "0").split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b || "0").split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0); if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}
function versionHost() {
  const { settings } = store.get("settings");
  const dash = settings && settings.dashboardUrl;
  return (dash && /^https?:\/\//.test(dash)) ? dash.replace(/\/+$/, "") : DEFAULT_VERSION_HOST;
}
async function checkForUpdate() {
  const host = versionHost();
  try {
    const res = await fetch(`${host}/api/public/extension-version`, { cache: "no-store" });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || !data.latest) return null;
    const info = { latest: String(data.latest), min: String(data.min || data.latest),
      install_url: String(data.install_url || `${host}/install`), checkedAt: Date.now() };
    store.setMany({ [VERSION_KEY]: info });
    return info;
  } catch (e) { return null; }
}
function getVersionInfo() { return store.get(VERSION_KEY)[VERSION_KEY] || null; }

// ---------- status ----------
async function status() {
  const auth = getAuth(); const rec = getRec();
  const needsReauth = getNeedsReauth();
  const queued = queueLength();
  const lastSyncAt = store.get(SYNC_KEY)[SYNC_KEY] || null;
  const vinfo = getVersionInfo();
  const installed = APP_VERSION;
  const updateAvailable = !!(vinfo && cmpVer(installed, vinfo.latest) < 0);
  const mustUpdate = !!(vinfo && cmpVer(installed, vinfo.min) < 0);
  let elapsed = 0;
  if (rec && rec.startedAt) elapsed = Math.round((Date.now() - rec.startedAt) / 1000);
  return {
    loggedIn: !!auth, email: auth ? auth.email : null, needsReauth,
    clockedIn: !!rec, paused: !!(rec && rec.paused),
    pausedAt: rec && rec.pausedAt ? rec.pausedAt : null,
    startedAt: rec && rec.startedAt ? rec.startedAt : null,
    clientId: rec && rec.clientId ? rec.clientId : null,
    onIdle: !!(rec && rec.idleStart),
    currentApp: rec && rec.activity ? rec.activity.app : null,
    elapsedSec: elapsed, queued, lastSyncAt,
    online: onlineFlag, version: installed,
    updateAvailable, mustUpdate,
    latestVersion: vinfo ? vinfo.latest : null,
    installUrl: vinfo ? vinfo.install_url : null,
  };
}

// ---------- IPC message handler ----------
async function handleMessage(msg) {
  if (!msg || !msg.type) return { ok: false };
  switch (msg.type) {
    case "wt-status": return await status();
    case "wt-login": return await login(msg.email, msg.password);
    case "wt-logout": {
      if (getRec()) await clockOut();
      setAuth(null); setNeedsReauth(false);
      return await status();
    }
    case "wt-clients": return await listClients();
    case "wt-clock-in": return await clockIn(msg.clientId);
    case "wt-clock-out": return await clockOut();
    case "wt-toggle-pause": return await togglePause(msg.breakType);
    case "wt-flush-now": await flushQueue(); return await status();
    case "wt-check-update": await checkForUpdate(); return await status();
    case "wt-click": /* no-op on desktop — see MIGRATION.md */ return { ok: true };
    case "wt-interaction": noteInteraction(msg.kind); return { ok: true };
    default: return { ok: false };
  }
}

// ---------- lifecycle ----------
let _idlePollHandle = null;
async function init({ appVersion } = {}) {
  APP_VERSION = appVersion || "0.0.0";
  const rec = getRec();
  if (rec) { setBadge(rec.paused ? "paused" : "rec"); armAlarms(); await recoverFromGapIfNeeded(); }
  else { setBadge("off"); ensureAlarm("wt-flush-queue", 0.5, onAlarm); }
  ensureAlarm("wt-version-check", 360, onAlarm);
  startActivePolling();
  _idlePollHandle = setInterval(pollIdle, 5000);
  powerMonitor.on("suspend", () => { flushQueue().catch(() => {}); });
  powerMonitor.on("resume", () => { recoverFromGapIfNeeded().catch(() => {}); });
  powerMonitor.on("lock-screen", () => { _idleState = "locked"; onIdleStateChanged("active", "locked").catch(() => {}); });
  powerMonitor.on("unlock-screen", () => { _idleState = "active"; onIdleStateChanged("locked", "active").catch(() => {}); });
  flushQueue().catch(() => {});
  checkForUpdate().catch(() => {});
  pollSessionCommands().catch(() => {});
}

function shutdown() {
  for (const [name] of alarms) clearAlarm(name);
  if (_idlePollHandle) clearInterval(_idlePollHandle);
  if (_activePollHandle) clearInterval(_activePollHandle);
  flushQueue().catch(() => {});
}

module.exports = {
  init, shutdown, handleMessage,
  on: (ev, cb) => bus.on(ev, cb),
};
