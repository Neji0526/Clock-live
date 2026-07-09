// Screenshot capture — the Electron equivalent of chrome.tabs.captureVisibleTab.
//
//   * web target   -> webContents.capturePage() of the active embedded tab
//                     (a faithful 1:1 replacement for "capture the visible tab").
//   * screen target-> desktopCapturer of the primary display (captures whatever
//                     native app the VA is in — the transparent-tracking intent
//                     is preserved for the whole desktop).
//
// Output is always a JPEG data URL, matching the extension's
// { format: "jpeg", quality } contract so the ingest payload is unchanged.

const { desktopCapturer, screen, webContents, nativeImage } = require("electron");
const os = require("os");
const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");

function toJpegDataUrl(image, quality) {
  const q = Math.max(1, Math.min(100, Number(quality) || 55));
  const buf = image.toJPEG(q);
  return "data:image/jpeg;base64," + buf.toString("base64");
}

function safeUnlink(p) {
  try { fs.unlinkSync(p); } catch (e) { /* best-effort */ }
}

// macOS: capture the primary display with the native `screencapture` utility.
// Electron's desktopCapturer is unreliable on macOS — getSources() commonly
// returns empty/blank thumbnails (ScreenCaptureKit backend quirks, and the
// Screen Recording grant is keyed to the exact code signature), which made
// captureScreen() return null and upload nothing. The OS tool is the canonical,
// dependable path. It still requires Screen Recording permission; without it
// macOS yields a desktop-only image rather than failing.
function captureScreenMac(quality) {
  return new Promise((resolve) => {
    const out = path.join(
      os.tmpdir(),
      `cw-shot-${Date.now()}-${Math.random().toString(36).slice(2)}.png`,
    );
    // -x: silent (no shutter sound)   -t png: format   -m: main display only
    execFile("/usr/sbin/screencapture", ["-x", "-t", "png", "-m", out], { timeout: 15_000 }, (err) => {
      if (err) { safeUnlink(out); return resolve(null); }
      try {
        const img = nativeImage.createFromPath(out);
        safeUnlink(out);
        if (!img || img.isEmpty()) return resolve(null);
        resolve(toJpegDataUrl(img, quality)); // re-encode to honor the JPEG quality contract
      } catch (e) {
        safeUnlink(out);
        resolve(null);
      }
    });
  });
}

// Capture from a webContents instance directly (used for click-trail step shots,
// where core.js already holds the sender webContents).
async function captureFrom(wc, quality) {
  if (!wc || wc.isDestroyed()) return null;
  const img = await wc.capturePage();
  if (!img || img.isEmpty()) return null;
  return toJpegDataUrl(img, quality);
}

// Capture a specific embedded web tab by its webContents id (used for periodic
// shots when the browser tab is active).
async function captureWebContents(id, quality) {
  const wc = webContents.fromId(id);
  return captureFrom(wc, quality);
}

// Capture the primary display. Robust against empty thumbnails: tries full
// resolution first, then falls back to a capped size (some GPU/driver combos
// return an empty image for very large thumbnailSize requests).
async function captureScreen(quality) {
  // On macOS, prefer the native screencapture tool; only fall back to
  // desktopCapturer if it fails to produce an image.
  if (process.platform === "darwin") {
    const viaNative = await captureScreenMac(quality);
    if (viaNative) return viaNative;
  }

  const display = screen.getPrimaryDisplay();
  const { width, height } = display.size;
  const sf = display.scaleFactor || 1;

  const sizes = [
    { width: Math.round(width * sf), height: Math.round(height * sf) },
    { width: Math.round(width), height: Math.round(height) }, // fallback: no scale
    { width: 1920, height: 1080 }, // last-resort cap
  ];

  for (const thumbnailSize of sizes) {
    let sources;
    try {
      sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize });
    } catch (e) {
      continue;
    }
    // Prefer the first source whose thumbnail is non-empty.
    const src = (sources || []).find((s) => s.thumbnail && !s.thumbnail.isEmpty());
    if (src) return toJpegDataUrl(src.thumbnail, quality);
  }
  return null;
}

module.exports = { captureFrom, captureWebContents, captureScreen };
