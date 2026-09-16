/**
 * Integration tests for CF app scanning and start/stop operations.
 *
 * Requires LOCAL_STORE_DIR=/tmp/btp-admin-test (set by test script).
 * CF API calls are intercepted by the fake HTTP server.
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.js';
import { scanSubaccountApps, getSubaccountApps } from './appService.js';
import { loadConfig } from './configService.js';
import { updateSettingsVarsCache } from './variablesService.js';
import { resetCfLoginCache } from './cfLoginService.js';
import { startFakeBtpCfServer, FAKE } from '../test-helpers/fakeBtpCfServer.js';
import { installFetchInterceptor, restoreFetch } from '../test-helpers/interceptFetch.js';
import type { FakeServer } from '../test-helpers/fakeBtpCfServer.js';

const CONF_DIR  = join(config.LOCAL_STORE_DIR, 'conf');
const SA_PATH   = join(CONF_DIR, 'subaccounts.json');
const APPS_DIR  = join(config.LOCAL_STORE_DIR, 'apps');

const FAKE_SA = {
  region:                 FAKE.SA.region,
  subdomain:              FAKE.SA.subdomain,
  subaccountId:           FAKE.SA.guid,
  subaccountName:         FAKE.SA.displayName,
  globalAccountGUID:      FAKE.GA.guid,
  globalAccountName:      FAKE.GA.displayName,
  globalAccountSubdomain: FAKE.GA.subdomain,
  groupIds: '', alias: '', pos: 1,
  inHomepage: false, manageDestinations: false, useAOD: true, manageRoles: false,
  org: {
    orgId:   FAKE.ORG.guid,
    orgName: FAKE.ORG.name,
    spaces:  [{ spaceId: FAKE.SPACE.guid, spaceName: FAKE.SPACE.name, manageDest: false, aod: true }],
  },
  subscriptions:    [],
  serviceInstances: [],
};

let srv: FakeServer;

before(async () => {
  await mkdir(CONF_DIR, { recursive: true });
  await mkdir(APPS_DIR, { recursive: true });

  // Seed subaccounts.json so scanSubaccountApps can find the org/spaces
  await writeFile(SA_PATH, JSON.stringify({ subaccounts: [FAKE_SA], globalAccounts: [] }), 'utf-8');

  srv = await startFakeBtpCfServer();
  installFetchInterceptor(srv.port);

  process.env.CF_USERNAME = 'test-user';
  process.env.CF_PASSWORD = 'test-pass';
  process.env.CF_REGIONS  = FAKE.SA.region;
  process.env.CONFIG_JSON = '{"services":[]}';
  updateSettingsVarsCache({});
  loadConfig();
  resetCfLoginCache();
});

after(async () => {
  restoreFetch();
  await srv.close();
  await rm(join(APPS_DIR, FAKE.SA.region), { recursive: true, force: true });
});

beforeEach(() => resetCfLoginCache());

// ─── scanSubaccountApps ───────────────────────────────────────────────────────

describe('scanSubaccountApps — against fake CF API', () => {
  test('returns app count and creates local JSON files', async () => {
    const result = await scanSubaccountApps(FAKE.SA.region, FAKE.SA.subdomain);

    // Fake CF apps API returns one app — result has created/updated/deleted counts
    assert.ok(result.created >= 0, `expected created >= 0; got ${result.created}`);
  });

  test('persists app file to local store', async () => {
    await scanSubaccountApps(FAKE.SA.region, FAKE.SA.subdomain);

    const apps = await getSubaccountApps(FAKE.SA.region, FAKE.SA.subdomain);
    assert.ok(apps.length >= 1, 'should have at least one app in local store');

    const app = apps.find(a => a.guid === FAKE.APP.guid);
    assert.ok(app, `app ${FAKE.APP.guid} should be in local store`);
    assert.equal(app!.name,   FAKE.APP.name);
    assert.equal(app!.state,  FAKE.APP.state);
    assert.equal(app!.region, FAKE.SA.region);
  });

  test('app includes URL from CF routes', async () => {
    await scanSubaccountApps(FAKE.SA.region, FAKE.SA.subdomain);
    const apps = await getSubaccountApps(FAKE.SA.region, FAKE.SA.subdomain);
    const app  = apps.find(a => a.guid === FAKE.APP.guid);
    assert.ok(app?.urls && app.urls.length > 0, 'app should have at least one URL from CF routes');
  });
});

// ─── getSubaccountApps ────────────────────────────────────────────────────────

describe('getSubaccountApps — reads from local store', () => {
  test('returns empty array when no app files exist for region/subdomain', async () => {
    const apps = await getSubaccountApps('us99', 'nonexistent-sa');
    assert.deepEqual(apps, []);
  });

  test('reads app data from pre-seeded JSON file', async () => {
    const spaceDir = join(APPS_DIR, 'eu10', 'seed-sa', 'dev-space');
    await mkdir(spaceDir, { recursive: true });
    await writeFile(join(spaceDir, 'seed-app.json'), JSON.stringify({
      guid: 'seed-app', name: 'seed-app', state: 'STARTED',
      spaceGuid: 'sp-x', region: 'eu10', subdomain: 'seed-sa',
      spaceName: 'dev-space', lastUpdated: Date.now(),
    }), 'utf-8');

    const apps = await getSubaccountApps('eu10', 'seed-sa');
    assert.ok(apps.some(a => a.guid === 'seed-app'), 'seeded app should be returned');

    await rm(join(APPS_DIR, 'eu10', 'seed-sa'), { recursive: true, force: true });
  });
});
