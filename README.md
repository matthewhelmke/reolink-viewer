# reolink-viewer

A local web app to view and monitor Reolink cameras connected to a Reolink Hub Pro.

> This is a work in progress. See [Next steps](#next-steps) for what is planned but not yet built.


## Description

reolink-viewer is a web app that runs on your local area network (LAN) and connects to a Reolink Hub Pro to display live camera feeds, device status, and recorded video. The goal is two modes of operation: Basic and Admin. Admin mode inherits all rules from Basic mode unless specifically noted.

I can do everything this app does using the official Android app from Reolink, so I didn't need to create the webapp — this project exists because I wanted to learn how to run AI agents and models locally and start experimenting. See [Acknowledgements](#acknowledgments).

> **LAN only.** This app is designed exclusively for use on a trusted home LAN. Do not expose it to the internet.

> **Hardware note:** The [Reolink Hub Pro](https://reolink.com/product/reolink-home-hub-pro/) is the only hub device available for testing. Behavior may differ on other Reolink Hub and NVR devices.


### What it does now (Basic mode)

- Displays hub device info (model, firmware, hardware version) in a sidebar
- Shows each connected camera in the sidebar with a colored status dot, a snapshot thumbnail that refreshes every 30 seconds, and a last-refreshed timestamp
- Camera sidebar order is user-adjustable with ▲▼ buttons; order persists in browser storage across page loads and server restarts
- Clicking a sidebar camera focuses it in the main area; the focused card fills the full viewport
- Live tab offers two quality modes: **Low quality** (MJPEG snapshots, ~1–2 fps) and **High quality** (RTSP stream transcoded server-side via FFmpeg, true video)
- Updates camera status and thumbnails automatically every 30 seconds without a page reload
- Recovers gracefully from stream errors
- Searches recorded video by date/time range per camera
- Plays back recorded clips in the browser — video starts streaming within ~1–2 seconds of clicking Play, transcoded server-side from H.265 to H.264
- Password-protected: viewer and admin roles, 1-year session cookies, login page at `/login`


### Admin mode (in progress — v0.0.3-beta)

Admin mode is under active development and incomplete. What exists today:

- A separate `/admin` page, accessible only to the `admin` role
- An **Admin** link appears in the viewer sidebar for admin sessions
- The admin page displays hub info, connected camera list, and a raw dump of the hub's `GetAbility` response (useful for feature discovery)
- `requireAdmin` middleware gates all `/api/admin/*` routes and the `/admin` page — viewer-role sessions receive 403 on API routes and are redirected to `/` on page routes

What is planned but not yet built:
- **Cross-camera event history** — search all channels in parallel, merged by timestamp, with event-type filtering
- **PTZ control** — only if `GetAbility` confirms a connected camera supports it
- **Encoding and AI config** — read-only view of `GetEnc` and `GetAiCfg` per channel, write ops later

Note: this app uses the [Reolink native HTTPS API](https://github.com/verheesj/reolink-api) exclusively. ONVIF is not used and has been disabled on the hub.

### Next steps

- **Dynamic camera discovery** — add/remove camera cards without a page reload
- **Admin mode** — complete event history, PTZ (if supported), and encoding/AI config views


### A note on live video quality

The Live tab offers two modes. **Low quality** uses MJPEG: the server fetches a JPEG snapshot from each camera roughly every half second and streams the frames to the browser, producing 1–2 frames per second on a typical home LAN. **High quality** uses the hub's RTSP stream: FFmpeg reads the stream over TCP and transcodes it to H.264 fragmented MP4, which the browser plays as true video. High quality starts in ~2 seconds and provides full frame rate.

### A note on recording playback

The Hub Pro stores recordings as H.265 (HEVC) in a non-standard FLV container. The server rewrites these in-flight to the Enhanced FLV format that FFmpeg understands, then transcodes to H.264 fragmented MP4 (scaled to 1920px wide) for browser playback. The browser streams the MP4 directly as it arrives, so video starts playing within 1–2 seconds of clicking Play. The hub streams recordings at roughly real-time speed, so longer clips continue downloading in the background while playing — brief buffering pauses are normal.


## Reolink Hub Pro settings

Some aspects of this application require specific settings in the Reolink Hub Pro app.

### Network (Device Info > Network Information)

- The hub defaults to DHCP. You'll need its assigned IP address for the `.env` file. Set a static IP or a DHCP reservation if you want the address to stay fixed.

### Server settings (Advanced Network Settings > Server Settings > Basic Service)

| Setting | Required state | Notes |
|---------|---------------|-------|
| HTTPS   | **On**        | All API calls and snapshot fetches use HTTPS. Required. |
| HTTP    | Off           | Not needed; tested and disabled. |
| RTSP    | On            | On and used by the higher-quality streaming option. |
| RTMP    | Off           | Tested and disabled. Not usable by the browser or server. |
| ONVIF   | **Off**       | Disabled 2026-04-19 — not used by this app (native Reolink API only). Disabling reduces attack surface. |


## Getting started

### Dependencies

- [Node.js](https://nodejs.org/en/download) 18 or later (includes npm)
- **FFmpeg** (git snapshot build) — required for recording playback

#### Installing FFmpeg

> **Docker users:** FFmpeg is installed automatically when building the Docker image. Skip this section if you are deploying with Docker Compose.

The Ubuntu 24.04 packaged FFmpeg (6.1.1) does not support Reolink's HEVC recording format. A git snapshot build from John Van Sickle's static builds is required:

```bash
mkdir -p bin
cd bin
wget https://johnvansickle.com/ffmpeg/builds/ffmpeg-git-amd64-static.tar.xz
tar -xf ffmpeg-git-amd64-static.tar.xz --strip-components=1 --wildcards '*/ffmpeg'
rm ffmpeg-git-amd64-static.tar.xz
cd ..
chmod +x bin/ffmpeg
```

The binary goes in `bin/ffmpeg` relative to the project root. The `bin/` directory is gitignored and will not be committed.

### Installing

1. Clone the repository:
   ```
   git clone git@github.com:matthewhelmke/reolink-viewer.git
   ```
   Or with HTTPS: `git clone https://github.com/matthewhelmke/reolink-viewer.git`
2. Install Node.js dependencies:
   ```
   npm install
   ```
3. Install FFmpeg as described above.
4. Create `.env` in the project root:
   ```
   REOLINK_NVR_HOST=192.168.x.x
   REOLINK_NVR_USER=admin
   REOLINK_NVR_PASS=your_hub_password

   VIEWER_PASSWORD=choose_a_shared_family_password
   ADMIN_PASSWORD=choose_a_strong_admin_password
   SESSION_SECRET=   # generate with: openssl rand -hex 32
   ```
   All six variables are required — the server exits at startup if any are missing.
   `.env` is listed in `.gitignore` and will never be committed to version control.

### Running

**Docker (recommended for LAN deployment)** — builds the image and runs in the background:
```
docker compose up --build -d
```
The first build takes a few minutes while apt downloads FFmpeg. Subsequent starts reuse the cached image — omit `--build` unless you have code changes. Access the app at `http://<host-ip>:3000` from any device on the LAN.

**Development** — runs directly from TypeScript source, no build step required:
```
npm run dev
```

**Production (without Docker)** — compile first, then run the compiled output:
```
npm run build
npm start
```

Open `http://localhost:3000` in a browser on the same machine. The terminal confirms a successful start:

```
Authenticated to Reolink Hub at 192.168.x.x
Reolink Viewer running at http://localhost:3000
```

If authentication fails at startup, the server exits immediately with an error message describing the cause.


## Repository contents

```
reolink-viewer/
├── .dockerignore         Files excluded from the Docker build context
├── .env                  Hub credentials (gitignored, never committed)
├── .gitignore
├── AGENTS.md             Instructions and context for AI agents working on this project
├── docker-compose.yml    Docker Compose service definition
├── Dockerfile            Multi-stage build: TypeScript compile + ubuntu:25.04 runtime
├── LICENSE.md            MIT License
├── package.json          Project metadata and npm scripts
├── package-lock.json     Locked dependency versions
├── README.md
├── tsconfig.json         TypeScript compiler configuration
├── bin/                  Local binaries (gitignored)
│   └── ffmpeg            FFmpeg git snapshot — required for dev without Docker, not committed
├── public/
│   ├── index.html        Browser frontend — structure and styles
│   ├── login.html        Login page (self-contained, no auth required to load)
│   ├── app.js            Browser frontend — vanilla JS, no framework
│   ├── admin.html        Admin page (in progress)
│   ├── admin.js          Admin page frontend (in progress)
│   └── js/
│       └── flv.min.js    flv.js library (included but not currently used)
└── src/
    ├── index.ts          Server entry point: env validation, Reolink client, app.listen
    ├── app.ts            Express app factory: all routes and middleware
    ├── utils.ts          Pure helper functions (cookies, session signing, error handling)
    ├── flv-transform.ts  FLV transform stream: rewrites Reolink codec-12 HEVC tags
    │                     to Enhanced FLV 'hvc1' for FFmpeg compatibility
    ├── flv-transform.test.ts  Unit tests for FLV transform
    └── index.test.ts     Integration tests for all routes and utilities
```

`dist/` (compiled output) and `node_modules/` (dependencies) are generated locally and are gitignored.


## Authors

[Matthew Helmke](https://github.com/matthewhelmke) with the assistance of all listed in [Acknowledgements](#acknowledgments).


## License

This project is licensed under the MIT License - see the [LICENSE.md](./LICENSE.md) file for details.


## Acknowledgments

I wrote this, but not in a vacuum. As noted in the [Description](#description), this project exists because I wanted to learn how to run AI agents and models locally and start experimenting.

The most effective AI agent and model that I used is [Claude Code](https://code.claude.com/docs/en/overview), mostly using the Claude Sonnet 4.6 model.

I have also used [LocalAI](https://localai.io) and many different LLM models, including (I don't think I have missed any, but it's possible):

- agentica-org_deepswe-preview
- codellama-7b
- deepseek-coder-v2-lite-instruct
- ibm-granite.granite-4.0-1b
- magnum-v3-34b
- mistralai_devstral-small-2505
- mistralai_ministral-3-14b-reasoning-2512-multimodal
- opencoder-8b-base
- qwen3.5-27b-claude-4.6-opus-reasoning-distilled-i1


[Reolink](https://reolink.com/) makes the cameras and hub this app talks to. Their [software for Windows, Mac, iOS, and Android](https://reolink.com/us/software-and-manual/) handles everything this app does and more. There would be no point in any of this if I hadn't already built and installed a system based on their equipment.

The [reolink-nvr-api](https://github.com/verheesj/reolink-api) is a comprehensive TypeScript SDK and CLI for Reolink NVR and IP Camera devices, MIT licensed. The server uses it for all hub communication.

Unofficial and official [Reolink API documentation](https://github.com/mnpg/Reolink_api_documentations) gathered by community members was useful for understanding the API.

The [ReolinkCameraAPI GitHub](https://github.com/ReolinkCameraAPI) has repositories for building applications that interact with Reolink cameras and hubs. I read through it but didn't use it, as it focuses on languages I wasn't using for this project.

The [reolink-fw](https://github.com/AT0myks/reolink-fw) repository and [reolink-fw-archive](https://github.com/AT0myks/reolink-fw-archive) are tools for working with Reolink firmware. I didn't use them but found them informative.

The [Reolink Community website](https://community.reolink.com/) has user-generated content including questions, answers, and troubleshooting. I browsed it and was ready to ask questions, but didn't need to.
