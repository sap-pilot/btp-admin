import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  signSession,
  verifySession,
  readSessionFromRequest,
  userLabel,
  cacheUserToken,
  getCachedUserToken,
} from './authService.js';
import type { SessionPayload } from './authService.js';

const SECRET = 'test-session-secret-32chars-long!!';

function makeSession(overrides: Partial<SessionPayload> = {}): SessionPayload {
  return {
    firstName: 'Alice',
    lastName: 'Smith',
    userName: 'alice@example.com',
    email: 'alice@example.com',
    initials: 'AS',
    origin: 'ldap',
    isAdmin: false,
    sub: 'sub-001',
    exp: Math.floor(Date.now() / 1000) + 3600, // 1 hour from now
    ...overrides,
  };
}

describe('signSession / verifySession', () => {
  test('round-trips a valid session', () => {
    const session = makeSession();
    const token = signSession(session, SECRET);
    const recovered = verifySession(token, SECRET);
    assert.ok(recovered);
    assert.equal(recovered.sub, session.sub);
    assert.equal(recovered.email, session.email);
    assert.equal(recovered.isAdmin, session.isAdmin);
  });

  test('returns null for tampered payload', () => {
    const session = makeSession();
    const token = signSession(session, SECRET);
    // Flip last char of MAC
    const tampered = token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a');
    assert.equal(verifySession(tampered, SECRET), null);
  });

  test('returns null for wrong secret', () => {
    const session = makeSession();
    const token = signSession(session, SECRET);
    assert.equal(verifySession(token, 'wrong-secret'), null);
  });

  test('returns null for expired session', () => {
    const session = makeSession({ exp: Math.floor(Date.now() / 1000) - 60 }); // expired 1 min ago
    const token = signSession(session, SECRET);
    assert.equal(verifySession(token, SECRET), null);
  });

  test('returns null when no dot separator', () => {
    assert.equal(verifySession('nodothere', SECRET), null);
  });

  test('preserves all session fields', () => {
    const session = makeSession({ isAdmin: true, initials: 'XY' });
    const token = signSession(session, SECRET);
    const recovered = verifySession(token, SECRET);
    assert.ok(recovered);
    assert.equal(recovered.isAdmin, true);
    assert.equal(recovered.initials, 'XY');
    assert.equal(recovered.origin, 'ldap');
  });
});

describe('readSessionFromRequest', () => {
  test('extracts btpauth cookie', () => {
    const session = makeSession();
    const token = signSession(session, SECRET);
    const recovered = readSessionFromRequest(`btpauth=${token}`, SECRET);
    assert.ok(recovered);
    assert.equal(recovered.sub, session.sub);
  });

  test('finds btpauth among multiple cookies', () => {
    const session = makeSession();
    const token = signSession(session, SECRET);
    const recovered = readSessionFromRequest(`other=val; btpauth=${token}; another=x`, SECRET);
    assert.ok(recovered);
    assert.equal(recovered.sub, session.sub);
  });

  test('returns null when btpauth cookie is absent', () => {
    assert.equal(readSessionFromRequest('sessionid=abc; lang=en', SECRET), null);
  });

  test('returns null for empty cookie header', () => {
    assert.equal(readSessionFromRequest('', SECRET), null);
  });

  test('returns null when token is invalid', () => {
    assert.equal(readSessionFromRequest('btpauth=garbage-token', SECRET), null);
  });
});

describe('userLabel', () => {
  test('includes email when different from userName', () => {
    const s = makeSession({ userName: 'alice', email: 'alice@example.com' });
    const label = userLabel(s);
    assert.ok(label.includes('alice'));
    assert.ok(label.includes('<alice@example.com>'));
  });

  test('omits email when same as userName', () => {
    const s = makeSession({ userName: 'alice@example.com', email: 'alice@example.com' });
    const label = userLabel(s);
    assert.ok(!label.includes('<'));
  });

  test('includes origin in parentheses', () => {
    const s = makeSession({ origin: 'ldap' });
    const label = userLabel(s);
    assert.ok(label.includes('(ldap)'));
  });

  test('omits origin when empty', () => {
    const s = makeSession({ origin: '' });
    const label = userLabel(s);
    assert.ok(!label.includes('('));
  });
});

describe('cacheUserToken / getCachedUserToken', () => {
  const SUB = 'test-sub-token';

  beforeEach(() => {
    // Clear any cached token by caching an expired one
    cacheUserToken(SUB, 'expired', Math.floor(Date.now() / 1000) - 120);
  });

  test('returns cached token when valid', () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    cacheUserToken(SUB, 'my-token', exp);
    assert.equal(getCachedUserToken(SUB), 'my-token');
  });

  test('returns null for unknown sub', () => {
    assert.equal(getCachedUserToken('unknown-sub'), null);
  });

  test('returns null when token expires within 60s', () => {
    const exp = Math.floor(Date.now() / 1000) + 30; // expires in 30s, within the 60s buffer
    cacheUserToken(SUB, 'near-expiry', exp);
    assert.equal(getCachedUserToken(SUB), null);
  });

  test('evicts near-expired tokens on access', () => {
    const exp = Math.floor(Date.now() / 1000) + 30;
    cacheUserToken(SUB, 'near-expiry', exp);
    getCachedUserToken(SUB); // triggers eviction
    // Second call should also return null (entry removed)
    assert.equal(getCachedUserToken(SUB), null);
  });
});
