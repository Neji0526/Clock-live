// Single source of truth for the current ClockWork Desktop (Electron) release.
// Bump these when shipping new installers to public/downloads/.
// Keep in sync with desktop/package.json "version".
export const DESKTOP_VERSION = "0.1.4";
// Below this, the desktop app shows a HARD "you must update" block.
// Must stay <= DESKTOP_VERSION or the app would hard-block itself.
export const MIN_DESKTOP_VERSION = "0.1.0";

// Installers are hosted on a separate PUBLIC GitHub repo's Release, so the asset
// URLs download without auth (this app's own repo is private). Keep DESKTOP_VERSION
// and these filenames in sync with the assets uploaded under the `desktop-apps`
// release tag.
const RELEASE_BASE =
  `https://github.com/Royal0106/desktop-apps-clockwork-/releases/download/desktop-apps`;


  
export const DESKTOP_DOWNLOADS = {
  windows: `${RELEASE_BASE}/ClockWork-Setup-${DESKTOP_VERSION}.exe`,
  mac: `${RELEASE_BASE}/ClockWork-${DESKTOP_VERSION}.dmg`,
  linux: `${RELEASE_BASE}/ClockWork-${DESKTOP_VERSION}.AppImage`,
} as const;
