import { Router } from 'express';
import type { Request, Response } from 'express';
import { getXsuaaConfig, buildAuthUrl, exchangeCode, signSession, readSessionFromRequest, userAuditLog } from '../services/authService.js';
import { getClientIp } from '../middleware/requireAuth.js';
import { logger } from '../logger.js';

const router = Router();

/** Derive the app's base URL from the actual request headers.
 *  VCAP_APPLICATION.application_uris[0] is intentionally avoided — that URI may be
 *  a stale default CF route that no longer exists; the real live route is in the headers. */
function callbackBase(req: Request): string {
  const proto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim() ?? req.protocol;
  const host = (req.headers['x-forwarded-host'] as string | undefined)?.split(',')[0]?.trim() ?? (req.headers.host ?? 'localhost');
  return `${proto}://${host}`;
}

/** Origin to use as postMessage target — always derived from the actual request so it matches
 *  the opener window's origin regardless of how many CF routes or custom domains are in use. */
function targetOrigin(req: Request): string {
  const proto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim() ?? req.protocol;
  const host = (req.headers['x-forwarded-host'] as string | undefined)?.split(',')[0]?.trim() ?? (req.headers.host ?? 'localhost');
  return `${proto}://${host}`;
}

function setCookie(res: Response, value: string, maxAge: number): void {
  const secure = process.env.VCAP_APPLICATION ? '; Secure' : '';
  res.setHeader('Set-Cookie', `btpauth=${value}; Path=/; HttpOnly${secure}; SameSite=Lax; Max-Age=${maxAge}`);
}

function clearCookie(res: Response): void {
  res.setHeader('Set-Cookie', 'btpauth=; Path=/; HttpOnly; Max-Age=0');
}

function popupHtml(script: string, message: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>BTP Status</title>` +
    `<style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;` +
    `height:100vh;margin:0;background:#0f0f0f;color:#888;font-size:13px}</style></head>` +
    `<body><p>${message}</p><script>${script}<\/script></body></html>`;
}

/**
 * Build the notification script that runs in the popup after login/logout.
 * Uses two channels in parallel:
 *  1. postMessage via window.opener (may be null in Chrome after cross-origin XSUAA navigation)
 *  2. BroadcastChannel (works regardless of opener state; same-origin only)
 */
function notifyScript(msg: string, origin: string): string {
  const bc = `try{var _bc=new BroadcastChannel('btpauth');_bc.postMessage(${msg});_bc.close();}catch(e){}`;
  return `try{window.opener&&window.opener.postMessage(${msg},${JSON.stringify(origin)});}catch(e){}${bc}window.close();`;
}

/** Redirect popup to XSUAA authorize endpoint. */
router.get('/login', (req: Request, res: Response) => {
  const x = getXsuaaConfig();
  if (!x) { res.status(503).send('XSUAA not configured'); return; }
  try {
    const url = buildAuthUrl(callbackBase(req));
    res.type('html').send(popupHtml(`window.location.href=${JSON.stringify(url)};`, 'Redirecting to login…'));
  } catch (err) {
    logger.error({ err }, 'Failed to build auth URL');
    res.status(500).send('Auth configuration error');
  }
});

/** Exchange auth code → JWT → signed session cookie, then notify opener. */
router.get('/login/callback', async (req: Request, res: Response) => {
  const x = getXsuaaConfig();
  if (!x) { res.status(503).send('XSUAA not configured'); return; }
  const code = typeof req.query['code'] === 'string' ? req.query['code'] : '';
  if (!code) { res.status(400).send('Missing authorization code'); return; }
  try {
    const session = await exchangeCode(code, callbackBase(req));
    const cookieValue = signSession(session, x.clientsecret);
    const ttl = Math.max(60, session.exp - Math.floor(Date.now() / 1000));
    setCookie(res, cookieValue, ttl);
    logger.info({ user: userAuditLog(session), ip: getClientIp(req) }, 'User logged in');
    const origin = targetOrigin(req);
    const msg = JSON.stringify({ type: 'login', user: { firstName: session.firstName, initials: session.initials, isAdmin: session.isAdmin } });
    res.type('html').send(popupHtml(notifyScript(msg, origin), 'Login successful — this window will close.'));
  } catch (err) {
    logger.error({ err }, 'Login callback error');
    const origin = targetOrigin(req);
    const msg = JSON.stringify({ type: 'login-error' });
    res.status(500).type('html').send(popupHtml(notifyScript(msg, origin), 'Login failed — please close this window and try again.'));
  }
});

/** Clear local session cookie, then redirect popup through XSUAA logout to invalidate XSUAA session. */
router.get('/logout', (req: Request, res: Response) => {
  const x = getXsuaaConfig();
  const session = x ? readSessionFromRequest(req.headers.cookie ?? '', x.clientsecret) : null;
  if (session) {
    logger.info({ user: userAuditLog(session), ip: getClientIp(req) }, 'User logged out');
  }
  clearCookie(res);
  if (x) {
    const redirectUri = `${callbackBase(req)}/logout/callback`;
    const logoutParams = new URLSearchParams({ client_id: x.clientid, redirect: redirectUri });
    res.redirect(`${x.url}/logout.do?${logoutParams}`);
  } else {
    const origin = targetOrigin(req);
    const msg = JSON.stringify({ type: 'logout' });
    res.type('html').send(popupHtml(notifyScript(msg, origin), 'Logged out — this window will close.'));
  }
});

/** XSUAA redirects here after completing its own logout; notify opener and close popup. */
router.get('/logout/callback', (req: Request, res: Response) => {
  const origin = targetOrigin(req);
  const msg = JSON.stringify({ type: 'logout' });
  res.type('html').send(popupHtml(notifyScript(msg, origin), 'Logged out — this window will close.'));
});

export default router;
