import express from 'express';
import path from 'node:path';
import https from 'node:https';
import { spawn } from 'node:child_process';

import { ReolinkFLVTransform } from './flv-transform.js';
import type { ReolinkClient } from 'reolink-nvr-api';
import { getAbility, getDevInfo } from 'reolink-nvr-api/endpoints/system';
import { snapToBuffer } from 'reolink-nvr-api/snapshot';
import { ReolinkHttpError } from 'reolink-nvr-api/types';

import { parseCookies, signSession, verifySession, safeCompare, toReolinkTime, sendError } from './utils.js';

export interface AppConfig {
  sessionSecret:  string;
  viewerPassword: string;
  adminPassword:  string;
  nvrHost:        string;
  nvrUser:        string;
  nvrPass:        string;
  ffmpegBin:      string;
  publicDir:      string;
}

export function createApp(client: ReolinkClient, config: AppConfig): express.Application {
  const {
    sessionSecret, viewerPassword, adminPassword,
    nvrHost, nvrUser, nvrPass, ffmpegBin, publicDir,
  } = config;

  // The Hub Pro uses rspCode -6 for "please login first", but the library's built-in
  // retry logic only recognises rspCode -1. This wrapper catches -6, re-authenticates,
  // and retries the call once before giving up.
  async function withRelogin<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (
        error instanceof ReolinkHttpError &&
        (error.rspCode === -6 || error.detail.toLowerCase().includes('login'))
      ) {
        console.log('Session expired, re-authenticating...');
        await client.login();
        return fn();
      }
      throw error;
    }
  }

  const COOKIE_NAME       = 'rv_session';
  const COOKIE_MAX_AGE_S  = 365 * 24 * 60 * 60; // 1 year
  const MJPEG_BOUNDARY    = 'reoframe';
  const MJPEG_INTERVAL_MS = 500;
  const STALL_TIMEOUT_MS  = 10_000;

  const app = express();
  app.use(express.json());

  // ── Unprotected routes ───────────────────────────────────────────────────────

  app.get('/login', (_req, res) => {
    res.sendFile(path.join(publicDir, 'login.html'));
  });

  app.post('/api/login', (req, res) => {
    const { password } = req.body as { password?: string };
    if (typeof password !== 'string' || !password) {
      res.status(400).json({ error: 'Password required' });
      return;
    }
    let role: string | null = null;
    if (safeCompare(password, adminPassword, sessionSecret))       role = 'admin';
    else if (safeCompare(password, viewerPassword, sessionSecret)) role = 'viewer';
    if (!role) {
      res.status(401).json({ error: 'Incorrect password' });
      return;
    }
    res.setHeader(
      'Set-Cookie',
      `${COOKIE_NAME}=${encodeURIComponent(signSession(role, sessionSecret))}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE_S}`
    );
    res.json({ role });
  });

  app.post('/api/logout', (_req, res) => {
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
    res.json({ ok: true });
  });

  // ── Auth middleware (protects everything below) ──────────────────────────────
  // Stateless signed cookies: no server-side session store, so container restarts
  // do not log anyone out. To revoke all sessions, rotate SESSION_SECRET and restart.

  app.use((req, res, next) => {
    const cookies = parseCookies(req.headers.cookie);
    const session = verifySession(cookies[COOKIE_NAME] ?? '', sessionSecret);
    if (session) {
      res.locals['role'] = session.role;
      next();
      return;
    }
    if (req.path.startsWith('/api/')) {
      res.status(401).json({ error: 'Unauthorized' });
    } else {
      res.redirect('/login');
    }
  });

  // ── Protected static files and API ──────────────────────────────────────────

  app.use(express.static(publicDir));

  app.get('/api/me', (_req, res) => {
    res.json({ role: res.locals['role'] });
  });

  app.get('/api/snapshot/:channel', async (req, res) => {
    const channel = parseInt(req.params['channel'] ?? '', 10);
    if (isNaN(channel) || channel < 0) {
      res.status(400).json({ error: 'Invalid channel' });
      return;
    }
    try {
      const jpeg = await withRelogin(() => snapToBuffer(client, channel));
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'no-store');
      res.send(jpeg);
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get('/api/device-info', async (_req, res) => {
    try {
      const info = await withRelogin(() => getDevInfo(client));
      res.json(info);
    } catch (error) {
      sendError(res, error);
    }
  });

  // MJPEG live stream — one JPEG frame per snapshot call, pushed as multipart chunks.
  // The browser consumes this natively in an <img> tag; no client-side library needed.
  // Frame rate is limited by round-trip latency to the hub (typically 1–3 fps on LAN).
  app.get('/api/live/:channel', async (req, res) => {
    const channel = parseInt(req.params['channel'] ?? '', 10);
    if (isNaN(channel) || channel < 0) {
      res.status(400).json({ error: 'Invalid channel' });
      return;
    }

    res.setHeader('Content-Type', `multipart/x-mixed-replace; boundary=${MJPEG_BOUNDARY}`);
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    let active = true;
    req.on('close', () => { active = false; });

    while (active) {
      try {
        const jpeg = await withRelogin(() => snapToBuffer(client, channel));
        if (!active) break;

        res.write(
          `--${MJPEG_BOUNDARY}\r\n` +
          `Content-Type: image/jpeg\r\n` +
          `Content-Length: ${jpeg.length}\r\n` +
          `\r\n`
        );
        res.write(jpeg);
        res.write('\r\n');
      } catch (error) {
        // Log and stop the stream — client will see a broken image
        console.error(`Live stream error on channel ${channel}:`, error instanceof Error ? error.message : error);
        break;
      }

      await new Promise(resolve => setTimeout(resolve, MJPEG_INTERVAL_MS));
    }

    res.end();
  });

  app.get('/api/recordings/:channel', async (req, res) => {
    const channel = parseInt(req.params['channel'] ?? '', 10);
    if (isNaN(channel) || channel < 0) {
      res.status(400).json({ error: 'Invalid channel' });
      return;
    }
    const { start, end } = req.query;
    if (typeof start !== 'string' || typeof end !== 'string') {
      res.status(400).json({ error: 'start and end query parameters are required (ISO 8601)' });
      return;
    }
    const startDate = new Date(start);
    const endDate   = new Date(end);
    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
      res.status(400).json({ error: 'start and end must be valid ISO 8601 timestamps' });
      return;
    }

    try {
      const result = await withRelogin(() =>
        client.api('Search', {
          Search: {
            channel,
            iLogicChannel: 0,
            onlyStatus: 0,
            streamType: 'main',
            StartTime: toReolinkTime(startDate),
            EndTime:   toReolinkTime(endDate),
          },
        })
      ) as { SearchResult?: { File?: unknown[]; Status?: unknown[] } };

      const sr = result?.SearchResult ?? {};
      res.json({ files: sr.File ?? [], status: sr.Status ?? [] });
    } catch (error) {
      sendError(res, error);
    }
  });

  // Proxy the hub's Playback endpoint so the browser never talks to the hub directly
  // and we avoid self-signed TLS issues in the browser.
  app.get('/api/playback/:channel', (req, res) => {
    const channel = parseInt(req.params['channel'] ?? '', 10);
    if (isNaN(channel) || channel < 0) {
      res.status(400).json({ error: 'Invalid channel' });
      return;
    }

    const { source, start, seek } = req.query;
    if (typeof source !== 'string' || !source || typeof start !== 'string' || !start) {
      res.status(400).json({ error: 'source and start query parameters are required' });
      return;
    }

    const token = (client as unknown as { token?: string }).token ?? '';
    const seekVal = typeof seek === 'string' ? seek : '0';

    const hubUrl = new URL(`https://${nvrHost}/cgi-bin/api.cgi`);
    hubUrl.searchParams.set('cmd',     'Playback');
    hubUrl.searchParams.set('channel', String(channel));
    hubUrl.searchParams.set('source',  source);
    hubUrl.searchParams.set('start',   start);
    hubUrl.searchParams.set('type',    '1');
    hubUrl.searchParams.set('seek',    seekVal);
    hubUrl.searchParams.set('token',   token);

    const hubReq = https.request(
      {
        hostname: hubUrl.hostname,
        port: Number(hubUrl.port) || 443,
        path: hubUrl.pathname + hubUrl.search,
        method: 'GET',
        rejectUnauthorized: false,
      },
      (hubRes) => {
        console.log(`[playback ch${channel}] hub status=${hubRes.statusCode} content-type=${hubRes.headers['content-type']} content-length=${hubRes.headers['content-length'] ?? 'unset'}`);

        if (hubRes.statusCode !== 200) {
          hubRes.resume(); // drain so the socket can be reused
          if (!res.headersSent) res.status(502).json({ error: `Hub returned status ${hubRes.statusCode}` });
          return;
        }

        // Start FFmpeg now that we have a confirmed 200.
        // frag_keyframe+empty_moov lets FFmpeg write fragmented MP4 to a non-seekable pipe.
        const ffmpeg = spawn(ffmpegBin, [
          '-loglevel', 'error',
          '-i', 'pipe:0',
          '-vf', 'scale=1920:-2',
          '-c:v', 'libx264',
          '-preset', 'ultrafast',
          '-g', '15',
          '-c:a', 'aac',
          '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
          '-f', 'mp4',
          'pipe:1',
        ]);

        ffmpeg.on('error', (e) => {
          console.error('[playback] ffmpeg spawn error:', e.message);
          if (!res.headersSent) res.status(503).json({ error: 'FFmpeg unavailable', detail: e.message });
        });
        ffmpeg.stderr.on('data', (data: Buffer) => {
          console.error(`[playback ch${channel}] ffmpeg: ${data.toString().trim()}`);
        });
        ffmpeg.stdin.on('error', () => {}); // ignore broken pipe

        // Commit response headers and stream MP4 output straight to the client.
        // Accept-Ranges: none tells the browser not to issue Range sub-requests
        // against this streaming endpoint.
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Accept-Ranges', 'none');
        ffmpeg.stdout.pipe(res);

        ffmpeg.on('close', (code) => {
          console.log(`[playback ch${channel}] ffmpeg exited code=${code}`);
          if (!res.writableEnded) res.end();
        });

        // Transform Reolink codec-12 FLV → Enhanced FLV 'hvc1' → FFmpeg.
        const transformer = new ReolinkFLVTransform();
        transformer.pipe(ffmpeg.stdin);

        // If the hub stops sending data for 10 s, end the stream so FFmpeg flushes
        // whatever it has rather than waiting forever.
        let stallTimer: ReturnType<typeof setTimeout> | null = null;
        const resetStallTimer = () => {
          if (stallTimer) clearTimeout(stallTimer);
          stallTimer = setTimeout(() => {
            console.log(`[playback ch${channel}] hub stalled, ending stream`);
            hubReq.destroy();
            transformer.end();
          }, STALL_TIMEOUT_MS);
        };

        let flvBytesReceived = 0;
        hubRes.on('data', (chunk: Buffer) => {
          flvBytesReceived += chunk.length;
          resetStallTimer();
          transformer.write(chunk);
        });
        hubRes.on('end', () => {
          if (stallTimer) clearTimeout(stallTimer);
          console.log(`[playback ch${channel}] hub FLV stream ended, total: ${flvBytesReceived} bytes`);
          transformer.end();
        });
        resetStallTimer(); // start timer even before first byte arrives
        console.log(`[playback ch${channel}] waiting for FLV data...`);
      }
    );

    hubReq.on('error', (e) => {
      console.error(`[playback ch${channel}] error:`, e.message);
      if (!res.headersSent) {
        res.status(503).json({ error: 'Playback request failed', detail: e.message });
      }
    });

    // If the browser cancels the fetch, tear down the hub connection.
    res.on('close', () => { hubReq.destroy(); });

    hubReq.end();
  });

  // Proxy the hub's RTSP stream for high-quality live view.
  // FFmpeg reads RTSP over TCP and outputs fragmented MP4 to the browser.
  // NOTE: The RTSP URL format (h264Preview_0N_main) is the standard Reolink pattern.
  // If the hub uses a different URL scheme this will need adjustment after testing.
  app.get('/api/rtsp/:channel', (req, res) => {
    const channel = parseInt(req.params['channel'] ?? '', 10);
    if (isNaN(channel) || channel < 0) {
      res.status(400).json({ error: 'Invalid channel' });
      return;
    }

    // Reolink RTSP URL: channels are 1-indexed in the path (channel 0 → "01", channel 1 → "02", …)
    const channelStr = String(channel + 1).padStart(2, '0');
    const rtspUrl = `rtsp://${encodeURIComponent(nvrUser)}:${encodeURIComponent(nvrPass)}@${nvrHost}:554/h264Preview_${channelStr}_main`;

    const ffmpeg = spawn(ffmpegBin, [
      '-loglevel', 'error',
      '-rtsp_transport', 'tcp',
      '-i', rtspUrl,
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-g', '15',
      '-c:a', 'aac',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
      '-f', 'mp4',
      'pipe:1',
    ]);

    ffmpeg.on('error', (e) => {
      console.error(`[rtsp ch${channel}] ffmpeg spawn error:`, e.message);
      if (!res.headersSent) res.status(503).json({ error: 'FFmpeg unavailable', detail: e.message });
    });
    ffmpeg.stderr.on('data', (data: Buffer) => {
      console.error(`[rtsp ch${channel}] ffmpeg: ${data.toString().trim()}`);
    });
    ffmpeg.stdin?.on('error', () => {});

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Accept-Ranges', 'none');
    ffmpeg.stdout.pipe(res);

    ffmpeg.on('close', (code) => {
      console.log(`[rtsp ch${channel}] ffmpeg exited code=${code}`);
      if (!res.writableEnded) res.end();
    });

    // Kill FFmpeg when the browser disconnects
    res.on('close', () => { ffmpeg.kill(); });
  });

  app.get('/api/devices', async (_req, res) => {
    try {
      // NOTE: GetChannelstatus is the most likely command for listing connected devices
      // on the Reolink Hub Pro, but has not been confirmed against this specific device.
      // If this returns an error (especially rspCode -9 "not supported"), we will need
      // to try alternative commands such as GetDevInfo with channel params or GetAbility.
      const devices = await withRelogin(() => client.api('GetChannelstatus'));
      res.json(devices);
    } catch (error) {
      sendError(res, error);
    }
  });

  // ── Admin routes ─────────────────────────────────────────────────────────────

  function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction): void {
    if (res.locals['role'] === 'admin') { next(); return; }
    if (req.path.startsWith('/api/')) {
      res.status(403).json({ error: 'Admin access required' });
    } else {
      res.redirect('/');
    }
  }

  app.get('/admin', requireAdmin, (_req, res) => {
    res.sendFile(path.join(publicDir, 'admin.html'));
  });

  app.get('/api/admin/ability', requireAdmin, async (_req, res) => {
    try {
      const ability = await withRelogin(() => getAbility(client));
      res.json(ability);
    } catch (error) {
      sendError(res, error);
    }
  });

  return app;
}
