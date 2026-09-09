/**
 * Fake HTTP server that mimics BTP CLI, CF API, XSUAA, and Destination Service APIs.
 * Used by integration tests via fetch interception — all https:// requests are
 * redirected to this server's localhost port.
 */
import http from 'node:http';

// ─── Shared fake data ─────────────────────────────────────────────────────────

export const FAKE = {
  SESSION:      'fake-btp-session-id',
  ACCESS_TOKEN: 'fake-access-token',
  REFRESH_TOKEN:'fake-refresh-token',
  GA: { guid: 'ga-001', subdomain: 'test-global-acc', displayName: 'Test Global Account' },
  SA: { guid: 'sa-001', displayName: 'Test Subaccount', subdomain: 'test-sa', region: 'eu10', globalAccountGUID: 'ga-001' },
  ORG: { guid: 'org-001', name: 'test-org' },
  SPACE: { guid: 'space-001', name: 'dev' },
  APP: { guid: 'app-001', name: 'my-app', state: 'STARTED' },
  DEST: { name: 'TestDest', type: 'HTTP', url: 'https://example.com', auth: 'NoAuthentication' },
  RC:   { id: 'rc-001', displayName: 'TestRC' },
  USER: { id: 'user-001', userName: 'alice@example.com', origin: 'sap.default' },
} as const;

// ─── Server infrastructure ────────────────────────────────────────────────────

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void;

interface RouteEntry { method: string; test: (url: string) => boolean; fn: Handler }

function jsonReply(res: http.ServerResponse, data: unknown, status = 200, extra: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...extra });
  res.end(JSON.stringify(data));
}

export interface FakeServer {
  port: number;
  close(): Promise<void>;
}

