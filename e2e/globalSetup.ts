/**
 * Playwright global setup:
 *  1. Starts the fake BTP/CF HTTP server
 *  2. Seeds the temp local store with realistic fake data
 *  3. Writes server port to process.env.FAKE_API_PORT (read by webServer command)
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startFakeBtpCfServer, FAKE } from '../server/src/test-helpers/fakeBtpCfServer.js';

export const LOCAL_STORE  = '/tmp/btp-e2e-test';
export const FAKE_API_PORT = 3998;

// Stored so teardown can close it
let _fakeServer: { port: number; close: () => Promise<void> } | null = null;
export function getFakeServer() { return _fakeServer; }

async function seed() {
  const confDir  = join(LOCAL_STORE, 'conf');
  const destDir  = join(LOCAL_STORE, 'dest', FAKE.SA.region, FAKE.SA.subdomain);
  const appsDir  = join(LOCAL_STORE, 'apps', FAKE.SA.region, FAKE.SA.subdomain, FAKE.SPACE.name);
  const rcsDir   = join(LOCAL_STORE, 'rcs',  FAKE.SA.region, FAKE.SA.subdomain);
  // Users are stored as individual XsuaaUser files: users/{region}/{subdomain}/{origin}/{email}.json
  const usersDir = join(LOCAL_STORE, 'users', FAKE.SA.region, FAKE.SA.subdomain, FAKE.USER.origin);

  await Promise.all([
    mkdir(confDir,  { recursive: true }),
    mkdir(destDir,  { recursive: true }),
    mkdir(appsDir,  { recursive: true }),
    mkdir(rcsDir,   { recursive: true }),
    mkdir(usersDir, { recursive: true }),
  ]);

  // ── subaccounts.json ─────────────────────────────────────────────────────────
  await writeFile(join(confDir, 'subaccounts.json'), JSON.stringify({
    subaccounts: [{
      region:                 FAKE.SA.region,
      globalAccountGUID:      FAKE.GA.guid,
      globalAccountName:      FAKE.GA.displayName,
      globalAccountSubdomain: FAKE.GA.subdomain,
      subdomain:              FAKE.SA.subdomain,
      subaccountId:           FAKE.SA.guid,
      subaccountName:         FAKE.SA.displayName,
      groupIds: '', alias: '', pos: 1,
      inHomepage:         true,
      manageDestinations: true,
      useAOD:             true,
      manageRoles:        true,
      org: {
        orgId:   FAKE.ORG.guid,
        orgName: FAKE.ORG.name,
        spaces:  [{ spaceId: FAKE.SPACE.guid, spaceName: FAKE.SPACE.name, manageDest: true, aod: true }],
      },
      subscriptions:    [],
      serviceInstances: [],
    }],
    globalAccounts: [FAKE.GA],
  }), 'utf-8');

  // ── destination file ─────────────────────────────────────────────────────────
  await writeFile(join(destDir, `${FAKE.DEST.name}.json`), JSON.stringify({
    Name:           FAKE.DEST.name,
    Type:           FAKE.DEST.type,
    URL:            FAKE.DEST.url,
    Authentication: FAKE.DEST.auth,
    ProxyType:      'Internet',
    _lastFetched:   Date.now(),
  }), 'utf-8');

  // ── app file ─────────────────────────────────────────────────────────────────
  await writeFile(join(appsDir, `${FAKE.APP.guid}.json`), JSON.stringify({
    guid:        FAKE.APP.guid,
    name:        FAKE.APP.name,
    state:       FAKE.APP.state,
    spaceGuid:   FAKE.SPACE.guid,
    region:      FAKE.SA.region,
    subdomain:   FAKE.SA.subdomain,
    spaceName:   FAKE.SPACE.name,
    process:     { type: 'web', instances: 1, memory_in_mb: 256, disk_in_mb: 1024 },
    aod:         false,
    urls:        ['my-app.cfapps.eu10.hana.ondemand.com'],
    lastUpdated: Date.now(),
  }), 'utf-8');

  // ── role collection file ─────────────────────────────────────────────────────
  await writeFile(join(rcsDir, `${FAKE.RC.displayName}.json`), JSON.stringify({
    name:           FAKE.RC.displayName,
    description:    'A test role collection',
    roleReferences: [],
  }), 'utf-8');

  // ── user file (XsuaaUser per-file format: users/{region}/{subdomain}/{origin}/{email}.json) ───
  await writeFile(join(usersDir, `${FAKE.USER.userName}.json`), JSON.stringify({
    id:            FAKE.USER.id,
    userName:      FAKE.USER.userName,
    emails:        [{ value: FAKE.USER.userName, primary: true }],
    origin:        FAKE.USER.origin,
    active:        true,
    lastLogonTime: Date.now() - 3600_000,
  }), 'utf-8');
}

export default async function globalSetup() {
  // Start fake BTP/CF server (used by the Express server for refresh flows)
  _fakeServer = await startFakeBtpCfServer(FAKE_API_PORT);
  process.env.FAKE_API_PORT = String(_fakeServer.port);
  process.env.LOCAL_STORE_DIR = LOCAL_STORE;
  process.env.CF_REGIONS  = FAKE.SA.region;
  process.env.CF_USERNAME = 'test-user';
  process.env.CF_PASSWORD = 'test-pass';
  process.env.CONFIG_JSON = '{"services":[]}';

  await seed();
}
