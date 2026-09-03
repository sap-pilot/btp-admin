import type { Request, Response, NextFunction } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { getXsuaaConfig, readSessionFromRequest } from '../services/authService.js';
import type { SessionPayload } from '../services/authService.js';
import { getSyncKey, getSyncNoIpProtection, getSyncWhitelistIPs, getSyncInternalIpWhitelist, getAodNoIpProtection, getAodWhitelistIPs } from '../services/configService.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

/**
 * Resolve the true client IP for a request.
 * On SAP BTP Cloud Foundry, the GoRouter injects x-cf-true-client-ip and strips any
 * client-supplied copy of that header — so it is trustworthy only when running on CF
 * (VCAP_APPLICATION present). In other environments (local dev, Docker, custom deploys)
 * the header can be forged by the caller, so we fall back to the socket-level IP.
 */
export function getClientIp(req: Request): string {
  if (process.env.VCAP_APPLICATION) {
    const header = req.headers['x-cf-true-client-ip'];
    if (typeof header === 'string' && header.trim()) return header.trim();
  }
  return req.ip ?? req.socket.remoteAddress ?? '';
}

// --- IP whitelist helpers (CIDR matching, no external deps) ---

function normalizeIp(ip: string): string {
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

function ipToU32(ip: string): number {
  const parts = ip.split('.');
  if (parts.length !== 4) return -1;
  let n = 0;
  for (const p of parts) {
    const b = parseInt(p, 10);
    if (isNaN(b) || b < 0 || b > 255) return -1;
    n = ((n << 8) | b) >>> 0;
  }
  return n;
}

function ipMatchesCidr(ip: string, cidr: string): boolean {
  const slash = cidr.indexOf('/');
  if (slash < 0) return ip === cidr;
  const base  = cidr.slice(0, slash);
  const bits  = parseInt(cidr.slice(slash + 1), 10);
  if (isNaN(bits) || bits < 0 || bits > 32) return false;
  const mask    = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  const ipNum   = ipToU32(ip);
  const baseNum = ipToU32(base);
  return ipNum >= 0 && (ipNum & mask) === (baseNum & mask);
}

function isIpAllowed(rawIp: string, list: string[]): boolean {
  const ip = normalizeIp(rawIp);
  return list.some(entry => ipMatchesCidr(ip, entry));
}

// RFC 1918 private IP ranges — always permitted for CF internal / container-to-container traffic
const CF_PRIVATE_CIDRS = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'];

// Lazy-loaded from ./config/btp-endpoints.json (relative to server CWD) — cached for process lifetime
let _btpEgressIPs: string[] | null = null;
function getBtpEgressIPs(): string[] {
  if (_btpEgressIPs !== null) return _btpEgressIPs;
  try {
    const data = JSON.parse(readFileSync('./config/btp-endpoints.json', 'utf-8')) as {
      region?: Record<string, { egressIPs?: Record<string, string[]> }>;
    };
    const ips: string[] = [];
    for (const region of Object.values(data.region ?? {})) {
      for (const block of Object.values(region.egressIPs ?? {})) {
        ips.push(...block);
      }
    }
    _btpEgressIPs = ips;
    logger.info({ count: ips.length }, 'BTP egress IP whitelist loaded from btp-endpoints.json');
  } catch {
    _btpEgressIPs = [];
  }
  return _btpEgressIPs;
}

// ---------------------------------------------------------------

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
    logger.warn({ ip: getClientIp(req), path: req.path }, 'Sync request rejected: SYNC_KEY is not configured');
    res.status(503).json({ error: 'Sync endpoint unavailable: SYNC_KEY is not configured on this server' });
    return;
  }

  // Loopback: always allow for local dev
  const ip = getClientIp(req);
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') { next(); return; }

  // IP whitelist: when btp-endpoints.json is present and SYNC_NO_IP_PROTECTION is not set,
  // only allow IPs from BTP egress ranges plus SYNC_WHITELIST_IPS.
  if (!getSyncNoIpProtection()) {
    const whitelist = [...getBtpEgressIPs(), ...getSyncWhitelistIPs(), ...getSyncInternalIpWhitelist(), ...CF_PRIVATE_CIDRS];
    if (whitelist.length > 0) {
      if (!isIpAllowed(ip, whitelist)) {
        logger.warn({ ip, path: req.path },
          'Sync request blocked: IP not in BTP egress whitelist — set SYNC_NO_IP_PROTECTION=true to disable, or add to SYNC_WHITELIST_IPS');
        res.status(403).json({ error: 'Forbidden: request origin IP is not in the allowed whitelist' });
        return;
      }
    }
  }

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

/**
 * Guards the /aod proxy endpoint.
 * Allows loopback (local dev), AOD_NO_IP_PROTECTION=true, or IPs in the BTP egress list
 * plus any AOD_WHITELIST_IPS. When btp-endpoints.json is absent and no whitelist is set,
 * the check is a no-op (same behaviour as sync IP filtering).
 */
export function requireAodIpFilter(req: Request, res: Response, next: NextFunction): void {
  if (getAodNoIpProtection()) { next(); return; }

  const ip = getClientIp(req);
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') { next(); return; }

  const whitelist = [...getBtpEgressIPs(), ...getAodWhitelistIPs(), ...CF_PRIVATE_CIDRS];
  if (whitelist.length > 0 && !isIpAllowed(ip, whitelist)) {
    logger.warn({ ip, path: req.path },
      'AOD request blocked: IP not in BTP egress whitelist — set AOD_NO_IP_PROTECTION=true to disable, or add to AOD_WHITELIST_IPS');
    res.status(403).json({ error: 'Forbidden: request origin is not in the allowed whitelist' });
    return;
  }

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
