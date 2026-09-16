import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseFilename } from './parseFilename.js';

// ---------------------------------------------------------------------------
// New format: yyyyMMdd-HHmmss_{slug}_{city}_{ms}_{status}[.starred][.json]
// ---------------------------------------------------------------------------

describe('parseFilename — new format', () => {
  test('parses basic new-format filename with .json', () => {
    const r = parseFilename('20240615-120000_my-svc_us-east_523_200.json');
    assert.ok(r);
    assert.equal(r.endpointSlug, 'my-svc');
    assert.equal(r.city, 'us-east');
    assert.equal(r.responseTime, 523);
    assert.equal(r.overallStatus, 200);
    assert.equal(r.filename, '20240615-120000_my-svc_us-east_523_200.json');
  });

  test('timestamp is parsed as UTC', () => {
    const r = parseFilename('20240615-120000_svc_city_100_200.json');
    assert.ok(r);
    const expected = Date.UTC(2024, 5, 15, 12, 0, 0); // June 15 2024 12:00 UTC
    assert.equal(r.timestamp, expected);
  });

  test('parses without .json extension and appends it', () => {
    const r = parseFilename('20240615-120000_my-svc_us-east_523_200');
    assert.ok(r);
    assert.equal(r.filename, '20240615-120000_my-svc_us-east_523_200.json');
  });

  test('parses .starred variant (sets starred=true, filename unchanged)', () => {
    const r = parseFilename('20240615-120000_my-svc_us-east_523_200.starred.json');
    assert.ok(r);
    assert.equal(r.starred, true);
    assert.equal(r.filename, '20240615-120000_my-svc_us-east_523_200.starred.json');
  });

  test('starred without .json extension appends .json', () => {
    const r = parseFilename('20240615-120000_my-svc_us-east_523_200.starred');
    assert.ok(r);
    assert.equal(r.starred, true);
    assert.equal(r.filename, '20240615-120000_my-svc_us-east_523_200.starred.json');
  });

  test('non-starred file has no starred property', () => {
    const r = parseFilename('20240615-120000_my-svc_us-east_523_200.json');
    assert.ok(r);
    assert.equal(r.starred, undefined);
  });

  test('accepts status 203', () => {
    const r = parseFilename('20240615-120000_svc_city_100_203.json');
    assert.ok(r);
    assert.equal(r.overallStatus, 203);
  });

  test('accepts status 400', () => {
    const r = parseFilename('20240615-120000_svc_city_100_400.json');
    assert.ok(r);
    assert.equal(r.overallStatus, 400);
  });

  test('accepts status 500', () => {
    const r = parseFilename('20240615-120000_svc_city_100_500.json');
    assert.ok(r);
    assert.equal(r.overallStatus, 500);
  });

  test('accepts status 503', () => {
    const r = parseFilename('20240615-120000_svc_city_100_503.json');
    assert.ok(r);
    assert.equal(r.overallStatus, 503);
  });

  test('accepts status 504', () => {
    const r = parseFilename('20240615-120000_svc_city_100_504.json');
    assert.ok(r);
    assert.equal(r.overallStatus, 504);
  });

  test('rejects disallowed status code (e.g. 201)', () => {
    const r = parseFilename('20240615-120000_svc_city_100_201.json');
    assert.equal(r, null);
  });

  test('handles alphanumeric slug with hyphens', () => {
    const r = parseFilename('20240615-120000_btp-api-prod_eu10_200_200.json');
    assert.ok(r);
    assert.equal(r.endpointSlug, 'btp-api-prod');
    assert.equal(r.city, 'eu10');
  });
});

// ---------------------------------------------------------------------------
// Old format: yyyyMMdd-HHmmss_{idx}_{ms}ms_{status}[.json]
// ---------------------------------------------------------------------------

describe('parseFilename — old format', () => {
  test('parses basic old-format filename', () => {
    const r = parseFilename('20240615-120000_0_523ms_200.json');
    assert.ok(r);
    assert.equal(r.endpointIndex, 0);
    assert.equal(r.city, 'unknown');
    assert.equal(r.responseTime, 523);
    assert.equal(r.overallStatus, 200);
    assert.equal(r.filename, '20240615-120000_0_523ms_200.json');
  });

  test('parses old format without .json and appends it', () => {
    const r = parseFilename('20240615-120000_2_100ms_500');
    assert.ok(r);
    assert.equal(r.filename, '20240615-120000_2_100ms_500.json');
  });

  test('endpointIndex parsed as integer', () => {
    const r = parseFilename('20240615-120000_3_400ms_503.json');
    assert.ok(r);
    assert.equal(r.endpointIndex, 3);
  });

  test('timestamp is parsed as local time (old format)', () => {
    // Old format uses local time — just verify it's a valid timestamp
    const r = parseFilename('20240615-120000_0_100ms_200.json');
    assert.ok(r);
    assert.ok(typeof r.timestamp === 'number');
    assert.ok(!isNaN(r.timestamp));
  });
});

// ---------------------------------------------------------------------------
// Invalid / unrecognised filenames
// ---------------------------------------------------------------------------

describe('parseFilename — invalid input', () => {
  test('returns null for random string', () => {
    assert.equal(parseFilename('foobar'), null);
  });

  test('returns null for empty string', () => {
    assert.equal(parseFilename(''), null);
  });

  test('returns null for partial new-format name', () => {
    assert.equal(parseFilename('20240615-120000_svc_city_abc_200.json'), null); // non-numeric ms
  });

  test('returns null for wrong date format', () => {
    assert.equal(parseFilename('2024-06-15_svc_city_100_200.json'), null);
  });
});
