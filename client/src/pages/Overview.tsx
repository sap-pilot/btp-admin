import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { parseFilename } from '@/lib/parseFilename';
import { Link, useNavigate } from 'react-router';
import type { ServiceWithHistory, HistoryFile, LandscapeConfig, ServiceSummary, SiteConfig } from '@shared/types';
import StatusDots from '@/components/StatusDots';
import type { NodeStatus } from '@/components/LandscapeDiagram';
const LandscapeDiagram = lazy(() => import('@/components/LandscapeDiagram'));
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { AlertCircle, ChevronDown, Menu, RefreshCw, Sun, Moon, ExternalLink, X, Zap } from 'lucide-react';
import { useTheme } from '@/hooks/useTheme';
import { useWindowWidth } from '@/hooks/useWindowWidth';
import { useAuth } from '@/hooks/useAuth';
import { useTimeRange, fmtDateRange } from '@/hooks/useTimeRange';
import AuthButton from '@/components/AuthButton';
import DateRangePicker from '@/components/DateRangePicker';
import { useLiveEvents } from '@/hooks/useLiveEvents';

const HOUR_OPTIONS = [
  { value: '1', label: 'Last 1 hour' },
  { value: '6', label: 'Last 6 hours' },
  { value: '12', label: 'Last 12 hours' },
  { value: '24', label: 'Last 24 hours' },
  { value: '48', label: 'Last 48 hours' },
  { value: '72', label: 'Last 72 hours' },
  { value: 'range', label: 'Date Range…' },
];

function tsOf(f: HistoryFile): number {
  return f.timestamp ?? parseFilename(f.filename)?.timestamp ?? 0;
}

function slugify(s: string): string {
  return s.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'endpoint';
}

function getEndpointNodeStatus(files: HistoryFile[]): NodeStatus | null {
  if (files.length === 0) return null;
  const sorted = [...files].sort((a, b) => tsOf(b) - tsOf(a));
  const latestTs = tsOf(sorted[0]);
  const latestFiles = sorted.filter(f => Math.floor(tsOf(f) / 1000) === Math.floor(latestTs / 1000));
  const latestPassed = latestFiles.every(f => f.overallStatus === 200 || f.overallStatus === 203);
  if (!latestPassed) {
    // Partial (400 only in latest) → warn; any full failure (500/503/504) → error
    const latestFullFail = latestFiles.some(f => f.overallStatus === 500 || f.overallStatus === 503 || f.overallStatus === 504);
    return latestFullFail ? 'error' : 'warn';
  }
  const anyFailed = sorted.some(f => f.overallStatus !== 200 && f.overallStatus !== 203);
  return anyFailed ? 'warn' : 'ok';
}

type ParsedService = Omit<ServiceWithHistory, 'history'> & { history: HistoryFile[] };

function getServiceOverallHistory(service: ParsedService): HistoryFile[] {
  // Group files by timestamp bucket (same second = same check run)
  // For each check run (same-timestamp files), overall pass = ALL endpoints passed
  const byTs = new Map<number, HistoryFile[]>();
  for (const f of service.history) {
    const bucket = Math.floor(tsOf(f) / 1000);
    if (!byTs.has(bucket)) byTs.set(bucket, []);
    byTs.get(bucket)!.push(f);
  }

  const combined: HistoryFile[] = [];
  for (const [, files] of byTs) {
    const first = files[0];
    // If any file has an override status (203/503), use the first override found
    const override = files.find(f => f.overallStatus === 203 || f.overallStatus === 503);
    if (override) {
      combined.push({ ...first, overallStatus: override.overallStatus });
    } else {
      const allPassed = files.every(f => f.overallStatus === 200);
      combined.push({ ...first, overallStatus: allPassed ? 200 : 500 });
    }
  }
  return combined.sort((a, b) => tsOf(b) - tsOf(a));
}

function fmtUptime(n: number): string {
  return parseFloat(n.toFixed(2)) === 100 ? '100%' : `${n.toFixed(2)}%`;
}

