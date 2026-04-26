import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

// Hoisted above imports by Vitest's transform — intercepts these modules in app.ts too
vi.mock('reolink-nvr-api/endpoints/system', () => ({ getDevInfo: vi.fn() }));
vi.mock('reolink-nvr-api/snapshot', () => ({ snapToBuffer: vi.fn() }));

import { getDevInfo } from 'reolink-nvr-api/endpoints/system';
import { snapToBuffer } from 'reolink-nvr-api/snapshot';
import { ReolinkHttpError } from 'reolink-nvr-api/types';

import {
  parseCookies, signSession, verifySession,
  safeCompare, toReolinkTime, hasFiles, sendError, parseDateLocal,
} from './utils.js';
import { createApp } from './app.js';

// ── Test fixtures ─────────────────────────────────────────────────────────────

const TEST_SECRET  = 'test-secret-32-bytes-long-00000000';
const VIEWER_PASS  = 'viewer-pass';
const ADMIN_PASS   = 'admin-pass';

const testConfig = {
  sessionSecret:  TEST_SECRET,
  viewerPassword: VIEWER_PASS,
  adminPassword:  ADMIN_PASS,
  nvrHost:        '192.168.0.1',
  nvrUser:        'admin',
  nvrPass:        'password',
  ffmpegBin:      '/usr/bin/ffmpeg',
  publicDir:      '/tmp',
};

const mockClient = {
  login: vi.fn().mockResolvedValue(undefined),
  api:   vi.fn().mockResolvedValue({}),
  token: 'test-token',
};

// Single app instance shared across all route tests — mock implementations
// are reset per-test via beforeEach.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const app = createApp(mockClient as any, testConfig);

const mockGetDevInfo   = vi.mocked(getDevInfo);
const mockSnapToBuffer = vi.mocked(snapToBuffer);

/** Return a valid session cookie header value for the given role. */
function authCookie(role: string): string {
  return `rv_session=${encodeURIComponent(signSession(role, TEST_SECRET))}`;
}

/** Minimal mock express.Response for testing sendError directly. */
function mockRes() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: any = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
}

beforeEach(() => {
  // Clear call history; implementations set via mockResolvedValue are preserved.
  vi.clearAllMocks();
});

// ── parseCookies ──────────────────────────────────────────────────────────────

describe('parseCookies', () => {
  it('returns empty object for undefined header', () => {
    expect(parseCookies(undefined)).toEqual({});
  });

  it('returns empty object for an empty string', () => {
    expect(parseCookies('')).toEqual({});
  });

  it('parses a single cookie', () => {
    expect(parseCookies('foo=bar')).toEqual({ foo: 'bar' });
  });

  it('parses multiple cookies separated by semicolons', () => {
    expect(parseCookies('a=1; b=2; c=3')).toEqual({ a: '1', b: '2', c: '3' });
  });

  it('URL-decodes cookie values', () => {
    expect(parseCookies('token=hello%20world')).toEqual({ token: 'hello world' });
  });

  it('skips parts with no equals sign', () => {
    expect(parseCookies('novalue; foo=bar')).toEqual({ foo: 'bar' });
  });
});

// ── signSession / verifySession ───────────────────────────────────────────────

describe('signSession / verifySession', () => {
  it('round-trips: signing and verifying with the same secret returns the role', () => {
    const token = signSession('viewer', TEST_SECRET);
    const result = verifySession(token, TEST_SECRET);
    expect(result).not.toBeNull();
    expect(result?.role).toBe('viewer');
  });

  it('returns null when the token has no dot separator', () => {
    expect(verifySession('nodot', TEST_SECRET)).toBeNull();
  });

  it('returns null when the signature has been tampered with', () => {
    const token = signSession('admin', TEST_SECRET);
    const tampered = token.slice(0, -3) + 'xxx';
    expect(verifySession(tampered, TEST_SECRET)).toBeNull();
  });

  it('returns null when verified with the wrong secret', () => {
    const token = signSession('viewer', TEST_SECRET);
    expect(verifySession(token, 'wrong-secret')).toBeNull();
  });

  it('returns null for a completely garbled value', () => {
    expect(verifySession('!!!.!!!', TEST_SECRET)).toBeNull();
  });
});

// ── safeCompare ───────────────────────────────────────────────────────────────

describe('safeCompare', () => {
  it('returns true for identical strings', () => {
    expect(safeCompare('password', 'password', TEST_SECRET)).toBe(true);
  });

  it('returns false for different strings', () => {
    expect(safeCompare('password', 'wrong', TEST_SECRET)).toBe(false);
  });

  it('returns false for same string with different case', () => {
    expect(safeCompare('Password', 'password', TEST_SECRET)).toBe(false);
  });
});

