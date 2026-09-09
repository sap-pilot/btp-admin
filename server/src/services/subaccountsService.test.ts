/**
 * Integration tests for refreshSubaccounts().
 *
 * These tests require LOCAL_STORE_DIR to be set to a writable temp directory
 * BEFORE Node starts (config.ts reads it at module load time).
 * The test script sets: LOCAL_STORE_DIR=/tmp/btp-admin-test
 *
 * All BTP CLI / CF API calls go to the in-process fake HTTP server via
 * globalThis.fetch interception.
 */
import { test, describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.js';
import { refreshSubaccounts, readSubaccounts, saveSubaccounts } from './subaccountsService.js';
import { loadConfig } from './configService.js';
import { updateSettingsVarsCache } from './variablesService.js';
import { resetCfLoginCache } from './cfLoginService.js';
import { startFakeBtpCfServer, FAKE } from '../test-helpers/fakeBtpCfServer.js';
import { installFetchInterceptor, restoreFetch } from '../test-helpers/interceptFetch.js';
import type { FakeServer } from '../test-helpers/fakeBtpCfServer.js';

const CONF_DIR  = join(config.LOCAL_STORE_DIR, 'conf');
const SA_PATH   = join(CONF_DIR, 'subaccounts.json');

let srv: FakeServer;

before(async () => {
  await mkdir(CONF_DIR, { recursive: true });
  srv = await startFakeBtpCfServer();
  installFetchInterceptor(srv.port);
  process.env.CF_USERNAME = 'test-user';
  process.env.CF_PASSWORD = 'test-pass';
  process.env.CF_REGIONS  = 'eu10';
  process.env.CONFIG_JSON = '{"services":[]}';
  updateSettingsVarsCache({});
  loadConfig();
  resetCfLoginCache();
});

after(async () => {
  restoreFetch();
  await srv.close();
  // Clean up written files
  await rm(SA_PATH, { force: true });
  await rm(join(config.LOCAL_STORE_DIR, 'conf', 'changelog.md'), { force: true });
});

afterEach(() => { resetCfLoginCache(); });

// ─── refreshSubaccounts ───────────────────────────────────────────────────────

describe('refreshSubaccounts — end-to-end against fake BTP/CF server', () => {
  test('returns one subaccount with org and space from fake server', async () => {
    const { data, warnings } = await refreshSubaccounts('test-runner');

    assert.ok(Array.isArray(data), 'data should be an array');
    assert.equal(data.length, 1, 'expect exactly one subaccount from fake BTP');

    const sa = data[0]!;
    assert.equal(sa.subaccountId,   FAKE.SA.guid);
    assert.equal(sa.subdomain,      FAKE.SA.subdomain);
    assert.equal(sa.subaccountName, FAKE.SA.displayName);
    assert.equal(sa.region,         FAKE.SA.region);
    assert.ok(Array.isArray(warnings));
  });

  test('persists subaccounts.json to local store', async () => {
    await refreshSubaccounts('test-runner');
    const raw = await readFile(SA_PATH, 'utf-8');
    const persisted = JSON.parse(raw) as { subaccounts: unknown[] };
    assert.ok(Array.isArray(persisted.subaccounts));
    assert.equal(persisted.subaccounts.length, 1);
  });

  test('subaccount includes CF org from fake server', async () => {
    const { data } = await refreshSubaccounts('test-runner');
    const sa = data[0]!;
    assert.equal(sa.org?.orgId,   FAKE.ORG.guid);
    assert.equal(sa.org?.orgName, FAKE.ORG.name);
  });

  test('subaccount includes space from fake CF spaces API', async () => {
    const { data } = await refreshSubaccounts('test-runner');
    const spaces = data[0]!.org?.spaces ?? [];
    assert.equal(spaces.length, 1);
    assert.equal(spaces[0]!.spaceId,   FAKE.SPACE.guid);
    assert.equal(spaces[0]!.spaceName, FAKE.SPACE.name);
  });

  test('globalAccountName is populated from GA list', async () => {
    const { data } = await refreshSubaccounts('test-runner');
    assert.equal(data[0]!.globalAccountName, FAKE.GA.displayName);
  });

  test('second refresh with pre-existing data preserves user-editable fields', async () => {
    // First refresh: subaccount gets pos=1, alias=''
    await refreshSubaccounts('test-runner');

    // Simulate user editing: set alias and manageDestinations
    const existing = await readSubaccounts();
    await saveSubaccounts([{ ...existing[0]!, alias: 'my-alias', manageDestinations: true }]);

    // Second refresh: should keep alias and manageDestinations
    const { data } = await refreshSubaccounts('test-runner');
    assert.equal(data[0]!.alias, 'my-alias');
    assert.equal(data[0]!.manageDestinations, true);
  });

  test('skipped=true when called concurrently without force', async () => {
    // Start first refresh, then immediately try second
    const p1 = refreshSubaccounts('runner-1');
    const r2  = await refreshSubaccounts('runner-2'); // runs while p1 is still in progress
    await p1; // let first complete
    assert.equal(r2.skipped, true, 'concurrent refresh without force should be skipped');
  });
});

// ─── readSubaccounts ─────────────────────────────────────────────────────────

describe('readSubaccounts', () => {
  test('returns empty array when file does not exist', async () => {
    await rm(SA_PATH, { force: true });
    const result = await readSubaccounts();
    assert.deepEqual(result, []);
  });

  test('returns subaccounts from file', async () => {
    await writeFile(SA_PATH, JSON.stringify({
      subaccounts: [{
        region: 'eu10', subdomain: 'test-sa', subaccountId: 'sa-001',
        subaccountName: 'Test', globalAccountGUID: 'ga-001',
        globalAccountName: 'GA', globalAccountSubdomain: 'ga',
        groupIds: '', alias: '', pos: 1,
        inHomepage: false, manageDestinations: false, useAOD: false, manageRoles: false,
        subscriptions: [], serviceInstances: [],
      }],
      globalAccounts: [],
    }), 'utf-8');
    const result = await readSubaccounts();
    assert.equal(result.length, 1);
    assert.equal(result[0]!.subaccountId, 'sa-001');
  });
});
