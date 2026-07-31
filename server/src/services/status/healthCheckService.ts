import { getService } from '../configService.js';
import { evaluateCondition } from './conditionEvaluator.js';
import { saveResponse } from '../localStoreService.js';
import { getEvaluationMode } from './overrideService.js';
import { runBrowserIasLogin } from './browserCheckService.js';
import { getCity } from '../geoService.js';
import { logger } from '../../logger.js';
import { config } from '../../config.js';
import { emit } from '../liveEvents.js';
import { notifyCallbacks } from '../syncService.js';
import type { ConditionResult, ResponseRecord, CheckResult, EndpointCheckResult, RetryAttempt, EndpointConfig } from '../../types/index.js';

export type { CheckResult, EndpointCheckResult };

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

function extractRegion(host: string): string | null {
  return host.match(/cfapps\.([^.]+)\.hana/)?.[1] ?? null;
}

interface HttpAttemptResult {
  respStatus: number;
  respHeaders: Record<string, string>;
  respBody: string;
  responseTime: number;
  fetchError: string | null;
  didTimeout: boolean;
}

async function runHttpAttempt(
  ep: EndpointConfig,
  reqHeaders: Record<string, string>,
  method: string,
  timeoutMs: number,
): Promise<HttpAttemptResult> {
  const start = Date.now();
  let respStatus = 0;
  let respHeaders: Record<string, string> = {};
  let respBody = '';
  let responseTime = 0;
  let fetchError: string | null = null;
  let didTimeout = false;

  try {
    const resp = await fetch(ep.url, {
      method,
      headers: reqHeaders,
      body: ep.body ?? undefined,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    responseTime = Date.now() - start;
    respStatus = resp.status;
    resp.headers.forEach((v, k) => { respHeaders[k] = v; });
    respBody = await resp.text();
  } catch (err) {
    responseTime = Date.now() - start;
    didTimeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    fetchError = err instanceof Error ? err.message : String(err);
    respBody = didTimeout ? `Request timed out after ${timeoutMs}ms` : fetchError;
  }

  return { respStatus, respHeaders, respBody, responseTime, fetchError, didTimeout };
}

export async function checkService(serviceName: string, requestHost?: string, onlyEpIdx?: number): Promise<CheckResult> {
  const service = getService(serviceName);
  if (!service) {
    throw Object.assign(new Error(`Service '${serviceName}' not found`), { status: 404 });
  }

  const evalMode = getEvaluationMode(serviceName);
  const details: EndpointCheckResult[] = [];
  const hostRegion = requestHost ? extractRegion(requestHost) : null;

  for (let i = 0; i < service.endpoints.length; i++) {
    if (onlyEpIdx !== undefined && i !== onlyEpIdx) continue;
    const ep = service.endpoints[i];
    const epName = ep.name ?? `Endpoint ${i}`;

    // ── Region filter ───────────────────────────────────────────────────────
    if (ep.region && hostRegion && ep.region !== hostRegion) {
      logger.debug({ service: serviceName, endpoint: epName, epRegion: ep.region, hostRegion }, 'Endpoint skipped — region mismatch');
      continue;
    }

    // ── Dummy endpoint — skip actual check ─────────────────────────────────
    if (ep.url === '/dummy') {
      const conditions: ConditionResult[] = [
        { condition: '[DUMMY] endpoint skipped', passed: true, actual: 'dummy', expected: 'dummy' },
      ];
      if (evalMode === 'alwayserror') {
        conditions.push({ condition: '[EVAL_MODE] == condition', passed: false, actual: 'alwayserror', expected: 'condition' });
      }
      const overallStatus: 200 | 203 | 500 | 503 =
        evalMode === 'alwaysok' ? 203 : evalMode === 'alwayserror' ? 503 : 200;
      const method = ep.mode === 'browser-ias-login' ? 'BROWSER' : (ep.method ?? 'GET');
      const record: ResponseRecord = {
        request: { url: '/dummy', method, headers: {}, body: null },
        response: { status: 200, headers: {}, body: 'Dummy endpoint — check skipped' },
        timestamp: new Date().toISOString(),
        responseTime: 0,
        endpointIndex: i,
        endpointName: epName,
        conditions,
        overallStatus,
        city: getCity(),
      };
      await saveResponse(serviceName, record);
      details.push({
        index: i, name: epName, conditions,
        passed: evalMode !== 'alwayserror',
        request: record.request,
        response: record.response,
        responseTime: 0,
      });
      continue;
    }

    // ── Browser-based IAS login check ──────────────────────────────────────
    if (ep.mode === 'browser-ias-login') {
      const result = await runBrowserIasLogin(ep, serviceName);

      const conditions: ConditionResult[] = [{
        condition: `[SELECTOR] found ${ep.waitForSelector ?? '(waitForSelector not set)'}`,
        passed: result.passed,
        actual: result.message,
        expected: ep.waitForSelector ?? '(not set)',
      }];

      if (evalMode === 'alwayserror') {
        conditions.push({
          condition: '[EVAL_MODE] == condition',
          passed: false,
          actual: 'alwayserror',
          expected: 'condition',
        });
      }

      const conditionsPassed = conditions.every(c => c.passed);

      for (const c of conditions) {
        if (!c.passed) {
          logger.warn({ service: serviceName, endpoint: epName, condition: c.condition, actual: c.actual }, 'Condition failed');
        }
      }

      // ── Browser retry logic ─────────────────────────────────────────────
      const retryFiles: string[] = [];
      const retryAttempts: RetryAttempt[] = [];
      let anyRetryPassed = false;
      if (!conditionsPassed && evalMode === 'condition' && (ep.retry ?? 0) > 0) {
        const retryDelayMs = (ep.retryDelay ?? 0) * 1000;
        for (let r = 0; r < ep.retry!; r++) {
          if (retryDelayMs > 0) await delay(retryDelayMs);
          logger.debug({ service: serviceName, endpoint: epName, attempt: r + 1 }, 'Browser retry attempt');
          const rr = await runBrowserIasLogin(ep, serviceName);
          const retryStatus: 200 | 500 = rr.passed ? 200 : 500;
          const retryConds: ConditionResult[] = [{
            condition: `[SELECTOR] found ${ep.waitForSelector ?? '(waitForSelector not set)'}`,
            passed: rr.passed,
            actual: rr.message,
            expected: ep.waitForSelector ?? '(not set)',
          }];
          const retryRecord: ResponseRecord = {
            request: { url: ep.url, method: 'BROWSER', headers: {}, body: null },
            response: { status: retryStatus, headers: {}, body: rr.message },
            timestamp: new Date().toISOString(),
            responseTime: rr.responseTime,
            endpointIndex: i,
            endpointName: epName,
            conditions: retryConds,
            overallStatus: retryStatus,
            city: getCity(),
          };
          const retryFile = await saveResponse(serviceName, retryRecord, rr.screenshot, rr.consoleLogs, rr.htmlContent, true);
          retryFiles.push(retryFile);
          const hasRetryScreenshot = rr.screenshot.length > 0;
          retryAttempts.push({
            attempt: r + 1,
            conditions: retryConds,
            passed: rr.passed,
            request: { url: ep.url, method: 'BROWSER', headers: {}, body: null },
            response: { status: retryStatus, headers: {}, body: rr.message },
            responseTime: rr.responseTime,
            screenshotUrl: hasRetryScreenshot
              ? `/api/download?path=${encodeURIComponent(serviceName)}/${encodeURIComponent(retryFile.replace(/\.json$/, '.screenshot.png'))}`
              : undefined,
            consoleText: rr.consoleLogs.length > 0 ? rr.consoleLogs.join('\n') : undefined,
            htmlText: rr.htmlContent || undefined,
          });
          if (rr.passed) { anyRetryPassed = true; break; }
        }
      }

      const overallStatus: 200 | 203 | 400 | 500 | 503 =
        evalMode === 'alwaysok' ? 203 :
        evalMode === 'alwayserror' ? 503 :
        conditionsPassed ? 200 :
        anyRetryPassed ? 400 : 500;

      const record: ResponseRecord = {
        request: { url: ep.url, method: 'BROWSER', headers: {}, body: null },
        response: { status: overallStatus, headers: {}, body: result.message },
        timestamp: new Date().toISOString(),
        responseTime: result.responseTime,
        endpointIndex: i,
        endpointName: epName,
        conditions,
        overallStatus,
        city: getCity(),
        retryFiles: retryFiles.length > 0 ? retryFiles : undefined,
      };

      const jsonFile = await saveResponse(serviceName, record, result.screenshot, result.consoleLogs, result.htmlContent);
      const screenshotFile = jsonFile.replace(/\.json$/, '.screenshot.png');
      const hasScreenshot = result.screenshot.length > 0;

      details.push({
        index: i,
        name: epName,
        conditions,
        passed: conditionsPassed,
        partiallyFailed: anyRetryPassed,
        retries: retryAttempts.length > 0 ? retryAttempts : undefined,
        request: { url: ep.url, method: 'BROWSER', headers: {}, body: null },
        response: { status: overallStatus, headers: {}, body: result.message },
        responseTime: result.responseTime,
        screenshotUrl: hasScreenshot
          ? `/api/download?path=${encodeURIComponent(serviceName)}/${encodeURIComponent(screenshotFile)}`
          : undefined,
        consoleText: result.consoleLogs.length > 0 ? result.consoleLogs.join('\n') : undefined,
        htmlText: result.htmlContent || undefined,
      });
      continue;
    }

    // ── Standard HTTP check ─────────────────────────────────────────────────
    const reqHeaders = normalizeHeaders(ep.headers);
    const method = ep.method ?? 'GET';
    const timeoutMs = ep.timeout != null ? ep.timeout * 1000 : config.REQUEST_TIMEOUT_MS;

    logger.debug({ service: serviceName, endpoint: epName, method, url: ep.url, timeoutMs }, 'Sending request');

    const attempt = await runHttpAttempt(ep, reqHeaders, method, timeoutMs);
    const { respStatus, respHeaders, respBody, responseTime, fetchError, didTimeout } = attempt;

    if (!fetchError) {
      logger.debug({ service: serviceName, endpoint: epName, status: respStatus, responseTime, bodyPreview: respBody.slice(0, 300) }, 'Response received');
    } else if (didTimeout) {
      logger.warn({ service: serviceName, endpoint: epName, url: ep.url, timeoutMs, responseTime }, 'Request timed out');
    } else {
      logger.error({ service: serviceName, endpoint: epName, url: ep.url, responseTime, err: fetchError }, 'Request failed with network error');
    }

    const ctx = { status: respStatus, responseTime, body: respBody, headers: respHeaders };
    const conditions: ConditionResult[] = (ep.conditions ?? []).map(c => evaluateCondition(c, ctx));

    if (didTimeout) {
      conditions.push({
        condition: `[TIMEOUT] response within ${timeoutMs}ms`,
        passed: false,
        actual: `${responseTime}ms`,
        expected: `< ${timeoutMs}ms`,
      });
    }

    if (evalMode === 'alwayserror') {
      conditions.push({
        condition: '[EVAL_MODE] == condition',
        passed: false,
        actual: 'alwayserror',
        expected: 'condition',
      });
    }

    const conditionsPassed = fetchError === null && conditions.every(c => c.passed);

    for (const c of conditions) {
      if (!c.passed) {
        logger.warn({ service: serviceName, endpoint: epName, condition: c.condition, actual: c.actual, expected: c.expected }, 'Condition failed');
      }
    }

    // ── HTTP retry logic ────────────────────────────────────────────────────
    const retryFiles: string[] = [];
    const retryAttempts: RetryAttempt[] = [];
    let anyRetryPassed = false;
    if (!conditionsPassed && evalMode === 'condition' && (ep.retry ?? 0) > 0) {
      const retryDelayMs = (ep.retryDelay ?? 0) * 1000;
      for (let r = 0; r < ep.retry!; r++) {
        if (retryDelayMs > 0) await delay(retryDelayMs);
        logger.debug({ service: serviceName, endpoint: epName, attempt: r + 1 }, 'HTTP retry attempt');
        const ra = await runHttpAttempt(ep, reqHeaders, method, timeoutMs);
        const retryCtx = { status: ra.respStatus, responseTime: ra.responseTime, body: ra.respBody, headers: ra.respHeaders };
        const retryConds: ConditionResult[] = (ep.conditions ?? []).map(c => evaluateCondition(c, retryCtx));
        if (ra.didTimeout) {
          retryConds.push({ condition: `[TIMEOUT] response within ${timeoutMs}ms`, passed: false, actual: `${ra.responseTime}ms`, expected: `< ${timeoutMs}ms` });
        }
        const retryPassed = ra.fetchError === null && retryConds.every(c => c.passed);
        const retryStatus: 200 | 500 | 504 = retryPassed ? 200 : ra.didTimeout ? 504 : 500;
        const retryRecord: ResponseRecord = {
          request: { url: ep.url, method, headers: reqHeaders, body: ep.body ?? null },
          response: { status: ra.respStatus, headers: ra.respHeaders, body: ra.respBody },
          timestamp: new Date().toISOString(),
          responseTime: ra.responseTime,
          endpointIndex: i,
          endpointName: epName,
          conditions: retryConds,
          overallStatus: retryStatus,
          city: getCity(),
        };
        const retryFile = await saveResponse(serviceName, retryRecord, undefined, undefined, undefined, true);
        retryFiles.push(retryFile);
        retryAttempts.push({
          attempt: r + 1,
          conditions: retryConds,
          passed: retryPassed,
          request: { url: ep.url, method, headers: reqHeaders, body: ep.body ?? null },
          response: { status: ra.respStatus, headers: ra.respHeaders, body: ra.respBody },
          responseTime: ra.responseTime,
        });
        if (retryPassed) { anyRetryPassed = true; break; }
      }
    }

    const overallStatus: 200 | 203 | 400 | 500 | 503 | 504 =
      evalMode === 'alwaysok' ? 203 :
      evalMode === 'alwayserror' ? 503 :
      conditionsPassed ? 200 :
      anyRetryPassed ? 400 :
      didTimeout ? 504 : 500;

    const record: ResponseRecord = {
      request: { url: ep.url, method, headers: reqHeaders, body: ep.body ?? null },
      response: { status: respStatus, headers: respHeaders, body: respBody },
      timestamp: new Date().toISOString(),
      responseTime,
      endpointIndex: i,
      endpointName: epName,
      conditions,
      overallStatus,
      city: getCity(),
      retryFiles: retryFiles.length > 0 ? retryFiles : undefined,
    };

    await saveResponse(serviceName, record);
    details.push({
      index: i,
      name: epName,
      conditions,
      passed: conditionsPassed,
      partiallyFailed: anyRetryPassed,
      retries: retryAttempts.length > 0 ? retryAttempts : undefined,
      request: { url: ep.url, method, headers: reqHeaders, body: ep.body ?? null },
      response: { status: respStatus, headers: respHeaders, body: respBody },
      responseTime,
    });
  }

  const allPassed = details.every(d => d.passed);
  const failMessages = details.flatMap(d =>
    d.conditions
      .filter(c => !c.passed)
      .map(c => `[${d.name}] ${c.condition}: expected ${c.expected}, got ${c.actual}`),
  );

  const ts = Date.now();
  emit('global', { service: serviceName, ts });
  emit(`service:${serviceName}`, { service: serviceName, ts });
  notifyCallbacks();

  return {
    success: allPassed,
    timedOut: !allPassed && details.some(d =>
      d.conditions.some(c => c.condition.startsWith('[TIMEOUT]')),
    ),
    message: allPassed ? 'OK' : failMessages.join('\n'),
    details,
  };
}

function normalizeHeaders(
  headers: Record<string, string> | Array<{ name: string; value: string }> | null | undefined,
): Record<string, string> {
  if (!headers) return {};
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers.map(h => [h.name, h.value]));
  }
  return headers;
}
