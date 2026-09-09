import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  updateSettingsVarsCache,
  getAllSettingsVars,
  getVar,
  maskIfSensitive,
  getEffectiveDefault,
} from './variablesService.js';

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

beforeEach(() => {
  updateSettingsVarsCache({});
  saveEnv('CF_USERNAME', 'CF_PASSWORD', 'SYNC_KEY', 'MONITOR_USERNAME', 'CONFIG_JSON');
  delete process.env.CF_USERNAME;
  delete process.env.CF_PASSWORD;
  delete process.env.SYNC_KEY;
  delete process.env.MONITOR_USERNAME;
  // Keep CONFIG_JSON set to an empty config to prevent reads from the real config.json
  // (configFileVarsCache is module-level and cached after first access)
  process.env.CONFIG_JSON = '{"services":[]}';
});

afterEach(() => restoreEnv());

// ---------------------------------------------------------------------------
// Priority chain
// ---------------------------------------------------------------------------

describe('getVar — override priority', () => {
  test('settings takes precedence over env', () => {
    process.env.CF_USERNAME = 'from-env';
    updateSettingsVarsCache({ CF_USERNAME: 'from-settings' });
    assert.equal(getVar('CF_USERNAME'), 'from-settings');
  });

  test('env is used when no settings override', () => {
    process.env.CF_USERNAME = 'from-env';
    assert.equal(getVar('CF_USERNAME'), 'from-env');
  });

  test('CONFIG_JSON blob used when no settings or env', () => {
    process.env.CONFIG_JSON = JSON.stringify({ variables: { MONITOR_USERNAME: 'from-blob' } });
    assert.equal(getVar('MONITOR_USERNAME'), 'from-blob');
  });

  test('returns undefined when key not set anywhere', () => {
    assert.equal(getVar('CF_USERNAME'), undefined);
  });

  test('empty string in settings is skipped (falls through to env)', () => {
    updateSettingsVarsCache({ CF_USERNAME: '' }); // empty string excluded from cache
    process.env.CF_USERNAME = 'from-env';
    assert.equal(getVar('CF_USERNAME'), 'from-env');
  });

  test('empty string in env is skipped (falls through)', () => {
    process.env.CF_USERNAME = '';
    process.env.CONFIG_JSON = JSON.stringify({ variables: { CF_USERNAME: 'from-blob' } });
    assert.equal(getVar('CF_USERNAME'), 'from-blob');
  });
});

// ---------------------------------------------------------------------------
// updateSettingsVarsCache / getAllSettingsVars
// ---------------------------------------------------------------------------

describe('updateSettingsVarsCache', () => {
  test('stores non-empty string values', () => {
    updateSettingsVarsCache({ CF_USERNAME: 'user1', SYNC_KEY: 'secret' });
    const all = getAllSettingsVars();
    assert.equal(all['CF_USERNAME'], 'user1');
    assert.equal(all['SYNC_KEY'], 'secret');
  });

  test('filters out empty string values', () => {
    updateSettingsVarsCache({ CF_USERNAME: '', SYNC_KEY: 'secret' });
    const all = getAllSettingsVars();
    assert.ok(!('CF_USERNAME' in all));
    assert.equal(all['SYNC_KEY'], 'secret');
  });

  test('clears cache when given empty object', () => {
    updateSettingsVarsCache({ CF_USERNAME: 'user1' });
    updateSettingsVarsCache({});
    assert.deepEqual(getAllSettingsVars(), {});
  });

  test('getAllSettingsVars returns snapshot (not reference)', () => {
    updateSettingsVarsCache({ CF_USERNAME: 'user1' });
    const snapshot = getAllSettingsVars();
    updateSettingsVarsCache({});
    assert.equal(snapshot['CF_USERNAME'], 'user1'); // snapshot is unaffected
  });
});

// ---------------------------------------------------------------------------
// maskIfSensitive
// ---------------------------------------------------------------------------

describe('maskIfSensitive', () => {
  test('masks CF_PASSWORD', () => {
    assert.equal(maskIfSensitive('CF_PASSWORD', 'my-password'), '****');
  });

  test('masks SYNC_KEY', () => {
    assert.equal(maskIfSensitive('SYNC_KEY', 'my-sync-key'), '****');
  });

  test('masks MONITOR_PASSWORD', () => {
    assert.equal(maskIfSensitive('MONITOR_PASSWORD', 'pass'), '****');
  });

  test('does not mask CF_USERNAME', () => {
    assert.equal(maskIfSensitive('CF_USERNAME', 'alice'), 'alice');
  });

  test('does not mask CF_REGIONS', () => {
    assert.equal(maskIfSensitive('CF_REGIONS', 'eu10,us10'), 'eu10,us10');
  });

  test('returns empty string for undefined value', () => {
    assert.equal(maskIfSensitive('CF_PASSWORD', undefined), '');
  });

  test('returns empty string for empty value', () => {
    assert.equal(maskIfSensitive('CF_PASSWORD', ''), '');
  });
});

// ---------------------------------------------------------------------------
// getEffectiveDefault
// ---------------------------------------------------------------------------

describe('getEffectiveDefault', () => {
  test('returns env value with isEnv=true', () => {
    process.env.CF_USERNAME = 'env-user';
    const r = getEffectiveDefault('CF_USERNAME');
    assert.equal(r.value, 'env-user');
    assert.equal(r.isEnv, true);
  });

  test('returns CONFIG_JSON blob value with isEnv=true', () => {
    process.env.CONFIG_JSON = JSON.stringify({ variables: { MONITOR_USERNAME: 'blob-user' } });
    const r = getEffectiveDefault('MONITOR_USERNAME');
    assert.equal(r.value, 'blob-user');
    assert.equal(r.isEnv, true);
  });

  test('skips settings cache (returns env, not settings)', () => {
    updateSettingsVarsCache({ CF_USERNAME: 'settings-value' });
    process.env.CF_USERNAME = 'env-value';
    const r = getEffectiveDefault('CF_USERNAME');
    assert.equal(r.value, 'env-value'); // settings skipped
    assert.equal(r.isEnv, true);
  });

  test('returns undefined value with isEnv=false when nothing set', () => {
    const r = getEffectiveDefault('CF_USERNAME');
    assert.equal(r.value, undefined);
    assert.equal(r.isEnv, false);
  });
});
