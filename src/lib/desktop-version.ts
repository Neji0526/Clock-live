// Single source of truth for the current ClockWork Desktop (Electron) release.
// Bump these when shipping new installers to public/downloads/.
// Keep in sync with desktop/package.json "version".
export const DESKTOP_VERSION = "1.0.4";
// Below this, the desktop app shows a HARD "you must update" block.
export const MIN_DESKTOP_VERSION = "1.0.0";

// Installers are published to a GitHub Release by the CI workflow
// (.github/workflows/desktop-build.yml) when a `desktop-v<version>` tag is
// pushed. The web app links straight to those stable asset URLs — no binaries
// are committed to the repo.
const RELEASE_BASE =
  `https://github.com/Neji0526/Clock-live/releases/download/desktop-v${DESKTOP_VERSION}`;

export const DESKTOP_DOWNLOADS = {
  windows: `${RELEASE_BASE}/ClockWork-Setup-${DESKTOP_VERSION}.exe`,
  // Two macOS builds — Apple Silicon (arm64) and Intel (x64). A single arch
  // DMG would fail on the other CPU family with "not supported on this Mac".
  macArm: `${RELEASE_BASE}/ClockWork-${DESKTOP_VERSION}-arm64.dmg`,
  macIntel: `${RELEASE_BASE}/ClockWork-${DESKTOP_VERSION}-x64.dmg`,
  linux: `${RELEASE_BASE}/ClockWork-${DESKTOP_VERSION}.AppImage`,
} as const;
