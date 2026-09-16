import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { getOrRefreshToken, fetchOrgsForRegion, fetchSpacesByOrgs, resetCfLoginCache } from './cfLoginService.js';
import { startFakeBtpCfServer, FAKE } from '../test-helpers/fakeBtpCfServer.js';
import { installFetchInterceptor, restoreFetch } from '../test-helpers/interceptFetch.js';
import type { FakeServer } from '../test-helpers/fakeBtpCfServer.js';

let srv: FakeServer;
const saved: Record<string, string | undefined> = {};

function save(...keys: string[]) {
  for (const k of keys) saved[k] = process.env[k];
}
function restore() {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

before(async () => {
  srv = await startFakeBtpCfServer();
  installFetchInterceptor(srv.port);
});

after(async () => {
  restoreFetch();
  await srv.close();
});

beforeEach(() => {
  save('CF_USERNAME', 'CF_PASSWORD', 'CONFIG_JSON');
  process.env.CF_USERNAME = 'test-user';
  process.env.CF_PASSWORD = 'test-pass';
  process.env.CONFIG_JSON = '{"services":[]}';
  resetCfLoginCache();
});

afterEach(() => { restore(); resetCfLoginCache(); });

// ─── getOrRefreshToken ────────────────────────────────────────────────────────

describe('getOrRefreshToken', () => {
  test('returns access_token from fake OAuth server', async () => {
    const token = await getOrRefreshToken('eu10');
    assert.equal(token.access_token, FAKE.ACCESS_TOKEN);
    assert.equal(token.token_type, 'bearer');
  });

  test('token expires_at is in the future', async () => {
    const token = await getOrRefreshToken('eu10');
    assert.ok(token.expires_at > Date.now(), 'expires_at should be in future');
  });

  test('api_url encodes the requested region', async () => {
    const token = await getOrRefreshToken('eu10');
    assert.ok(token.api_url.includes('eu10'), `api_url should contain region; got: ${token.api_url}`);
  });

  test('different regions produce different api_url values', async () => {
    const t1 = await getOrRefreshToken('eu10');
    resetCfLoginCache();
    const t2 = await getOrRefreshToken('us10');
    assert.notEqual(t1.api_url, t2.api_url);
  });
});

// ─── fetchOrgsForRegion ───────────────────────────────────────────────────────

describe('fetchOrgsForRegion', () => {
  test('returns the fake org', async () => {
    const orgs = await fetchOrgsForRegion('eu10');
    assert.equal(orgs.length, 1);
    assert.equal(orgs[0]!.guid, FAKE.ORG.guid);
    assert.equal(orgs[0]!.name, FAKE.ORG.name);
  });
});

// ─── fetchSpacesByOrgs ────────────────────────────────────────────────────────

describe('fetchSpacesByOrgs', () => {
  test('returns empty map for empty org list', async () => {
    const result = await fetchSpacesByOrgs('eu10', []);
    assert.equal(result.size, 0);
  });

  test('returns space-001 under org-001', async () => {
    const result = await fetchSpacesByOrgs('eu10', [FAKE.ORG.guid]);
    assert.ok(result.has(FAKE.ORG.guid), 'map should have org entry');
    const spaces = result.get(FAKE.ORG.guid)!;
    assert.equal(spaces.length, 1);
    assert.equal(spaces[0]!.space_id,   FAKE.SPACE.guid);
    assert.equal(spaces[0]!.space_name, FAKE.SPACE.name);
  });
});