// ── toReolinkTime ─────────────────────────────────────────────────────────────

describe('toReolinkTime', () => {
  it('maps Date fields to the Reolink time object structure', () => {
    const d = new Date(2024, 5, 15, 10, 30, 45); // June 15 2024, 10:30:45 local time
    expect(toReolinkTime(d)).toEqual({
      year: 2024, mon: 6, day: 15,
      hour: 10, min: 30, sec: 45,
    });
  });

  it('converts January correctly (month should be 1, not 0)', () => {
    const d = new Date(2025, 0, 1, 0, 0, 0);
    expect(toReolinkTime(d).mon).toBe(1);
  });
});

// ── hasFiles ──────────────────────────────────────────────────────────────────

describe('hasFiles', () => {
  it('returns false for null and undefined', () => {
    expect(hasFiles(null)).toBe(false);
    expect(hasFiles(undefined)).toBe(false);
  });

  it('returns false for an empty object', () => {
    expect(hasFiles({})).toBe(false);
  });

  it('returns false when the File array is empty', () => {
    expect(hasFiles({ SearchResult: { File: [] } })).toBe(false);
  });

  it('returns true when SearchResult.File has entries', () => {
    expect(hasFiles({ SearchResult: { File: [{ name: 'clip.mp4' }] } })).toBe(true);
  });

  it('returns true when a bare result (no SearchResult wrapper) has a File array', () => {
    expect(hasFiles({ File: [{ name: 'clip.mp4' }] })).toBe(true);
  });
});

// ── sendError ─────────────────────────────────────────────────────────────────

describe('sendError', () => {
  it('sends 401 for ReolinkHttpError with rspCode -1 (invalid token)', () => {
    const res = mockRes();
    sendError(res, new ReolinkHttpError(401, -1, 'Invalid token'));
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'Authentication failed' }));
  });

  it('sends 502 for ReolinkHttpError with any other rspCode', () => {
    const res = mockRes();
    sendError(res, new ReolinkHttpError(200, -9, 'Not supported'));
    expect(res.status).toHaveBeenCalledWith(502);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: -9 }));
  });

  it('sends 503 for a generic Error (hub unreachable)', () => {
    const res = mockRes();
    sendError(res, new Error('ECONNREFUSED'));
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'Device unreachable' }));
  });

  it('sends 500 for an unknown error type', () => {
    const res = mockRes();
    sendError(res, 'something weird');
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

// ── POST /api/login ───────────────────────────────────────────────────────────

describe('POST /api/login', () => {
  it('returns 400 when the password field is missing', async () => {
    const res = await request(app).post('/api/login').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/password required/i);
  });

  it('returns 400 when the password field is an empty string', async () => {
    const res = await request(app).post('/api/login').send({ password: '' });
    expect(res.status).toBe(400);
  });

  it('returns 401 for a wrong password', async () => {
    const res = await request(app).post('/api/login').send({ password: 'wrong' });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/incorrect password/i);
  });

  it('returns 200 and role=viewer for the viewer password', async () => {
    const res = await request(app).post('/api/login').send({ password: VIEWER_PASS });
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('viewer');
    expect(res.headers['set-cookie']).toBeDefined();
  });

  it('returns 200 and role=admin for the admin password', async () => {
    const res = await request(app).post('/api/login').send({ password: ADMIN_PASS });
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('admin');
    expect(res.headers['set-cookie']).toBeDefined();
  });
});

// ── POST /api/logout ──────────────────────────────────────────────────────────

describe('POST /api/logout', () => {
  it('returns 200 and sets Max-Age=0 to clear the session cookie', async () => {
    const res = await request(app).post('/api/logout');
    expect(res.status).toBe(200);
    const cookie = (res.headers['set-cookie'] as string[])?.[0] ?? '';
    expect(cookie).toMatch(/Max-Age=0/);
  });
});

// ── Auth middleware ───────────────────────────────────────────────────────────

