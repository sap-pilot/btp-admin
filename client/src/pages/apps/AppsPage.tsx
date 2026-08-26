import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router';
import { PanelLeft, RefreshCw, Search, X } from 'lucide-react';
import { useSidebar } from '@/components/AppLayout';
import DateRangePicker from '@/components/DateRangePicker';
import { fmtDateRange } from '@/hooks/useTimeRange';
import type { SubaccountEntry } from '@/components/config/SubaccountsTable';
import type { TabEntry, TabSection } from '@/components/config/TabsTable';
import SubaccountAppsModal from './SubaccountAppsModal';

// ─── Types ────────────────────────────────────────────────────────────────────

interface StatsRow {
  timestamp:    number;
  startedApps:  number;
  stoppedApps:  number;
  sumStartedMB: number;
  sumStoppedMB: number;
}

type DurationMode =
  | { mode: 'days'; days: 1 | 2 | 3 | 7 }
  | { mode: 'dateRange'; fromDate: string; untilDate: string };

type ViewMode = 'all' | 'aod';

interface SseMsg {
  type:      string;
  current?:  number;
  total?:    number;
  region?:   string;
  error?:    boolean | string;
  allStats?: StatsRow | null;
  aodStats?: StatsRow | null;
}

interface AppTopEntry {
  guid:      string;
  name:      string;
  spaceName: string;
  memoryMB:  number;
}

interface SubaccountTopApps {
  region:         string;
  subdomain:      string;
  subaccountName: string;
  alias:          string;
  apps:           AppTopEntry[];
}

interface ScanProgress {
  type:     'progress' | 'done' | 'error';
  current?: number;
  total?:   number;
  region?:  string;
  error?:   string;
}

const VALID_DAYS = new Set([1, 2, 3, 7]);

// ─── URL helpers ──────────────────────────────────────────────────────────────

function parseDuration(search: string): DurationMode {
  const p    = new URLSearchParams(search);
  const from = p.get('from');
  const to   = p.get('to');
  if (from && to && /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return { mode: 'dateRange', fromDate: from, untilDate: to };
  }
  const d = Number(p.get('days'));
  if (VALID_DAYS.has(d)) return { mode: 'days', days: d as 1 | 2 | 3 | 7 };
  return { mode: 'days', days: 3 };
}

