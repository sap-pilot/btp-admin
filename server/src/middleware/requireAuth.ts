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
 * Guards /api/browse, /api/batch-download, and /api/download-trigger.
 * HMAC-only: accepts only loopback or valid HMAC-signed headers (x-sync-ts + x-sync-sig).
 * XSUAA session cookies are NOT accepted — sync endpoints are exclusively for peer-sync.
 * When SYNC_KEY is not configured the request passes through (open deployment).
 */
export function requireSyncAuth(req: Request, res: Response, next: NextFunction): void {
  const syncKey = getSyncKey();

  // Loopback: always allow for local dev
  const ip = req.ip ?? req.socket.remoteAddress ?? '';
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') { next(); return; }

  // HMAC peer-sync: if syncKey is set and signature is valid → allow
  if (syncKey) {
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
  }

  // Open deployment (no SYNC_KEY) → allow
  if (!syncKey) { next(); return; }

  // SYNC_KEY configured but no valid HMAC → reject
  logger.debug({ ip, path: req.path }, 'Sync auth rejected: no valid HMAC headers');
  res.status(401).json({
    error: 'Unauthorized: provide valid HMAC sync signature headers (x-sync-ts, x-sync-sig)',
  });
}

/**
 * Same as requireSyncAuth but skips all validation when SYNC_PROTECTION_OFF is set.
 * Used on /api/browse and /api/batch-download for transitory open access during key rotation.
 * Like requireSyncAuth, XSUAA session cookies are NOT accepted on these routes.
 */
export function requireSyncAuthOrOpen(req: Request, res: Response, next: NextFunction): void {
  if (config.SYNC_PROTECTION_OFF) { next(); return; }
  requireSyncAuth(req, res, next);
}

/**
 * Global session-auth guard for all /api/* routes when XSUAA is configured.
 * Passes through when:
 *   - XSUAA is not configured (open deployment)
 *   - path is /me or /info (always public)
 *   - request carries x-sync-sig HMAC headers (peer sync — per-route requireSyncAuth handles it;
 *     /api/view rejects HMAC at the per-route requireAuth level since it requires an XSUAA session)
 *   - SYNC_PROTECTION_OFF is active and the path is /browse or /batch-download
 */
export function requireSessionGlobal(req: Request, res: Response, next: NextFunction): void {
  if (req.path === '/me' || req.path === '/info' || req.path === '/settings') { next(); return; }
  if (req.headers['x-sync-sig']) { next(); return; }
  if (config.SYNC_PROTECTION_OFF && (req.path === '/browse' || req.path === '/batch-download')) { next(); return; }
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
