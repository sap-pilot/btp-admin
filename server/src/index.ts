import express from 'express';
import { config } from './config.js';
import { loadConfig } from './services/status/configService.js';
import { logger } from './logger.js';
import { startScheduler, stopScheduler } from './services/status/schedulerService.js';
import { syncFromRemote, setLastTriggerSyncTs, startIntervalFallback, stopIntervalFallback } from './services/status/syncService.js';
import { startHousekeepingScheduler, stopHousekeepingScheduler } from './services/status/housekeepingService.js';
import { initGeo } from './services/geoService.js';
import { closeBrowser } from './services/status/browserCheckService.js';
import healthRouter from './routes/health.js';
import apiRouter from './routes/api.js';
import statusApiRouter from './routes/status/api.js';
import authRouter from './routes/auth.js';
import { errorHandler } from './middleware/errorHandler.js';
import { compress } from './middleware/compress.js';
import { serveStatic } from './static.js';

const app = express();
app.use(compress);
app.use(express.json());

const cfg = loadConfig();
logger.info({ configFile: config.CONFIG_FILE, services: cfg.services.length }, 'Config initialized');

app.use('/health', healthRouter);
app.use(authRouter);
// API responses must never be cached — prevents 304s on repeated /api/download requests
app.use('/api', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
app.use('/api/status', statusApiRouter);
app.use('/api', apiRouter);

try {
  serveStatic(app);
} catch {
  // public dir not present before first client build
}

app.use(errorHandler);

const server = app.listen(config.PORT, () => {
  logger.info({ port: config.PORT }, 'BTP Admin server started');
  if (config.SYNC_PROTECTION_OFF) {
    logger.warn('SYNC_PROTECTION_OFF is active — /api/browse and /api/batch-download require no authentication');
  }
  void initGeo();
  startScheduler();
  startHousekeepingScheduler();
  if (config.SYNC_REMOTE) {
    // Record the start time now (≈ browse time) so the next trigger/interval sync
    // uses since= from before the startup browse, catching any files generated
    // between the browse and the batch-download completing.
    const startupSyncTs = Date.now();
    syncFromRemote(config.SYNC_REMOTE, { selfBaseUrl: config.SELF_URL })
      .catch(err => logger.error({ err }, 'Remote sync error'))
      .finally(() => setLastTriggerSyncTs(startupSyncTs));
    startIntervalFallback();
  }
});

function shutdown(signal: string) {
  logger.info({ signal }, 'Shutting down');
  stopScheduler();
  stopHousekeepingScheduler();
  stopIntervalFallback();
  server.close(() => {
    closeBrowser().finally(() => process.exit(0));
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
