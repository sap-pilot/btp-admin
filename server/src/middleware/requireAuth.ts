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
 * Guards /api/browse, /api/batch-download, and /api/download.
 * Allows the request when ANY of the following is true:
 *   - Loopback origin (127.0.0.1 / ::1) — local dev
 *   - Valid HMAC-signed headers (x-sync-ts + x-sync-sig) within a ±1-minute window
 *     (peer-sync; attaches no authSession — route handler treats absence as full access)
 *   - Valid XSUAA session cookie (attaches authSession; route handler enforces role)
 * When neither SYNC_KEY nor XSUAA is configured the request passes through (open deployment).
 * When XSUAA is configured but there is no SYNC_KEY, XSUAA authentication is still required.
 */
export function requireSyncAuth(req: Request, res: Response, next: NextFunction): void {
  const syncKey = getSyncKey();
  const xsuaa   = getXsuaaConfig();

  // Loopback: always allow for local dev
  const ip = req.ip ?? req.socket.remoteAddress ?? '';
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') { next(); return; }

  // HMAC peer-sync: if syncKey is set and signature is valid → allow (no session attached)
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

  // XSUAA session: attach to request so route handlers can enforce role-level access
  if (xsuaa) {
    const session = readSessionFromRequest(req.headers.cookie ?? '', xsuaa.clientsecret);
    if (session) { (req as AuthRequest).authSession = session; next(); return; }
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  // Open deployment (no SYNC_KEY, no XSUAA) → allow
  if (!syncKey) { next(); return; }

  // SYNC_KEY configured but no valid HMAC and no XSUAA → reject
  res.status(401).json({
    error: 'Unauthorized: provide valid HMAC sync signature headers (x-sync-ts, x-sync-sig)',
  });
}

/**
 * Same as requireSyncAuth but skips all validation when SYNC_PROTECTION_OFF is set.
 * Used on /api/browse and /api/batch-download for transitory open access during key rotation.
 */
export function requireSyncAuthOrOpen(req: Request, res: Response, next: NextFunction): void {
  if (config.SYNC_PROTECTION_OFF) { next(); return; }
  requireSyncAuth(req, res, next);
}

/**
 * Global session-auth guard for all /api/* routes when XSUAA is configured.
 * Passes through when:
 *   - XSUAA is not configured (open deployment)
 *   - path is /me (auth-state probe — always public so the client can detect auth)
 *   - request carries x-sync-sig HMAC headers (peer sync — per-route requireSyncAuth handles it)
 *   - SYNC_PROTECTION_OFF is active and the path is /browse or /batch-download
 */
export function requireSessionGlobal(req: Request, res: Response, next: NextFunction): void {
  if (req.path === '/me' || req.path === '/info') { next(); return; }
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
