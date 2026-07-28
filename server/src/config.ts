const CONFIG_FILE = process.env.CONFIG_FILE ?? './config.json';
const PORT = parseInt(process.env.PORT ?? '3000', 10);
const RESPONSE_DIR = process.env.RESPONSE_DIR ?? './response';
const SYNC_REMOTE = process.env.SYNC_REMOTE ?? '';
const SYNC_REMOTE_BATCH_SIZE = Math.max(1, parseInt(process.env.SYNC_REMOTE_BATCH_SIZE ?? '200', 10));
const SYNC_INTERVAL = Math.max(0, parseInt(process.env.SYNC_INTERVAL ?? '300', 10));
const MAX_RESPONSE_STORAGE_DAYS = Math.max(0, parseInt(process.env.MAX_RESPONSE_STORAGE_DAYS ?? '7', 10));
const REQUEST_TIMEOUT_MS = Math.max(1000, parseInt(process.env.REQUEST_TIMEOUT_MS ?? '30000', 10));
/** When set to any non-empty value, /api/browse and /api/batch-download skip HMAC/XSUAA validation entirely. */
const SYNC_PROTECTION_OFF = !!(process.env['SYNC_PROTECTION_OFF']);

// Self URL for webhook callback registration. Set SELF_URL explicitly or derive from CF VCAP_APPLICATION.
const SELF_URL = (() => {
  if (process.env.SELF_URL) return process.env.SELF_URL.replace(/\/$/, '');
  try {
    const vcap = JSON.parse(process.env.VCAP_APPLICATION ?? '{}') as { application_uris?: string[] };
    const uri = vcap.application_uris?.[0];
    return uri ? `https://${uri}` : '';
  } catch { return ''; }
})();

export const config = { CONFIG_FILE, PORT, RESPONSE_DIR, SYNC_REMOTE, SELF_URL, SYNC_REMOTE_BATCH_SIZE, SYNC_INTERVAL, MAX_RESPONSE_STORAGE_DAYS, REQUEST_TIMEOUT_MS, SYNC_PROTECTION_OFF };
