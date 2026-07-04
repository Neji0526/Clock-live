# Chrome Extension → Electron migration notes

This document lists every Chrome API used by the original extension and how
the desktop app replaces it. Business rules, ingest payloads, session
lifecycle, break/idle semantics, and offline queue behaviour are **identical**
to the extension. Only the runtime host changed.

| Chrome API used by extension              | Desktop equivalent                                   |
| ----------------------------------------- | ---------------------------------------------------- |
| `chrome.storage.local.{get,set,remove}`   | `electron-store` behind an API-compatible shim       |
| `chrome.runtime.sendMessage` (popup→bg)   | `ipcRenderer.invoke("wt-msg", …)` ↔ `ipcMain.handle` |
| `chrome.runtime.getManifest().version`    | `app.getVersion()`                                   |
| `chrome.runtime.openOptionsPage()`        | Custom BrowserWindow opened by main                  |
| `chrome.tabs.create({ url })`             | `shell.openExternal(url)`                            |
| `chrome.tabs.captureVisibleTab`           | `desktopCapturer.getSources({ types: ["screen"] })`  |
| `chrome.tabs.query`, `chrome.windows.*`   | `active-win` polling every 5 s                       |
| `chrome.tabs.onActivated / onUpdated`     | Same active-win polling → `onActiveTabChanged()`     |
| `chrome.alarms.create` / `onAlarm`        | `setInterval` scheduler in `background.js`          |
| `chrome.idle.setDetectionInterval`        | `powerMonitor.getSystemIdleTime()` polling           |
| `chrome.idle.onStateChanged`              | Same polling → `onIdleStateChanged(prev, next)`      |
| `chrome.action.setBadgeText`              | Tray tooltip + macOS dock badge                      |
| `chrome.scripting.executeScript`          | **Not applicable** — see "Click-trail scope" below   |

## What's identical

- Supabase URL, anon key, auth flow, token refresh, needs-reauth flag.
- Offline queue: same 500-cap, same 8-attempt drop rule.
- Ingest payload shapes: `session_start`, `activity`, `idle`, `heartbeat`,
  `screenshot`, `engagement`, `step`, `break_start`, `lunch_start`,
  `break_end`, `session_end`.
- Screenshot cadence: default 5 min, self-heal after 1.5× interval.
- Capture-request and session-command polling.
- Sleep/wake gap recovery: closes the abandoned session at
  `last_activity_at` when the gap exceeds `sessionTimeoutMin`.
- Version-check endpoint (`/api/public/extension-version`) and update banner
  shown in the popup.

## Click-trail scope reduction

The extension recorded every DOM click in every web page via the
`recorder.js` content script (`chrome.scripting.executeScript`).

On a desktop, cross-application DOM observation is not possible from
user-space Electron on any of the three target platforms — it would require
per-OS accessibility hooks (UI Automation on Windows, AXAPI on macOS,
AT-SPI on Linux). The desktop app therefore records workflow steps at
**window-title granularity** using `active-win`. Payload shape is
preserved (`kind: "step"`); the `label` is the window title and the `url`
is a synthetic `https://<app>.desktop/<title>` URL so downstream
consumers (SOP builder, blocklist matcher, `hostOf(...)`) work unchanged.

If per-DOM-click parity is required later, add a per-OS accessibility
listener behind a feature flag — the rest of the pipeline is unchanged.

## Screenshots

`chrome.tabs.captureVisibleTab` returned only the active browser tab. The
desktop app captures the **primary display** via `desktopCapturer`. This is
higher-fidelity (whole workspace) and matches the intent of a work tracker.