function buildSearch(dur: DurationMode): string {
  if (dur.mode === 'dateRange') return `?from=${dur.fromDate}&to=${dur.untilDate}`;
  return `?days=${dur.days}`;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtMB(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
}

function fmtTime(unixSecs: number): string {
  return new Date(unixSecs * 1000).toLocaleTimeString(undefined, {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function toYMD(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function durationToRange(dur: DurationMode): { fromSecs: number; toSecs: number } {
  const now = Math.floor(Date.now() / 1000);
  if (dur.mode === 'days') return { fromSecs: now - dur.days * 86400, toSecs: now };
  const [fy, fm, fd] = dur.fromDate.split('-').map(Number);
  const [uy, um, ud] = dur.untilDate.split('-').map(Number);
  return {
    fromSecs: Math.floor(new Date(fy!, fm! - 1, fd!, 0, 0, 0).getTime() / 1000),
    toSecs:   Math.floor(new Date(uy!, um! - 1, ud!, 23, 59, 59).getTime() / 1000),
  };
}

function csvIncludes(csv: string, id: string): boolean {
  return csv.split(',').map(s => s.trim()).includes(id);
}

// ─── SVG Chart ────────────────────────────────────────────────────────────────

function StatsChart({ rows, toSecs }: { rows: StatsRow[]; toSecs: number }) {
  const containerRef              = useRef<HTMLDivElement>(null);
  const [width, setWidth]         = useState(900);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      const w = entries[0]?.contentRect.width;
      if (w && w > 0) setWidth(Math.floor(w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const W   = width;
  const H   = 240;
  const pad = { t: 24, r: 24, b: 40, l: 72 };
  const cW  = W - pad.l - pad.r;
  const cH  = H - pad.t - pad.b;

  if (rows.length === 0) {
    return (
      <div ref={containerRef} className="flex items-center justify-center h-40 text-muted-foreground text-sm">
        No data for selected period
      </div>
    );
  }

  const effectiveFrom = rows[0]!.timestamp;
  const maxMB  = Math.max(...rows.flatMap(r => [r.sumStartedMB, r.sumStoppedMB]), 1);
  const xOf    = (ts: number) => pad.l + ((ts - effectiveFrom) / (toSecs - effectiveFrom)) * cW;
  const yOf    = (mb: number) => pad.t + cH - (mb / maxMB) * cH;
  const pathOf = (get: (r: StatsRow) => number) =>
    rows.map((r, i) => `${i === 0 ? 'M' : 'L'}${xOf(r.timestamp).toFixed(1)},${yOf(get(r)).toFixed(1)}`).join(' ');

  const yTicks = Array.from({ length: 5 }, (_, i) => (maxMB * i) / 4);
  const rangeSecs = toSecs - effectiveFrom;
  const xTicks = Array.from({ length: 5 }, (_, i) => {
    const ts    = effectiveFrom + (rangeSecs / 4) * i;
    const d     = new Date(ts * 1000);
    const label = rangeSecs <= 2 * 86400
      ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    return { ts, label };
  });

  return (
    <div ref={containerRef} className="w-full">
      <svg width={W} height={H}>
        {yTicks.map((mb, i) => (
          <line key={i} x1={pad.l} y1={yOf(mb).toFixed(1)} x2={pad.l + cW} y2={yOf(mb).toFixed(1)}
            stroke="currentColor" strokeOpacity={0.08} strokeWidth={1} />
        ))}
        <path d={pathOf(r => r.sumStartedMB)} fill="none" stroke="#3b82f6" strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />
        <path d={pathOf(r => r.sumStoppedMB)} fill="none" stroke="#f97316" strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />
        {yTicks.map((mb, i) => (
          <text key={i} x={pad.l - 8} y={yOf(mb).toFixed(1)} textAnchor="end" dominantBaseline="middle"
            fontSize={10} fill="currentColor" opacity={0.5}>{fmtMB(mb)}</text>
        ))}
        {xTicks.map(({ ts, label }) => (
          <text key={ts} x={xOf(ts).toFixed(1)} y={H - pad.b + 16} textAnchor="middle"
            fontSize={10} fill="currentColor" opacity={0.5}>{label}</text>
        ))}
        <line x1={pad.l} y1={pad.t} x2={pad.l} y2={pad.t + cH} stroke="currentColor" strokeOpacity={0.15} />
        <line x1={pad.l} y1={pad.t + cH} x2={pad.l + cW} y2={pad.t + cH} stroke="currentColor" strokeOpacity={0.15} />
        <circle cx={pad.l + 12} cy={pad.t - 8} r={4} fill="#3b82f6" />
        <text x={pad.l + 20} y={pad.t - 8} dominantBaseline="middle" fontSize={11} fill="currentColor" opacity={0.7}>Started MB</text>
        <circle cx={pad.l + 110} cy={pad.t - 8} r={4} fill="#f97316" />
        <text x={pad.l + 118} y={pad.t - 8} dominantBaseline="middle" fontSize={11} fill="currentColor" opacity={0.7}>Stopped MB</text>
      </svg>
    </div>
  );
}

// ─── Info Block ───────────────────────────────────────────────────────────────

function InfoBlock({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: string }) {
  return (
    <div className="rounded-lg border border-border bg-card text-center px-4 pt-4 pb-3 min-w-0">
      <div className={`text-base sm:text-2xl font-bold tabular-nums truncate ${accent ?? ''}`}>{value}</div>
      {sub && <div className="text-xs text-muted-foreground mt-0.5 truncate">{sub}</div>}
      <div className="text-xs text-muted-foreground mt-1">{label}</div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function AppsPage() {
  const { view: viewParam }  = useParams<{ view: string }>();
  const navigate             = useNavigate();
  const location             = useLocation();
  const { toggle }           = useSidebar();

  const viewMode: ViewMode = viewParam === 'aod' ? 'aod' : 'all';
  const duration            = parseDuration(location.search);
  const { fromSecs, toSecs } = durationToRange(duration);

  const [datePickerOpen, setDatePickerOpen] = useState(false);
  const [rows, setRows]                     = useState<StatsRow[]>([]);
  const [latest, setLatest]                 = useState<StatsRow | null>(null);
  const [isRefreshing, setIsRefreshing]     = useState(false);
  const [progress, setProgress]             = useState<ScanProgress | null>(null);
  const [loadingData, setLoadingData]       = useState(false);
  const autoHideRef                         = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [topApps, setTopApps]               = useState<SubaccountTopApps[]>([]);
  const [tabEntries, setTabEntries]         = useState<TabEntry[]>([]);
  const [saData, setSaData]                 = useState<SubaccountEntry[]>([]);
  const [activeTab, setActiveTab]           = useState('');

  const [searchInput, setSearchInput]         = useState('');
  const [committedSearch, setCommittedSearch] = useState('');
  const [isSearching, setIsSearching]         = useState(false);
  const [searchResults, setSearchResults]     = useState<SubaccountTopApps[] | null>(null);
  const [modalState, setModalState]           = useState<{ region: string; subdomain: string; guid: string; spaceName: string; appName: string } | null>(null);
  const savedPath                             = useRef<string>('');

  // ── Navigation helpers ────────────────────────────────────────────────────

  function navigateTo(view: ViewMode, dur: DurationMode) {
    navigate(`/apps/${view}${buildSearch(dur)}`, { replace: true });
  }

  // ── Top apps lookup map ───────────────────────────────────────────────────

  function makeTopAppsMap(data: SubaccountTopApps[]): Map<string, AppTopEntry[]> {
    const m = new Map<string, AppTopEntry[]>();
    for (const sa of data) m.set(`${sa.region}/${sa.subdomain}`, sa.apps);
    return m;
  }

  // ── Fetch stats data ──────────────────────────────────────────────────────

  const fetchTopApps = useCallback(async () => {
    try {
      const res  = await fetch('/api/aod/apps/top');
      const data = await res.json() as { ok: boolean; data: SubaccountTopApps[] };
      if (data.ok) setTopApps(data.data);
    } catch { /* ignore */ }
  }, []);

  const fetchStats = useCallback(async (from: number, to: number, mode: ViewMode) => {
    setLoadingData(true);
    try {
      const aodParam = mode === 'aod' ? '&aod=1' : '';
      const res  = await fetch(`/api/aod/apps/stats?from=${from}&to=${to}${aodParam}`);
      const data = await res.json() as { ok: boolean; data: StatsRow[]; latest: StatsRow | null };
      if (data.ok) { setRows(data.data); setLatest(data.latest); }
    } catch { /* ignore */ } finally {
      setLoadingData(false);
    }
  }, []);

  // ── Initial load ──────────────────────────────────────────────────────────

  useEffect(() => {
    void fetch('/api/aod/apps/status')
      .then(r => r.json() as Promise<{ ok: boolean; refreshing: boolean }>)
      .then(d => { if (d.ok) setIsRefreshing(d.refreshing); })
      .catch(() => {});

    void Promise.all([
      fetch('/api/config/tabs').then(r => r.json() as Promise<{ ok: boolean; data: TabEntry[] }>),
      fetch('/api/config/subaccounts').then(r => r.json() as Promise<{ ok: boolean; data: SubaccountEntry[] }>),
    ]).then(([tabs, sas]) => {
      if (tabs.ok) setTabEntries(tabs.data);
      if (sas.ok)  setSaData(sas.data);
    }).catch(() => {});

    void fetchTopApps();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Re-fetch on duration / viewMode change ────────────────────────────────

  useEffect(() => {
    void fetchStats(fromSecs, toSecs, viewMode);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromSecs, toSecs, viewMode]);

  // ── SSE ───────────────────────────────────────────────────────────────────

  useEffect(() => {
    const es = new EventSource('/api/events?aod=1');

    es.addEventListener('connected', () => {
      void fetch('/api/aod/apps/status')
        .then(r => r.json() as Promise<{ ok: boolean; refreshing: boolean }>)
        .then(d => {
          if (!d.ok || d.refreshing) return;
          setIsRefreshing(false);
          setProgress(prev => {
            if (prev?.type === 'progress') {
              void fetchStats(fromSecs, toSecs, viewMode);
              void fetchTopApps();
              return null;
            }
            return prev;
          });
        })
        .catch(() => {});
    });

    es.addEventListener('update', (e: MessageEvent) => {
      try {
        const msg = JSON.parse(e.data as string) as SseMsg;
        if (msg.type === 'refresh-start') {
          setIsRefreshing(true);
          if (autoHideRef.current) { clearTimeout(autoHideRef.current); autoHideRef.current = null; }
          setProgress({ type: 'progress', current: 0, total: 0 });
        } else if (msg.type === 'refresh-progress') {
          setProgress({ type: 'progress', current: msg.current ?? 0, total: msg.total ?? 1, region: msg.region });
        } else if (msg.type === 'refresh-done' || msg.type === 'refresh-error') {
          setIsRefreshing(false);
          if (msg.type === 'refresh-done') {
            setProgress(prev => ({ type: 'done', total: prev?.total ?? 0 }));
            const newLatest = viewMode === 'aod' ? (msg.aodStats ?? null) : (msg.allStats ?? null);
            if (newLatest) setLatest(newLatest);
            void fetchStats(fromSecs, toSecs, viewMode);
            void fetchTopApps();
          } else {
            setProgress({ type: 'error', error: typeof msg.error === 'string' ? msg.error : 'Scan failed' });
          }
          autoHideRef.current = setTimeout(() => setProgress(null), 5000);
        }
      } catch { /* ignore */ }
    });

    return () => es.close();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromSecs, toSecs, viewMode]);

  // ── Refresh ───────────────────────────────────────────────────────────────

  async function handleRefresh() {
    if (isRefreshing) return;
    if (autoHideRef.current) { clearTimeout(autoHideRef.current); autoHideRef.current = null; }
    try {
      const res  = await fetch('/api/aod/apps/refresh', { method: 'POST' });
      const data = await res.json() as { ok: boolean; started?: boolean };
      if (data.ok && data.started) { setIsRefreshing(true); setProgress({ type: 'progress', current: 0, total: 0 }); }
    } catch { /* ignore */ }
  }

  // ── Search ────────────────────────────────────────────────────────────────

  async function handleSearch(q: string) {
    const trimmed = q.trim();
    if (!trimmed) { clearSearch(); return; }
    setIsSearching(true);
    setCommittedSearch(trimmed);
    try {
      const res  = await fetch(`/api/aod/apps/search?q=${encodeURIComponent(trimmed)}`);
      const data = await res.json() as { ok: boolean; data: SubaccountTopApps[] };
      if (data.ok) setSearchResults(data.data);
    } catch { /* ignore */ } finally {
      setIsSearching(false);
    }
  }

  function clearSearch() {
    setSearchInput('');
    setSearchResults(null);
    setCommittedSearch('');
  }

  // ── Modal URL sync ────────────────────────────────────────────────────────

  function openModal(region: string, subdomain: string, guid: string, spaceName: string, appName: string) {
    savedPath.current = window.location.pathname + window.location.search;
    const url = `/apps/${encodeURIComponent(region)}/${encodeURIComponent(subdomain)}/${encodeURIComponent(spaceName)}/${encodeURIComponent(appName)}`;
    window.history.pushState({ modal: true }, '', url);
    setModalState({ region, subdomain, guid, spaceName, appName });
  }

  function closeModal() {
    if (savedPath.current) {
      window.history.replaceState(null, '', savedPath.current);
      savedPath.current = '';
    }
    setModalState(null);
  }

  // Handle browser back button while modal is open
  useEffect(() => {
    if (!modalState) return;
    const handler = () => setModalState(null);
    window.addEventListener('popstate', handler);
    return () => window.removeEventListener('popstate', handler);
  }, [modalState]);

  // ── Duration select ───────────────────────────────────────────────────────

  function handleDurationChange(v: string) {
    if (v === 'range') { setDatePickerOpen(true); return; }
    navigateTo(viewMode, { mode: 'days', days: Number(v) as 1 | 2 | 3 | 7 });
  }

  const durationSelectValue = duration.mode === 'dateRange' ? 'range' : String(duration.days);
  const durationLabel       = duration.mode === 'dateRange'
    ? fmtDateRange(duration.fromDate, duration.untilDate)
    : null;

  // ── Tab / group derivations ───────────────────────────────────────────────

  const allSas = saData.filter(sa => !sa.restricted);

  const isSearchMode   = searchResults !== null;
  const searchMap      = isSearchMode ? makeTopAppsMap(searchResults!) : null;
  const topAppsMap     = makeTopAppsMap(topApps);

  const visibleTabs = tabEntries.filter(te =>
    te.sections.some(s => s.type === 'subaccountGroup' && allSas.some(sa => csvIncludes(sa.groupIds, s.groupId))),
  );

  // In search mode, only show tabs that have at least one SA with matches
  const tabsWithMatches: Set<string> | null = isSearchMode
    ? new Set(visibleTabs
        .filter(te => te.sections
          .filter((s): s is Extract<TabSection, { type: 'subaccountGroup' }> => s.type === 'subaccountGroup')
          .some(grp => allSas
            .filter(sa => csvIncludes(sa.groupIds, grp.groupId))
            .some(sa => (searchMap!.get(`${sa.region}/${sa.subdomain}`)?.length ?? 0) > 0),
          ),
        )
        .map(te => te.tab))
    : null;

  const displayedTabs = tabsWithMatches ? visibleTabs.filter(te => tabsWithMatches.has(te.tab)) : visibleTabs;

  const activeTabEntry = displayedTabs.find(te => te.tab === activeTab) ?? displayedTabs[0];

  // Keep activeTab in sync when displayed tabs change
  useEffect(() => {
    if (displayedTabs.length > 0 && (!activeTab || !displayedTabs.some(te => te.tab === activeTab))) {
      setActiveTab(displayedTabs[0]!.tab);
    }
  }, [displayedTabs, activeTab]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Derived stats ──────────────────────────────────────────────────────────

  const totalMB   = (latest?.sumStartedMB ?? 0) + (latest?.sumStoppedMB ?? 0);
  const savingPct = totalMB > 0 ? ((latest?.sumStoppedMB ?? 0) / totalMB * 100).toFixed(1) : '—';

  const tabCls = (active: boolean) =>
    `px-4 py-2 text-sm transition-colors border-b-2 shrink-0 ${
      active
        ? 'border-primary text-foreground font-medium'
        : 'border-transparent text-muted-foreground hover:text-foreground'
    }`;

  // ── Modal subaccount list ──────────────────────────────────────────────────
  // Pass full SubaccountEntry so the modal can build cockpit links

  return (
    <div className="flex flex-col h-full min-h-0">

      {/* Header */}
      <div className="border-b border-border bg-background px-3 flex items-center gap-2 shrink-0 min-h-[52px]">
        <button onClick={toggle} className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors" title="Toggle sidebar">
          <PanelLeft className="h-4 w-4" />
        </button>
        <span className="text-sm font-semibold">Apps</span>
        <div className="ml-auto flex items-center gap-2">

          {/* Search box */}
          <div className="relative flex items-center">
            <Search className="absolute left-2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
            <input
              type="text"
              value={searchInput}
              onChange={e => setSearchInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') void handleSearch(searchInput); else if (e.key === 'Escape') clearSearch(); }}
              placeholder="Search apps…"
              className="h-8 pl-7 pr-7 rounded-md border border-input bg-background text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring w-48"
            />
            {(searchInput || committedSearch) && (
              <button onClick={clearSearch} className="absolute right-1.5 p-0.5 text-muted-foreground hover:text-foreground">
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          {/* Refresh button */}
          <button
            onClick={() => void handleRefresh()}
            disabled={isRefreshing}
            className="flex items-center gap-1.5 h-8 rounded-md border border-input bg-background px-3 text-sm text-foreground hover:bg-accent hover:text-accent-foreground disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />
            {isRefreshing ? 'Scanning…' : 'Refresh'}
          </button>

          {/* All apps / AOD apps toggle */}
          <div className="flex h-8 rounded-md border border-input overflow-hidden text-sm">
            <button
              onClick={() => navigateTo('all', duration)}
              className={`px-3 transition-colors ${viewMode === 'all' ? 'bg-primary text-primary-foreground' : 'bg-background text-foreground hover:bg-accent hover:text-accent-foreground'}`}
            >
              All apps
            </button>
            <button
              onClick={() => navigateTo('aod', duration)}
              className={`px-3 transition-colors border-l border-input ${viewMode === 'aod' ? 'bg-primary text-primary-foreground' : 'bg-background text-foreground hover:bg-accent hover:text-accent-foreground'}`}
            >
              AOD apps
            </button>
          </div>
        </div>
      </div>

      {/* Progress bar */}
      {progress && (() => {
        const isDone    = progress.type === 'done';
        const isError   = progress.type === 'error';
        const pct       = isDone ? 100 : (progress.total ?? 0) > 0 ? Math.round(((progress.current ?? 0) / progress.total!) * 100) : 0;
        const barColor  = isError ? 'bg-amber-500' : isDone ? 'bg-green-500' : 'bg-primary';
        const textColor = isError ? 'text-amber-600 dark:text-amber-400' : isDone ? 'text-green-600 dark:text-green-400' : 'text-foreground';
        const bgColor   = isError ? 'bg-amber-500/8' : isDone ? 'bg-green-500/8' : 'bg-muted/40';
        const msg       = isError
          ? (progress.error ?? 'Scan failed')
          : isDone
            ? `Scanned ${progress.total ?? 0} regions`
            : (progress.total ?? 0) > 0
              ? `Refreshing ${progress.current ?? 0} of ${progress.total} regions${progress.region ? `: ${progress.region}` : ''}`
              : 'Starting scan…';
        return (
          <div className={`relative shrink-0 border-b border-border ${bgColor}`}>
            <div className="h-1 w-full bg-transparent">
              <div className={`h-full transition-all duration-300 ${barColor}`} style={{ width: `${pct}%` }} />
            </div>
            <div className={`px-4 py-1.5 text-xs text-center pr-8 ${textColor}`}>{msg}</div>
            <button
              onClick={() => setProgress(null)}
              className="absolute top-1 right-1 p-0.5 rounded text-muted-foreground/60 hover:text-foreground hover:bg-black/10 dark:hover:bg-white/10 transition-colors"
              title="Dismiss"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })()}

      {/* Search results banner */}
      {isSearchMode && (
        <div className="shrink-0 border-b border-border bg-muted/20 px-4 py-2 flex items-center gap-2 text-xs">
          {isSearching
            ? <span className="text-muted-foreground">Searching for "{committedSearch}"…</span>
            : <span className="text-muted-foreground">
                Results for <span className="font-medium text-foreground">"{committedSearch}"</span>
                {searchResults && searchResults.length > 0
                  ? ` — ${searchResults.reduce((s, sa) => s + sa.apps.length, 0)} app(s) across ${searchResults.length} subaccount(s)`
                  : ' — no matches'
                }
              </span>
          }
          <button
            onClick={clearSearch}
            className="ml-auto inline-flex items-center gap-1 px-2 py-0.5 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          >
            <X className="h-3 w-3" /> Clear
          </button>
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-auto min-h-0 p-6 space-y-6">

        {/* Info blocks */}
        <div className={`grid gap-3 sm:gap-4 ${viewMode === 'aod' ? 'grid-cols-2 sm:grid-cols-4' : 'grid-cols-2 sm:grid-cols-3'}`}>
          <InfoBlock
            label={latest ? `Started Apps: ${latest.startedApps}` : 'Started Apps'}
            value={latest ? fmtMB(latest.sumStartedMB) : '—'}
            accent="text-blue-500"
          />
          <InfoBlock
            label={latest ? `Stopped Apps: ${latest.stoppedApps}` : 'Stopped Apps'}
            value={latest ? fmtMB(latest.sumStoppedMB) : '—'}
            accent="text-orange-500"
          />
          {viewMode === 'aod' && (
            <InfoBlock
              label="Memory Saving"
              value={`${savingPct}%`}
              sub={latest ? `${fmtMB(latest.sumStoppedMB)} idle / ${fmtMB(totalMB)} total` : undefined}
              accent="text-emerald-500"
            />
          )}
          <InfoBlock
            label="Last Checked"
            value={latest ? fmtTime(latest.timestamp) : '—'}
          />
        </div>

        {/* Chart */}
        <div className="rounded-lg border border-border bg-card px-5 py-4 min-h-0">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm font-medium text-foreground">Memory Over Time</span>
            <div className="flex items-center gap-2">
              {loadingData && <span className="text-xs text-muted-foreground">Loading…</span>}
              <select
                value={durationSelectValue}
                onChange={e => handleDurationChange(e.target.value)}
                className="h-7 rounded-md border border-input bg-background px-2 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="1">1 Day</option>
                <option value="2">2 Days</option>
                <option value="3">3 Days</option>
                <option value="7">7 Days</option>
                {duration.mode === 'dateRange'
                  ? <option value="range">{durationLabel}</option>
                  : <option value="range">Custom Range…</option>
                }
              </select>
            </div>
          </div>
          <StatsChart rows={rows} toSecs={toSecs} />
        </div>

        {/* Tab bar — below the chart, above the groups */}
        {displayedTabs.length > 1 && (
          <div className="flex items-stretch border-b border-border overflow-x-auto">
            {displayedTabs.map(te => (
              <button key={te.tab} className={tabCls(te === activeTabEntry)} onClick={() => setActiveTab(te.tab)}>
                {te.tab}
              </button>
            ))}
          </div>
        )}

        {/* Subaccount groups (tabs → groups → subaccounts table) */}
        {visibleTabs.length === 0 && saData.length === 0 && (
          <div className="text-xs text-muted-foreground text-center py-8">
            Loading subaccounts…
          </div>
        )}

        {activeTabEntry?.sections
          .filter((s): s is Extract<TabSection, { type: 'subaccountGroup' }> => s.type === 'subaccountGroup')
          .map(grp => {
            const grpSas = allSas
              .filter(sa => csvIncludes(sa.groupIds, grp.groupId))
              .sort((a, b) => a.pos - b.pos);
            if (grpSas.length === 0) return null;

            // In search mode, filter columns to SAs with matches
            const displayCols = isSearchMode
              ? grpSas.filter(sa => (searchMap!.get(`${sa.region}/${sa.subdomain}`)?.length ?? 0) > 0)
              : grpSas;
            if (isSearchMode && displayCols.length === 0) return null;

            const rowCount = isSearchMode
              ? Math.max(...displayCols.map(sa => searchMap!.get(`${sa.region}/${sa.subdomain}`)?.length ?? 0), 0)
              : 10;

            return (
              <div key={grp.groupId} className="space-y-1.5">
                <div className="px-1">
                  <span className="text-xs font-semibold text-foreground">{grp.title ?? grp.groupId}</span>
                </div>
                <div className="border border-border rounded-md overflow-hidden">
                  <div className="overflow-x-auto">
                    <table className="w-full border-collapse text-sm" style={{ tableLayout: 'auto' }}>
                      <thead>
                        <tr className="bg-muted/30">
                          {displayCols.map(sa => (
                            <th
                              key={sa.subaccountId}
                              colSpan={2}
                              className="text-center text-xs font-medium px-3 py-2 min-w-[260px] border-l border-b border-border text-muted-foreground first:border-l-0"
                            >
                              <div className="flex flex-col gap-0.5 items-center">
                                <span>{sa.alias || sa.subaccountName}</span>
                                <span className="text-[10px] font-normal font-mono text-muted-foreground/60 leading-tight">{sa.subdomain}</span>
                              </div>
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {Array.from({ length: rowCount }, (_, i) => (
                          <tr key={i} className="hover:bg-muted/20">
                            {displayCols.map(sa => {
                              const key  = `${sa.region}/${sa.subdomain}`;
                              const apps = isSearchMode ? (searchMap!.get(key) ?? []) : (topAppsMap.get(key) ?? []);
                              const app  = apps[i];
                              return (
                                <Fragment key={sa.subaccountId}>
                                  <td className="px-3 py-1 text-xs border-b border-border border-l first:border-l-0 max-w-[200px]">
                                    {app
                                      ? <button
                                          className="truncate block w-full text-left hover:text-primary transition-colors"
                                          title={`${app.name} (${app.spaceName})`}
                                          onClick={() => openModal(sa.region, sa.subdomain, app.guid, app.spaceName, app.name)}
                                        >
                                          {app.name}
                                          <span className="text-muted-foreground/50 ml-1">({app.spaceName})</span>
                                        </button>
                                      : <span className="text-muted-foreground/30">—</span>
                                    }
                                  </td>
                                  <td className="px-2 py-1 text-[11px] border-b border-border text-muted-foreground whitespace-nowrap tabular-nums w-[72px]">
                                    {app ? fmtMB(app.memoryMB) : ''}
                                  </td>
                                </Fragment>
                              );
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            );
          })}
      </div>

      {/* Subaccount apps modal */}
      {modalState && (
        <SubaccountAppsModal
          initialRegion={modalState.region}
          initialSubdomain={modalState.subdomain}
          initialGuid={modalState.guid}
          allSubaccounts={allSas}
          onClose={closeModal}
        />
      )}

      {/* Date range picker */}
      <DateRangePicker
        open={datePickerOpen}
        onClose={() => setDatePickerOpen(false)}
        onApply={(from, until) => navigateTo(viewMode, { mode: 'dateRange', fromDate: from, untilDate: until })}
        fromDate={duration.mode === 'dateRange' ? duration.fromDate : toYMD(new Date(Date.now() - 86400000))}
        untilDate={duration.mode === 'dateRange' ? duration.untilDate : toYMD(new Date())}
        maxStorageDays={3650}
      />
    </div>
  );
}