describe('Auth middleware', () => {
  it('returns 401 for unauthenticated API requests', async () => {
    const res = await request(app).get('/api/me');
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/unauthorized/i);
  });

  it('redirects unauthenticated non-API requests to /login', async () => {
    const res = await request(app).get('/some-page');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  it('allows requests with a valid viewer cookie through', async () => {
    const res = await request(app).get('/api/me').set('Cookie', authCookie('viewer'));
    expect(res.status).toBe(200);
  });

  it('rejects a cookie signed with the wrong secret', async () => {
    const bad = `rv_session=${encodeURIComponent(signSession('admin', 'wrong-secret'))}`;
    const res = await request(app).get('/api/me').set('Cookie', bad);
    expect(res.status).toBe(401);
  });
});

// ── GET /api/me ───────────────────────────────────────────────────────────────

describe('GET /api/me', () => {
  it('returns the viewer role', async () => {
    const res = await request(app).get('/api/me').set('Cookie', authCookie('viewer'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ role: 'viewer' });
  });

  it('returns the admin role', async () => {
    const res = await request(app).get('/api/me').set('Cookie', authCookie('admin'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ role: 'admin' });
  });
});

// ── GET /api/device-info ──────────────────────────────────────────────────────

describe('GET /api/device-info', () => {
  it('returns the JSON from getDevInfo', async () => {
    mockGetDevInfo.mockResolvedValueOnce({ model: 'Hub Pro', firmware: '3.2.0' } as never);
    const res = await request(app).get('/api/device-info').set('Cookie', authCookie('viewer'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ model: 'Hub Pro', firmware: '3.2.0' });
  });

  it('returns 503 when the hub is unreachable', async () => {
    mockGetDevInfo.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const res = await request(app).get('/api/device-info').set('Cookie', authCookie('viewer'));
    expect(res.status).toBe(503);
  });

  it('returns 502 for a hub-level API error', async () => {
    mockGetDevInfo.mockRejectedValueOnce(new ReolinkHttpError(200, -9, 'Not supported'));
    const res = await request(app).get('/api/device-info').set('Cookie', authCookie('viewer'));
    expect(res.status).toBe(502);
    expect(res.body.code).toBe(-9);
  });
});

// ── GET /api/devices ──────────────────────────────────────────────────────────

describe('GET /api/devices', () => {
  it('returns the channel status payload from the hub', async () => {
    const payload = { count: 1, status: [{ channel: 0, name: 'Front Door' }] };
    mockClient.api.mockResolvedValueOnce(payload);
    const res = await request(app).get('/api/devices').set('Cookie', authCookie('viewer'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual(payload);
    expect(mockClient.api).toHaveBeenCalledWith('GetChannelstatus');
  });

  it('returns 503 when the hub is unreachable', async () => {
    mockClient.api.mockRejectedValueOnce(new Error('timeout'));
    const res = await request(app).get('/api/devices').set('Cookie', authCookie('viewer'));
    expect(res.status).toBe(503);
  });
});

// ── GET /api/snapshot/:channel ────────────────────────────────────────────────

describe('GET /api/snapshot/:channel', () => {
  it('returns 400 for a non-numeric channel', async () => {
    const res = await request(app).get('/api/snapshot/abc').set('Cookie', authCookie('viewer'));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid channel/i);
  });

  it('returns 400 for a negative channel number', async () => {
    const res = await request(app).get('/api/snapshot/-1').set('Cookie', authCookie('viewer'));
    expect(res.status).toBe(400);
  });

  it('returns JPEG bytes with correct headers for a valid channel', async () => {
    const fakeJpeg = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10]); // JPEG SOI + APP0
    mockSnapToBuffer.mockResolvedValueOnce(fakeJpeg as never);
    const res = await request(app).get('/api/snapshot/0').set('Cookie', authCookie('viewer'));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/image\/jpeg/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(mockSnapToBuffer).toHaveBeenCalledWith(mockClient, 0);
  });

  it('returns 503 when snapToBuffer fails', async () => {
    mockSnapToBuffer.mockRejectedValueOnce(new Error('timeout'));
    const res = await request(app).get('/api/snapshot/0').set('Cookie', authCookie('viewer'));
    expect(res.status).toBe(503);
  });

  it('passes the correct channel number to snapToBuffer', async () => {
    mockSnapToBuffer.mockResolvedValueOnce(Buffer.from([0xFF, 0xD8]) as never);
    await request(app).get('/api/snapshot/2').set('Cookie', authCookie('viewer'));
    expect(mockSnapToBuffer).toHaveBeenCalledWith(mockClient, 2);
  });
});

// ── GET /api/recordings/:channel ─────────────────────────────────────────────

