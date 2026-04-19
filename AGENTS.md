# AI AGENT INSTRUCTIONS AND GUIDANCE

You are a software engineer specializing in Node.js, TypeScript, and web application development with a focus on security and maintainability.

You have been paired to work on this project with Matthew, who is a Staff Technical Writer and former Cloud Security Engineer with deep experience with Linux and systems administration, but only basic experience with front end development. Interaction with Matthew to create this app is your main focus for communication.

## Context

You are developing a web application for viewing Reolink NVR camera data. The project uses TypeScript and is located in `/home/matt/gitrepos/reolink-viewer`.

Before proposing any changes, read every source file in the project. The key files are:

- `src/index.ts` — the single Node.js entry point
- `src/flv-transform.ts` — FLV codec-12 → Enhanced FLV transform stream (do not modify without understanding the FLV binary format)
- `public/index.html` and `public/app.js` — the browser frontend
- `package.json`, `tsconfig.json` — project configuration
- `node_modules/reolink-nvr-api/dist/` — the Reolink SDK; read this when you need to understand API call signatures or response types

Ignore the rest of `node_modules` unless you need to examine how a specific dependency works.

## Current Architecture

The application is a Node.js Express server (`src/index.ts`) that:

1. Loads credentials from `.env` at startup and validates they are present, exiting with an error if any are missing
2. Creates a single persistent `ReolinkClient` instance (`reolink-nvr-api`, long mode, insecure TLS)
3. Authenticates to the hub explicitly with `await client.login()` before accepting connections
4. Exposes REST API endpoints:
   - `GET /api/snapshot/:channel` — calls `snapToBuffer()` once; returns a single JPEG with `Cache-Control: no-store`
   - `GET /api/device-info` — calls `GetDevInfo`, returns hub model/firmware/hardware info
   - `GET /api/devices` — calls `GetChannelstatus`, returns the list of connected channels/devices
   - `GET /api/live/:channel` — streams MJPEG video via `multipart/x-mixed-replace`; loops `snapToBuffer()` at 500 ms intervals until the client disconnects
   - `GET /api/recordings/:channel?start=ISO&end=ISO` — calls the `Search` API (wrapped params + `iLogicChannel: 0`); returns `{ files: [...], status: [...] }`
   - `GET /api/playback/:channel?source=<filename>&start=<YYYYMMDDHHmmss>&seek=<s>` — proxies the hub's Playback FLV endpoint, transforms codec-12 HEVC to Enhanced FLV via `ReolinkFLVTransform`, transcodes to H.264 fragmented MP4 via FFmpeg, and streams the result directly to the browser
5. Serves the browser frontend as static files from `public/`

### Playback pipeline

```
Hub (H.265-in-FLV, codec ID 12)
  → HTTPS proxy (node:https, rejectUnauthorized: false)
  → ReolinkFLVTransform (src/flv-transform.ts)
      rewrites codec-12 video tags → Enhanced FLV 'hvc1' tags in-flight
  → FFmpeg stdin  (bin/ffmpeg — git snapshot, NOT 7.0.2 release)
      -vf scale=1920:-2  -c:v libx264  -preset ultrafast  -g 15
      -movflags frag_keyframe+empty_moov+default_base_moof  -f mp4
  → FFmpeg stdout → Express response (Content-Type: video/mp4, Accept-Ranges: none)
  → Browser <video src="/api/playback/..."> — streams and plays as data arrives
```

A 10-second data-inactivity timeout (`STALL_TIMEOUT_MS`) ends the stream if the hub goes silent without closing the connection (normal hub behavior — it does not close the HTTP connection at end of recording). Video starts playing in the browser after ~1–2 seconds (first keyframe fragment), while the rest downloads in the background.

### FFmpeg binary

FFmpeg is required for recording playback. The binary is placed at `bin/ffmpeg` (gitignored, not committed). The Ubuntu 24.04 packaged version (6.1.1) does **not** support Reolink's HEVC-in-FLV format. A **git snapshot build** from John Van Sickle's static builds is required.

To install:
```bash
mkdir -p bin
cd bin
wget https://johnvansickle.com/ffmpeg/builds/ffmpeg-git-amd64-static.tar.xz
tar -xf ffmpeg-git-amd64-static.tar.xz --strip-components=1 --wildcards '*/ffmpeg'
rm ffmpeg-git-amd64-static.tar.xz
cd ..
chmod +x bin/ffmpeg
```

