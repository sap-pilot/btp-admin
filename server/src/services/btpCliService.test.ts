import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  btpLogin, btpListGlobalAccounts, btpListSubaccounts,
  btpListEnvInstances, btpListSubscriptions, btpListServiceInstances,
} from './btpCliService.js';
import { startFakeBtpCfServer, FAKE } from '../test-helpers/fakeBtpCfServer.js';
import { installFetchInterceptor, restoreFetch } from '../test-helpers/interceptFetch.js';
import type { FakeServer } from '../test-helpers/fakeBtpCfServer.js';

let srv: FakeServer;
let sessionId: string;

before(async () => {
  srv = await startFakeBtpCfServer();
  installFetchInterceptor(srv.port);
  sessionId = await btpLogin('test-user', 'test-pass');
});

after(async () => {
  restoreFetch();
  await srv.close();
});

// ─── btpLogin ────────────────────────────────────────────────────────────────

test('btpLogin returns the session ID from x-cpcli-sessionid header', () => {
  assert.equal(sessionId, FAKE.SESSION);
});

// ─── btpListGlobalAccounts ───────────────────────────────────────────────────

describe('btpListGlobalAccounts', () => {
  test('returns one global account with expected fields', async () => {
    const gas = await btpListGlobalAccounts(sessionId);
    assert.equal(gas.length, 1);
    assert.equal(gas[0]!.guid,        FAKE.GA.guid);
    assert.equal(gas[0]!.subdomain,   FAKE.GA.subdomain);
    assert.equal(gas[0]!.displayName, FAKE.GA.displayName);
  });
});

// ─── btpListSubaccounts ───────────────────────────────────────────────────────

describe('btpListSubaccounts', () => {
  test('returns one subaccount with expected fields', async () => {
    const sas = await btpListSubaccounts(sessionId, FAKE.GA.subdomain);
    assert.equal(sas.length, 1);
    assert.equal(sas[0]!.guid,              FAKE.SA.guid);
    assert.equal(sas[0]!.subdomain,         FAKE.SA.subdomain);
    assert.equal(sas[0]!.displayName,       FAKE.SA.displayName);
    assert.equal(sas[0]!.region,            FAKE.SA.region);
    assert.equal(sas[0]!.globalAccountGUID, FAKE.SA.globalAccountGUID);
  });
});

// ─── btpListEnvInstances ──────────────────────────────────────────────────────

describe('btpListEnvInstances', () => {
  test('returns org-001 as cloudfoundry environment instance', async () => {
    const instances = await btpListEnvInstances(sessionId, FAKE.GA.subdomain, FAKE.SA.guid);
    assert.equal(instances.length, 1);
    assert.equal(instances[0]!.orgId,   FAKE.ORG.guid);
    assert.equal(instances[0]!.orgName, FAKE.ORG.name);
  });
});

// ─── btpListSubscriptions ─────────────────────────────────────────────────────

describe('btpListSubscriptions', () => {
  test('returns empty array (no subscriptions in fake data)', async () => {
    const subs = await btpListSubscriptions(sessionId, FAKE.GA.subdomain, FAKE.SA.guid);
    assert.deepEqual(subs, []);
  });
});

// ─── btpListServiceInstances ──────────────────────────────────────────────────

describe('btpListServiceInstances', () => {
  test('returns empty array (no service instances in fake data)', async () => {
    const insts = await btpListServiceInstances(sessionId, FAKE.GA.subdomain, FAKE.SA.guid);
    assert.deepEqual(insts, []);
  });
});
