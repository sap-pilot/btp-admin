import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCondition } from './conditionEvaluator.js';

const ctx = (overrides: Partial<{ status: number; responseTime: number; body: string; headers: Record<string, string> }> = {}) => ({
  status: 200,
  responseTime: 500,
  body: '',
  headers: {},
  ...overrides,
});

describe('evaluateCondition — [STATUS]', () => {
  test('== passes when equal', () => {
    const r = evaluateCondition('[STATUS] == 200', ctx({ status: 200 }));
    assert.equal(r.passed, true);
    assert.equal(r.actual, '200');
  });

  test('== fails when not equal', () => {
    const r = evaluateCondition('[STATUS] == 200', ctx({ status: 404 }));
    assert.equal(r.passed, false);
  });

  test('!= passes when different', () => {
    const r = evaluateCondition('[STATUS] != 500', ctx({ status: 200 }));
    assert.equal(r.passed, true);
  });

  test('< 500 passes for 200', () => {
    const r = evaluateCondition('[STATUS] < 500', ctx({ status: 200 }));
    assert.equal(r.passed, true);
  });

  test('>= 200 passes for 200', () => {
    const r = evaluateCondition('[STATUS] >= 200', ctx({ status: 200 }));
    assert.equal(r.passed, true);
  });

  test('>= 200 fails for 199', () => {
    const r = evaluateCondition('[STATUS] >= 200', ctx({ status: 199 }));
    assert.equal(r.passed, false);
  });

  test('<= 204 passes for 200', () => {
    const r = evaluateCondition('[STATUS] <= 204', ctx({ status: 200 }));
    assert.equal(r.passed, true);
  });

  test('> 199 passes for 200', () => {
    const r = evaluateCondition('[STATUS] > 199', ctx({ status: 200 }));
    assert.equal(r.passed, true);
  });

  test('result includes condition and expected', () => {
    const r = evaluateCondition('[STATUS] == 200', ctx({ status: 200 }));
    assert.equal(r.condition, '[STATUS] == 200');
    assert.ok(r.expected.includes('=='));
  });
});

describe('evaluateCondition — [RESPONSE_TIME]', () => {
  test('< 3000 passes', () => {
    const r = evaluateCondition('[RESPONSE_TIME] < 3000', ctx({ responseTime: 1500 }));
    assert.equal(r.passed, true);
  });

  test('< 3000 fails when slow', () => {
    const r = evaluateCondition('[RESPONSE_TIME] < 3000', ctx({ responseTime: 5000 }));
    assert.equal(r.passed, false);
    assert.equal(r.actual, '5000');
  });

  test('== compares exact value', () => {
    const r = evaluateCondition('[RESPONSE_TIME] == 500', ctx({ responseTime: 500 }));
    assert.equal(r.passed, true);
  });
});

describe('evaluateCondition — [BODY] (whole-body string)', () => {
  test('== string literal (single quotes)', () => {
    const r = evaluateCondition("[BODY] == 'ok'", ctx({ body: 'ok' }));
    assert.equal(r.passed, true);
  });

  test('== string literal (double quotes)', () => {
    const r = evaluateCondition('[BODY] == "ok"', ctx({ body: 'ok' }));
    assert.equal(r.passed, true);
  });

  test('!= string', () => {
    const r = evaluateCondition("[BODY] != 'error'", ctx({ body: 'ok' }));
    assert.equal(r.passed, true);
  });

  test('compares stringified JSON body', () => {
    const body = '{"status":"ok"}';
    const r = evaluateCondition(`[BODY] == "${body}"`, ctx({ body }));
    assert.equal(r.passed, true);
  });

  test('empty body == empty string', () => {
    const r = evaluateCondition('[BODY] == ""', ctx({ body: '' }));
    assert.equal(r.passed, true);
  });

  // Note: [BODY].path format is a parse-error due to regex limitation.
  // JSON path access via [BODY.path] format is parsed but currently resolves to ''.
  // Use [BODY] for whole-body comparisons; deeper JSON inspection is not yet functional.
  test('[BODY].path format is a parse-error', () => {
    const r = evaluateCondition('[BODY].status == "healthy"', ctx({ body: '{"status":"healthy"}' }));
    assert.equal(r.passed, false);
    assert.equal(r.actual, 'parse-error');
  });
});