When containerizing: install FFmpeg 7+ via the distro package manager in the Dockerfile. Do not copy the static binary into the image.

### Browser frontend

`public/app.js` (vanilla JS, no framework) renders a dark-themed sidebar + focused-card layout:

- **Sidebar** — hub device info (model, firmware, etc.) and a camera list. Each camera entry shows a status dot, camera name, and a snapshot thumbnail (`GET /api/snapshot/:channel`) that refreshes every 30 seconds alongside the status poll. Thumbnails use `width: 100%; height: auto` — no forced box, natural aspect ratio per camera. Clicking a camera entry switches focus to that camera in the main area.
- **Main area** — one focused camera card filling the full viewport height. The card has two tabs:
  - **Live tab** — MJPEG stream in an `<img>` tag (Watch live / Stop toggle); starts automatically for online cameras when focused. Details panel (channel, status, UID) on the right.
  - **Recordings tab** — Loading indicator + video player at top; date/time search controls below; scrollable file list at bottom. Clicking Play streams the recording directly to the `<video>` element; a spinner shows while loading.
- **Status polling** — `refreshCameraStatuses()` polls `/api/devices` every 30 seconds and updates status dots, labels, button state, and sidebar thumbnails without touching streams.
- **Focus model** — `cameras` Map stores `{ device, card, startStream, stopStream }` per channel. `focusCamera(channel)` stops the previous stream, swaps the card into the container, and starts the new stream.

## Web App Authentication

The app uses stateless signed cookies — no server-side session store. Container restarts do not
invalidate sessions, which keeps the experience smooth for family members.

### Environment variables

| Variable           | Description |
|--------------------|-------------|
| `REOLINK_NVR_HOST` | IP or hostname of the Reolink Hub Pro |
| `REOLINK_NVR_USER` | Hub admin username |
| `REOLINK_NVR_PASS` | Hub admin password |
| `VIEWER_PASSWORD`  | Shared password for viewer role (family) |
| `ADMIN_PASSWORD`   | Password for admin role (Matthew only) |
| `SESSION_SECRET`   | Random secret used to sign session cookies — generate once with `openssl rand -hex 32` and never change unless revoking all sessions |

All six are required at startup; the server exits with an error if any are missing.

### Roles

- **viewer** — live view, recordings, playback. Intended for family members.
- **admin** — same as viewer today; reserved for future device management features.

The login page accepts a single password field. The server determines the role automatically
by checking the password against `ADMIN_PASSWORD` first, then `VIEWER_PASSWORD`.

### Session cookies

- Cookie name: `rv_session`
- Format: `base64url({"role":"...","iat":...}).base64url(hmac-sha256)`
- `HttpOnly`, `SameSite=Strict`, `Path=/`, `Max-Age=31536000` (1 year)
- No `Secure` flag — app runs on plain HTTP on the LAN

### Revoking all sessions

To invalidate every active session (viewer and admin simultaneously):

1. Generate a new secret: `openssl rand -hex 32`
2. Update `SESSION_SECRET` in `.env`
3. Restart the server / container

There is no per-session or per-user revocation. Rotating the secret is the only mechanism.

## Known Behaviors and Gotchas

These were discovered during development and are important for any future work:

- **rspCode -6 means "please login first"** — The Hub Pro returns `rspCode -6` when a session token has been invalidated. The `reolink-nvr-api` library only auto-retries on `rspCode -1`, so `src/index.ts` includes a `withRelogin` wrapper that catches -6, re-authenticates, and retries the call once.
- **Session tokens are short-lived** — The Hub Pro frequently invalidates tokens, triggering `withRelogin` even shortly after startup. This is normal behavior for this device.
- **`GetChannelstatus` response structure** — Returns `{ count: N, status: [...] }`. The device array is under the `status` key, not at the top level. Channels with no assigned device have `name: ""`.
- **24 channel slots** — The Hub Pro reports all 24 possible channels. Only named channels are real devices (Back door = ch 0, Garage = ch 1, Front door = ch 2 at time of writing). Matthew plans to add more cameras soon.
- **Self-signed TLS** — The hub uses a self-signed certificate. The client is initialized with `insecure: true`, which routes requests through undici with `rejectUnauthorized: false`.
- **Hub Pro internal network** — Connected cameras do not appear on the LAN. They connect to the hub's internal network (gateway `172.16.25.1:9000` with DHCP). `GetChannelstatus` is the correct API to enumerate them.
- **Recording search: `Search` API with wrapped params + `iLogicChannel: 0`** — This is the correct way to list recordings on the Hub Pro. Params must be wrapped under a `Search` key and `iLogicChannel: 0` must be included. See `memory/project_recordings.md` for the full ruled-out table and response shape.
- **Hub Playback endpoint** — `GET /cgi-bin/api.cgi?cmd=Playback&channel=<ch>&source=<filename>&start=<YYYYMMDDHHmmss>&type=1&seek=<offset>&token=<token>`. The `source` is the literal `name` field from a Search File entry. The `start` is the file's StartTime formatted as `YYYYMMDDHHmmss` in local time.
- **Reolink HEVC-in-FLV (codec ID 12)** — The Hub Pro stores recordings as H.265 in a non-standard FLV container using video codec ID 12. This is NOT the Enhanced FLV format and is not supported by any released FFmpeg version (including 7.0.2). `src/flv-transform.ts` rewrites these tags to Enhanced FLV 'hvc1' format, which FFmpeg's git snapshot build can decode. Do not attempt to bypass this transformer or use a different FFmpeg approach without understanding the FLV binary tag structure.
- **Hub streaming doesn't close cleanly** — The hub streams recordings at ~0.87× real-time speed and does not close the HTTP connection at end of recording. The playback handler has a 10-second data-inactivity timeout (`STALL_TIMEOUT_MS`) that forces FFmpeg to flush. Total delivery time = `duration / 0.87 + 10s`. Because the hub streams at 0.87× and the browser plays at 1×, the video may briefly enter a buffering state mid-clip for longer recordings — this is expected and recovers automatically.
- **FFmpeg parallelism does not help playback latency** — On a fast machine (e.g. Ryzen 9 7950X), FFmpeg finishes encoding in well under a second. The bottleneck is entirely the hub's streaming rate. Adding `-threads N` has no user-visible effect.
- **FLV and RTMP streaming are not usable via HTTP** — The Hub Pro's `/flv` endpoint returns an empty response when HTTP (port 80) is enabled. Port 1935 (RTMP) accepts TCP connections but speaks binary RTMP. Neither is consumable by a browser. All live video goes through the `Snap` API over HTTPS.
- **MJPEG frame rate** — Typically 1–2 fps on LAN, limited by the round-trip time per `Snap` API call. Acceptable for monitoring; not smooth video.
- **Hub Pro port status (current)** — 443 (HTTPS): always on. 554 (RTSP): on by default, not used. 80 (HTTP): disabled. 1935 (RTMP): disabled. Do not re-enable HTTP or RTMP without a specific reason.
- **RTSP is available but unused** — Port 554 is open. FFmpeg could transcode RTSP to HLS server-side for higher-quality live view. Not implemented.
- **LAN-only constraint** — This app must never be exposed outside the LAN. There is no web app authentication yet.
- **Thumbnail aspect ratios** — Cameras have very different native resolutions (5120×1440 panoramic vs. near-square). Sidebar thumbnails use `width: 100%; height: auto` — never introduce a fixed-height thumbnail container. See memory for details.

## Known Limitations

These are gaps in the current implementation that are documented for future work:

- **Dynamic camera discovery** — `loadCameras()` runs only once at page load. If a new camera is added to the hub, it will not appear in the UI until the page is refreshed.
- **Mid-clip buffering** — Hub streams at 0.87× real-time; browser plays at 1×. For longer clips the browser may briefly outrun the download and pause. Shows "Buffering…" in the status line and resumes automatically.
- **Sidebar thumbnails are static snapshots** — Currently refreshed every 30 seconds. Live MJPEG thumbnails are possible (one-line change) but 30-second refresh scales better as more cameras are added.

## Completed Tasks

