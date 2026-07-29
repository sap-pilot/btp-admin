export interface EndpointConfig {
  name?: string;
  url: string;
  // Standard HTTP fields (not required for browser-ias-login mode)
  method?: string;
  headers?: Record<string, string> | Array<{ name: string; value: string }>;
  body?: string | null;
  conditions?: string[];
  // Browser-based IAS login check
  mode?: 'browser-ias-login';
  username?: string;
  password?: string;
  waitForSelector?: string;
  /** Timeout in seconds (was milliseconds before v0.12) */
  timeout?: number;
  region?: string;
  /** Per-endpoint auto-check interval in seconds */
  interval?: number;
  /** Max retry attempts on failure */
  retry?: number;
  /** Seconds between retry attempts */
  retryDelay?: number;
}

export interface ServiceConfig {
  group: string;
  name: string;
  enabled: boolean;
  /** Service-level interval (seconds) — kept for backward compat; endpoint-level interval takes precedence */
  interval?: number;
  homepage?: string;
  landscapes?: string[];
  endpoints: EndpointConfig[];
}

export interface LandscapeConfig {
  name: string;
  diagram: string;
}

export interface SiteConfig {
  name: string;
  url: string;
  legacyUrls?: string[];
}

export interface AppConfig {
  services: ServiceConfig[];
  landscapes?: LandscapeConfig[];
  variables?: Record<string, string>;
  sites?: SiteConfig[];
}

export interface ConditionResult {
  condition: string;
  passed: boolean;
  actual: string;
  expected: string;
}

export interface ResponseRecord {
  request: { url: string; method: string; headers: Record<string, string>; body: string | null };
  response: { status: number; headers: Record<string, string>; body: string };
  timestamp: string;
  responseTime: number;
  endpointIndex: number;
  endpointName: string;
  conditions: ConditionResult[];
  overallStatus: 200 | 203 | 400 | 500 | 503 | 504;
  city?: string;
  screenshotFile?: string;
  consoleLogFile?: string;
  contentFile?: string;
  /** Filenames of .retry.json files saved for each retry attempt */
  retryFiles?: string[];
}

/** Parsed representation of a response filename. All fields are derived from the filename itself. */
export interface HistoryFile {
  filename: string;                              // always includes .json
  overallStatus: 200 | 203 | 400 | 500 | 503 | 504;
  timestamp?: number;                            // absent only if filename is unrecognised
  responseTime?: number;
  city?: string;
  endpointSlug?: string;                         // new-format files only
  endpointIndex?: number;                        // old-format files only
  starred?: boolean;                             // true when filename contains .starred.
}

export interface ServiceWithHistory extends ServiceConfig {
  /** Filenames without .json — parse with parseFilename on the client to get HistoryFile fields. */
  history: string[];
}

/** Per-service status summary returned by GET /api/service-summary */
export interface ServiceSummary {
  name: string;
  group: string;
  /**
   * ok      — all runs in the selected range passed
   * warning — latest run passed but at least one earlier run failed
   * error   — latest run failed
   * null    — no history in the selected range
   */
  rangeStatus: 'ok' | 'warning' | 'error' | null;
}

/** Evaluation mode — controls what /health and Run Test return regardless of actual condition results */
export type EvaluationMode = 'condition' | 'alwaysok' | 'alwayserror';
