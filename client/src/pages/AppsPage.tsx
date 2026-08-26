import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
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

type DurationMode = { mode: 'days'; days: 1 | 2 | 3 | 7 } | { mode: 'dateRange'; fromDate: string; untilDate: string };

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtMB(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
}

function fmtTime(unixSecs: number): string {
  return new Date(unixSecs * 1000).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function toYMD(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function durationToRange(mode: DurationMode): { fromSecs: number; toSecs: number } {
  const now = Math.floor(Date.now() / 1000);
  if (mode.mode === 'days') {
    return { fromSecs: now - mode.days * 86400, toSecs: now };
  }
  const [fy, fm, fd] = mode.fromDate.split('-').map(Number);
  const [uy, um, ud] = mode.untilDate.split('-').map(Number);
  return {
    fromSecs: Math.floor(new Date(fy, fm - 1, fd, 0, 0, 0).getTime() / 1000),
    toSecs:   Math.floor(new Date(uy, um - 1, ud, 23, 59, 59).getTime() / 1000),
  };
}

// ─── SVG Chart ────────────────────────────────────────────────────────────────

function StatsChart({ rows, fromSecs, toSecs }: { rows: StatsRow[]; fromSecs: number; toSecs: number }) {
  const W = 900, H = 240;
  const pad = { t: 24, r: 24, b: 40, l: 72 };
  const cW = W - pad.l - pad.r;
  const cH = H - pad.t - pad.b;

  if (rows.length === 0) {
    return (
      <div className="flex items-center justify-center h-40 text-muted-foreground text-sm">
        No data for selected period
      </div>
    );
  }

  const maxMB = Math.max(...rows.flatMap(r => [r.sumStartedMB, r.sumStoppedMB]), 1);
  const xOf   = (ts: number) => pad.l + ((ts - fromSecs) / (toSecs - fromSecs)) * cW;
  const yOf   = (mb: number) => pad.t + cH - (mb / maxMB) * cH;

  const pathOf = (getter: (r: StatsRow) => number) =>
    rows.map((r, i) => `${i === 0 ? 'M' : 'L'}${xOf(r.timestamp).toFixed(1)},${yOf(getter(r)).toFixed(1)}`).join(' ');

  // 5 Y ticks
  const yTicks = Array.from({ length: 5 }, (_, i) => (maxMB * i) / 4);

  // X ticks: ~5 evenly spaced
  const rangeSecs = toSecs - fromSecs;
  const xTickCount = 5;
  const xTicks = Array.from({ length: xTickCount }, (_, i) => {
    const ts = fromSecs + (rangeSecs / (xTickCount - 1)) * i;
    const d  = new Date(ts * 1000);
    let label: string;
    if (rangeSecs <= 2 * 86400) {
      label = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    } else {
      label = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    }
    return { ts, label };
  });

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" style={{ maxHeight: 280 }}>
      {/* grid lines */}
      {yTicks.map((mb, i) => (
        <line key={i} x1={pad.l} y1={yOf(mb).toFixed(1)} x2={pad.l + cW} y2={yOf(mb).toFixed(1)}
          stroke="currentColor" strokeOpacity={0.08} strokeWidth={1} />
      ))}

      {/* started line (blue) */}
      <path d={pathOf(r => r.sumStartedMB)} fill="none" stroke="#3b82f6" strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />
      {/* stopped line (orange) */}
      <path d={pathOf(r => r.sumStoppedMB)} fill="none" stroke="#f97316" strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />

      {/* Y axis labels */}
      {yTicks.map((mb, i) => (
        <text key={i} x={pad.l - 8} y={yOf(mb).toFixed(1)} textAnchor="end" dominantBaseline="middle"
          fontSize={10} fill="currentColor" opacity={0.5}>
          {fmtMB(mb)}
        </text>
      ))}

      {/* X axis labels */}
      {xTicks.map(({ ts, label }) => (
        <text key={ts} x={xOf(ts).toFixed(1)} y={H - pad.b + 16} textAnchor="middle"
          fontSize={10} fill="currentColor" opacity={0.5}>
          {label}
        </text>
      ))}

      {/* axes */}
      <line x1={pad.l} y1={pad.t} x2={pad.l} y2={pad.t + cH} stroke="currentColor" strokeOpacity={0.15} />
      <line x1={pad.l} y1={pad.t + cH} x2={pad.l + cW} y2={pad.t + cH} stroke="currentColor" strokeOpacity={0.15} />

      {/* legend */}
      <circle cx={pad.l + 12} cy={pad.t - 8} r={4} fill="#3b82f6" />
      <text x={pad.l + 20} y={pad.t - 8} dominantBaseline="middle" fontSize={11} fill="currentColor" opacity={0.7}>
        Started MB
      </text>
      <circle cx={pad.l + 110} cy={pad.t - 8} r={4} fill="#f97316" />
      <text x={pad.l + 118} y={pad.t - 8} dominantBaseline="middle" fontSize={11} fill="currentColor" opacity={0.7}>
        Stopped MB
      </text>
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
  const [duration, setDuration]         = useState<DurationMode>({ mode: 'days', days: 1 });
  const [datePickerOpen, setDatePickerOpen] = useState(false);
  const [rows, setRows]                 = useState<StatsRow[]>([]);
  const [latest, setLatest]             = useState<StatsRow | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [loadingData, setLoadingData]   = useState(false);
  const esRef = useRef<EventSource | null>(null);

  const { fromSecs, toSecs } = durationToRange(duration);

  // ── Fetch stats data ──────────────────────────────────────────────────────

  const fetchStats = useCallback(async (from: number, to: number) => {
    setLoadingData(true);
    try {
      const res  = await fetch(`/api/aod/apps/stats?from=${from}&to=${to}`);
      const data = await res.json() as { ok: boolean; data: StatsRow[]; latest: StatsRow | null };
      if (data.ok) { setRows(data.data); setLatest(data.latest); }
    } catch { /* ignore */ } finally {
      setLoadingData(false);
    }
  }, []);

  // ── Initial load (status + stats) ────────────────────────────────────────

  useEffect(() => {
    void fetch('/api/aod/apps/status')
      .then(r => r.json() as Promise<{ ok: boolean; refreshing: boolean }>)
      .then(d => { if (d.ok) setIsRefreshing(d.refreshing); })
      .catch(() => {});
    void fetchStats(fromSecs, toSecs);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Re-fetch when duration changes ───────────────────────────────────────

  useEffect(() => {
    void fetchStats(fromSecs, toSecs);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromSecs, toSecs]);

  // ── SSE ───────────────────────────────────────────────────────────────────

  useEffect(() => {
    const es = new EventSource('/api/events?aod=1');
    esRef.current = es;

    es.addEventListener('update', (e: MessageEvent) => {
      try {
        const msg = JSON.parse(e.data as string) as { type: string; stats?: StatsRow | null };
        if (msg.type === 'refresh-start') {
          setIsRefreshing(true);
        } else if (msg.type === 'refresh-done' || msg.type === 'refresh-error') {
          setIsRefreshing(false);
          if (msg.type === 'refresh-done' && msg.stats) {
            setLatest(msg.stats);
            void fetchStats(fromSecs, toSecs);
          }
        }
      } catch { /* ignore */ }
    });

    return () => { es.close(); esRef.current = null; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromSecs, toSecs]);

  // ── Refresh ───────────────────────────────────────────────────────────────

  async function handleRefresh() {
    if (isRefreshing) return;
    try {
      const res  = await fetch('/api/aod/apps/refresh', { method: 'POST' });
      const data = await res.json() as { ok: boolean; started?: boolean };
      if (data.ok && data.started) setIsRefreshing(true);
    } catch { /* ignore */ }
  }

  // ── Duration select ───────────────────────────────────────────────────────

  function handleDurationChange(v: string) {
    if (v === 'range') { setDatePickerOpen(true); return; }
    const days = Number(v) as 1 | 2 | 3 | 7;
    setDuration({ mode: 'days', days });
  }

  const durationLabel = duration.mode === 'dateRange'
    ? fmtDateRange(duration.fromDate, duration.untilDate)
    : null;

  // ── Derived stats ──────────────────────────────────────────────────────────

  const totalMB   = (latest?.sumStartedMB ?? 0) + (latest?.sumStoppedMB ?? 0);
  const savingPct = totalMB > 0 ? ((latest?.sumStoppedMB ?? 0) / totalMB * 100).toFixed(1) : '—';

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 border-b border-border px-6 min-h-[52px] shrink-0">
        <h1 className="text-sm font-semibold">Apps</h1>
        <div className="flex items-center gap-2">
          {/* Duration select */}
          <select
            value={duration.mode === 'dateRange' ? 'range' : String(duration.days)}
            onChange={e => handleDurationChange(e.target.value)}
            className="h-8 rounded-md border border-input bg-background px-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
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

          {/* Refresh button */}
          <button
            onClick={() => void handleRefresh()}
            disabled={isRefreshing}
            className="flex items-center gap-1.5 h-8 rounded-md border border-input bg-background px-3 text-sm text-foreground hover:bg-accent hover:text-accent-foreground disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />
            {isRefreshing ? 'Scanning…' : 'Refresh'}
          </button>
        </div>
      </div>

      {/* Progress bar */}
      {isRefreshing && (
        <div className="h-0.5 bg-border shrink-0 overflow-hidden relative">
          <div className="absolute inset-y-0 bg-primary animate-pulse" style={{ left: '0%', width: '60%' }} />
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-auto min-h-0 p-6 flex flex-col gap-6">

        {/* Info blocks */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
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
          <InfoBlock
            label="Memory Saving"
            value={`${savingPct}%`}
            sub={latest ? `${fmtMB(latest.sumStoppedMB)} idle / ${fmtMB(totalMB)} total` : undefined}
            accent="text-emerald-500"
          />
          <InfoBlock
            label="Last Checked"
            value={latest ? fmtTime(latest.timestamp) : '—'}
          />
        </div>

        {/* Chart */}
        <div className="rounded-lg border border-border bg-card px-5 py-4 min-h-0">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm font-medium text-foreground">Memory Over Time</span>
            {loadingData && <span className="text-xs text-muted-foreground">Loading…</span>}
          </div>
          <StatsChart rows={rows} fromSecs={fromSecs} toSecs={toSecs} />
        </div>
      </div>

      {/* Date range picker */}
      <DateRangePicker
        open={datePickerOpen}
        onClose={() => setDatePickerOpen(false)}
        onApply={(from, until) => setDuration({ mode: 'dateRange', fromDate: from, untilDate: until })}
        fromDate={duration.mode === 'dateRange' ? duration.fromDate : toYMD(new Date(Date.now() - 86400000))}
        untilDate={duration.mode === 'dateRange' ? duration.untilDate : toYMD(new Date())}
        maxStorageDays={3650}
      />
    </div>
  );
}
