import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

import { requireSyncAuth, requireAodIpFilter, getClientIp } from './requireAuth.js';
// Reset configService cache in tests that manipulate SYNC_KEY
import { loadConfig } from '../services/configService.js';

// ---------------------------------------------------------------------------
// Minimal mock helpers
// ---------------------------------------------------------------------------

function makeReq(ip: string, headers: Record<string, string | undefined> = {}, path = '/api/sync/browse'): Request {
  return {
    ip,
    socket: { remoteAddress: ip },
    headers,
    path,
  } as unknown as Request;
}

interface MockRes {
  statusCode: number | undefined;
  body: unknown;
  status(code: number): this;
  json(body: unknown): this;
}

function makeRes(): MockRes {
  const r: MockRes = {
    statusCode: undefined,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  return r;
}

function makeNext(): { fn: NextFunction; called: boolean } {
  const ctx = { fn: (() => { ctx.called = true; }) as NextFunction, called: false };
  return ctx;
}

// ---------------------------------------------------------------------------
// Env var management
// ---------------------------------------------------------------------------

let savedEnv: Record<string, string | undefined> = {};

function saveEnv(...keys: string[]) {
  for (const k of keys) savedEnv[k] = process.env[k];
}

function restoreEnv() {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  savedEnv = {};
}

// ---------------------------------------------------------------------------
// getClientIp
// ---------------------------------------------------------------------------

describe('getClientIp', () => {
  afterEach(() => restoreEnv());

  test('falls back to req.ip when VCAP_APPLICATION not set', () => {
    saveEnv('VCAP_APPLICATION');
    delete process.env.VCAP_APPLICATION;
    const req = makeReq('1.2.3.4');
    assert.equal(getClientIp(req), '1.2.3.4');
  });

  test('uses x-cf-true-client-ip when VCAP_APPLICATION is set', () => {
    saveEnv('VCAP_APPLICATION');
    process.env.VCAP_APPLICATION = '{"application_uris":["app.cfapps.eu10.hana.ondemand.com"]}';
    const req = makeReq('10.0.0.1', { 'x-cf-true-client-ip': '203.0.113.5' });
    assert.equal(getClientIp(req), '203.0.113.5');
  });

  test('falls back to req.ip when VCAP_APPLICATION set but header absent', () => {
    saveEnv('VCAP_APPLICATION');
    process.env.VCAP_APPLICATION = '{"application_uris":["app.cfapps.eu10.hana.ondemand.com"]}';
    const req = makeReq('10.0.0.2');
    assert.equal(getClientIp(req), '10.0.0.2');
  });
});

// ---------------------------------------------------------------------------
// requireSyncAuth
// ---------------------------------------------------------------------------

describe('requireSyncAuth — no SYNC_KEY', () => {
  beforeEach(() => saveEnv('SYNC_KEY', 'SYNC_NO_IP_PROTECTION', 'VCAP_APPLICATION', 'CONFIG_JSON'));
  afterEach(() => restoreEnv());

  test('returns 503 when SYNC_KEY is not configured', () => {
    delete process.env.SYNC_KEY;
    delete process.env.VCAP_APPLICATION;
    // Force config reload with empty variables so config-file SYNC_KEY is not used
    process.env.CONFIG_JSON = '{"services":[]}';
    loadConfig();
    const req = makeReq('10.0.0.1');
    const res = makeRes();
    const next = makeNext();
    requireSyncAuth(req, res as unknown as Response, next.fn);
    assert.equal(res.statusCode, 503);
    assert.equal(next.called, false);
  });
});

describe('requireSyncAuth — loopback bypass', () => {
  beforeEach(() => saveEnv('SYNC_KEY', 'SYNC_NO_IP_PROTECTION', 'VCAP_APPLICATION'));
  afterEach(() => restoreEnv());

  test('loopback 127.0.0.1 passes without HMAC', () => {
    process.env.SYNC_KEY = 'test-key';
    delete process.env.VCAP_APPLICATION;
    const req = makeReq('127.0.0.1');
    const res = makeRes();
    const next = makeNext();
    requireSyncAuth(req, res as unknown as Response, next.fn);
    assert.equal(next.called, true);
  });

  test('loopback ::1 passes without HMAC', () => {
    process.env.SYNC_KEY = 'test-key';
    delete process.env.VCAP_APPLICATION;
    const req = makeReq('::1');
    const res = makeRes();
    const next = makeNext();
    requireSyncAuth(req, res as unknown as Response, next.fn);
    assert.equal(next.called, true);
  });

  test('loopback ::ffff:127.0.0.1 passes without HMAC', () => {
    process.env.SYNC_KEY = 'test-key';
    delete process.env.VCAP_APPLICATION;
    const req = makeReq('::ffff:127.0.0.1');
    const res = makeRes();
    const next = makeNext();
    requireSyncAuth(req, res as unknown as Response, next.fn);
    assert.equal(next.called, true);
  });
});

describe('requireSyncAuth — HMAC validation (IP protection disabled)', () => {
  const SYNC_KEY = 'my-sync-secret';

  beforeEach(() => saveEnv('SYNC_KEY', 'SYNC_NO_IP_PROTECTION', 'VCAP_APPLICATION', 'SYNC_WHITELIST_IPS'));
  afterEach(() => restoreEnv());

  function validHmac(key: string, ts: string): string {
    return createHmac('sha256', key).update(ts).digest('hex');
  }

  test('valid HMAC passes', () => {
    process.env.SYNC_KEY = SYNC_KEY;
    process.env.SYNC_NO_IP_PROTECTION = 'true';
    delete process.env.VCAP_APPLICATION;
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = validHmac(SYNC_KEY, ts);
    const req = makeReq('8.8.8.8', { 'x-sync-ts': ts, 'x-sync-sig': sig });
    const res = makeRes();
    const next = makeNext();
    requireSyncAuth(req, res as unknown as Response, next.fn);
    assert.equal(next.called, true);
  });

  test('wrong key returns 401', () => {
    process.env.SYNC_KEY = SYNC_KEY;
    process.env.SYNC_NO_IP_PROTECTION = 'true';
    delete process.env.VCAP_APPLICATION;
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = validHmac('wrong-key', ts);
    const req = makeReq('8.8.8.8', { 'x-sync-ts': ts, 'x-sync-sig': sig });
    const res = makeRes();
    const next = makeNext();
    requireSyncAuth(req, res as unknown as Response, next.fn);
    assert.equal(res.statusCode, 401);
    assert.equal(next.called, false);
  });

  test('timestamp skew > 60s returns 401', () => {
    process.env.SYNC_KEY = SYNC_KEY;
    process.env.SYNC_NO_IP_PROTECTION = 'true';
    delete process.env.VCAP_APPLICATION;
    const staleTs = String(Math.floor(Date.now() / 1000) - 120);
    const sig = validHmac(SYNC_KEY, staleTs);
    const req = makeReq('8.8.8.8', { 'x-sync-ts': staleTs, 'x-sync-sig': sig });
    const res = makeRes();
    const next = makeNext();
    requireSyncAuth(req, res as unknown as Response, next.fn);
    assert.equal(res.statusCode, 401);
  });

  test('missing HMAC headers returns 401', () => {
    process.env.SYNC_KEY = SYNC_KEY;
    process.env.SYNC_NO_IP_PROTECTION = 'true';
    delete process.env.VCAP_APPLICATION;
    const req = makeReq('8.8.8.8');
    const res = makeRes();
    const next = makeNext();
    requireSyncAuth(req, res as unknown as Response, next.fn);
    assert.equal(res.statusCode, 401);
  });
});

describe('requireSyncAuth — IP filtering', () => {
  beforeEach(() => saveEnv('SYNC_KEY', 'SYNC_NO_IP_PROTECTION', 'VCAP_APPLICATION', 'SYNC_WHITELIST_IPS', 'SYNC_INTERNAL_IP_WHITELIST'));
  afterEach(() => restoreEnv());

  test('private IP 10.x proceeds past IP filter (reaches HMAC check → 401)', () => {
    process.env.SYNC_KEY = 'test-key';
    delete process.env.SYNC_NO_IP_PROTECTION;
    delete process.env.VCAP_APPLICATION;
    const req = makeReq('10.1.2.3'); // private range always allowed
    const res = makeRes();
    const next = makeNext();
    requireSyncAuth(req, res as unknown as Response, next.fn);
    // Passed IP filter but no HMAC headers → 401
    assert.equal(res.statusCode, 401);
  });

  test('private IP 192.168.x proceeds past IP filter', () => {
    process.env.SYNC_KEY = 'test-key';
    delete process.env.SYNC_NO_IP_PROTECTION;
    delete process.env.VCAP_APPLICATION;
    const req = makeReq('192.168.10.5');
    const res = makeRes();
    const next = makeNext();
    requireSyncAuth(req, res as unknown as Response, next.fn);
    assert.equal(res.statusCode, 401); // IP passed, HMAC missing
  });

  test('SYNC_WHITELIST_IPS allows extra CIDRs', () => {
    process.env.SYNC_KEY = 'test-key';
    process.env.SYNC_WHITELIST_IPS = '203.0.113.0/24';
    delete process.env.SYNC_NO_IP_PROTECTION;
    delete process.env.VCAP_APPLICATION;
    const req = makeReq('203.0.113.42');
    const res = makeRes();
    const next = makeNext();
    requireSyncAuth(req, res as unknown as Response, next.fn);
    assert.equal(res.statusCode, 401); // IP allowed, HMAC missing → 401 (not 403)
  });
});

// ---------------------------------------------------------------------------
// requireAodIpFilter
// ---------------------------------------------------------------------------

describe('requireAodIpFilter', () => {
  beforeEach(() => saveEnv('AOD_NO_IP_PROTECTION', 'AOD_WHITELIST_IPS', 'VCAP_APPLICATION'));
  afterEach(() => restoreEnv());

  test('loopback always passes', () => {
    delete process.env.AOD_NO_IP_PROTECTION;
    delete process.env.VCAP_APPLICATION;
    const req = makeReq('127.0.0.1');
    const res = makeRes();
    const next = makeNext();
    requireAodIpFilter(req, res as unknown as Response, next.fn);
    assert.equal(next.called, true);
  });

  test('AOD_NO_IP_PROTECTION=true bypasses filter', () => {
    process.env.AOD_NO_IP_PROTECTION = 'true';
    delete process.env.VCAP_APPLICATION;
    const req = makeReq('1.2.3.4');
    const res = makeRes();
    const next = makeNext();
    requireAodIpFilter(req, res as unknown as Response, next.fn);
    assert.equal(next.called, true);
  });

  test('private IP 10.x passes', () => {
    delete process.env.AOD_NO_IP_PROTECTION;
    delete process.env.VCAP_APPLICATION;
    const req = makeReq('10.5.6.7');
    const res = makeRes();
    const next = makeNext();
    requireAodIpFilter(req, res as unknown as Response, next.fn);
    assert.equal(next.called, true);
  });
});
