# ClockWork Desktop

Cross-platform (Windows / macOS / Linux) desktop edition of the ClockWork time
and work tracker. Migrated from the Chrome extension — same server, same
data model, same business rules.

## Run in development

```bash
cd electron-app
npm install
npm start
```

## Build native installers

```bash
npm run dist:win     # → Clockwork-win-x64.exe (NSIS installer)
npm run dist:mac     # → Clockwork-mac-x64.dmg  (unsigned unless you configure signing)
npm run dist:linux   # → Clockwork-linux-x64.AppImage + .deb
```

Build outputs land in `electron-app/dist-out/`. Cross-compiling a signed macOS
`.dmg` requires macOS. A signed Windows `.exe` requires a code-signing cert.

## Architecture

- `main/main.js` — Electron main process: window, tray, IPC.
- `main/background.js` — ported extension background logic.
- `main/preload.js` — exposes a `chrome`-shaped shim on `window` so the
  extension's popup.js runs unchanged.
- `main/storage.js` — `chrome.storage.local` implemented on top of
  `electron-store`.
- `renderer/popup.html` + `popup.js` — verbatim copies from the extension.
- `renderer/options.html` + `options.js` — verbatim copies.

See `MIGRATION.md` for the Chrome → Electron API mapping.
