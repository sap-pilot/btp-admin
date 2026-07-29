import { existsSync } from 'node:fs';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { logger } from '../../logger.js';
import type { EndpointConfig } from '../../types/index.js';

const SYSTEM_CHROME = '/usr/bin/google-chrome-stable';

export interface BrowserCheckResult {
  passed: boolean;
  message: string;
  responseTime: number;
  screenshot: Buffer;
  consoleLogs: string[];
  htmlContent: string;
}

let _browser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (_browser?.isConnected()) return _browser;
  _browser = await chromium.launch({
    headless: true,
    executablePath: existsSync(SYSTEM_CHROME) ? SYSTEM_CHROME : undefined,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  _browser.on('disconnected', () => { _browser = null; });
  logger.info('Shared browser instance launched');
  return _browser;
}

export async function closeBrowser(): Promise<void> {
  if (_browser) {
    try { await _browser.close(); } catch { /* ignore */ }
    _browser = null;
  }
}

export async function runBrowserIasLogin(
  ep: EndpointConfig,
  serviceName: string,
): Promise<BrowserCheckResult> {
  const timeout = ep.timeout != null ? ep.timeout * 1000 : 30_000;
  let passed = false;
  let message = '';
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  let responseTime = 0;
  let start = 0;

  const consoleLogs: string[] = [];

  try {
    const browser = await getBrowser();
    context = await browser.newContext();
    page = await context.newPage();
    page.on('console', msg => {
      consoleLogs.push(`[${new Date().toISOString()}] [${msg.type()}] ${msg.text()}`);
    });
    await page.setViewportSize({ width: 1280, height: 800 });

    logger.debug({ service: serviceName, endpoint: ep.name, url: ep.url }, 'Browser: navigating');

    start = Date.now();
    await page.goto(ep.url, { timeout });

    await page.waitForSelector('#j_username', { timeout });
    await page.fill('#j_username', ep.username ?? '');
    logger.debug({ service: serviceName, endpoint: ep.name }, 'Browser: filled username');

    await page.click('#logOnFormSubmit');

    await page.waitForSelector('#j_password', { timeout });
    await page.fill('#j_password', ep.password ?? '');
    logger.debug({ service: serviceName, endpoint: ep.name }, 'Browser: filled password');

    await page.click('#logOnFormSubmit');

    const selector = ep.waitForSelector ?? '';
    await page.waitForSelector(selector, { timeout: timeout, state: 'attached' });

    passed = true;
    message = `Login succeeded — element "${selector}" found`;
    logger.info({ service: serviceName, endpoint: ep.name, finalUrl: page.url() }, 'Browser check passed');
    responseTime = Date.now() - start;
  } catch (err) {
    responseTime = start > 0 ? Date.now() - start : 0;
    message = err instanceof Error ? err.message : String(err);
    logger.warn({ service: serviceName, endpoint: ep.name, err }, 'Browser check failed');
  }

  let screenshot: Buffer = Buffer.alloc(0);
  let htmlContent = '';
  if (page) {
    try {
      screenshot = await page.screenshot({ fullPage: false });
    } catch (err) {
      logger.debug({ service: serviceName, err }, 'Browser screenshot failed');
    }
    try {
      htmlContent = await page.content();
    } catch (err) {
      logger.debug({ service: serviceName, err }, 'Browser page.content() failed');
    }
  }

  try { await context?.close(); } catch { /* ignore */ }

  return { passed, message, responseTime, screenshot, consoleLogs, htmlContent };
}
