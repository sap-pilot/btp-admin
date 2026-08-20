import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export type RfcAddonResult =
  | { json: string }
  | { error: string };

type AddonExports = {
  invokeRfc(
    params: Record<string, string>,
    funcName: string,
    importParams: Record<string, string>,
  ): Promise<RfcAddonResult>;
};

let _addon: AddonExports | null | undefined;

function loadAddon(): AddonExports | null {
  if (_addon !== undefined) return _addon;
  try {
    const require = createRequire(import.meta.url);
    const dir = dirname(fileURLToPath(import.meta.url));
    // Walk up from src/rfc/ to server root, then into build/Release/
    const addonPath = join(dir, '..', '..', 'build', 'Release', 'rfcaddon.node');
    _addon = require(addonPath) as AddonExports;
    return _addon;
  } catch (e) {
    console.warn('[rfcAddon] Native addon not available:', e instanceof Error ? e.message : String(e));
    console.warn('[rfcAddon] Run: cd server && npm run build:addon');
    _addon = null;
    return null;
  }
}

export function invokeRfc(
  params: Record<string, string>,
  funcName: string,
  importParams: Record<string, string>,
): Promise<RfcAddonResult> | null {
  const addon = loadAddon();
  if (!addon) return null;
  return addon.invokeRfc(params, funcName, importParams);
}
