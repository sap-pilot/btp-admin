// In-memory cache for parsed settings overrides (aod, sites, statusPage).
// Kept in its own module to avoid a circular import:
//   configService → settingsService → syncService → configService
// Both configService and settingsService can import this module safely.

export interface CachedAodOverride {
  regionalEndpoints?: Record<string, string>;
  excludeApps?: string[];
}

export interface CachedSiteEntry {
  name: string;
  url: string;
  legacyUrls?: string[];
}

export interface CachedStatusPageOverride {
  landscapes?: Array<{ name: string; diagram: string }>;
  services?: unknown[];
}

export interface CachedSettingsData {
  aod?: CachedAodOverride;
  sites?: CachedSiteEntry[];
  statusPage?: CachedStatusPageOverride;
}

let cache: CachedSettingsData = {};

export function getCachedSettingsOverrides(): CachedSettingsData { return cache; }
export function updateSettingsDataCache(data: CachedSettingsData): void { cache = { ...data }; }