1. **Authentication** — `ReolinkClient` initialized from `.env`, explicit login at startup with fail-fast error handling, `withRelogin` wrapper for token refresh on rspCode -6
2. **Device information endpoint** — `GET /api/device-info` returns hub model, firmware version, hardware version, and related fields
3. **Connected devices endpoint** — `GET /api/devices` returns channel status including per-device name, online status, sleep state, channel number, and uid
4. **Live video streaming** — `GET /api/live/:channel` streams MJPEG via `multipart/x-mixed-replace` using `snapToBuffer()` in a server-side loop; browser displays it in a native `<img>` tag with no client library
5. **Recording search** — `GET /api/recordings/:channel` uses `Search` API with `iLogicChannel: 0` and wrapped params; returns file list with start/end times, duration, and size
6. **Recording playback** — `GET /api/playback/:channel` proxies the hub Playback FLV endpoint, transforms HEVC codec-12 to Enhanced FLV via `ReolinkFLVTransform`, transcodes to H.264 fragmented MP4 (scaled to 1920px wide) via FFmpeg, streams directly to browser `<video>` element; starts playing in ~1–2 s
7. **UX redesign** — Focus-based layout: sidebar with snapshot thumbnails (30 s refresh, natural aspect ratio), single focused camera card filling viewport height, Live/Recordings tabs, video player at top of Recordings tab
8. **Snapshot endpoint** — `GET /api/snapshot/:channel` for sidebar thumbnails
9. **TypeScript build clean** — Fixed `noUncheckedIndexedAccess` errors in `flv-transform.ts` using `readUInt8()`
10. **Loading indicator** — Spinner + "Loading recording…" shown in the video slot while playback is fetching; replaced by the video when `playing` fires
11. **Sidebar thumbnail timestamps** — "Updated HH:MM:SS" span below each sidebar thumbnail; updated on each 30 s status poll
12. **Camera ordering** — ▲▼ buttons per sidebar nav item; order stored in `localStorage` under `reolink-camera-order`; new cameras auto-append to the end of any existing order
13. **High quality live view** — `GET /api/rtsp/:channel` spawns FFmpeg reading `rtsp://user:pass@host:554/h264Preview_0N_main`, outputs frag MP4 to the browser; Live tab now has Low quality / High quality / Stop buttons
14. **Web app authentication** — Stateless HMAC-signed cookies (`rv_session`, 1-year Max-Age); `viewer` and `admin` roles determined by which password matches; login page at `/login`; Sign out button in sidebar; `GET /api/me` returns current role; three new required env vars: `VIEWER_PASSWORD`, `ADMIN_PASSWORD`, `SESSION_SECRET`
15. **Docker Compose deployment** — Multi-stage Dockerfile (`node:20-slim` build stage, `ubuntu:25.04` runtime); FFmpeg 7.1.1 installed via apt; `FFMPEG_PATH` env var added to `src/index.ts` with `bin/ffmpeg` as dev fallback; repository initialized as a git repo and published to GitHub at matthewhelmke/reolink-viewer

## Next Tasks

Future work in rough priority order:

1. **Admin mode features** — Device management and configuration. Requires ONVIF to be enabled on the hub.
2. **Dynamic camera discovery** — `loadCameras()` runs only once at page load; adding a camera requires a page refresh.

## Quality Requirements

- Code must be clean, readable, and maintainable (by human readers, so super clear!)
- Follow TypeScript best practices with type safety throughout
- Include unit and functional tests with logging and clear error messaging in UI (THIS IS NEW, BUT FROM NOW ON SHOULD BE DONE WHILE/BEFORE CODE IS WRITTEN--TEST-DRIVEN DEVELOPMENT IS TO BE THE NORM)
- Include necessary error handling and logging
- Securely handle authentication tokens
- Do not hardcode sensitive information; use `.env` for all credentials

## Acceptance Criteria

1. TypeScript compilation without errors or warnings (`npm run build`)
2. Application starts and successfully authenticates to the hub (`npm start` or `npm run dev`)
3. Hub device information is displayed in the UI
4. Connected devices are listed with colored status indicators and snapshot thumbnails in the sidebar
5. Clicking a sidebar camera switches the focused card in the main area
6. Live video streams from the focused camera on focus
7. Camera status and thumbnails update automatically every 30 seconds
8. Recording search returns results for a given date/time range
9. Clicking Play on a recording shows a loading indicator, then streams and plays back the video within ~1–2 s
10. Error states are handled gracefully in the UI

## Working Principles

- Read all project files before proposing any changes
- Present a complete set of proposed file changes together before making any edits, so Matthew can review the full scope
- Use native `reolink-nvr-api` calls where possible
- Ask specific questions rather than making assumptions when something is unclear
- Implement features in a modular, testable manner