describe('GET /api/recordings/:channel', () => {
  const validQuery = 'start=2024-06-01T00:00:00.000Z&end=2024-06-01T23:59:59.000Z';

  it('returns 400 for a non-numeric channel', async () => {
    const res = await request(app)
      .get(`/api/recordings/abc?${validQuery}`)
      .set('Cookie', authCookie('viewer'));
    expect(res.status).toBe(400);
  });

  it('returns 400 when start and end params are missing', async () => {
    const res = await request(app)
      .get('/api/recordings/0')
      .set('Cookie', authCookie('viewer'));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/start and end/i);
  });

  it('returns 400 for invalid (non-parseable) date strings', async () => {
    const res = await request(app)
      .get('/api/recordings/0?start=not-a-date&end=also-not')
      .set('Cookie', authCookie('viewer'));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/ISO 8601/i);
  });

  it('returns files and status for a valid search', async () => {
    const files = [{ name: 'clip01.mp4', StartTime: { year: 2024 } }];
    mockClient.api.mockResolvedValueOnce({ SearchResult: { File: files, Status: [] } });
    const res = await request(app)
      .get(`/api/recordings/0?${validQuery}`)
      .set('Cookie', authCookie('viewer'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ files, status: [] });
    expect(mockClient.api).toHaveBeenCalledWith('Search', expect.objectContaining({
      Search: expect.objectContaining({ channel: 0, iLogicChannel: 0 }),
    }));
  });

  it('returns empty files and status when SearchResult is absent from the response', async () => {
    mockClient.api.mockResolvedValueOnce({});
    const res = await request(app)
      .get(`/api/recordings/0?${validQuery}`)
      .set('Cookie', authCookie('viewer'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ files: [], status: [] });
  });

  it('returns 503 when the hub is unreachable', async () => {
    mockClient.api.mockRejectedValueOnce(new Error('timeout'));
    const res = await request(app)
      .get(`/api/recordings/0?${validQuery}`)
      .set('Cookie', authCookie('viewer'));
    expect(res.status).toBe(503);
  });
});

// ── withRelogin behavior ──────────────────────────────────────────────────────

describe('withRelogin', () => {
  it('re-authenticates and retries when the hub returns rspCode -6', async () => {
    const files = [{ name: 'clip.mp4' }];
    mockClient.api
      .mockRejectedValueOnce(new ReolinkHttpError(200, -6, 'Please login first'))
      .mockResolvedValueOnce({ SearchResult: { File: files, Status: [] } });

    const res = await request(app)
      .get('/api/recordings/0?start=2024-06-01T00:00:00.000Z&end=2024-06-01T23:59:59.000Z')
      .set('Cookie', authCookie('viewer'));

    expect(res.status).toBe(200);
    expect(mockClient.login).toHaveBeenCalledOnce();
    expect(mockClient.api).toHaveBeenCalledTimes(2);
  });
});

// ── GET /api/playback/:channel — input validation only ────────────────────────

describe('GET /api/playback/:channel — input validation', () => {
  it('returns 400 for a non-numeric channel', async () => {
    const res = await request(app)
      .get('/api/playback/abc?source=file.mp4&start=20240601100000')
      .set('Cookie', authCookie('viewer'));
    expect(res.status).toBe(400);
  });

  it('returns 400 when source or start params are missing', async () => {
    const res = await request(app)
      .get('/api/playback/0')
      .set('Cookie', authCookie('viewer'));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/source and start/i);
  });
});

// ── GET /api/rtsp/:channel — input validation only ────────────────────────────

describe('GET /api/rtsp/:channel — input validation', () => {
  it('returns 400 for a non-numeric channel', async () => {
    const res = await request(app)
      .get('/api/rtsp/abc')
      .set('Cookie', authCookie('viewer'));
    expect(res.status).toBe(400);
  });
});

// ── requireAdmin middleware ───────────────────────────────────────────────────

describe('requireAdmin middleware', () => {
  it('returns 403 for viewer on admin API routes', async () => {
    const res = await request(app)
      .get('/api/admin/ability')
      .set('Cookie', authCookie('viewer'));
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/admin/i);
  });

  it('returns 401 for unauthenticated requests to admin API routes', async () => {
    const res = await request(app).get('/api/admin/ability');
    expect(res.status).toBe(401);
  });

  it('redirects viewer to / when accessing /admin page', async () => {
    const res = await request(app)
      .get('/admin')
      .set('Cookie', authCookie('viewer'));
    expect(res.status).toBe(302);
    expect(res.headers['location']).toBe('/');
  });
});

// ── GET /api/admin/ability ────────────────────────────────────────────────────

