import { createFileRoute } from "@tanstack/react-router";
import { DESKTOP_VERSION } from "@/lib/desktop-version";

// Streams desktop installers from the PRIVATE GitHub Release
// (tag: release-desktop-apps) through this server, so end users can download
// them without a GitHub account. The GitHub token stays server-side.
//
// GitHub release asset URLs on private repos require auth — direct linking
// gives users a 404. Instead we call the GitHub API with a PAT and stream
// the bytes back through this same-origin endpoint.

const GITHUB_OWNER = "AI4B-Team";
const GITHUB_REPO = "auto-sop-hero";
const RELEASE_TAG = "release-desktop-apps";

type Platform = "windows" | "mac" | "linux";

const PLATFORM_FILES: Record<Platform, { filename: string; contentType: string }> = {
  windows: {
    filename: `ClockWork-Setup-${DESKTOP_VERSION}.exe`,
    contentType: "application/octet-stream",
  },
  mac: {
    filename: `ClockWork-${DESKTOP_VERSION}.dmg`,
    contentType: "application/x-apple-diskimage",
  },
  linux: {
    filename: `ClockWork-${DESKTOP_VERSION}.AppImage`,
    contentType: "application/octet-stream",
  },
};

export const Route = createFileRoute("/api/public/download/$platform")({
  server: {
    handlers: {
      OPTIONS: async () =>
        new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, OPTIONS",
            "Access-Control-Allow-Headers": "*",
          },
        }),

      GET: async ({ params }) => {
        const platform = params.platform as Platform;
        const meta = PLATFORM_FILES[platform];
        if (!meta) {
          return new Response("Unknown platform", { status: 404 });
        }

        const token =
          process.env.GITHUB_PERSONAL_ACCESS_TOKEN ?? process.env.GITHUB_RELEASE_TOKEN;
        if (!token) {
          console.error("[download] GITHUB_PERSONAL_ACCESS_TOKEN is not configured");
          return new Response("Download temporarily unavailable", { status: 503 });
        }

        const apiBase = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}`;
        const commonHeaders = {
          Authorization: `Bearer ${token}`,
          "User-Agent": "clockwork-app",
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        };

        // 1. Look up the release by tag to get asset IDs.
        const releaseRes = await fetch(`${apiBase}/releases/tags/${RELEASE_TAG}`, {
          headers: commonHeaders,
        });
        if (!releaseRes.ok) {
          const body = await releaseRes.text().catch(() => "");
          console.error("[download] release lookup failed", releaseRes.status, body.slice(0, 200));
          return new Response("Release not found", { status: 502 });
        }
        const release = (await releaseRes.json()) as {
          assets: Array<{ id: number; name: string; size: number }>;
        };

        const asset = release.assets.find((a) => a.name === meta.filename);
        if (!asset) {
          console.error(
            "[download] asset not found",
            meta.filename,
            "available:",
            release.assets.map((a) => a.name).join(", "),
          );
          return new Response(`Installer not published yet: ${meta.filename}`, { status: 404 });
        }

        // 2. Fetch the asset bytes. Accept: application/octet-stream tells the
        //    GitHub API to return the file itself (via a signed redirect).
        const assetRes = await fetch(`${apiBase}/releases/assets/${asset.id}`, {
          headers: {
            ...commonHeaders,
            Accept: "application/octet-stream",
          },
          redirect: "follow",
        });
        if (!assetRes.ok || !assetRes.body) {
          console.error("[download] asset fetch failed", assetRes.status);
          return new Response("Failed to fetch installer", { status: 502 });
        }

        // 3. Stream to the client with a Save-As filename.
        return new Response(assetRes.body, {
          status: 200,
          headers: {
            "Content-Type": meta.contentType,
            "Content-Disposition": `attachment; filename="${meta.filename}"`,
            "Content-Length": String(asset.size),
            "Cache-Control": "public, max-age=300",
            "Access-Control-Allow-Origin": "*",
          },
        });
      },
    },
  },
});
