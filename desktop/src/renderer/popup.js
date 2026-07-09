const $ = (id) => document.getElementById(id);
const VIEWS = ["view-signin", "view-reauth", "view-out", "view-rec", "view-break"];

function show(id) {
  for (const v of VIEWS) {
    const el = $(v);
    if (!el) continue;
    if (v === id) {
      if (el.classList.contains("hidden")) {
        el.classList.remove("hidden");
        el.classList.remove("fade"); void el.offsetWidth; el.classList.add("fade");
      }
    } else el.classList.add("hidden");
  }
}

function send(type, extra) {
  return new Promise((resolve) => clockwork.runtime.sendMessage({ type, ...(extra || {}) }, resolve));
}

function fmtHMS(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
}
function fmtMS(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
}
function fmtAgo(ms) {
  if (!ms) return "Not yet synced";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 5) return "Synced just now";
  if (s < 60) return `Last synced ${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `Last synced ${m}m ago`;
  const h = Math.floor(m / 60);
  return `Last synced ${h}h ago`;
}

function pillsHTML(st) {
  const out = [];
  if (!st.online) out.push('<span class="pill red">● offline</span>');
  if (st.queued > 0) out.push(`<span class="pill amber">${st.queued} queued</span>`);
  if (st.online && (st.queued || 0) === 0 && st.clockedIn && !st.paused) out.push('<span class="pill green">live</span>');
  return out.join(" ");
}

// Inject (or remove) an "Update available" banner at the top of the active view.
function renderUpdateBanner(viewId) {
  // Clear from every view first so stale banners don't linger.
  document.querySelectorAll(".update-banner").forEach((n) => n.remove());
  if (!st || !st.updateAvailable) return;
  const view = document.getElementById(viewId);
  if (!view) return;
  const wrap = view.querySelector(".wrap");
  if (!wrap) return;
  const installUrl = st.installUrl || "";
  const hard = !!st.mustUpdate;
  const div = document.createElement("div");
  div.className = "banner update-banner " + (hard ? "err" : "warn");
  div.innerHTML = `
    <span class="ic">${hard ? "⚠" : "↻"}</span>
    <div style="flex:1; min-width:0;">
      <b>${hard ? "Update required" : "New version available"}</b>
      You're on v${st.version}. Latest is v${st.latestVersion}.
      <a class="upd-link" style="color:var(--gold); text-decoration:underline; cursor:pointer; display:inline-block; margin-top:4px;">
        Open install page →
      </a>
    </div>
  `;
  const link = div.querySelector(".upd-link");
  link.onclick = () => {
    if (installUrl) clockwork.tabs.create({ url: installUrl });
    else toast("No install URL available");
  };
  // Insert at top of wrap, after header if present.
  const hdr = wrap.querySelector(".hdr");
  if (hdr && hdr.nextSibling) wrap.insertBefore(div, hdr.nextSibling);
  else wrap.insertBefore(div, wrap.firstChild);
}

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.add("hidden"), 1800);
}

// In-popup confirmation. Replaces window.confirm(), which on the Linux tray
// build steals focus (firing the main-process blur→hide) and blocks the single
// renderer thread while its own dialog is hidden and unanswerable — freezing
// every button. This overlay lives inside the popup DOM: no focus change, no
// blocking, so the UI stays responsive and reopening the popup can't strand it.
function askConfirm(message, okLabel = "Confirm") {
  return new Promise((resolve) => {
    document.querySelectorAll(".cw-confirm").forEach((n) => n.remove());
    const ov = document.createElement("div");
    ov.className = "cw-confirm";
    ov.innerHTML = `
      <div class="cw-confirm-card">
        <div class="cw-confirm-msg"></div>
        <div class="cw-confirm-row">
          <button class="ghost cw-cancel" type="button">Cancel</button>
          <button class="stop cw-ok" type="button"></button>
        </div>
      </div>`;
    ov.querySelector(".cw-confirm-msg").textContent = message;
    ov.querySelector(".cw-ok").textContent = okLabel;
    const done = (val) => { ov.remove(); resolve(val); };
    ov.querySelector(".cw-cancel").onclick = () => done(false);
    ov.querySelector(".cw-ok").onclick = () => done(true);
    // Click the dark backdrop = cancel; Esc = cancel.
    ov.addEventListener("click", (e) => { if (e.target === ov) done(false); });
    const onKey = (e) => {
      if (e.key === "Escape") { document.removeEventListener("keydown", onKey); done(false); }
    };
    document.addEventListener("keydown", onKey);
    document.body.appendChild(ov);
    ov.querySelector(".cw-ok").focus();
  });
}

let tick = null;
let st = null;
let clockingOut = false; // guards the RUNNING→STOPPING→STOPPED transition
let clockingIn = false;  // guards the STOPPED→STARTING→RUNNING transition
let clientName = "No client";
let clientsCache = [];
let clientsLoaded = false;

function startTicker() {
  if (tick) clearInterval(tick);
  tick = setInterval(updateLive, 1000);
}

function updateLive() {
  if (!st) return;
  if (st.clockedIn && !st.paused && st.startedAt) {
    const sec = Math.floor((Date.now() - st.startedAt) / 1000);
    if ($("timerRec")) $("timerRec").textContent = fmtHMS(sec);
  }
  if (st.clockedIn && st.paused && st.pausedAt) {
    const sec = Math.floor((Date.now() - st.pausedAt) / 1000);
    if ($("breakTimer")) $("breakTimer").textContent = fmtMS(sec);
  }
  if ($("syncRec")) $("syncRec").textContent = fmtAgo(st.lastSyncAt);
  if ($("syncOut")) $("syncOut").textContent = st.lastSyncAt ? fmtAgo(st.lastSyncAt) : "Ready";
  if ($("syncBreak")) $("syncBreak").textContent = "Paused · " + fmtAgo(st.lastSyncAt);
}

function buildFooter(elId, includeLogout = true) {
  const el = $(elId);
  if (!el) return;
  el.innerHTML = `
    <a data-act="dash">Dashboard</a>
    ${includeLogout ? '<a data-act="logout">Sign out</a>' : ''}
    <span class="sp"></span>
    <span>v${(st && st.version) || ""}</span>
  `;
  el.querySelectorAll("a").forEach(a => a.onclick = onFootAct);
}

async function onFootAct(e) {
  const act = e.currentTarget.getAttribute("data-act");
  if (act === "dash") {
    const { settings } = await clockwork.storage.local.get("settings");
    const url = (settings && settings.dashboardUrl) || "";
    if (url) clockwork.tabs.create({ url });
    else toast("No dashboard URL configured");
  } else if (act === "logout") {
    st = await send("wt-logout");
    await refresh();
  }
}

async function loadClients(selectedId) {
  if (!clientsLoaded) {
    clientsCache = (await send("wt-clients")) || [];
    clientsLoaded = true;
  }
  const sel = $("client");
  if (!sel) return;
  sel.innerHTML = '<option value="">— No client —</option>' +
    clientsCache.map(c => `<option value="${c.id}">${(c.name || "").replace(/</g, "&lt;")}</option>`).join("");
  const { wtLastClient } = await clockwork.storage.local.get("wtLastClient");
  const want = selectedId || wtLastClient;
  if (want) sel.value = want;
}

function clientNameFor(id) {
  if (!id) return "No client";
  const c = clientsCache.find(x => x.id === id);
  return c ? c.name : "Client";
}

function shotStatusText(st) {
  const res = st && st.lastShot;
  const at = st && st.lastShotAt;
  if (res && res.ok === false) return "⚠ Screenshot failed: " + (res.reason || "error");
  if (at) {
    const s = Math.max(0, Math.round((Date.now() - at) / 1000));
    const ago = s < 60 ? s + "s ago" : s < 3600 ? Math.floor(s / 60) + "m ago" : Math.floor(s / 3600) + "h ago";
    return "📷 Last screenshot " + ago;
  }
  return st && st.clockedIn ? "📷 Waiting for first screenshot…" : "📷 No screenshots yet — clock in to start";
}

async function render() {
  if (!st) return;

  // Never let a Clock Out button stay stuck reading "Stopping…": whenever we are
  // not actively mid-stop, restore it to its clickable default. During a stop
  // the `clockingOut` guard keeps the "Stopping…" label until the transition
  // resolves (success → STOPPED view, or failure → re-enabled for retry).
  if (!clockingOut) {
    for (const id of ["clockOutBtn", "clockOutBtn2"]) {
      const b = $(id);
      if (b) { b.disabled = false; b.textContent = "■  Clock Out"; }
    }
  }
// Same self-heal for Clock In: unless a start is genuinely mid-flight, keep it
  // clickable so a reopened popup is never stranded on a stuck "Starting…".
  if (!clockingIn) {
    const b = $("clockInBtn");
    if (b) { b.disabled = false; b.innerHTML = "▶  Clock In"; }
  }

  // Signed out
  if (!st.loggedIn) {
    show("view-signin");
    $("verSignin").textContent = "v" + (st.version || "");
    renderUpdateBanner("view-signin");
    return;
  }

  // Re-auth needed
  if (st.needsReauth) {
    show("view-reauth");
    $("verReauth").textContent = "v" + (st.version || "");
    renderUpdateBanner("view-reauth");
    return;
  }

  // Recording
  if (st.clockedIn && !st.paused) {
    show("view-rec");
    await loadClients(st.clientId);
    $("whoRec").textContent = (st.email || "Signed in").split("@")[0];
    $("timerRec").textContent = fmtHMS(st.elapsedSec);
    $("clientRec").textContent = clientNameFor(st.clientId);
    $("appRec").textContent = st.currentApp ? "on " + st.currentApp : "Waiting for activity…";
    $("syncRec").textContent = fmtAgo(st.lastSyncAt);
    $("pillsRec").innerHTML = pillsHTML(st);
    if ($("shotRec")) $("shotRec").textContent = shotStatusText(st);
    $("retryBtn").classList.toggle("hidden", !(st.queued > 0));
    buildFooter("footRec");
    renderUpdateBanner("view-rec");
    return;
  }

  // Break
  if (st.clockedIn && st.paused) {
    show("view-break");
    $("breakTimer").textContent = fmtMS(st.pausedAt ? (Date.now() - st.pausedAt) / 1000 : 0);
    $("pillsBreak").innerHTML = pillsHTML(st);
    buildFooter("footBreak");
    renderUpdateBanner("view-break");
    return;
  }

  // Clocked out (connected)
  show("view-out");
  await loadClients();
  $("whoOut").textContent = st.email || "Signed in";
  $("pillsOut").innerHTML = pillsHTML(st);
  buildFooter("footOut");
  $("syncOut").textContent = st.lastSyncAt ? fmtAgo(st.lastSyncAt) : "Ready";
  if ($("shotOut")) $("shotOut").textContent = shotStatusText(st);
  renderUpdateBanner("view-out");

  // First-run welcome after install + sign-in
  const { wtSawWelcome } = await clockwork.storage.local.get("wtSawWelcome");
  if (!wtSawWelcome) {
    $("welcome").classList.remove("hidden");
    clockwork.storage.local.set({ wtSawWelcome: true });
  } else {
    $("welcome").classList.add("hidden");
  }
}

// Measure the currently-visible view and ask main to size the window to it,
// so there is no empty dark space below the card/footer.
let _lastFitH = 0;
function fitWindow() {
  requestAnimationFrame(() => {
    const view = VIEWS.map((v) => $(v)).find((el) => el && !el.classList.contains("hidden"));
    const el = view || document.body;
    const h = Math.ceil(el.getBoundingClientRect().height);
    if (h && h !== _lastFitH && window.clockwork && window.clockwork.resizeWindow) {
      _lastFitH = h;
      window.clockwork.resizeWindow(h);
    }
  });
}

async function refresh() {
  st = await send("wt-status");
  await render();
  fitWindow();
}

// ============ Event wiring ============
document.addEventListener("DOMContentLoaded", () => {
  $("togglePw").onclick = () => {
    const i = $("password");
    const isPw = i.type === "password";
    i.type = isPw ? "text" : "password";
    $("togglePw").textContent = isPw ? "Hide" : "Show";
  };

  $("loginBtn").onclick = async () => {
    $("loginErr").textContent = "";
    const email = $("email").value.trim();
    const pw = $("password").value;
    if (!email || !pw) { $("loginErr").textContent = "Enter email and password."; return; }
    $("loginBtn").disabled = true; $("loginBtn").textContent = "Signing in…";
    const r = await send("wt-login", { email, password: pw });
    $("loginBtn").disabled = false; $("loginBtn").textContent = "Sign in";
    if (r && r.ok) {
      // Reset welcome flag on fresh sign-in so users get the affirmation
      await clockwork.storage.local.remove("wtSawWelcome");
      toast("Signed in ✓");
      await refresh();
    } else {
      $("loginErr").textContent = (r && r.error) || "Sign in failed. Check email and password.";
    }
  };

  $("password").addEventListener("keydown", (e) => { if (e.key === "Enter") $("loginBtn").click(); });
  $("email").addEventListener("keydown", (e) => { if (e.key === "Enter") $("password").focus(); });

  $("reauthBtn").onclick = async () => {
    await send("wt-logout");
    await refresh();
  };
  $("footLogout2").onclick = async () => { await send("wt-logout"); await refresh(); };

  $("clockInBtn").onclick = async () => {
    if (clockingIn) return;
    const sel = $("client");
    const clientId = sel ? sel.value : "";
    await clockwork.storage.local.set({ wtLastClient: clientId });
    clockingIn = true;
    $("clockInBtn").disabled = true; $("clockInBtn").textContent = "Starting…";
    // const r = await send("wt-clock-in", { clientId: clientId || null });
    // $("clockInBtn").disabled = false; $("clockInBtn").innerHTML = "▶  Clock In";
    // if (r && r.error) { toast(r.error); return; }
    // toast("Clocked in ✓");
    // await refresh();
    try {
      // Timeout-guard the round-trip so a stalled IPC can never leave the button
      // hung on "Starting…" (the finally always restores it).
      const r = await Promise.race([
        send("wt-clock-in", { clientId: clientId || null }),
        new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 15000)),
      ]);
      if (r && r.error) { toast(r.error); return; }
      toast("Clocked in ✓");
      await refresh();
    } catch (e) {
      toast(e && e.message === "timeout" ? "Start timed out — try again" : "Couldn't clock in — try again");
    } finally {
      clockingIn = false;
      $("clockInBtn").disabled = false; $("clockInBtn").innerHTML = "▶  Clock In";
    }
  };

  async function doClockOut(btn) {
    if (clockingOut) return;
    if (!(await askConfirm("Clock out and end this session?", "Clock Out"))) return;
    // NOTE: deliberately no window.confirm() here. confirm() blocks the renderer
    // thread synchronously; on Linux the frameless/skipTaskbar popup hides itself
    // on blur when the dialog steals focus, so no dialog is ever shown and the UI
    // freezes permanently ("disabled, can't touch the app"). Clock Out is an
    // explicit, distinctly-styled action — stop immediately instead.
    // RUNNING → STOPPING
    clockingOut = true;
    btn.disabled = true; btn.textContent = "Stopping…";
    try {
      // Guard the round-trip with a timeout so the button can never hang in
      // "Stopping…" if the IPC/main call stalls. wt-clock-out resolves with the
      // fresh status (rec already cleared) — verify we actually reached STOPPED.
      const res = await Promise.race([
        send("wt-clock-out"),
        new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 15000)),
      ]);
      st = res || (await send("wt-status"));
      if (st && st.clockedIn) throw new Error("still_recording");
      // STOPPED
      toast("Clocked out ✓");
    } catch (e) {
      // Don't strand the user in "Stopping…": surface the failure, log the
      // reason, and re-enable so pressing Clock Out again retries.
      console.warn("[ClockWork] clock-out failed:", e && e.message);
      toast(e && e.message === "timeout"
        ? "Stop timed out — press Clock Out to retry"
        : "Couldn't stop — press Clock Out to retry");
      st = await send("wt-status");
    } finally {
      clockingOut = false;
      await render();
      fitWindow();
    }
  }
  $("clockOutBtn").onclick = () => doClockOut($("clockOutBtn"));
  $("clockOutBtn2").onclick = () => doClockOut($("clockOutBtn2"));

  $("pauseBtn").onclick = async () => {
    $("pauseBtn").disabled = true;
    // await send("wt-toggle-pause", { breakType: "short_break" });
    // $("pauseBtn").disabled = false;
    // await refresh();
    try {
      await send("wt-toggle-pause", { breakType: "short_break" });
      await refresh();
    } finally {
      $("pauseBtn").disabled = false;
    }
  };

  $("lunchBtn").onclick = async () => {
    $("lunchBtn").disabled = true;
    // await send("wt-toggle-pause", { breakType: "lunch" });
    // $("lunchBtn").disabled = false;
    // await refresh();
    try {
      await send("wt-toggle-pause", { breakType: "lunch" });
      await refresh();
    } finally {
      $("lunchBtn").disabled = false;
    }
  };

  $("resumeBtn").onclick = async () => {
    $("resumeBtn").disabled = true; $("resumeBtn").textContent = "Resuming…";
    // await send("wt-toggle-pause");
    // toast("Resumed ✓");
    // await refresh();
    try {
      await send("wt-toggle-pause");
      toast("Resumed ✓");
      await refresh();
    } finally {
      $("resumeBtn").disabled = false; $("resumeBtn").innerHTML = "▶  Resume work";
    }
  };

  $("retryBtn").onclick = async () => {
    $("retryBtn").disabled = true; $("retryBtn").textContent = "Syncing…";
    await send("wt-flush-now");
    $("retryBtn").disabled = false; $("retryBtn").textContent = "Retry sync now";
    await refresh();
  };

  $("testShotBtn").onclick = async () => {
    const btn = $("testShotBtn");
    btn.disabled = true;
    const old = btn.innerHTML;
    btn.textContent = "📷  Capturing…";
    const r = await send("wt-test-shot");
    btn.disabled = false;
    btn.innerHTML = old;
    toast(r && r.reason ? r.reason : r && r.ok ? "Captured ✓" : "Capture failed");
    await refresh();
  };

  refresh();
  // Force a version-check on every popup open so VAs see fresh status.
  send("wt-check-update").then((s) => { if (s) { st = s; render().then(fitWindow); } });
  // Re-fit whenever the visible content changes size (banners, pills, etc.).
  window.addEventListener("load", fitWindow);
  new ResizeObserver(fitWindow).observe(document.body);
  startTicker();
  setInterval(refresh, 5000);
});