function getUptimePct(history: HistoryFile[]): number {
  if (history.length === 0) return 100;
  const up = history.filter(h => h.overallStatus === 200 || h.overallStatus === 203).length;
  return (up / history.length) * 100;
}

export default function Overview() {
  const navigate = useNavigate();
  const { theme, toggleTheme } = useTheme();
  const auth = useAuth();
  const windowWidth = useWindowWidth();
  // max-w-7xl (1280px) page with px-4 (32px) → page content width
  // table-fixed: service col w-56 (224px) + stats col w-40 (160px) + 3×px-4 cells (96px)
  // timeline td inner width = content - 224 - 160 - 96 = content - 480
  // each dot slot = w-2.5 (10px) + gap-0.5 (2px) = 12px
  const timelineWidth = Math.min(windowWidth, 1280) - 32 - 224; // 170 (name col) + 110 (badge col) - ~24 card/border, timeline td px-0
  const maxDots = Math.max(8, Math.floor(timelineWidth / 12));
  const isMobile = windowWidth < 640;

  const { range, setRange: setRangeBase, queryString } = useTimeRange(window.location.search);
  function setRange(next: Parameters<typeof setRangeBase>[0]) {
    setRangeBase(next);
    const sp = new URLSearchParams(window.location.search);
    if (next.mode === 'hours') {
      sp.set('hours', String(next.hours));
    } else {
      sp.delete('hours');
    }
    navigate('?' + sp.toString(), { replace: true });
  }
  const [datePickerOpen, setDatePickerOpen] = useState(false);
  const [maxStorageDays, setMaxStorageDays] = useState(7);
  const [data, setData] = useState<ParsedService[]>([]);
  const [summaries, setSummaries] = useState<ServiceSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());
  const [refreshTick, setRefreshTick] = useState(0);
  const lastFetchTsRef = useRef<number>(Date.now());
  const silentRefreshRef = useRef(false);
  const [testingAll, setTestingAll] = useState(false);
  const [syncAvailable, setSyncAvailable] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [serverCity, setServerCity] = useState<string>('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [statusFilter, setStatusFilter] = useState<'failed' | 'partial' | null>(() => {
    const s = new URLSearchParams(window.location.search).get('status');
    return s === 'failed' ? 'failed' : s === 'partial' ? 'partial' : null;
  });
  const [landscapes, setLandscapes] = useState<LandscapeConfig[]>([]);
  const [sites, setSites] = useState<SiteConfig[]>([]);
  const [activeLandscape, setActiveLandscape] = useState<string>(() => {
    const h = window.location.hash;
    return h.startsWith('#landscape-') ? decodeURIComponent(h.slice('#landscape-'.length)) : '';
  });

  useEffect(() => {
    fetch('/api/info')
      .then(r => r.json() as Promise<{ syncRemote: boolean; city?: string; sites?: SiteConfig[]; maxStorageDays?: number }>)
      .then(d => {
        setSyncAvailable(d.syncRemote);
        if (d.city && d.city !== 'unknown') setServerCity(d.city);
        if (d.sites) setSites(d.sites);
        if (d.maxStorageDays !== undefined) setMaxStorageDays(d.maxStorageDays);
      })
      .catch(() => null);
    fetch('/api/landscapes')
      .then(r => r.json() as Promise<LandscapeConfig[]>)
      .then(ls => {
        setLandscapes(ls);
        setActiveLandscape(prev => {
          if (prev && ls.some(l => l.name === prev)) return prev;
          return ls[0]?.name ?? '';
        });
      })
      .catch(() => null);
  }, []);

  useEffect(() => {
    const silent = silentRefreshRef.current;
    silentRefreshRef.current = false;
    if (!silent) setLoading(true);
    setError(null);
    fetch(`/api/overview?${queryString}`)
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<{ lastModified: number; services: ServiceWithHistory[] }>;
      })
      .then(({ lastModified, services }) => {
        lastFetchTsRef.current = lastModified;
        setData(services.map(svc => ({
          ...svc,
          history: svc.history.map(fn => parseFilename(fn) ?? { filename: fn + '.json', overallStatus: 200 as const }),
        })));
        setLastRefresh(new Date());
      })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
    fetch(`/api/service-summary?${queryString}`)
      .then(r => r.json() as Promise<ServiceSummary[]>)
      .then(d => setSummaries(d))
      .catch(() => null);
  }, [queryString, refreshTick]);

  const handleLiveUpdate = useCallback(() => {
    const since = lastFetchTsRef.current - 5_000;
    fetch(`/api/overview?since=${since}`)
      .then(r => r.json() as Promise<{ lastModified: number; services: ServiceWithHistory[] }>)
      .then(({ lastModified, services }) => {
        lastFetchTsRef.current = lastModified;
        const deltaData = services.map(svc => ({
          ...svc,
          history: svc.history.map(fn => parseFilename(fn) ?? { filename: fn + '.json', overallStatus: 200 as const }),
        }));
        setData(prev => prev.map(existing => {
          const dSvc = deltaData.find(d => d.name === existing.name);
          if (!dSvc || dSvc.history.length === 0) return existing;
          const toCanonical = (fn: string) => fn.replace('.starred.', '.');
          const incomingNames = new Set(dSvc.history.map(f => f.filename));
          const incomingCanonicals = new Set(dSvc.history.map(f => toCanonical(f.filename)));
          const kept = existing.history.filter(f =>
            !incomingNames.has(f.filename) && !incomingCanonicals.has(toCanonical(f.filename)),
          );
          return { ...existing, history: [...dSvc.history, ...kept] };
        }));
        setLastRefresh(new Date());
      })
      .catch(() => null);
    fetch(`/api/service-summary?${queryString}`)
      .then(r => r.json() as Promise<ServiceSummary[]>)
      .then(d => setSummaries(d))
      .catch(() => null);
  }, [queryString]);

  useLiveEvents(null, handleLiveUpdate);

  async function runSync() {
    setSyncing(true);
    try {
      await fetch('/api/sync', { method: 'POST' });
    } finally {
      setSyncing(false);
      silentRefreshRef.current = true;
      setRefreshTick(t => t + 1);
    }
  }

  function applyStatusFilter(next: 'failed' | 'partial' | null) {
    setStatusFilter(next);
    const sp = new URLSearchParams(window.location.search);
    if (next) sp.set('status', next);
    else sp.delete('status');
    const qs = sp.toString();
    navigate(window.location.pathname + (qs ? `?${qs}` : ''), { replace: true });
  }

  async function runAllTests() {
    setTestingAll(true);
    try {
      await Promise.all(
        data.map(svc =>
          fetch(`/api/check/${encodeURIComponent(svc.name)}`).catch(() => null),
        ),
      );
    } finally {
      setTestingAll(false);
      setRefreshTick(t => t + 1);
    }
  }

  const summaryMap = useMemo(
    () => Object.fromEntries(summaries.map(s => [s.name, s.rangeStatus])) as Record<string, ServiceSummary['rangeStatus']>,
    [summaries],
  );

  const endpointStatuses = data.flatMap(svc =>
    svc.endpoints.map((ep, ei) => {
      const epSlug = slugify(ep.name ?? '');
      const epFiles = svc.history.filter(f =>
        f.endpointSlug !== undefined ? f.endpointSlug === epSlug : f.endpointIndex === ei,
      );
      return getEndpointNodeStatus(epFiles);
    }),
  );
  const totalEndpoints = endpointStatuses.length;
  const healthyEndpoints = endpointStatuses.filter(st => st !== 'error').length;
  const anyCurrentlyFailing = summaries.some(s => s.rangeStatus === 'error');
  const anyImperfect = summaries.some(s => s.rangeStatus === 'warning');

  // Aggregate stats — raw endpoint files for check/response counts
  const allFiles = data.flatMap(s => s.history);
  const totalChecks = allFiles.length;
  const failedChecks = allFiles.filter(f => f.overallStatus === 500 || f.overallStatus === 503 || f.overallStatus === 504).length;
  const partiallyFailedChecks = allFiles.filter(f => f.overallStatus === 400).length;

  // Per-service + per-endpoint status for diagram coloring
  const serviceStatusMap = useMemo<Record<string, NodeStatus>>(() => {
    const map: Record<string, NodeStatus> = {};
    for (const [name, rs] of Object.entries(summaryMap)) {
      if (rs === 'error') map[name] = 'error';
      else if (rs === 'warning') map[name] = 'warn';
      else if (rs === 'ok') map[name] = 'ok';
    }
    // Endpoint-level nodes: keyed as "service.endpoint"
    for (const svc of data) {
      for (const ep of svc.endpoints) {
        if (!ep.name) continue;
        const epFiles = svc.history.filter(f => f.endpointSlug === slugify(ep.name!));
        const st = getEndpointNodeStatus(epFiles);
        if (st) map[`${svc.name}.${ep.name}`] = st;
      }
    }
    return map;
  }, [summaryMap, data]);

  const filteredData = useMemo(() => {
    if (!statusFilter) return data;
    const matchStatus = statusFilter === 'failed'
      ? (s: number) => s === 500 || s === 503 || s === 504
      : (s: number) => s === 400;
    return data.filter(svc =>
      svc.endpoints.some((ep, ei) => {
        const epSlug = slugify(ep.name ?? '');
        return svc.history.some(f =>
          (f.endpointSlug !== undefined ? f.endpointSlug === epSlug : f.endpointIndex === ei) &&
          matchStatus(f.overallStatus)
        );
      })
    );
  }, [data, statusFilter]);

  // Per-landscape availability badge
  function landscapeBadgeProps(landscapeName: string) {
    const svcs = data.filter(s => s.landscapes?.includes(landscapeName));
    if (svcs.length === 0) return { label: '—', cls: '' };
    const anyFail = svcs.some(s => summaryMap[s.name] === 'error');
    const anyWarn = svcs.some(s => summaryMap[s.name] === 'warning');
    const combinedRuns = svcs.flatMap(s => getServiceOverallHistory(s));
    const uptime = combinedRuns.length > 0
      ? combinedRuns.filter(h => h.overallStatus === 200 || h.overallStatus === 203).length / combinedRuns.length * 100
      : 100;
    const label = fmtUptime(uptime);
    if (anyFail) return { label, cls: 'border-red-600 text-red-400' };
    if (anyWarn) return { label, cls: 'border-yellow-600 text-yellow-400' };
    return { label, cls: 'border-green-600 text-green-400' };
  }

  function handleLandscapeChange(name: string) {
    setActiveLandscape(name);
    window.location.hash = `#landscape-${encodeURIComponent(name)}`;
  }

  const currentSite = sites.find(s => {
    try { return new URL(s.url).origin === window.location.origin; } catch { return false; }
  }) ?? null;
  const currentSiteUrl = currentSite?.url ?? '';

  const appTitle = currentSite?.name ?? (serverCity ? `${serverCity} - BTP Status` : 'BTP Status');

  useEffect(() => {
    document.title = appTitle;
  }, [appTitle]);

  function handleSiteSwitch(url: string) {
    if (url && url !== currentSiteUrl) window.location.replace(url);
  }

  function toServiceUrl(svcName: string, endpoint?: string): string {
    const params = new URLSearchParams();
    if (endpoint) params.set('endpoint', endpoint);
    if (statusFilter) params.set('status', statusFilter);
    params.set('from', statusFilter ? `/overview?status=${statusFilter}` : '/overview');
    return `/service/${encodeURIComponent(svcName)}?${params.toString()}`;
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Header */}
      <header className="border-b border-border sticky top-0 bg-background z-10">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <img src="/images/favicon-32x32.png" alt="" className="h-5 w-5" />
            <h1 className="text-base sm:text-lg font-semibold">{appTitle}</h1>
            {sites.length >= 2 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button className="text-muted-foreground hover:text-foreground transition-colors" title="Switch site">
                    <ChevronDown className="h-3.5 w-3.5" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  {sites.map(s => (
                    <DropdownMenuItem
                      key={s.url}
                      className={`text-xs cursor-pointer${s.url === currentSiteUrl ? ' font-semibold' : ''}`}
                      onSelect={() => handleSiteSwitch(s.url)}
                    >
                      {s.name}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            <a
              href="https://github.com/sap-pilot/btp-status/releases"
              target="_blank"
              rel="noopener noreferrer"
              title={`v${__APP_VERSION__}+${__COMMIT_HASH__} built at: ${new Date(__BUILD_DATE__).toLocaleString(undefined, { timeZoneName: 'short' })}`}
              className="text-xs text-muted-foreground font-mono hover:text-foreground transition-colors"
            >
              v{__APP_VERSION__}+{__COMMIT_HASH__}
            </a>
          </div>
          {/* Desktop controls */}
          <div className="hidden sm:flex items-center gap-3">
            <Badge
              variant={anyCurrentlyFailing ? 'destructive' : 'outline'}
              className={
                anyCurrentlyFailing ? '' :
                anyImperfect ? 'border-yellow-600 text-yellow-400' :
                'bg-green-600 hover:bg-green-600 border-green-600 text-white'
              }
              title={`${healthyEndpoints} out of ${totalEndpoints} endpoints are healthy (for yellow status — some previous check failed but latest was successful)`}
            >
              {healthyEndpoints}/{totalEndpoints} healthy
            </Badge>
            <Select
              value={range.mode === 'dateRange' ? '' : String(range.hours)}
              onValueChange={(v: string) => {
                if (v === 'range') { setDatePickerOpen(true); }
                else setRange({ mode: 'hours', hours: Number(v) });
              }}
            >
              <SelectTrigger className="w-36 h-8 text-xs">
                {range.mode === 'dateRange'
                  ? <span className="truncate">{fmtDateRange(range.fromDate, range.untilDate)}</span>
                  : <SelectValue />
                }
              </SelectTrigger>
              <SelectContent>
                {HOUR_OPTIONS.map(o => (
                  <SelectItem key={o.value} value={o.value} className="text-xs">
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {(!auth.enabled || auth.loggedIn) && (
              <button
                onClick={() => void runAllTests()}
                disabled={testingAll || data.length === 0}
                className="text-muted-foreground hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1 text-xs"
                title="Run health checks for all services"
              >
                <Zap className={`h-4 w-4 ${testingAll ? 'animate-pulse text-yellow-400' : ''}`} />
                {testingAll ? 'Running…' : 'Test all'}
              </button>
            )}
            {syncAvailable && (!auth.enabled || auth.loggedIn) && (
              <button
                onClick={() => void runSync()}
                disabled={syncing}
                className="text-muted-foreground hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed"
                title="Sync response files from remote"
              >
                <RefreshCw className={`h-4 w-4 ${syncing ? 'animate-spin text-blue-400' : ''}`} />
              </button>
            )}
            <button
              onClick={toggleTheme}
              className="text-muted-foreground hover:text-foreground"
              title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            >
              {theme === 'dark' ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
            </button>
            <AuthButton auth={auth} />
          </div>
          {/* Mobile hamburger */}
          <button
            className="sm:hidden text-muted-foreground hover:text-foreground p-1"
            onClick={() => setMenuOpen(o => !o)}
            title={menuOpen ? 'Close menu' : 'Open menu'}
          >
            {menuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>
        {/* Mobile dropdown menu */}
        {menuOpen && (
          <div className="sm:hidden border-t border-border bg-background">
            <div className="max-w-7xl mx-auto px-4 py-3 space-y-3">
              <div className="flex items-center justify-between">
                <Badge
                  variant={anyCurrentlyFailing ? 'destructive' : 'outline'}
                  className={
                    anyCurrentlyFailing ? '' :
                    anyImperfect ? 'border-yellow-600 text-yellow-400' :
                    'bg-green-600 hover:bg-green-600 border-green-600 text-white'
                  }
                  title={`${healthyEndpoints} out of ${totalEndpoints} endpoints are healthy (for yellow status — some previous check failed but latest was successful)`}
                >
                  {healthyEndpoints}/{totalEndpoints} healthy
                </Badge>
              </div>
              <div className="flex items-center gap-2">
                <Select
                  value={range.mode === 'dateRange' ? '' : String(range.hours)}
                  onValueChange={(v: string) => {
                    if (v === 'range') { setDatePickerOpen(true); setMenuOpen(false); }
                    else setRange({ mode: 'hours', hours: Number(v) });
                  }}
                >
                  <SelectTrigger className="flex-1 h-9 text-xs">
                    {range.mode === 'dateRange'
                      ? <span className="truncate">{fmtDateRange(range.fromDate, range.untilDate)}</span>
                      : <SelectValue />
                    }
                  </SelectTrigger>
                  <SelectContent>
                    {HOUR_OPTIONS.map(o => (
                      <SelectItem key={o.value} value={o.value} className="text-xs">{o.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {(!auth.enabled || auth.loggedIn) && (
                  <button
                    onClick={() => void runAllTests()}
                    disabled={testingAll || data.length === 0}
                    className="text-muted-foreground hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1 text-xs"
                    title="Run health checks for all services"
                  >
                    <Zap className={`h-4 w-4 ${testingAll ? 'animate-pulse text-yellow-400' : ''}`} />
                    {testingAll ? 'Running…' : 'Test all'}
                  </button>
                )}
                {syncAvailable && (!auth.enabled || auth.loggedIn) && (
                  <button
                    onClick={() => void runSync()}
                    disabled={syncing}
                    className="text-muted-foreground hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1 text-xs"
                    title="Sync response files from remote"
                  >
                    <RefreshCw className={`h-4 w-4 ${syncing ? 'animate-spin text-blue-400' : ''}`} />
                    {syncing ? 'Syncing…' : 'Sync'}
                  </button>
                )}
                <button
                  onClick={toggleTheme}
                  className="text-muted-foreground hover:text-foreground"
                  title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
                >
                  {theme === 'dark' ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
                </button>
                <AuthButton auth={auth} />
              </div>
            </div>
          </div>
        )}
      </header>

      <DateRangePicker
        open={datePickerOpen}
        onClose={() => setDatePickerOpen(false)}
        onApply={(from, until) => setRange({ mode: 'dateRange', fromDate: from, untilDate: until })}
        fromDate={range.mode === 'dateRange' ? range.fromDate : new Date(Date.now() - 86400000).toISOString().slice(0, 10)}
        untilDate={range.mode === 'dateRange' ? range.untilDate : new Date().toISOString().slice(0, 10)}
        maxStorageDays={maxStorageDays}
      />

      <main className="max-w-7xl mx-auto px-4 py-6 space-y-6">
        {loading && <span className="text-xs text-muted-foreground">Loading…</span>}

        {error && (
          <div className="flex items-center gap-2 text-destructive text-sm">
            <AlertCircle className="h-4 w-4" />
            {error}
          </div>
        )}

        {/* Aggregate stats */}
        {data.length > 0 && (
          <div className="stat-grid grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4">
            <Card
              className={`transition-colors${statusFilter ? ' cursor-pointer hover:bg-muted/50' : ''}`}
              onClick={statusFilter ? () => applyStatusFilter(null) : undefined}
              title={statusFilter ? 'Clear status filter' : undefined}
            >
              <CardContent className="pt-4 text-center">
                <div className="text-base sm:text-2xl font-bold">{totalChecks}</div>
                <div className="text-xs text-muted-foreground mt-1">Total Checks</div>
              </CardContent>
            </Card>
            <Card
              className={`transition-colors${failedChecks > 0 ? ' cursor-pointer hover:bg-muted/50' : ''}${statusFilter === 'failed' ? ' ring-1 ring-red-500/60' : ''}`}
              onClick={failedChecks > 0 ? () => applyStatusFilter(statusFilter === 'failed' ? null : 'failed') : undefined}
              title={failedChecks > 0 ? (statusFilter === 'failed' ? 'Clear filter' : 'Show completely failed only') : undefined}
            >
              <CardContent className="pt-4 text-center">
                <div className={`text-base sm:text-2xl font-bold ${failedChecks > 0 ? 'text-red-500' : ''}`}>{failedChecks}</div>
                <div className="text-xs text-muted-foreground mt-1">Completely Failed</div>
              </CardContent>
            </Card>
            <Card
              className={`transition-colors${partiallyFailedChecks > 0 ? ' cursor-pointer hover:bg-muted/50' : ''}${statusFilter === 'partial' ? ' ring-1 ring-orange-500/60' : ''}`}
              onClick={partiallyFailedChecks > 0 ? () => applyStatusFilter(statusFilter === 'partial' ? null : 'partial') : undefined}
              title={partiallyFailedChecks > 0 ? (statusFilter === 'partial' ? 'Clear filter' : 'Show partially failed only') : undefined}
            >
              <CardContent className="pt-4 text-center">
                <div className={`text-base sm:text-2xl font-bold ${partiallyFailedChecks > 0 ? 'text-orange-400' : ''}`}>{partiallyFailedChecks}</div>
                <div className="text-xs text-muted-foreground mt-1">Partially Failed</div>
              </CardContent>
            </Card>
            <Card
              className={`transition-colors${(!auth.enabled || auth.loggedIn) ? ' cursor-pointer hover:bg-muted/50' : ''}`}
              onClick={(!auth.enabled || auth.loggedIn) ? () => void runSync() : undefined}
              title={(!auth.enabled || auth.loggedIn) ? 'Click to sync' : undefined}
            >
              <CardContent className="pt-4 text-center">
                <div className={`text-base sm:text-2xl font-bold tabular-nums${syncing ? ' opacity-50' : ''}`}>
                  {lastRefresh.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}
                </div>
                <div className="text-xs text-muted-foreground mt-1">{syncing ? 'Syncing…' : 'Last Checked'}</div>
              </CardContent>
            </Card>
          </div>
        )}

        {/* Landscape tabs */}
        {landscapes.length > 0 && (
          <Card>
            <CardContent className="pt-4 pb-4">
              <Tabs value={activeLandscape} onValueChange={handleLandscapeChange}>
                <TabsList className="flex-wrap h-auto gap-1 mb-4">
                  {landscapes.map(ls => {
                    const badge = landscapeBadgeProps(ls.name);
                    return (
                      <TabsTrigger key={ls.name} value={ls.name} className="gap-2">
                        {ls.name}
                        {badge.label !== '—' && (
                          <Badge variant="outline" className={`text-xs ${badge.cls}`}>
                            {badge.label}
                          </Badge>
                        )}
                      </TabsTrigger>
                    );
                  })}
                </TabsList>
                {landscapes.map(ls => {
                  // Filter to only services belonging to this landscape
                  const lsStatuses: Record<string, NodeStatus> = {};
                  const lsNames = new Set<string>();
                  for (const svc of data) {
                    if (!svc.landscapes?.includes(ls.name)) continue;
                    lsNames.add(svc.name);
                    const st = serviceStatusMap[svc.name];
                    if (st) lsStatuses[svc.name] = st;
                    // Add per-endpoint nodes (service.endpoint format)
                    for (const ep of svc.endpoints) {
                      if (!ep.name) continue;
                      const nodeKey = `${svc.name}.${ep.name}`;
                      lsNames.add(nodeKey);
                      const epSt = serviceStatusMap[nodeKey];
                      if (epSt) lsStatuses[nodeKey] = epSt;
                    }
                  }
                  return (
                    <TabsContent key={ls.name} value={ls.name}>
                      <Suspense fallback={<div className="text-xs text-muted-foreground p-4 text-center">Loading diagram…</div>}>
                        <LandscapeDiagram
                          diagramText={ls.diagram}
                          serviceStatuses={lsStatuses}
                          serviceNames={lsNames}
                          isDark={theme === 'dark'}
                          returnUrl={`/overview#landscape-${encodeURIComponent(ls.name)}`}
                        />
                      </Suspense>
                    </TabsContent>
                  );
                })}
              </Tabs>
            </CardContent>
          </Card>
        )}

        {/* Per-service cards */}
        {filteredData.map(svc => {
          const rs = summaryMap[svc.name] ?? null;
          return (
            <Card key={svc.name}>
              <CardHeader className="pb-2">
                <div className="flex items-center gap-2">
                  <span
                    className={`w-2 h-2 rounded-full flex-shrink-0 ${
                      rs === 'ok' ? 'bg-green-500' :
                      rs === 'warning' ? 'bg-amber-400' :
                      rs === 'error' ? 'bg-red-500' :
                      'bg-gray-500'
                    }`}
                  />
                  <CardTitle className="text-sm font-medium">
                    <Link
                      to={toServiceUrl(svc.name)}
                      className="hover:text-primary transition-colors"
                    >
                      {svc.name}
                    </Link>
                  </CardTitle>
                  {svc.homepage && (
                    <a
                      href={svc.homepage}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={`Open ${svc.name} homepage`}
                      className="text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  )}
                </div>
              </CardHeader>
              <CardContent className="p-0">
                <table className={`w-full ${isMobile ? '' : 'table-fixed'}`}>
                  {!isMobile && (
                    <colgroup>
                      <col className="w-[170px]" />
                      <col />
                      <col className="w-[110px]" />
                    </colgroup>
                  )}
                  <tbody>
                    {svc.endpoints.map((ep, ei) => {
                      const epSlug = slugify(ep.name ?? '');
                      const epFiles = svc.history.filter(f =>
                        f.endpointSlug !== undefined ? f.endpointSlug === epSlug : f.endpointIndex === ei,
                      );
                      if (statusFilter === 'failed' && !epFiles.some(f => f.overallStatus === 500 || f.overallStatus === 503 || f.overallStatus === 504)) return null;
                      if (statusFilter === 'partial' && !epFiles.some(f => f.overallStatus === 400)) return null;
                      const epUptime = getUptimePct(epFiles);
                      const epNodeSt = getEndpointNodeStatus(epFiles);
                      const badgeCls = epFiles.length === 0 ? 'text-muted-foreground border-border' :
                        epNodeSt === 'error' ? 'border-red-600 text-red-400' :
                        epNodeSt === 'warn' || epUptime < 100 ? 'border-yellow-600 text-yellow-400' :
                        'border-green-600 text-green-400';
                      return (
                        <tr
                          key={ei}
                          className="border-b border-border last:border-0 hover:bg-muted/20 transition-colors"
                        >
                          <td className="px-4 pr-2 py-2 align-middle">
                            <div className="flex items-center gap-1.5 min-w-0">
                              <Link
                                to={toServiceUrl(svc.name, ep.name ?? ep.url)}
                                className="text-xs hover:underline truncate"
                              >
                                {ep.name ?? ep.url}
                              </Link>
                              {ep.url.startsWith('http') && (
                                <a
                                  href={ep.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="flex-shrink-0 text-muted-foreground hover:text-foreground"
                                  title={ep.url}
                                  onClick={e => e.stopPropagation()}
                                >
                                  <ExternalLink className="h-3 w-3" />
                                </a>
                              )}
                            </div>
                          </td>
                          {!isMobile && (
                            <td className="px-0 py-2 align-middle">
                              <StatusDots
                                history={epFiles}
                                maxDots={maxDots}
                                showUptime={false}
                                showAvg={false}
                                onDotClick={file => navigate(
                                  toServiceUrl(svc.name),
                                  { state: { autoOpenFilename: file.filename } },
                                )}
                              />
                            </td>
                          )}
                          <td className="px-2 py-2 align-middle">
                            <div className="flex justify-end">
                              <Badge variant="outline" className={`text-xs ${badgeCls}`}>
                                {epFiles.length > 0 ? `${fmtUptime(epUptime)} up` : 'no data'}
                              </Badge>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          );
        })}

        {!loading && data.length === 0 && !error && (
          <div className="text-center text-muted-foreground py-16">
            <img src="/images/favicon-32x32.png" alt="" className="h-10 w-10 mx-auto mb-3 opacity-30" />
            <p className="text-sm">No services configured.</p>
            <p className="text-xs mt-1">Create a config.json and restart the server.</p>
          </div>
        )}
      </main>
    </div>
  );
}