describe('GET /api/admin/ability', () => {
  it('returns the GetAbility response from the hub', async () => {
    const ability = { Ability: { GetEvents: { permit: 3 } } };
    mockClient.api.mockResolvedValueOnce(ability);
    const res = await request(app)
      .get('/api/admin/ability')
      .set('Cookie', authCookie('admin'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual(ability);
    expect(mockClient.api).toHaveBeenCalledWith('GetAbility', { User: { userName: testConfig.nvrUser } });
  });

  it('returns 503 when the hub is unreachable', async () => {
    mockClient.api.mockRejectedValueOnce(new Error('connection refused'));
    const res = await request(app)
      .get('/api/admin/ability')
      .set('Cookie', authCookie('admin'));
    expect(res.status).toBe(503);
  });

  it('returns 502 for a hub API error', async () => {
    mockClient.api.mockRejectedValueOnce(new ReolinkHttpError(200, -9, 'Not supported'));
    const res = await request(app)
      .get('/api/admin/ability')
      .set('Cookie', authCookie('admin'));
    expect(res.status).toBe(502);
  });
});

// ── parseDateLocal ────────────────────────────────────────────────────────────

describe('parseDateLocal', () => {
  it('parses YYYY-MM-DD as a local-time midnight Date', () => {
    const d = parseDateLocal('2026-04-20');
    expect(d?.getFullYear()).toBe(2026);
    expect(d?.getMonth()).toBe(3); // April = month index 3
    expect(d?.getDate()).toBe(20);
    expect(d?.getHours()).toBe(0);
  });

  it('returns null for strings not matching YYYY-MM-DD format', () => {
    expect(parseDateLocal('not-a-date')).toBeNull();
    expect(parseDateLocal('20260420')).toBeNull();
    expect(parseDateLocal('2026-04-20T10:00:00')).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(parseDateLocal('')).toBeNull();
  });
});

// ── GET /api/admin/ai-config ──────────────────────────────────────────────────

describe('GET /api/admin/ai-config', () => {
  const namedChannels = {
    count: 2,
    status: [
      { channel: 0, name: 'Back door', online: 1, sleep: 0 },
      { channel: 1, name: 'Garage',    online: 1, sleep: 0 },
    ],
  };

  it('returns 403 for viewer role', async () => {
    const res = await request(app)
      .get('/api/admin/ai-config')
      .set('Cookie', authCookie('viewer'));
    expect(res.status).toBe(403);
  });

  it('returns 401 for unauthenticated requests', async () => {
    const res = await request(app).get('/api/admin/ai-config');
    expect(res.status).toBe(401);
  });

  it('returns AI config for all named channels', async () => {
    const aiCfg0 = { AiDetection: { channel: 0, people: 1, vehicle: 1, dog_cat: 0, package: 1 } };
    const aiCfg1 = { AiDetection: { channel: 1, people: 1, vehicle: 0, dog_cat: 1, package: 0 } };
    mockClient.api
      .mockResolvedValueOnce(namedChannels)
      .mockResolvedValueOnce(aiCfg0)
      .mockResolvedValueOnce(aiCfg1);

    const res = await request(app)
      .get('/api/admin/ai-config')
      .set('Cookie', authCookie('admin'));

    expect(res.status).toBe(200);
    expect(res.body.configs).toHaveLength(2);
    expect(res.body.configs[0]).toMatchObject({ channel: 0, channelName: 'Back door', config: aiCfg0 });
    expect(res.body.configs[1]).toMatchObject({ channel: 1, channelName: 'Garage',    config: aiCfg1 });
    expect(mockClient.api).toHaveBeenCalledWith('GetAiCfg', { channel: 0 });
    expect(mockClient.api).toHaveBeenCalledWith('GetAiCfg', { channel: 1 });
  });

  it('returns null config for a failing channel and continues with the rest', async () => {
    const aiCfg1 = { AiDetection: { channel: 1, people: 1 } };
    mockClient.api
      .mockResolvedValueOnce(namedChannels)
      .mockRejectedValueOnce(new Error('ch0 failed'))
      .mockResolvedValueOnce(aiCfg1);

    const res = await request(app)
      .get('/api/admin/ai-config')
      .set('Cookie', authCookie('admin'));

    expect(res.status).toBe(200);
    expect(res.body.configs).toHaveLength(2);
    expect(res.body.configs[0]).toMatchObject({ channel: 0, config: null });
    expect(res.body.configs[1]).toMatchObject({ channel: 1, config: aiCfg1 });
  });

  it('skips unnamed channel slots', async () => {
    mockClient.api.mockResolvedValueOnce({
      count: 3,
      status: [
        { channel: 0, name: 'Back door', online: 1, sleep: 0 },
        { channel: 1, name: '',          online: 0, sleep: 0 },
        { channel: 2, name: 'Garage',    online: 1, sleep: 0 },
      ],
    });
    mockClient.api
      .mockResolvedValueOnce({ AiDetection: { channel: 0 } })
      .mockResolvedValueOnce({ AiDetection: { channel: 2 } });

    const res = await request(app)
      .get('/api/admin/ai-config')
      .set('Cookie', authCookie('admin'));

    expect(res.status).toBe(200);
    expect(res.body.configs).toHaveLength(2);
    expect(mockClient.api).not.toHaveBeenCalledWith('GetAiCfg', { channel: 1 });
  });

  it('returns 503 when GetChannelstatus fails', async () => {
    mockClient.api.mockRejectedValueOnce(new Error('hub unreachable'));
    const res = await request(app)
      .get('/api/admin/ai-config')
      .set('Cookie', authCookie('admin'));
    expect(res.status).toBe(503);
  });
});

// ── POST /api/admin/ai-config/:channel ───────────────────────────────────────

describe('POST /api/admin/ai-config/:channel', () => {
  const validBody = {
    AiDetectType: { people: 1, vehicle: 1, dog_cat: 0, face: 0, package: 0 },
    aiTrack: 0,
    bSmartTrack: 0,
    trackTask: '',
    trackType: { people: 1, vehicle: 0, dog_cat: 0, face: 0, package: 0 },
  };

  it('returns 403 for viewer role', async () => {
    const res = await request(app)
      .post('/api/admin/ai-config/0')
      .set('Cookie', authCookie('viewer'))
      .send(validBody);
    expect(res.status).toBe(403);
  });

  it('returns 401 for unauthenticated requests', async () => {
    const res = await request(app)
      .post('/api/admin/ai-config/0')
      .send(validBody);
    expect(res.status).toBe(401);
  });

  it('returns 400 for a non-numeric channel', async () => {
    const res = await request(app)
      .post('/api/admin/ai-config/abc')
      .set('Cookie', authCookie('admin'))
      .send(validBody);
    expect(res.status).toBe(400);
  });

  it('returns 400 when the body is an array instead of an object', async () => {
    const res = await request(app)
      .post('/api/admin/ai-config/0')
      .set('Cookie', authCookie('admin'))
      .send([validBody]);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/JSON object/i);
  });

  it('calls SetAiCfg with the channel from the URL, overriding any channel in the body', async () => {
    mockClient.api.mockResolvedValueOnce({ rspCode: 200 });
    const res = await request(app)
      .post('/api/admin/ai-config/0')
      .set('Cookie', authCookie('admin'))
      .send({ ...validBody, channel: 99 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, rspCode: 200 });
    expect(mockClient.api).toHaveBeenCalledWith('SetAiCfg', expect.objectContaining({ channel: 0 }));
  });

  it('returns 503 when the hub is unreachable', async () => {
    mockClient.api.mockRejectedValueOnce(new Error('timeout'));
    const res = await request(app)
      .post('/api/admin/ai-config/0')
      .set('Cookie', authCookie('admin'))
      .send(validBody);
    expect(res.status).toBe(503);
  });

  it('returns 502 for a hub API error', async () => {
    mockClient.api.mockRejectedValueOnce(new ReolinkHttpError(200, -9, 'Not supported'));
    const res = await request(app)
      .post('/api/admin/ai-config/0')
      .set('Cookie', authCookie('admin'))
      .send(validBody);
    expect(res.status).toBe(502);
  });
});

// ── GET /api/admin/events ─────────────────────────────────────────────────────

describe('GET /api/admin/events', () => {
  const validQuery = 'start=2026-04-20&end=2026-04-20';

  const twoNamedChannels = {
    count: 2,
    status: [
      { channel: 0, name: 'Back door', online: 1, sleep: 0 },
      { channel: 1, name: 'Garage',    online: 1, sleep: 0 },
    ],
  };

  const emptySearch = { SearchResult: { File: [], Status: [] } };

  function fileAt(name: string, hour: number, channel = 0, size = '5242880') {
    return { name, size, StartTime: { year: 2026, mon: 4, day: 20, hour, min: 0, sec: 0 }, EndTime: { year: 2026, mon: 4, day: 20, hour, min: 1, sec: 0 }, channel };
  }

  it('returns 403 for viewer role', async () => {
    const res = await request(app)
      .get(`/api/admin/events?${validQuery}`)
      .set('Cookie', authCookie('viewer'));
    expect(res.status).toBe(403);
  });

  it('returns 401 for unauthenticated requests', async () => {
    const res = await request(app).get(`/api/admin/events?${validQuery}`);
    expect(res.status).toBe(401);
  });

  it('returns 400 when start param is missing', async () => {
    const res = await request(app)
      .get('/api/admin/events?end=2026-04-20')
      .set('Cookie', authCookie('admin'));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/start and end/i);
  });

  it('returns 400 for invalid date strings', async () => {
    const res = await request(app)
      .get('/api/admin/events?start=not-a-date&end=2026-04-20')
      .set('Cookie', authCookie('admin'));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/YYYY-MM-DD/i);
  });

  it('searches all named channels and skips unnamed channel slots', async () => {
    mockClient.api.mockResolvedValueOnce({
      count: 3,
      status: [
        { channel: 0, name: 'Back door', online: 1, sleep: 0 },
        { channel: 1, name: 'Garage',    online: 1, sleep: 0 },
        { channel: 2, name: '',          online: 0, sleep: 0 },
      ],
    });
    mockClient.api.mockResolvedValue(emptySearch);

    const res = await request(app)
      .get(`/api/admin/events?${validQuery}`)
      .set('Cookie', authCookie('admin'));

    expect(res.status).toBe(200);
    expect(mockClient.api).toHaveBeenCalledWith('GetChannelstatus');
    expect(mockClient.api).toHaveBeenCalledWith('Search', expect.objectContaining({
      Search: expect.objectContaining({ channel: 0, iLogicChannel: 0 }),
    }));
    expect(mockClient.api).toHaveBeenCalledWith('Search', expect.objectContaining({
      Search: expect.objectContaining({ channel: 1, iLogicChannel: 0 }),
    }));
    expect(mockClient.api).not.toHaveBeenCalledWith('Search', expect.objectContaining({
      Search: expect.objectContaining({ channel: 2 }),
    }));
  });

  it('returns events sorted by StartTime descending', async () => {
    // Both files land in the 08:00–11:59 window (hour 9 and 11).
    // mockImplementation returns data only when the search window starts at hour 8,
    // and emptySearch for follow-up pagination calls (which start at hour 9 or 11).
    mockClient.api.mockImplementation((cmd: string, params: unknown) => {
      if (cmd === 'GetChannelstatus') return Promise.resolve(twoNamedChannels);
      if (cmd !== 'Search') return Promise.resolve({});
      const { channel, StartTime } =
        (params as { Search: { channel: number; StartTime: { hour: number } } }).Search;
      if (channel === 0 && StartTime.hour === 8)
        return Promise.resolve({ SearchResult: { File: [fileAt('early.mp4', 9)], Status: [] } });
      if (channel === 1 && StartTime.hour === 8)
        return Promise.resolve({ SearchResult: { File: [fileAt('late.mp4', 11)], Status: [] } });
      return Promise.resolve(emptySearch);
    });

    const res = await request(app)
      .get(`/api/admin/events?${validQuery}`)
      .set('Cookie', authCookie('admin'));

    expect(res.status).toBe(200);
    expect(res.body.events[0].name).toBe('late.mp4');
    expect(res.body.events[1].name).toBe('early.mp4');
  });

  it('deduplicates recordings that the hub returns in more than one time window', async () => {
    // Simulate the hub returning the same file for two consecutive Search calls —
    // the deduplication-by-name guard should suppress the second occurrence.
    let searchCallCount = 0;
    mockClient.api.mockImplementation((cmd: string) => {
      if (cmd === 'GetChannelstatus') return Promise.resolve({
        count: 1,
        status: [{ channel: 0, name: 'Back door', online: 1, sleep: 0 }],
      });
      if (cmd === 'Search') {
        searchCallCount++;
        if (searchCallCount <= 2)
          return Promise.resolve({ SearchResult: { File: [fileAt('dup.mp4', 3)], Status: [] } });
        return Promise.resolve(emptySearch);
      }
      return Promise.resolve({});
    });

    const res = await request(app)
      .get(`/api/admin/events?${validQuery}`)
      .set('Cookie', authCookie('admin'));

    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0].name).toBe('dup.mp4');
  });

  it('enriches each event with channel number and channelName', async () => {
    mockClient.api.mockResolvedValueOnce({
      count: 1,
      status: [{ channel: 0, name: 'Back door', online: 1, sleep: 0 }],
    });
    mockClient.api.mockResolvedValueOnce({
      SearchResult: { File: [fileAt('clip.mp4', 10)], Status: [] },
    });

    const res = await request(app)
      .get(`/api/admin/events?${validQuery}`)
      .set('Cookie', authCookie('admin'));

    expect(res.status).toBe(200);
    expect(res.body.events[0]).toMatchObject({ channel: 0, channelName: 'Back door', name: 'clip.mp4' });
  });

  it('restricts search to specified channels when channels param is provided', async () => {
    mockClient.api.mockResolvedValueOnce(twoNamedChannels);
    mockClient.api.mockResolvedValue(emptySearch);

    const res = await request(app)
      .get(`/api/admin/events?${validQuery}&channels=1`)
      .set('Cookie', authCookie('admin'));

    expect(res.status).toBe(200);
    expect(mockClient.api).not.toHaveBeenCalledWith('Search', expect.objectContaining({
      Search: expect.objectContaining({ channel: 0 }),
    }));
    expect(mockClient.api).toHaveBeenCalledWith('Search', expect.objectContaining({
      Search: expect.objectContaining({ channel: 1 }),
    }));
  });

  it('filters events by type when types param is provided', async () => {
    mockClient.api.mockResolvedValueOnce({
      count: 1,
      status: [{ channel: 0, name: 'Back door', online: 1, sleep: 0 }],
    });
    mockClient.api.mockResolvedValueOnce({
      SearchResult: {
        File: [
          { ...fileAt('motion.mp4', 10), type: 'sub'  },
          { ...fileAt('timer.mp4',  11), type: 'main' },
        ],
        Status: [],
      },
    });

    const res = await request(app)
      .get(`/api/admin/events?${validQuery}&types=sub`)
      .set('Cookie', authCookie('admin'));

    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0].name).toBe('motion.mp4');
  });

  it('excludes zero-size recordings from results', async () => {
    mockClient.api.mockResolvedValueOnce({
      count: 1,
      status: [{ channel: 0, name: 'Back door', online: 1, sleep: 0 }],
    });
    mockClient.api.mockResolvedValueOnce({
      SearchResult: {
        File: [fileAt('valid.mp4', 10, 0, '5242880'), fileAt('phantom.mp4', 11, 0, '0')],
        Status: [],
      },
    });

    const res = await request(app)
      .get(`/api/admin/events?${validQuery}`)
      .set('Cookie', authCookie('admin'));

    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0].name).toBe('valid.mp4');
  });

  it('excludes recordings shorter than 30 seconds', async () => {
    mockClient.api.mockResolvedValueOnce({
      count: 1,
      status: [{ channel: 0, name: 'Back door', online: 1, sleep: 0 }],
    });
    // short: 13s duration; long: 46s duration
    const shortFile = { name: 'short.mp4', size: '1572864',
      StartTime: { year: 2026, mon: 4, day: 20, hour: 15, min: 15, sec: 15 },
      EndTime:   { year: 2026, mon: 4, day: 20, hour: 15, min: 15, sec: 28 } };
    const longFile  = { name: 'long.mp4',  size: '9437184',
      StartTime: { year: 2026, mon: 4, day: 20, hour: 10, min: 0, sec: 0 },
      EndTime:   { year: 2026, mon: 4, day: 20, hour: 10, min: 0, sec: 46 } };
    mockClient.api.mockResolvedValueOnce({
      SearchResult: { File: [shortFile, longFile], Status: [] },
    });

    const res = await request(app)
      .get(`/api/admin/events?${validQuery}`)
      .set('Cookie', authCookie('admin'));

    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0].name).toBe('long.mp4');
  });

  it('keeps recordings with missing EndTime (hub may not have written it yet)', async () => {
    mockClient.api.mockResolvedValueOnce({
      count: 1,
      status: [{ channel: 0, name: 'Garage', online: 1, sleep: 0 }],
    });
    const noEndTime = { name: 'recent.mp4', size: '4194304',
      StartTime: { year: 2026, mon: 4, day: 20, hour: 15, min: 15, sec: 5 } };
    mockClient.api.mockResolvedValueOnce({
      SearchResult: { File: [noEndTime], Status: [] },
    });

    const res = await request(app)
      .get(`/api/admin/events?${validQuery}`)
      .set('Cookie', authCookie('admin'));

    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0].name).toBe('recent.mp4');
  });

  it('returns an empty events array when no files are found', async () => {
    mockClient.api.mockResolvedValueOnce({
      count: 1,
      status: [{ channel: 0, name: 'Back door', online: 1, sleep: 0 }],
    });
    mockClient.api.mockResolvedValueOnce(emptySearch);

    const res = await request(app)
      .get(`/api/admin/events?${validQuery}`)
      .set('Cookie', authCookie('admin'));

    expect(res.status).toBe(200);
    expect(res.body.events).toEqual([]);
  });

  it('returns results from healthy channels when one channel search fails', async () => {
    mockClient.api.mockResolvedValueOnce(twoNamedChannels);
    mockClient.api.mockRejectedValueOnce(new Error('timeout'));
    mockClient.api.mockResolvedValueOnce({
      SearchResult: { File: [fileAt('ok.mp4', 10, 1)], Status: [] },
    });

    const res = await request(app)
      .get(`/api/admin/events?${validQuery}`)
      .set('Cookie', authCookie('admin'));

    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0].name).toBe('ok.mp4');
  });

  it('returns 503 when GetChannelstatus itself fails', async () => {
    mockClient.api.mockRejectedValueOnce(new Error('hub unreachable'));
    const res = await request(app)
      .get(`/api/admin/events?${validQuery}`)
      .set('Cookie', authCookie('admin'));
    expect(res.status).toBe(503);
  });
});
