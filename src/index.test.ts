import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

// Hoisted above imports by Vitest's transform — intercepts these modules in app.ts too
vi.mock('reolink-nvr-api/endpoints/system', () => ({ getDevInfo: vi.fn(), getAbility: vi.fn() }));
vi.mock('reolink-nvr-api/snapshot', () => ({ snapToBuffer: vi.fn() }));

import { getDevInfo, getAbility } from 'reolink-nvr-api/endpoints/system';
import { snapToBuffer } from 'reolink-nvr-api/snapshot';
import { ReolinkHttpError } from 'reolink-nvr-api/types';

import {
  parseCookies, signSession, verifySession,
  safeCompare, toReolinkTime, hasFiles, sendError,
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
const mockGetAbility   = vi.mocked(getAbility);

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
    mockGetAbility.mockResolvedValueOnce(ability as never);
    const res = await request(app)
      .get('/api/admin/ability')
      .set('Cookie', authCookie('admin'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual(ability);
  });

  it('returns 503 when the hub is unreachable', async () => {
    mockGetAbility.mockRejectedValueOnce(new Error('connection refused'));
    const res = await request(app)
      .get('/api/admin/ability')
      .set('Cookie', authCookie('admin'));
    expect(res.status).toBe(503);
  });

  it('returns 502 for a hub API error', async () => {
    mockGetAbility.mockRejectedValueOnce(new ReolinkHttpError(200, -9, 'Not supported'));
    const res = await request(app)
      .get('/api/admin/ability')
      .set('Cookie', authCookie('admin'));
    expect(res.status).toBe(502);
  });
});
