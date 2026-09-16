import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadConfig,
  getRestrictedIds,
  getSyncExcludes,
  getSyncKey,
  getAutoSubaccountRefreshMs,
  getAutoGlobalRefreshMs,
} from './configService.js';

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

const MINIMAL_CONFIG = JSON.stringify({ services: [] });

beforeEach(() => {
  saveEnv(
    'CONFIG_JSON', 'CONFIG_FILE',
    'RESTRICTED_SUBACCOUNT_IDS', 'SYNC_EXCLUDES', 'SYNC_KEY',
    'AUTO_SUBACCOUNT_REFRESH_MINS', 'AUTO_GLOBAL_REFRESH_HRS',
    'DESTINATIONS_AUTO_SUBACCOUNT_REFRESH_MINS', 'DESTINATION_AUTO_SUBACCOUNT_REFRESH_MINS',
    'DESTINATION_AUTO_GLOBAL_REFRESH_HRS',
  );
  // Prevent filesystem reads in all tests
  process.env.CONFIG_JSON = MINIMAL_CONFIG;
  delete process.env.RESTRICTED_SUBACCOUNT_IDS;
  delete process.env.SYNC_EXCLUDES;
  delete process.env.SYNC_KEY;
  delete process.env.AUTO_SUBACCOUNT_REFRESH_MINS;
  delete process.env.AUTO_GLOBAL_REFRESH_HRS;
  delete process.env.DESTINATIONS_AUTO_SUBACCOUNT_REFRESH_MINS;
  delete process.env.DESTINATION_AUTO_SUBACCOUNT_REFRESH_MINS;
  delete process.env.DESTINATION_AUTO_GLOBAL_REFRESH_HRS;
  // Reset config cache
  loadConfig();
});

afterEach(() => restoreEnv());

// ---------------------------------------------------------------------------
// loadConfig — variable substitution
// ---------------------------------------------------------------------------

describe('loadConfig — variable substitution', () => {
  test('substitutes {{VAR}} placeholders in endpoint URLs', () => {
    process.env.CONFIG_JSON = JSON.stringify({
      services: [{
        name: 'svc1',
        enabled: true,
        endpoints: [{ url: 'https://{{HOST}}/health', method: 'GET' }],
      }],
      variables: { HOST: 'api.example.com' },
    });
    const cfg = loadConfig();
    assert.equal(cfg.services[0]!.endpoints[0]!.url, 'https://api.example.com/health');
  });

  test('leaves unresolved {{MISSING}} placeholders as-is', () => {
    process.env.CONFIG_JSON = JSON.stringify({
      services: [{
        name: 'svc1',
        enabled: true,
        endpoints: [{ url: 'https://{{MISSING}}/health', method: 'GET' }],
      }],
      variables: {},
    });
    const cfg = loadConfig();
    assert.equal(cfg.services[0]!.endpoints[0]!.url, 'https://{{MISSING}}/health');
  });

  test('substitutes {{VAR}} in endpoint username and password', () => {
    process.env.CONFIG_JSON = JSON.stringify({
      services: [{
        name: 'svc1',
        enabled: true,
        endpoints: [{
          url: 'https://example.com/health',
          method: 'GET',
          username: '{{MONITOR_USERNAME}}',
          password: '{{MONITOR_PASSWORD}}',
        }],
      }],
      variables: { MONITOR_USERNAME: 'user1', MONITOR_PASSWORD: 'pass1' },
    });
    const cfg = loadConfig();
    assert.equal(cfg.services[0]!.endpoints[0]!.username, 'user1');
    assert.equal(cfg.services[0]!.endpoints[0]!.password, 'pass1');
  });

});

// ---------------------------------------------------------------------------
// getRestrictedIds
// ---------------------------------------------------------------------------

