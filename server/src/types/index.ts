export interface EndpointConfig {
  name?: string;
  url: string;
  method?: string;
  headers?: Record<string, string> | Array<{ name: string; value: string }>;
  body?: string | null;
  conditions?: string[];
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

export interface HistoryFile {
  filename: string;
  timestamp: number;
  /** -1 for new-format files (use endpointSlug instead) */
  endpointIndex: number;
  /** Sanitized endpoint name from filename; present in new-format files only */
  endpointSlug?: string;
  /** Geo-resolved city at time of check; present in new-format files only */
  city?: string;
  responseTime: number;
  httpStatus: number;
  overallStatus: 200 | 203 | 400 | 500 | 503 | 504;
  screenshotFile?: string;
  /** True when this file has been starred (filename contains .starred.) */
  starred?: boolean;
}

export interface ServiceWithHistory {
  group: string;
  name: string;
  enabled: boolean;
  endpoints: EndpointConfig[];
  history: HistoryFile[];
}

/** One retry attempt returned inline with a live check result (GET /api/check/:name). */
export interface RetryAttempt {
  /** 1-based retry attempt number */
  attempt: number;
  conditions: ConditionResult[];
  passed: boolean;
  request: { url: string; method: string; headers: Record<string, string>; body: string | null };
  response: { status: number; headers: Record<string, string>; body: string };
  responseTime: number;
  screenshotUrl?: string;
  consoleText?: string;
  htmlText?: string;
}

export interface EndpointCheckResult {
  index: number;
  name: string;
  conditions: ConditionResult[];
  passed: boolean;
  partiallyFailed?: boolean;
  /** Retry attempts made after the initial failure; populated only for live Run Test results. */
  retries?: RetryAttempt[];
  request: { url: string; method: string; headers: Record<string, string>; body: string | null };
  response: { status: number; headers: Record<string, string>; body: string };
  responseTime: number;
  screenshotUrl?: string;
  consoleText?: string;
  htmlText?: string;
}

export interface CheckResult {
  success: boolean;
  timedOut: boolean;
  message: string;
  details: EndpointCheckResult[];
}

export type EvaluationMode = 'condition' | 'alwaysok' | 'alwayserror';

export interface ServiceSummary {
  name: string;
  group: string;
  rangeStatus: 'ok' | 'warning' | 'error' | null;
}
