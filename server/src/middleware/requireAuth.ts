import type { Request, Response, NextFunction } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { getXsuaaConfig, readSessionFromRequest } from '../services/authService.js';
import type { SessionPayload } from '../services/authService.js';
import { getSyncKey } from '../services/configService.js';
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
 * Guards /api/sync/* routes.
 * HMAC-only: accepts loopback, SYNC_PROTECTION_OFF override, or valid HMAC headers.
 * XSUAA session cookies are NOT accepted — sync endpoints are exclusively for peer-sync.
 * When SYNC_KEY is not configured the request is rejected with 503 (misconfiguration).
 */
export function requireSyncAuth(req: Request, res: Response, next: NextFunction): void {
  // Transitory open access during key rotation
  if (config.SYNC_PROTECTION_OFF) { next(); return; }

  const syncKey = getSyncKey();

  // SYNC_KEY not configured → refuse with 503 (server misconfiguration)
  if (!syncKey) {
    logger.warn({ ip: req.ip, path: req.path }, 'Sync request rejected: SYNC_KEY is not configured');
    res.status(503).json({ error: 'Sync endpoint unavailable: SYNC_KEY is not configured on this server' });
    return;
  }

  // Loopback: always allow for local dev
  const ip = req.ip ?? req.socket.remoteAddress ?? '';
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') { next(); return; }

  // HMAC peer-sync: signature must be valid
  const ts  = req.headers['x-sync-ts'];
  const sig = req.headers['x-sync-sig'];
  if (typeof ts === 'string' && typeof sig === 'string') {
    const tsNum = parseInt(ts, 10);
    const now   = Math.floor(Date.now() / 1000);
    const skew  = isNaN(tsNum) ? Infinity : Math.abs(now - tsNum);
    if (skew <= 60) {
      const expected = createHmac('sha256', syncKey).update(ts).digest('hex');
      const expBuf   = Buffer.from(expected);
      const sigBuf   = Buffer.from(sig);
      if (expBuf.length === sigBuf.length && timingSafeEqual(expBuf, sigBuf)) { next(); return; }
    }
    logger.warn({ ip, path: req.path }, 'Sync auth rejected: invalid HMAC signature or timestamp skew');
  }

  logger.debug({ ip, path: req.path }, 'Sync auth rejected: no valid HMAC headers');
  res.status(401).json({
    error: 'Unauthorized: provide valid HMAC sync signature headers (x-sync-ts, x-sync-sig)',
  });
}

/**
 * Global session-auth guard for all /api/* routes when XSUAA is configured.
 * Passes through when:
 *   - XSUAA is not configured (open deployment)
 *   - path is /me or /info (always public)
 *   - request carries x-sync-sig HMAC headers (peer sync — per-route requireSyncAuth handles it)
 *   - SYNC_PROTECTION_OFF is active and the path is a /sync/* browse/batch endpoint
 */
export function requireSessionGlobal(req: Request, res: Response, next: NextFunction): void {
  if (req.path === '/me' || req.path === '/info' || req.path === '/settings') { next(); return; }
  if (req.headers['x-sync-sig']) { next(); return; }
  if (config.SYNC_PROTECTION_OFF && (req.path === '/sync/browse' || req.path === '/sync/batch')) { next(); return; }
  const x = getXsuaaConfig();
  if (!x) { next(); return; }
  const session = readSessionFromRequest(req.headers.cookie ?? '', x.clientsecret);
  if (!session) { res.status(401).json({ error: 'Authentication required' }); return; }
  next();
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