export async function startFakeBtpCfServer(port = 0): Promise<FakeServer> {
  const routes: RouteEntry[] = [];

  const on = (method: string, prefix: string, fn: Handler) =>
    routes.push({ method, test: (u) => u === prefix || u.startsWith(prefix + '?') || u.startsWith(prefix + '/'), fn });

  // ── BTP CLI: login ───────────────────────────────────────────────────────────
  on('POST', '/login', (_, res) => jsonReply(res, {}, 200, { 'x-cpcli-sessionid': FAKE.SESSION }));

  // ── BTP CLI: global account list ─────────────────────────────────────────────
  on('POST', '/client', (_, res) => jsonReply(res, [FAKE.GA]));

  // ── BTP CLI: subaccount list ─────────────────────────────────────────────────
  on('POST', '/command/v2.106.1/accounts/subaccount', (_, res) =>
    jsonReply(res, { value: [{ ...FAKE.SA }] }));

  // ── BTP CLI: environment instances (CF org binding) ──────────────────────────
  on('POST', '/command/v2.106.1/accounts/environment-instance', (_, res) =>
    jsonReply(res, {
      environmentInstances: [{
        environmentType: 'cloudfoundry',
        platformId: FAKE.ORG.guid,
        labels: JSON.stringify({ 'Org Name': FAKE.ORG.name }),
      }],
    }));

  // ── BTP CLI: subscriptions ───────────────────────────────────────────────────
  on('POST', '/command/v2.106.1/accounts/subscription', (_, res) =>
    jsonReply(res, { applications: [] }));

  // ── BTP CLI: service instances ───────────────────────────────────────────────
  on('POST', '/command/v2.106.1/services/instance', (_, res) => jsonReply(res, []));

  // ── BTP CLI: service plans ───────────────────────────────────────────────────
  on('POST', '/command/v2.106.1/services/plan', (_, res) => jsonReply(res, []));

  // ── CF: /v2/info (token endpoint discovery) ──────────────────────────────────
  on('GET', '/v2/info', (_, res, _b) => {
    const port = (server.address() as { port: number }).port;
    jsonReply(res, { token_endpoint: `http://localhost:${port}` });
  });

  // ── CF / XSUAA: OAuth token ──────────────────────────────────────────────────
  on('POST', '/oauth/token', (_, res) =>
    jsonReply(res, {
      access_token:  FAKE.ACCESS_TOKEN,
      token_type:    'bearer',
      expires_in:    3600,
      refresh_token: FAKE.REFRESH_TOKEN,
    }));

  // ── CF V3: organizations ─────────────────────────────────────────────────────
  on('GET', '/v3/organizations', (_, res) =>
    jsonReply(res, { resources: [{ guid: FAKE.ORG.guid, name: FAKE.ORG.name }], pagination: { next: null } }));

  // ── CF V3: spaces ────────────────────────────────────────────────────────────
  on('GET', '/v3/spaces', (_, res) =>
    jsonReply(res, {
      resources: [{
        guid: FAKE.SPACE.guid,
        name: FAKE.SPACE.name,
        relationships: { organization: { data: { guid: FAKE.ORG.guid } } },
      }],
      pagination: { next: null },
    }));

  // ── CF V3: apps ──────────────────────────────────────────────────────────────
  on('GET', '/v3/apps', (_, res) =>
    jsonReply(res, {
      resources: [{
        guid:  FAKE.APP.guid,
        name:  FAKE.APP.name,
        state: FAKE.APP.state,
        relationships: { space: { data: { guid: FAKE.SPACE.guid } } },
      }],
      pagination: { next: null },
    }));

  // ── CF V3: app start/stop actions ────────────────────────────────────────────
  routes.push({
    method: 'POST',
    test: (u) => /^\/v3\/apps\/[^/]+\/actions\/(stop|start)$/.test(u),
    fn: (req, res) => {
      const stopped = req.url?.endsWith('/actions/stop');
      jsonReply(res, { guid: FAKE.APP.guid, state: stopped ? 'STOPPED' : 'STARTED' });
    },
  });

  // ── CF V3: processes ─────────────────────────────────────────────────────────
  on('GET', '/v3/processes', (_, res) =>
    jsonReply(res, {
      resources: [{
        type: 'web', instances: 1, memory_in_mb: 256, disk_in_mb: 1024,
        relationships: { app: { data: { guid: FAKE.APP.guid } } },
      }],
      pagination: { next: null },
    }));

  // ── CF V3: routes ────────────────────────────────────────────────────────────
  on('GET', '/v3/routes', (_, res) =>
    jsonReply(res, {
      resources: [{
        url: 'my-app.cfapps.eu10.hana.ondemand.com',
        destinations: [{ app: { guid: FAKE.APP.guid } }],
      }],
      pagination: { next: null },
    }));

  // ── CF V3: service plans ─────────────────────────────────────────────────────
  on('GET', '/v3/service_plans', (_, res) =>
    jsonReply(res, { resources: [], pagination: { next: null } }));

  // ── CF V3: service instances ─────────────────────────────────────────────────
  on('GET', '/v3/service_instances', (_, res) =>
    jsonReply(res, { resources: [], pagination: { next: null } }));

  // ── CF V2: service keys (used by destinationService / rcService for credential fetch) ──
  on('GET', '/v2/service_keys', (_, res) => jsonReply(res, { resources: [] }));

  on('POST', '/v2/service_keys', (_, res) => {
    const port = (server.address() as { port: number }).port;
    const base  = `http://localhost:${port}`;
    jsonReply(res, {
      metadata: { guid: 'sk-001' },
      entity: {
        name: 'test-key',
        service_instance_guid: 'inst-001',
        credentials: {
          uri:          base,
          url:          base,
          apiurl:       base,
          clientid:     'fake-client',
          clientsecret: 'fake-secret',
          xsappname:    'fake-app',
        },
      },
    }, 201);
  });

  // ── Destination Service API ───────────────────────────────────────────────────
  on('GET', '/destination-configuration/v1/subaccountDestinations', (_, res) =>
    jsonReply(res, [{
      Name:           FAKE.DEST.name,
      Type:           FAKE.DEST.type,
      URL:            FAKE.DEST.url,
      Authentication: FAKE.DEST.auth,
      ProxyType:      'Internet',
    }]));

  on('PUT',  '/destination-configuration/v1/subaccountDestinations', (_, res) =>
    jsonReply(res, {}, 201));

  on('POST', '/destination-configuration/v1/subaccountDestinations', (_, res) =>
    jsonReply(res, {}, 201));

  routes.push({
    method: 'DELETE',
    test: (u) => u.startsWith('/destination-configuration/v1/subaccountDestinations/'),
    fn: (_, res) => jsonReply(res, {}),
  });

  // ── XSUAA: role collections (Groups) ─────────────────────────────────────────
  on('GET', '/Groups', (_, res) =>
    jsonReply(res, {
      resources:    [{ id: FAKE.RC.id, displayName: FAKE.RC.displayName, members: [] }],
      totalResults: 1,
      itemsPerPage: 100,
      startIndex:   1,
    }));

  // ── XSUAA: users ─────────────────────────────────────────────────────────────
  on('GET', '/Users', (_, res) =>
    jsonReply(res, {
      resources: [{
        id:       FAKE.USER.id,
        userName: FAKE.USER.userName,
        name:     { givenName: 'Alice', familyName: 'Smith' },
        emails:   [{ value: FAKE.USER.userName, primary: true }],
        origin:   FAKE.USER.origin,
        active:   true,
        groups:   [],
      }],
      totalResults: 1,
      itemsPerPage: 100,
      startIndex:   1,
    }));

  // ── HTTP server ───────────────────────────────────────────────────────────────
  const server = http.createServer((req, res) => {
    const url    = req.url ?? '/';
    const method = req.method ?? 'GET';
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => {
      const entry = routes.find(r => r.method === method && r.test(url));
      if (entry) {
        entry.fn(req, res, body);
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `FakeServer: no handler for ${method} ${url}` }));
      }
    });
  });

  return new Promise<FakeServer>((resolve, reject) => {
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({
        port: addr.port,
        close: () => new Promise((res, rej) => server.close(e => (e ? rej(e) : res()))),
      });
    });
    server.on('error', reject);
  });
}