describe('evaluateCondition — [HEADER]', () => {
  test('header value matches', () => {
    const r = evaluateCondition('[HEADER.content-type] == "application/json"', ctx({
      headers: { 'content-type': 'application/json' },
    }));
    assert.equal(r.passed, true);
  });

  test('missing header is empty string', () => {
    const r = evaluateCondition('[HEADER.x-custom] == ""', ctx({ headers: {} }));
    assert.equal(r.passed, true);
  });

  test('header != passes when different', () => {
    const r = evaluateCondition('[HEADER.x-powered-by] != "php"', ctx({
      headers: { 'x-powered-by': 'node' },
    }));
    assert.equal(r.passed, true);
  });
});

describe('evaluateCondition — len([BODY])', () => {
  test('counts elements in JSON array', () => {
    const r = evaluateCondition('len([BODY]) == 3', ctx({ body: '[1,2,3]' }));
    assert.equal(r.passed, true);
    assert.equal(r.actual, '3');
  });

  test('> 0 passes for non-empty array', () => {
    const r = evaluateCondition('len([BODY]) > 0', ctx({ body: '[1,2]' }));
    assert.equal(r.passed, true);
  });

  test('== 0 passes for empty array', () => {
    const r = evaluateCondition('len([BODY]) == 0', ctx({ body: '[]' }));
    assert.equal(r.passed, true);
  });

  test('counts keys in JSON object', () => {
    const r = evaluateCondition('len([BODY]) == 2', ctx({ body: '{"a":1,"b":2}' }));
    assert.equal(r.passed, true);
  });

  test('counts chars in plain string body', () => {
    const r = evaluateCondition('len([BODY]) == 5', ctx({ body: 'hello' }));
    assert.equal(r.passed, true);
  });

  test('== 0 on empty body', () => {
    const r = evaluateCondition('len([BODY]) == 0', ctx({ body: '' }));
    assert.equal(r.passed, true);
  });
});

describe('evaluateCondition — pat() pattern matching', () => {
  test('pat(*) matches anything', () => {
    const r = evaluateCondition('[BODY] == pat(*)', ctx({ body: 'anything here' }));
    assert.equal(r.passed, true);
  });

  test('pat(*) matches empty string', () => {
    const r = evaluateCondition('[BODY] == pat(*)', ctx({ body: '' }));
    assert.equal(r.passed, true);
  });

  test('pat(foo*) matches when body starts with "foo"', () => {
    const r = evaluateCondition('[BODY] == pat(foo*)', ctx({ body: 'foobar' }));
    assert.equal(r.passed, true);
  });

  test('pat(foo*) does not match body with no "foo" substring', () => {
    const r = evaluateCondition('[BODY] == pat(foo*)', ctx({ body: 'barbaz' }));
    assert.equal(r.passed, false);
  });

  test('pat() is case-insensitive', () => {
    const r = evaluateCondition('[BODY] == pat(HELLO*)', ctx({ body: 'hello world' }));
    assert.equal(r.passed, true);
  });

  test('pat() works on [STATUS] actual value string', () => {
    // STATUS is numeric; pat() converts to string before testing
    const r = evaluateCondition('[STATUS] == pat(2*)', ctx({ status: 200 }));
    assert.equal(r.passed, true);
  });
});

describe('evaluateCondition — parse errors', () => {
  test('empty string is parse-error', () => {
    const r = evaluateCondition('', ctx());
    assert.equal(r.passed, false);
    assert.equal(r.actual, 'parse-error');
  });

  test('missing operator is parse-error', () => {
    const r = evaluateCondition('[STATUS] 200', ctx());
    assert.equal(r.passed, false);
    assert.equal(r.actual, 'parse-error');
  });

  test('unknown variable is parse-error', () => {
    const r = evaluateCondition('[UNKNOWN] == 1', ctx());
    assert.equal(r.passed, false);
    assert.equal(r.actual, 'parse-error');
  });

  test('plain text with no brackets is parse-error', () => {
    const r = evaluateCondition('status == 200', ctx());
    assert.equal(r.passed, false);
    assert.equal(r.actual, 'parse-error');
  });
});
