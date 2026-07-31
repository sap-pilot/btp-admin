import express from 'express';
import { config } from './config.js';
import { loadConfig } from './services/configService.js';
import { logger } from './logger.js';
import { startScheduler, stopScheduler } from './services/status/schedulerService.js';
import { startupSync, startIntervalFallback, stopIntervalFallback } from './services/syncService.js';
import { startHousekeepingScheduler, stopHousekeepingScheduler } from './services/housekeepingService.js';
import { initGeo } from './services/geoService.js';
import { closeBrowser } from './services/status/browserCheckService.js';
import healthRouter from './routes/health.js';
import apiRouter from './routes/api.js';
import statusApiRouter from './routes/status.js';
import homepageRouter from './routes/homepage.js';
import configRouter from './routes/config.js';
import destRouter from './routes/destinations.js';
import authRouter from './routes/auth.js';
import { requireSessionGlobal } from './middleware/requireAuth.js';
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
// Global session auth: all /api/* require login when XSUAA is bound (exceptions in requireSessionGlobal)
app.use('/api', requireSessionGlobal);
app.use('/api/status', statusApiRouter);
app.use('/api/homepage', homepageRouter);
app.use('/api/config', configRouter);
app.use('/api/destinations', destRouter);
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
    logger.warn('SYNC_PROTECTION_OFF is active — /api/browse and /api/batch-download require no authentication');
  }
  void initGeo();
  startScheduler();
  startHousekeepingScheduler();
  if (config.SYNC_REMOTE) {
    startupSync();
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
