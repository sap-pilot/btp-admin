import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router';
import { PanelLeft, RefreshCw, X } from 'lucide-react';
import { useSidebar } from '@/components/AppLayout';
import DateRangePicker from '@/components/DateRangePicker';
import { fmtDateRange } from '@/hooks/useTimeRange';

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
    fromSecs: Math.floor(new Date(fy, fm - 1, fd, 0, 0, 0).getTime() / 1000),
    toSecs:   Math.floor(new Date(uy, um - 1, ud, 23, 59, 59).getTime() / 1000),
  };
}

// ─── SVG Chart ────────────────────────────────────────────────────────────────

function StatsChart({ rows, toSecs }: { rows: StatsRow[]; toSecs: number }) {
  const W = 900, H = 240;
  const pad = { t: 24, r: 24, b: 40, l: 72 };
  const cW  = W - pad.l - pad.r;
  const cH  = H - pad.t - pad.b;

  if (rows.length === 0) {
    return (
      <div className="flex items-center justify-center h-40 text-muted-foreground text-sm">
        No data for selected period
      </div>
    );
  }

  // X axis starts from first available data point within the range
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
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" style={{ maxHeight: 280 }}>
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
  );
}

// ─── Info Block ───────────────────────────────────────────────────────────────

function InfoBlock({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-border bg-card px-5 py-4 min-w-0">
      <span className="text-xs text-muted-foreground font-medium uppercase tracking-wide">{label}</span>
      <span className={`text-2xl font-semibold tabular-nums truncate ${accent ?? ''}`}>{value}</span>
      {sub && <span className="text-xs text-muted-foreground">{sub}</span>}
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

  // ── Navigation helpers ────────────────────────────────────────────────────

  function navigateTo(view: ViewMode, dur: DurationMode) {
    navigate(`/apps/${view}${buildSearch(dur)}`, { replace: true });
  }

  // ── Fetch stats data ──────────────────────────────────────────────────────

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

    // On every SSE connect/reconnect, re-sync state in case refresh-done was missed
    // (scan ran before we connected, or we were briefly disconnected)
    es.addEventListener('connected', () => {
      void fetch('/api/aod/apps/status')
        .then(r => r.json() as Promise<{ ok: boolean; refreshing: boolean }>)
        .then(d => {
          if (!d.ok || d.refreshing) return;
          setIsRefreshing(false);
          setProgress(prev => {
            if (prev?.type === 'progress') {
              void fetchStats(fromSecs, toSecs, viewMode);
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

  // ── Duration select ───────────────────────────────────────────────────────

  function handleDurationChange(v: string) {
    if (v === 'range') { setDatePickerOpen(true); return; }
    navigateTo(viewMode, { mode: 'days', days: Number(v) as 1 | 2 | 3 | 7 });
  }

  const durationSelectValue = duration.mode === 'dateRange' ? 'range' : String(duration.days);
  const durationLabel       = duration.mode === 'dateRange'
    ? fmtDateRange(duration.fromDate, duration.untilDate)
    : null;

  // ── Derived stats ──────────────────────────────────────────────────────────

  const totalMB   = (latest?.sumStartedMB ?? 0) + (latest?.sumStoppedMB ?? 0);
  const savingPct = totalMB > 0 ? ((latest?.sumStoppedMB ?? 0) / totalMB * 100).toFixed(1) : '—';

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="border-b border-border bg-background px-3 flex items-center gap-2 shrink-0 min-h-[52px]">
        <button onClick={toggle} className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors" title="Toggle sidebar">
          <PanelLeft className="h-4 w-4" />
        </button>
        <span className="text-sm font-semibold">Apps</span>
        <div className="ml-auto flex items-center gap-2">
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

      {/* Content */}
      <div className="flex-1 overflow-auto min-h-0 p-6 flex flex-col gap-6">

        {/* Info blocks */}
        <div className={`grid gap-4 ${viewMode === 'aod' ? 'grid-cols-2 md:grid-cols-4' : 'grid-cols-2 md:grid-cols-3'}`}>
          <InfoBlock
            label="Started Apps"
            value={latest ? String(latest.startedApps) : '—'}
            sub={latest ? fmtMB(latest.sumStartedMB) : undefined}
            accent="text-blue-500"
          />
          <InfoBlock
            label="Stopped Apps"
            value={latest ? String(latest.stoppedApps) : '—'}
            sub={latest ? fmtMB(latest.sumStoppedMB) : undefined}
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
      </div>

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
