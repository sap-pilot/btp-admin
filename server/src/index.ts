import express from 'express';
import { config } from './config.js';
import { loadConfig, getSyncExcludes } from './services/configService.js';
import { logger } from './logger.js';
import { startScheduler, stopScheduler } from './services/status/schedulerService.js';
import { startupSync, startIntervalFallback, stopIntervalFallback, registerOnAccessLogSynced } from './services/syncService.js';
import { refreshLastUpdated } from './services/lastUpdatedService.js';
import { startHousekeepingScheduler, stopHousekeepingScheduler } from './services/housekeepingService.js';
import { initGeo } from './services/geoService.js';
import { closeBrowser } from './services/status/browserCheckService.js';
import healthRouter from './routes/health.js';
import apiRouter from './routes/api.js';
import syncRouter from './routes/sync.js';
import statusApiRouter from './routes/status.js';
import configRouter from './routes/config.js';
import settingsRouter from './routes/settings.js';
import destRouter from './routes/destinations.js';
import rcsRouter from './routes/rcs.js';
import usersRouter from './routes/users.js';
import authRouter from './routes/auth.js';
import aodRouter, { aodProxyHandler } from './routes/aod.js';
import appsRouter from './routes/apps.js';
import { startAppsScheduler, stopAppsScheduler } from './services/appService.js';
import { initRequestLog, mergeAccessLogFromSync } from './services/aodAnalyticsService.js';
import { requireSessionGlobal } from './middleware/requireAuth.js';
import { errorHandler } from './middleware/errorHandler.js';
import { compress } from './middleware/compress.js';
import { serveStatic } from './static.js';

const app = express();
app.use(compress);
app.use(express.json({ limit: '5mb' }));

const cfg = loadConfig();
logger.info({ configFile: config.CONFIG_FILE, services: cfg.services.length }, 'Config initialized');

app.use('/health', healthRouter);
app.use(authRouter);
// AOD proxy: no auth — must be mounted before requireSessionGlobal
app.use('/aod', aodProxyHandler);
// API responses must never be cached — prevents 304s on repeated /api/view requests
app.use('/api', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
// Global session auth: all /api/* require login when XSUAA is bound (exceptions in requireSessionGlobal)
app.use('/api', requireSessionGlobal);
app.use('/api/status', statusApiRouter);
app.use('/api/config', configRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/destinations', destRouter);
app.use('/api/role-collections', rcsRouter);
app.use('/api/users', usersRouter);
app.use('/api/sync', syncRouter);
app.use('/api/apps', appsRouter);
app.use('/api/aod', aodRouter);
app.use('/api', apiRouter);

try {
  serveStatic(app);
} catch {
  // public dir not present before first client build
}

app.use(errorHandler);

const server = app.listen(config.PORT, () => {
  logger.info({ port: config.PORT }, 'btp-admin server started');
  if (config.SYNC_PROTECTION_OFF) {
    logger.warn('SYNC_PROTECTION_OFF is active — /api/sync/browse and /api/sync/batch require no authentication');
  }
  void refreshLastUpdated();
  void initGeo();
  void initRequestLog();
  registerOnAccessLogSynced(saPaths => {
    for (const key of saPaths) {
      const slash = key.indexOf('/');
      if (slash === -1) continue;
      void mergeAccessLogFromSync(key.slice(0, slash), key.slice(slash + 1));
    }
  });
  startScheduler();
  startHousekeepingScheduler();
  startAppsScheduler();
  if (config.SYNC_REMOTE) {
    const syncExcludes = getSyncExcludes();
    if (syncExcludes.size > 0) {
      logger.info({ folders: [...syncExcludes].join(', ') }, 'Sync exclude list active — these folders will be skipped during remote sync');
    }
    startupSync();
    startIntervalFallback();
  }
});

function shutdown(signal: string) {
  logger.info({ signal }, 'Shutting down');
  stopScheduler();
  stopHousekeepingScheduler();
  stopAppsScheduler();
  stopIntervalFallback();
  server.close(() => {
    closeBrowser().finally(() => process.exit(0));
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
