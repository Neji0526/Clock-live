# public/downloads/

Placeholder folder. Do not commit installers here.

End-user desktop installers (`.exe`, `.dmg`, `.AppImage`) are hosted on the
private GitHub Release `release-desktop-apps` and streamed to users by the
server route `src/routes/api/public/download.$platform.ts` using
`GITHUB_RELEASE_TOKEN`. The `/install` page links to that endpoint via
`src/lib/desktop-version.ts` → `DESKTOP_DOWNLOADS`.
