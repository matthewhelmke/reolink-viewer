import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Response } from 'express';
import { ReolinkHttpError } from 'reolink-nvr-api/types';

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const val = part.slice(eq + 1).trim();
    try { out[key] = decodeURIComponent(val); } catch { out[key] = val; }
  }
  return out;
}

export function signSession(role: string, secret: string): string {
  const data = Buffer.from(JSON.stringify({ role, iat: Math.floor(Date.now() / 1000) }))
    .toString('base64url');
  const sig = createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${sig}`;
}

export function verifySession(value: string, secret: string): { role: string } | null {
  const dot = value.lastIndexOf('.');
  if (dot < 0) return null;
  const data = value.slice(0, dot);
  const sig  = value.slice(dot + 1);
  try {
    const expected = createHmac('sha256', secret).update(data).digest('base64url');
    if (!timingSafeEqual(Buffer.from(sig, 'base64url'), Buffer.from(expected, 'base64url'))) return null;
    return JSON.parse(Buffer.from(data, 'base64url').toString('utf8')) as { role: string };
  } catch {
    return null;
  }
}

// Timing-safe password comparison: compares HMACs so neither length nor content leaks.
export function safeCompare(a: string, b: string, secret: string): boolean {
  const ha = createHmac('sha256', secret).update(a).digest();
  const hb = createHmac('sha256', secret).update(b).digest();
  return timingSafeEqual(ha, hb);
}

// Convert a JS Date to the local-time object the Reolink Search API requires.
// The hub indexes recordings in its own local time, so we use local (not UTC) components.
export function toReolinkTime(date: Date) {
  return {
    year: date.getFullYear(),
    mon:  date.getMonth() + 1,
    day:  date.getDate(),
    hour: date.getHours(),
    min:  date.getMinutes(),
    sec:  date.getSeconds(),
  };
}

// Returns true if a Search response contains at least one file entry.
export function hasFiles(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false;
  const r  = result as Record<string, unknown>;
  const sr = (r['SearchResult'] ?? r) as Record<string, unknown>;
  return Array.isArray(sr['File']) && (sr['File'] as unknown[]).length > 0;
}

export function sendError(res: Response, error: unknown): void {
  if (error instanceof ReolinkHttpError) {
    if (error.rspCode === -1) {
      res.status(401).json({ error: 'Authentication failed', detail: error.detail });
    } else {
      res.status(502).json({ error: error.detail, code: error.rspCode });
    }
  } else if (error instanceof Error) {
    res.status(503).json({ error: 'Device unreachable', detail: error.message });
  } else {
    res.status(500).json({ error: 'Unknown error' });
  }
}