describe('getRestrictedIds', () => {
  test('parses comma-separated GUIDs', () => {
    process.env.RESTRICTED_SUBACCOUNT_IDS = 'abc-123,def-456';
    const ids = getRestrictedIds();
    assert.ok(ids.has('abc-123'));
    assert.ok(ids.has('def-456'));
    assert.equal(ids.size, 2);
  });

  test('strips label suffix (guid:label format)', () => {
    process.env.RESTRICTED_SUBACCOUNT_IDS = 'abc-123:prod-acct,def-456:staging';
    const ids = getRestrictedIds();
    assert.ok(ids.has('abc-123'));
    assert.ok(ids.has('def-456'));
    assert.ok(!ids.has('abc-123:prod-acct'));
  });

  test('trims whitespace around entries', () => {
    process.env.RESTRICTED_SUBACCOUNT_IDS = ' abc-123 , def-456 ';
    const ids = getRestrictedIds();
    assert.ok(ids.has('abc-123'));
    assert.ok(ids.has('def-456'));
  });

  test('returns empty set for empty env var', () => {
    process.env.RESTRICTED_SUBACCOUNT_IDS = '';
    assert.equal(getRestrictedIds().size, 0);
  });

  test('returns empty set when env var not set', () => {
    delete process.env.RESTRICTED_SUBACCOUNT_IDS;
    assert.equal(getRestrictedIds().size, 0);
  });

  test('handles single entry without label', () => {
    process.env.RESTRICTED_SUBACCOUNT_IDS = 'only-one';
    const ids = getRestrictedIds();
    assert.ok(ids.has('only-one'));
    assert.equal(ids.size, 1);
  });
});

// ---------------------------------------------------------------------------
// getSyncExcludes
// ---------------------------------------------------------------------------

describe('getSyncExcludes', () => {
  test('parses comma-separated folder names', () => {
    process.env.SYNC_EXCLUDES = 'rcs,users';
    const ex = getSyncExcludes();
    assert.ok(ex.has('rcs'));
    assert.ok(ex.has('users'));
  });

  test('returns empty set for empty string', () => {
    process.env.SYNC_EXCLUDES = '';
    assert.equal(getSyncExcludes().size, 0);
  });

  test('returns empty set when not set', () => {
    delete process.env.SYNC_EXCLUDES;
    assert.equal(getSyncExcludes().size, 0);
  });

  test('trims whitespace', () => {
    process.env.SYNC_EXCLUDES = ' rcs , users ';
    const ex = getSyncExcludes();
    assert.ok(ex.has('rcs'));
    assert.ok(ex.has('users'));
  });
});

// ---------------------------------------------------------------------------
// getSyncKey
// ---------------------------------------------------------------------------

describe('getSyncKey', () => {
  test('returns env var SYNC_KEY when set', () => {
    process.env.SYNC_KEY = 'env-sync-secret';
    assert.equal(getSyncKey(), 'env-sync-secret');
  });

  test('returns null when not configured', () => {
    delete process.env.SYNC_KEY;
    assert.equal(getSyncKey(), null);
  });

  test('env var takes precedence over config variable', () => {
    process.env.SYNC_KEY = 'env-key';
    process.env.CONFIG_JSON = JSON.stringify({
      services: [],
      variables: { SYNC_KEY: 'config-key' },
    });
    loadConfig();
    assert.equal(getSyncKey(), 'env-key');
  });
});

// ---------------------------------------------------------------------------
// getAutoSubaccountRefreshMs
// ---------------------------------------------------------------------------

describe('getAutoSubaccountRefreshMs', () => {
  test('default is 10 minutes (600000ms) when nothing set', () => {
    assert.equal(getAutoSubaccountRefreshMs(), 600_000);
  });

  test('env var AUTO_SUBACCOUNT_REFRESH_MINS sets interval', () => {
    process.env.AUTO_SUBACCOUNT_REFRESH_MINS = '5';
    assert.equal(getAutoSubaccountRefreshMs(), 300_000); // 5 * 60000
  });

  test('0 disables (returns 0)', () => {
    process.env.AUTO_SUBACCOUNT_REFRESH_MINS = '0';
    assert.equal(getAutoSubaccountRefreshMs(), 0);
  });

  test('fractional minutes supported (0.5 = 30s)', () => {
    process.env.AUTO_SUBACCOUNT_REFRESH_MINS = '0.5';
    assert.equal(getAutoSubaccountRefreshMs(), 30_000);
  });
});

// ---------------------------------------------------------------------------
// getAutoGlobalRefreshMs
// ---------------------------------------------------------------------------

describe('getAutoGlobalRefreshMs', () => {
  test('default is 6 hours (21600000ms) when nothing set', () => {
    assert.equal(getAutoGlobalRefreshMs(), 6 * 3_600_000);
  });

  test('env var AUTO_GLOBAL_REFRESH_HRS sets interval', () => {
    process.env.AUTO_GLOBAL_REFRESH_HRS = '2';
    assert.equal(getAutoGlobalRefreshMs(), 2 * 3_600_000);
  });

  test('0 disables (returns 0)', () => {
    process.env.AUTO_GLOBAL_REFRESH_HRS = '0';
    assert.equal(getAutoGlobalRefreshMs(), 0);
  });
});
