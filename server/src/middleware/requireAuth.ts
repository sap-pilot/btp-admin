import type { Request, Response, NextFunction } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { getXsuaaConfig, readSessionFromRequest } from '../services/authService.js';
import type { SessionPayload } from '../services/authService.js';
import { getSyncKey } from '../services/status/configService.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

export interface AuthRequest extends Request {
  authSession?: SessionPayload;
}

function getSession(req: Request): SessionPayload | null {
  const x = getXsuaaConfig();
  if (!x) return null;
  return readSessionFromRequest(req.headers.cookie ?? '', x.clientsecret);
}

/** Requires any authenticated session. Pass-through when XSUAA is not configured. */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!getXsuaaConfig()) { next(); return; }
  const session = getSession(req);
  if (!session) { res.status(401).json({ error: 'Authentication required' }); return; }
  (req as AuthRequest).authSession = session;
  next();
}

/**
 * Guards sync endpoints when a sync key is configured.
 * Allows the request if:
 *   - No sync key is configured (open access)
 *   - The request originates from loopback (127.0.0.1 / ::1) — local dev
 *   - The request carries valid HMAC-signed headers (x-sync-ts + x-sync-sig) within a 1-minute window
 *   - The request carries a valid XSUAA session cookie
 * Otherwise responds 401.
 */
export function requireSyncAuth(req: Request, res: Response, next: NextFunction): void {
  const syncKey = getSyncKey();
  if (!syncKey) { next(); return; }
  const ip = req.ip ?? req.socket.remoteAddress ?? '';
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') { next(); return; }
  const ts = req.headers['x-sync-ts'];
  const sig = req.headers['x-sync-sig'];
  if (typeof ts === 'string' && typeof sig === 'string') {
    const tsNum = parseInt(ts, 10);
    const now = Math.floor(Date.now() / 1000);
    const skew = isNaN(tsNum) ? Infinity : Math.abs(now - tsNum);
    if (skew > 60) {
      logger.warn({ skewSec: skew, ip, path: req.path }, 'Sync auth rejected: timestamp skew exceeds 60 s');
    } else {
      const expected = createHmac('sha256', syncKey).update(ts).digest('hex');
      const expBuf = Buffer.from(expected);
      const sigBuf = Buffer.from(sig);
      if (expBuf.length === sigBuf.length && timingSafeEqual(expBuf, sigBuf)) { next(); return; }
      logger.warn({ ip, path: req.path }, 'Sync auth rejected: HMAC signature mismatch');
    }
  }
  const x = getXsuaaConfig();
  if (x) {
    const session = readSessionFromRequest(req.headers.cookie ?? '', x.clientsecret);
    if (session) { next(); return; }
  }
  res.status(401).json({
    error: 'Unauthorized: provide valid HMAC sync signature headers (x-sync-ts, x-sync-sig) or authenticate via XSUAA',
  });
}

/**
 * Same as requireSyncAuth but skips all validation when SYNC_PROTECTION_OFF is set.
 * Used on /api/browse and /api/batch-download so a backup/transitory instance can
 * pull files without needing a matching SYNC_KEY.
 */
export function requireSyncAuthOrOpen(req: Request, res: Response, next: NextFunction): void {
  if (config.SYNC_PROTECTION_OFF) { next(); return; }
  requireSyncAuth(req, res, next);
}

/** Requires admin scope. Pass-through when XSUAA is not configured. */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!getXsuaaConfig()) { next(); return; }
  const session = getSession(req);
  if (!session) { res.status(401).json({ error: 'Authentication required' }); return; }
  if (!session.isAdmin) { res.status(403).json({ error: 'Admin role required' }); return; }
  (req as AuthRequest).authSession = session;
  next();
}
