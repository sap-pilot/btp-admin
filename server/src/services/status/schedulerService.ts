import { getAllServices, getService } from './configService.js';
import { checkService } from './healthCheckService.js';
import { logger } from '../../logger.js';

// Timer key: "${serviceName}/${endpointIdx}"
const timers = new Map<string, ReturnType<typeof setInterval>>();
const running = new Set<string>();

export function startScheduler(): void {
  const all = getAllServices();
  let scheduledCount = 0;
  const manualServices: string[] = [];

  for (const svc of all) {
    let svcHasSchedule = false;
    for (let i = 0; i < svc.endpoints.length; i++) {
      const ep = svc.endpoints[i];
      const effectiveInterval = ep.interval ?? svc.interval ?? 0;
      if (effectiveInterval > 0) {
        register(`${svc.name}/${i}`, svc.name, i, effectiveInterval);
        scheduledCount++;
        svcHasSchedule = true;
      }
    }
    if (!svcHasSchedule) manualServices.push(svc.name);
  }

  if (scheduledCount > 0) {
    logger.info({ count: scheduledCount }, 'Scheduler started');
  }
  if (manualServices.length > 0) {
    logger.info({ count: manualServices.length, services: manualServices }, 'Services with no interval — manual trigger only (Run Test / /health/:name)');
  }
}

function register(key: string, serviceName: string, epIdx: number, intervalSecs: number): void {
  const timer = setInterval(() => { void tick(key, serviceName, epIdx, intervalSecs); }, intervalSecs * 1000);
  timer.unref();
  timers.set(key, timer);
  logger.debug({ key, intervalSecs }, 'Auto-check registered');
}

async function tick(key: string, serviceName: string, epIdx: number, intervalSecs: number): Promise<void> {
  if (running.has(key)) {
    logger.warn({ key }, 'Auto-check skipped: previous run still in progress');
    return;
  }
  running.add(key);
  try {
    logger.debug({ key }, 'Auto-check triggered');
    await checkService(serviceName, undefined, epIdx);
  } catch (err) {
    logger.error({ key, err }, 'Auto-check error; will retry at next interval');
    if (!timers.has(key)) {
      logger.warn({ key }, 'Timer missing after error, re-registering');
      register(key, serviceName, epIdx, intervalSecs);
    }
  } finally {
    running.delete(key);
  }
}

export function rescheduleService(name: string, intervalSecs: number): void {
  // Clear all timers for this service
  for (const key of [...timers.keys()]) {
    if (key.startsWith(`${name}/`)) {
      clearInterval(timers.get(key)!);
      timers.delete(key);
    }
  }
  if (intervalSecs > 0) {
    const svc = getService(name);
    if (svc) {
      for (let i = 0; i < svc.endpoints.length; i++) {
        register(`${name}/${i}`, name, i, intervalSecs);
      }
    }
    logger.info({ service: name, intervalSecs }, 'Service rescheduled');
  } else {
    logger.info({ service: name }, 'Service auto-run disabled');
  }
}

export function stopScheduler(): void {
  for (const [key, timer] of timers) {
    clearInterval(timer);
    logger.debug({ key }, 'Auto-check timer cleared');
  }
  timers.clear();
  running.clear();
  logger.info('Scheduler stopped');
}
