import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router';
import { Loader2, PanelLeft, RefreshCw, ScrollText, Search, X } from 'lucide-react';
import { useSidebar } from '@/components/AppLayout';
import SubaccountModal from '@/components/SubaccountModal';
import DateRangePicker from '@/components/DateRangePicker';
import type { SubaccountEntry } from '@/components/config/SubaccountsTable';
import type { CockpitMenuItem } from '@/components/home/HomepageContent';

// ─── Types ────────────────────────────────────────────────────────────────────

interface AuditHourStat {
  hourKey:      string;
  region:       string;
  subdomain:    string;
  dataAccess:   number;
  security:     number;
  config:       number;
  modification: number;
  other:        number;
}

interface ChartPoint {
  hourKey:      string;
  dataAccess:   number;
  security:     number;
  config:       number;
  modification: number;
  other:        number;
}

interface SaBarEntry {
  alias:      string;
  region:     string;
  subdomain:  string;
  da:         number;
  se:         number;
  cfg:        number;
  dm:         number;
  other:      number;
  total:      number;
  sizeBytes?: number;
}

interface AuditRecord {
  uuid?:     string;
  time:      string;
  category:  string;
  message:   unknown;
  [key: string]: unknown;
}

interface SubaccountLatest {
  region:    string;
  subdomain: string;
  alias:     string;
  entries:   AuditRecord[];
}

type ProgressState =
  | { type: 'running'; current: number; total: number; alias: string; phase: string; page?: number; lastTime?: string }
  | { type: 'done';    warnings: string[] }
  | { type: 'error';   error: string; warnings: string[] };

// ─── Helpers ──────────────────────────────────────────────────────────────────

const PREVIEW_SKIP = new Set(['uuid', 'time', 'msgId', 'correlationId']);

function previewMessage(msg: unknown): string {
  let obj: unknown = msg;
  if (typeof obj === 'string') {
    const str = obj;
    try { obj = JSON.parse(str); } catch { return str; }
  }
  if (obj !== null && typeof obj === 'object' && !Array.isArray(obj)) {
    const filtered = Object.fromEntries(
      Object.entries(obj as Record<string, unknown>).filter(([k]) => !PREVIEW_SKIP.has(k))
    );
    return JSON.stringify(filtered);
  }
  return typeof obj === 'string' ? obj : JSON.stringify(obj);
}

function fullDetail(r: AuditRecord): string {
  let msg: unknown = r.message;
  if (typeof msg === 'string') { try { msg = JSON.parse(msg); } catch { /* keep as string */ } }
  return JSON.stringify({ ...r, message: msg }, null, 2);
}

function categoryColor(cat: string): string {
  switch (cat) {
    case 'audit.data-access':       return 'text-blue-600 dark:text-blue-400';
    case 'audit.security-events':   return 'text-amber-600 dark:text-amber-400';
    case 'audit.configuration':     return 'text-purple-600 dark:text-purple-400';
    case 'audit.data-modification': return 'text-green-600 dark:text-green-400';
    default:                        return 'text-slate-600 dark:text-slate-400';
  }
}

function splitKeywords(kw: string): string[] {
  return kw.trim().split(/\s+/).filter(Boolean);
}

function formatBytes(b: number): string {
  if (b >= 1_073_741_824) return `${(b / 1_073_741_824).toFixed(1)} GB`;
  if (b >= 1_048_576)     return `${(b / 1_048_576).toFixed(1)} MB`;
  if (b >= 1_024)         return `${(b / 1_024).toFixed(0)} KB`;
  return `${b} B`;
}

function HighlightText({ text, keywords }: { text: string; keywords: string[] }) {
  if (!keywords.length) return <>{text}</>;
  const escaped = keywords.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(`(${escaped.join('|')})`, 'gi');
  const parts = text.split(re);
  const lcKws = new Set(keywords.map(k => k.toLowerCase()));
  return (
    <>
      {parts.map((part, i) =>
        lcKws.has(part.toLowerCase())
          ? <mark key={i} className="bg-yellow-200/80 dark:bg-yellow-700/50 text-inherit rounded-sm px-px">{part}</mark>
          : <span key={i}>{part}</span>
      )}
    </>
  );
}

// ─── Series definitions ───────────────────────────────────────────────────────

const SERIES = [
  { key: 'dataAccess',   label: 'Data Access',    color: '#3b82f6', cat: 'data-access'      },
  { key: 'security',     label: 'Security Events', color: '#f59e0b', cat: 'security-events'  },
  { key: 'config',       label: 'Configuration',  color: '#a855f7', cat: 'configuration'     },
  { key: 'modification', label: 'Modification',   color: '#22c55e', cat: 'data-modification' },
  { key: 'other',        label: 'Other',          color: '#64748b', cat: 'other'             },
] as const;

const ALL_OVERVIEW_CATS = new Set(SERIES.map(s => s.cat));

// ─── Overview stacked area chart ─────────────────────────────────────────────

function OverviewAuditChart({ points, selectedCats, from, to, onSelect, onToggleSeries }: {
  points:         ChartPoint[];
  selectedCats:   Set<string>;
  from:           string;
  to:             string;
  onSelect:       (from: string, to: string) => void;
  onToggleSeries: (catKey: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth]       = useState(900);
  const [dragAnchor, setDragAnchor] = useState<number | null>(null);
  const [dragCursor, setDragCursor] = useState<number | null>(null);

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

  const W  = width;
  const H  = 200;
  const pl = 48, pr = 16, pt = 16, pb = 36;
  const cW = Math.max(W - pl - pr, 1);
  const cH = H - pt - pb;
  const n  = points.length;

  const xOf     = (i: number) => pl + (n <= 1 ? cW / 2 : (i / (n - 1)) * cW);
  const pxToIdx = (offset: number) => Math.max(0, Math.min(n - 1, Math.round((offset / cW) * (n - 1))));

  // cumulative stacking: series order matches SERIES array
  const cumulative = points.map(p => {
    let s = 0;
    return SERIES.map(sr => { s += p[sr.key]; return s; });
  });
  const maxTotal = Math.max(...cumulative.map(row => row[row.length - 1] ?? 0), 1);
  const yOf      = (v: number) => pt + cH - (v / maxTotal) * cH;

  function areaPath(si: number): string {
    if (n === 0) return '';
    const topPts = points.map((_, i) => `${i === 0 ? 'M' : 'L'}${xOf(i).toFixed(1)},${yOf(cumulative[i]![si]!).toFixed(1)}`);
    const botPts = (si === 0
      ? points.map((_, i) => ({ x: xOf(i), y: yOf(0) }))
      : points.map((_, i) => ({ x: xOf(i), y: yOf(cumulative[i]![si - 1]!) }))
    ).reverse().map(p => `L${p.x.toFixed(1)},${p.y.toFixed(1)}`);
    return `${topPts.join(' ')} ${botPts.join(' ')} Z`;
  }

  function selRect(fStr: string, tStr: string) {
    if (!fStr && !tStr) return null;
    const fKey = fStr.slice(0, 13), tKey = tStr.slice(0, 13);
    let lo = 0, hi = n - 1;
    if (fKey) { const idx = points.findIndex(p => p.hourKey >= fKey); if (idx >= 0) lo = idx; }
    if (tKey) { for (let i = n - 1; i >= 0; i--) { if (points[i]!.hourKey <= tKey) { hi = i; break; } } }
    if (lo > hi) return null;
    return { x1: xOf(lo), x2: xOf(hi) };
  }

  const existingSel = n > 0 ? selRect(from, to) : null;
  const dragSel     = dragAnchor !== null && dragCursor !== null
    ? { x1: xOf(Math.min(dragAnchor, dragCursor)), x2: xOf(Math.max(dragAnchor, dragCursor)) }
    : null;

  function onMD(e: React.MouseEvent<SVGRectElement>) {
    const off = e.clientX - e.currentTarget.getBoundingClientRect().left;
    setDragAnchor(pxToIdx(off)); setDragCursor(pxToIdx(off));
  }
  function onMM(e: React.MouseEvent<SVGRectElement>) {
    if (dragAnchor === null) return;
    setDragCursor(pxToIdx(e.clientX - e.currentTarget.getBoundingClientRect().left));
  }
  function onMU(e: React.MouseEvent<SVGRectElement>) {
    if (dragAnchor === null) return;
    const end = pxToIdx(e.clientX - e.currentTarget.getBoundingClientRect().left);
    const lo = Math.min(dragAnchor, end), hi = Math.max(dragAnchor, end);
    setDragAnchor(null); setDragCursor(null);
    const fKey = points[lo]?.hourKey, tKey = points[hi]?.hourKey;
    if (fKey && tKey) onSelect(`${fKey}:00`, `${tKey}:59`);
  }

  const yTicks     = Array.from({ length: 5 }, (_, i) => Math.round((maxTotal * i) / 4));
  const xTickCount = Math.min(n, 6);
  const xTicks     = Array.from({ length: xTickCount }, (_, i) => {
    const idx = Math.round(i * (n - 1) / Math.max(xTickCount - 1, 1));
    return { idx, label: points[idx]?.hourKey?.slice(5, 13).replace('T', ' ') ?? '' };
  });

  if (n === 0) {
    return (
      <div ref={containerRef} className="flex items-center justify-center h-[200px] text-muted-foreground text-sm">
        No audit data for selected period
      </div>
    );
  }

  return (
    <div ref={containerRef} className="w-full select-none">
      {/* Clickable legend */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mb-2">
        {SERIES.map(s => {
          const on = selectedCats.has(s.cat);
          return (
            <button key={s.key} onClick={() => onToggleSeries(s.cat)}
              title={on ? `Hide ${s.label}` : `Show ${s.label}`}
              className="inline-flex items-center gap-1.5 text-[11px] transition-opacity hover:opacity-80"
              style={{ opacity: on ? 1 : 0.3 }}>
              <span className="inline-block w-3 h-2.5 rounded-sm shrink-0" style={{ backgroundColor: s.color }} />
              {s.label}
            </button>
          );
        })}
        {(from || to) && (
          <button onClick={() => onSelect('', '')}
            className="ml-auto inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors">
            <X className="h-3 w-3" /> Clear selection
          </button>
        )}
      </div>
      <svg width={W} height={H} style={{ cursor: 'crosshair', display: 'block' }}>
        {/* Grid lines */}
        {yTicks.map((v, i) => (
          <line key={i} x1={pl} y1={yOf(v).toFixed(1)} x2={pl + cW} y2={yOf(v).toFixed(1)}
            stroke="currentColor" strokeOpacity={0.07} strokeWidth={1} />
        ))}
        {/* Stacked areas back-to-front */}
        {[4, 3, 2, 1, 0].map(si => (
          <path key={si} d={areaPath(si)} fill={SERIES[si]!.color} fillOpacity={0.75} />
        ))}
        {/* Existing selection overlay */}
        {existingSel && !dragSel && (
          <rect x={existingSel.x1} y={pt} width={Math.max(existingSel.x2 - existingSel.x1, 2)} height={cH}
            fill="white" fillOpacity={0.15} stroke="white" strokeOpacity={0.5} strokeWidth={1} />
        )}
        {/* Active drag selection */}
        {dragSel && (
          <rect x={dragSel.x1} y={pt} width={Math.max(dragSel.x2 - dragSel.x1, 2)} height={cH}
            fill="white" fillOpacity={0.25} stroke="white" strokeOpacity={0.8} strokeWidth={1} />
        )}
        {/* Invisible drag-capture rect */}
        <rect x={pl} y={pt} width={cW} height={cH} fill="transparent"
          onMouseDown={onMD} onMouseMove={onMM} onMouseUp={onMU}
          onMouseLeave={() => { setDragAnchor(null); setDragCursor(null); }} />
        {/* Y axis labels */}
        {yTicks.map((v, i) => (
          <text key={i} x={pl - 6} y={yOf(v).toFixed(1)} textAnchor="end" dominantBaseline="middle"
            fontSize={10} fill="currentColor" opacity={0.5}>{v}</text>
        ))}
        {/* X axis labels */}
        {xTicks.map(({ idx, label }) => (
          <text key={idx} x={xOf(idx).toFixed(1)} y={H - pb + 14} textAnchor="middle"
            fontSize={10} fill="currentColor" opacity={0.5}>{label}</text>
        ))}
        {/* Axes */}
        <line x1={pl} y1={pt} x2={pl} y2={pt + cH} stroke="currentColor" strokeOpacity={0.15} />
        <line x1={pl} y1={pt + cH} x2={pl + cW} y2={pt + cH} stroke="currentColor" strokeOpacity={0.15} />
      </svg>
    </div>
  );
}

// ─── Per-SA stacked bar chart ─────────────────────────────────────────────────

const SA_BAR_SEGS = [
  { key: 'da'  as const, color: '#3b82f6', label: 'Data Access'  },
  { key: 'se'  as const, color: '#f59e0b', label: 'Security'     },
  { key: 'cfg' as const, color: '#a855f7', label: 'Config'       },
  { key: 'dm'  as const, color: '#22c55e', label: 'Modification' },
  { key: 'other' as const, color: '#64748b', label: 'Other'      },
] satisfies Array<{ key: keyof Omit<SaBarEntry, 'alias' | 'total'>; color: string; label: string }>;

function SaBarChart({ data, onSaClick }: { data: SaBarEntry[]; onSaClick?: (region: string, subdomain: string) => void }) {
  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center py-8 text-xs text-muted-foreground">No data</div>
    );
  }
  const maxTotal = Math.max(...data.map(e => e.total), 1);
  return (
    <div className="space-y-2">
      {data.map(e => (
        <div key={`${e.region}/${e.subdomain}`}>
          <div className="flex items-baseline justify-between gap-1 mb-0.5">
            <div className="flex items-baseline gap-1.5 min-w-0">
              <button
                className="text-[11px] truncate text-foreground/80 leading-tight hover:underline hover:text-primary transition-colors text-left"
                title={`Open audit logs for ${e.alias}`}
                onClick={() => onSaClick?.(e.region, e.subdomain)}
              >{e.alias}</button>
              <span className="text-[10px] text-muted-foreground/40 font-mono shrink-0">{e.region}/{e.subdomain}</span>
            </div>
            <span className="text-[10px] text-muted-foreground/60 shrink-0 tabular-nums">
              {e.total.toLocaleString()}
              {e.sizeBytes != null && <span className="text-muted-foreground/40"> · {formatBytes(e.sizeBytes)}</span>}
            </span>
          </div>
          <div className="flex h-2.5 rounded-sm overflow-hidden bg-muted/20">
            {SA_BAR_SEGS.map(seg => {
              const count = e[seg.key];
              if (count === 0) return null;
              return (
                <div key={seg.key}
                  title={`${seg.label}: ${count.toLocaleString()}`}
                  style={{ width: `${(count / maxTotal) * 100}%`, backgroundColor: seg.color, opacity: 0.82 }}
                />
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

const BASE_DURATIONS = [
  { label: 'Last 7 Days',  value: 7  },
  { label: 'Last 14 Days', value: 14 },
  { label: 'Last 30 Days', value: 30 },
  { label: 'Last 60 Days', value: 60 },
];

function toYMD(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export default function AuditLogPage() {
  const { toggle, collapsed } = useSidebar();
  const { region: urlRegion, subdomain: urlSubdomain } = useParams<{ region?: string; subdomain?: string }>();
  const [keyword,         setKeyword]         = useState(() => { try { return new URLSearchParams(window.location.search).get('q') ?? ''; } catch { return ''; } });
  const [committed,       setCommitted]       = useState(() => { try { return new URLSearchParams(window.location.search).get('q') ?? ''; } catch { return ''; } });
  const [duration,        setDuration]        = useState(() => { try { const v = parseInt(new URLSearchParams(window.location.search).get('duration') ?? '', 10); return v > 0 ? v : 30; } catch { return 30; } });
  const [isCustomRange,   setIsCustomRange]   = useState(() => { try { const sp = new URLSearchParams(window.location.search); return !!(sp.get('from') && sp.get('to')); } catch { return false; } });
  const [customFrom,      setCustomFrom]      = useState(() => { try { return new URLSearchParams(window.location.search).get('from') ?? ''; } catch { return ''; } });
  const [customTo,        setCustomTo]        = useState(() => { try { return new URLSearchParams(window.location.search).get('to') ?? ''; } catch { return ''; } });
  const [datePickerOpen,  setDatePickerOpen]  = useState(false);
  const [progress,        setProgress]        = useState<ProgressState | null>(null);
  const [stats,           setStats]           = useState<AuditHourStat[]>([]);
  const [saSizes,         setSaSizes]         = useState<Record<string, number>>({});
  const [latest,          setLatest]          = useState<SubaccountLatest[]>([]);
  const [loading,         setLoading]         = useState(false);
  const [isRefreshing,    setIsRefreshing]    = useState(false);
  const [lastRefreshTime, setLastRefreshTime] = useState<number | null>(() => {
    try { const v = localStorage.getItem('auditLogLastRefresh'); return v ? Number(v) : null; } catch { return null; }
  });
  const [maxAuditDays,    setMaxAuditDays]    = useState(0);
  const [allSubaccounts,  setAllSubaccounts]  = useState<SubaccountEntry[]>([]);
  const [modalSa,         setModalSa]         = useState<SubaccountEntry | null>(null);
  const [cockpit,         setCockpit]         = useState<{ idp: string; host: string }>({ idp: '', host: '' });
  const [cockpitMenu,     setCockpitMenu]     = useState<CockpitMenuItem | null>(null);
  const [selectedCats,    setSelectedCats]    = useState<Set<string>>(() => new Set(ALL_OVERVIEW_CATS));
  const [expandedRows,    setExpandedRows]    = useState<Set<string>>(() => new Set());
  const [chartFrom,       setChartFrom]       = useState('');
  const [chartTo,         setChartTo]         = useState('');
  const progressTimerRef   = useRef<ReturnType<typeof setTimeout> | null>(null);
  const evsRef             = useRef<EventSource | null>(null);
  const autoOpenedRef      = useRef(false);
  const savedOverviewUrl   = useRef<string | null>(null);

  // SSE subscription
  useEffect(() => {
    const evs = new EventSource('/api/events?audit=1');
    evsRef.current = evs;
    evs.addEventListener('update', (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data as string) as {
          type?: string;
          current?: number; total?: number; alias?: string; phase?: string; page?: number; lastTime?: string;
          warnings?: string[]; error?: string;
        };
        if (data.type === 'audit-start') {
          setIsRefreshing(true);
          setProgress({ type: 'running', current: 0, total: data.total ?? 0, alias: '', phase: 'starting' });
        } else if (data.type === 'audit-progress') {
          setProgress({ type: 'running', current: data.current ?? 0, total: data.total ?? 0, alias: data.alias ?? '', phase: data.phase ?? '', page: data.page, lastTime: data.lastTime });
        } else if (data.type === 'audit-done') {
          setIsRefreshing(false);
          setProgress({ type: 'done', warnings: data.warnings ?? [] });
          void fetchData();
          const now = Date.now();
          setLastRefreshTime(now);
          try { localStorage.setItem('auditLogLastRefresh', String(now)); } catch { /* ignore */ }
          if (progressTimerRef.current) clearTimeout(progressTimerRef.current);
          progressTimerRef.current = setTimeout(() => setProgress(null), 8000);
        } else if (data.type === 'audit-error') {
          setIsRefreshing(false);
          setProgress({ type: 'error', error: data.error ?? 'Unknown error', warnings: data.warnings ?? [] });
        }
      } catch { /* ignore */ }
    });
    return () => { evs.close(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const dynamicDurations = useMemo(() => {
    const base = BASE_DURATIONS.filter(d => maxAuditDays <= 0 || d.value <= maxAuditDays);
    if (maxAuditDays > 0 && !BASE_DURATIONS.some(d => d.value === maxAuditDays)) {
      return [...base, { label: `Last ${maxAuditDays} Days`, value: maxAuditDays }];
    }
    return base;
  }, [maxAuditDays]);

  async function fetchData(kwOvr?: string, catsOvr?: Set<string>, fromOvr?: string, toOvr?: string, customFromOvr?: string, customToOvr?: string, isCustomOvr?: boolean) {
    setLoading(true);
    try {
      const useKw        = kwOvr        !== undefined ? kwOvr        : committed;
      const useCats      = catsOvr      !== undefined ? catsOvr      : selectedCats;
      const useChartFrom = fromOvr      !== undefined ? fromOvr      : chartFrom;
      const useChartTo   = toOvr        !== undefined ? toOvr        : chartTo;
      const useCustFrom  = customFromOvr !== undefined ? customFromOvr : customFrom;
      const useCustTo    = customToOvr   !== undefined ? customToOvr   : customTo;
      const useIsCustom  = isCustomOvr   !== undefined ? isCustomOvr   : isCustomRange;

      let params: URLSearchParams;
      if (useIsCustom && useCustFrom && useCustTo) {
        params = new URLSearchParams({ from: useCustFrom, to: useCustTo });
      } else {
        params = new URLSearchParams({ duration: String(duration) });
      }
      if (useKw.trim()) params.set('q', useKw.trim());
      const latestParams = new URLSearchParams(params);
      if (useChartFrom) latestParams.set('from', useChartFrom);
      if (useChartTo)   latestParams.set('to',   useChartTo);
      if (useCats.size > 0 && useCats.size < ALL_OVERVIEW_CATS.size) {
        latestParams.set('categories', [...useCats].join(','));
      }
      const [statsRes, latestRes] = await Promise.all([
        fetch(`/api/audit-log/stats?${params}`),
        fetch(`/api/audit-log/latest?${latestParams}`),
      ]);
      const [statsJson, latestJson] = await Promise.all([
        statsRes.json() as Promise<{ ok: boolean; stats: AuditHourStat[]; saSizes?: Record<string, number> }>,
        latestRes.json() as Promise<{ ok: boolean; entries: SubaccountLatest[] }>,
      ]);
      if (statsJson.ok)  { setStats(statsJson.stats ?? []); setSaSizes(statsJson.saSizes ?? {}); }
      if (latestJson.ok) setLatest(latestJson.entries ?? []);
    } catch { /* ignore */ } finally {
      setLoading(false);
    }
  }

  useEffect(() => { if (!isCustomRange) void fetchData(); }, [duration, isCustomRange]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    fetch('/api/config/subaccounts')
      .then(r => r.json() as Promise<{ ok: boolean; data: SubaccountEntry[] }>)
      .then(j => { if (j.ok && j.data) setAllSubaccounts(j.data); })
      .catch(() => { /* ignore */ });
  }, []);

  // Keep the overview URL in sync with the current keyword + duration/range so a refresh
  // restores both. Skipped while the modal is open — AuditLogTab manages the URL then.
  useEffect(() => {
    if (urlRegion || urlSubdomain || modalSa) return;
    const params = new URLSearchParams();
    if (committed.trim()) params.set('q', committed.trim());
    if (isCustomRange && customFrom && customTo) {
      params.set('from', customFrom);
      params.set('to', customTo);
    } else if (duration !== 30) {
      params.set('duration', String(duration));
    }
    const qs = params.toString();
    history.replaceState(null, '', qs ? `/audit-logs?${qs}` : '/audit-logs');
  }, [committed, duration, isCustomRange, customFrom, customTo, modalSa, urlRegion, urlSubdomain]);

  // Auto-open the subaccount modal when the URL contains /audit-logs/{region}/{subdomain}.
  // AuditLogTab reads ?q= from window.location.search on mount, so the keyword is
  // restored automatically without any extra prop plumbing.
  useEffect(() => {
    if (autoOpenedRef.current || !urlRegion || !urlSubdomain || allSubaccounts.length === 0) return;
    const found = allSubaccounts.find(
      s => s.region === urlRegion && s.subdomain.toLowerCase() === urlSubdomain.toLowerCase(),
    );
    if (found) { autoOpenedRef.current = true; setModalSa(found); }
  }, [allSubaccounts, urlRegion, urlSubdomain]);

  useEffect(() => {
    fetch('/api/info')
      .then(r => r.json() as Promise<{ maxAuditStorageDays?: number }>)
      .then(j => {
        const m = j.maxAuditStorageDays && j.maxAuditStorageDays > 0 ? j.maxAuditStorageDays : 0;
        setMaxAuditDays(m);
        if (m > 0) setDuration(d => {
          if (d <= m) return d;
          const opts = BASE_DURATIONS.filter(v => v.value <= m);
          return opts.length > 0 ? opts[opts.length - 1]!.value : m;
        });
      })
      .catch(() => { /* ignore */ });
    fetch('/api/settings')
      .then(r => r.json() as Promise<{ ok: boolean; data: { homepage?: { cockpit?: { idp: string; host: string } } } }>)
      .then(j => { if (j.ok) setCockpit(j.data?.homepage?.cockpit ?? { idp: '', host: '' }); })
      .catch(() => { /* ignore */ });
    fetch('/api/config/cockpit-menu')
      .then(r => r.json() as Promise<CockpitMenuItem | null>)
      .then(j => { if (j) setCockpitMenu(j); })
      .catch(() => { /* ignore */ });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleRefresh() {
    try { await fetch('/api/audit-log/refresh', { method: 'POST' }); } catch { /* ignore */ }
  }

  function toggleCat(catKey: string) {
    const next = new Set(selectedCats);
    if (next.has(catKey)) { if (next.size <= 1) return; next.delete(catKey); }
    else                   { next.add(catKey); }
    setSelectedCats(next);
    void fetchData(undefined, next);
  }

  // Aggregate stats by hour, applying selectedCats filter
  const chartPoints: ChartPoint[] = (() => {
    const map = new Map<string, ChartPoint>();
    for (const s of stats) {
      const existing = map.get(s.hourKey);
      if (existing) {
        if (selectedCats.has('data-access'))       existing.dataAccess   += s.dataAccess;
        if (selectedCats.has('security-events'))   existing.security     += s.security;
        if (selectedCats.has('configuration'))     existing.config       += s.config;
        if (selectedCats.has('data-modification')) existing.modification += s.modification;
        if (selectedCats.has('other'))             existing.other        += s.other;
      } else {
        map.set(s.hourKey, {
          hourKey:      s.hourKey,
          dataAccess:   selectedCats.has('data-access')       ? s.dataAccess   : 0,
          security:     selectedCats.has('security-events')   ? s.security     : 0,
          config:       selectedCats.has('configuration')     ? s.config       : 0,
          modification: selectedCats.has('data-modification') ? s.modification : 0,
          other:        selectedCats.has('other')             ? s.other        : 0,
        });
      }
    }
    return [...map.values()].sort((a, b) => a.hourKey.localeCompare(b.hourKey));
  })();

  // Per-SA totals for the side stacked bar chart — derived from the same stats data.
  const saBarData: SaBarEntry[] = (() => {
    const map = new Map<string, SaBarEntry>();
    for (const s of stats) {
      const key = `${s.region}/${s.subdomain}`;
      if (!map.has(key)) {
        const alias = allSubaccounts.find(a => a.region === s.region && a.subdomain === s.subdomain)?.alias ?? s.subdomain;
        map.set(key, { alias, region: s.region, subdomain: s.subdomain, da: 0, se: 0, cfg: 0, dm: 0, other: 0, total: 0 });
      }
      const e = map.get(key)!;
      if (selectedCats.has('data-access'))       e.da    += s.dataAccess;
      if (selectedCats.has('security-events'))   e.se    += s.security;
      if (selectedCats.has('configuration'))     e.cfg   += s.config;
      if (selectedCats.has('data-modification')) e.dm    += s.modification;
      if (selectedCats.has('other'))             e.other += s.other;
    }
    return [...map.values()]
      .map(e => ({ ...e, total: e.da + e.se + e.cfg + e.dm + e.other, sizeBytes: saSizes[`${e.region}/${e.subdomain}`] }))
      .filter(e => e.total > 0)
      .sort((a, b) => b.total - a.total);
  })();

  const keywords = splitKeywords(committed);

  const filteredLatest = latest.filter(sa => sa.entries.length > 0);

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden">
      {/* Title bar */}
      <div className="border-b border-border bg-background px-3 flex items-center gap-2 shrink-0 min-h-[52px]">
        <button onClick={toggle} className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors" title="Toggle sidebar">
          <PanelLeft className="h-4 w-4" />
        </button>
        {collapsed && <ScrollText className="h-4 w-4 sm:hidden text-muted-foreground" aria-label="Audit Log" />}
        <div className="hidden sm:flex flex-col justify-center min-w-0">
          <span className="text-sm font-semibold leading-tight">Audit Log</span>
          {lastRefreshTime !== null && (
            <span className="text-[10px] text-muted-foreground/50 leading-tight">
              Refreshed: {new Date(lastRefreshTime).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}
            </span>
          )}
        </div>
        <div className="relative flex-1 min-w-0 ml-2">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
          <input
            type="text" value={keyword}
            onChange={e => setKeyword(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { setCommitted(keyword); void fetchData(keyword); } }}
            placeholder="Search audit logs (space-separated keywords, all must match)…"
            className="w-full h-8 pl-7 pr-8 text-xs border border-border rounded bg-background focus:outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
          />
          {keyword && (
            <span className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5">
              {committed && loading
                ? <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                : <button onClick={() => { setKeyword(''); setCommitted(''); void fetchData(''); }}
                    title="Clear search"
                    className="text-muted-foreground hover:text-foreground transition-colors rounded">
                    <X className="h-3.5 w-3.5" />
                  </button>
              }
            </span>
          )}
        </div>
        <select
          value={isCustomRange ? 'custom' : String(duration)}
          onChange={e => {
            const v = e.target.value;
            if (v === 'custom') { setDatePickerOpen(true); return; }
            setIsCustomRange(false);
            setCustomFrom('');
            setCustomTo('');
            setDuration(Number(v));
          }}
          className="h-8 px-2 text-xs border border-border rounded bg-background focus:outline-none focus:ring-1 focus:ring-ring">
          {dynamicDurations.map(d => <option key={d.value} value={d.value}>{d.label}</option>)}
          {isCustomRange
            ? <option value="custom">{customFrom} – {customTo}</option>
            : <option value="custom">Custom Date Range…</option>}
        </select>
        <button onClick={() => void handleRefresh()} disabled={isRefreshing}
          className="inline-flex items-center gap-1.5 h-8 px-3 rounded text-xs font-medium border border-border hover:bg-accent hover:text-accent-foreground transition-colors disabled:opacity-50"
          title="Refresh audit logs from BTP">
          <RefreshCw className={`h-3.5 w-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />
          {isRefreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {/* Progress bar */}
      {progress && (() => {
        const isDone     = progress.type === 'done';
        const hasIssues  = isDone && !!progress.warnings.length;
        const isError    = progress.type === 'error';
        const pct        = isDone || isError ? 100 : progress.total > 0 ? Math.round((Math.max(progress.current - 1, 0) / progress.total) * 100) : 0;
        const barColor   = hasIssues || isError ? 'bg-amber-500' : isDone ? 'bg-green-500' : 'bg-primary';
        const textColor  = hasIssues || isError ? 'text-amber-600 dark:text-amber-400' : isDone ? 'text-green-600 dark:text-green-400' : 'text-foreground';
        const bgColor    = hasIssues || isError ? 'bg-amber-500/8' : isDone ? 'bg-green-500/8' : 'bg-muted/40';
        const msg = progress.type === 'running'
          ? `Refreshing ${progress.current}/${progress.total}${progress.alias ? ` — ${progress.alias}` : ''}${progress.phase === 'fetching' && progress.page ? ` (page ${progress.page}${progress.lastTime ? ` · ${progress.lastTime}` : ''})` : ''}`
          : progress.type === 'done'
            ? `Refresh complete${progress.warnings.length ? ` — ${progress.warnings.length} warning(s)` : ''}`
            : `Error: ${progress.error}`;
        return (
          <div className={`relative shrink-0 border-b border-border ${bgColor}`}>
            <div className="h-1 w-full"><div className={`h-full transition-all duration-300 ${barColor}`} style={{ width: `${pct}%` }} /></div>
            <div className={`px-4 py-1.5 text-xs text-center ${textColor} pr-8`}>{msg}</div>
            {hasIssues && (
              <div className="px-4 pb-2 flex flex-col gap-0.5">
                {progress.warnings.map((w, i) => (
                  <div key={i} className="text-[11px] text-amber-600 dark:text-amber-400 text-center">{w}</div>
                ))}
              </div>
            )}
            <button onClick={() => { if (progressTimerRef.current) clearTimeout(progressTimerRef.current); setProgress(null); }}
              className="absolute top-1 right-1 p-0.5 rounded text-muted-foreground/60 hover:text-foreground hover:bg-black/10 dark:hover:bg-white/10 transition-colors" title="Dismiss">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })()}

      {/* Main content */}
      <div className="flex-1 overflow-auto min-h-0 px-4 py-4 space-y-6">

        {/* Charts row: area chart (75%) + per-SA bar chart (25%) */}
        <div className="flex gap-4 items-stretch">

          {/* Area chart */}
          <div className="flex-1 min-w-0 rounded-lg border border-border bg-card p-4">
            <h2 className="text-sm font-semibold mb-3">Audit Events Over Time</h2>
            {loading && chartPoints.length === 0 ? (
              <div className="flex items-center justify-center h-[200px] text-xs text-muted-foreground">Loading…</div>
            ) : (
              <OverviewAuditChart
                points={chartPoints}
                selectedCats={selectedCats}
                from={chartFrom}
                to={chartTo}
                onSelect={(f, t) => {
                  setChartFrom(f); setChartTo(t);
                  void fetchData(undefined, undefined, f, t);
                }}
                onToggleSeries={toggleCat}
              />
            )}
            {(chartFrom || chartTo) && (
              <p className="text-[11px] text-muted-foreground mt-1.5">
                Showing entries from {chartFrom || '—'} to {chartTo || '—'} · entries table filtered below
              </p>
            )}
          </div>

          {/* Per-SA stacked bar chart */}
          <div className="w-1/4 shrink-0 rounded-lg border border-border bg-card p-4 flex flex-col overflow-hidden">
            <h2 className="text-sm font-semibold mb-3 shrink-0">Events per Subaccount</h2>
            <div className="flex-1 overflow-y-auto min-h-0">
              {loading && saBarData.length === 0 ? (
                <div className="flex items-center justify-center py-8 text-xs text-muted-foreground">Loading…</div>
              ) : (
                <SaBarChart data={saBarData} onSaClick={(region, subdomain) => {
                  const fullSa = allSubaccounts.find(a => a.region === region && a.subdomain === subdomain);
                  if (fullSa) { savedOverviewUrl.current = window.location.pathname + window.location.search; setModalSa(fullSa); }
                }} />
              )}
            </div>
          </div>

        </div>

        {/* Latest entries by subaccount */}
        {latest.length > 0 && (
          <div className="space-y-4">
            <h2 className="text-sm font-semibold">
              Latest Audit Entries by Subaccount
              {(chartFrom || chartTo || selectedCats.size < ALL_OVERVIEW_CATS.size) && (
                <span className="ml-2 text-[11px] font-normal text-muted-foreground">(filtered)</span>
              )}
            </h2>
            {filteredLatest.length === 0 && (
              <p className="text-xs text-muted-foreground py-4">No entries match the current filter / time selection.</p>
            )}
            {filteredLatest.map(sa => {
              const fullSa = allSubaccounts.find(s => s.region === sa.region && s.subdomain === sa.subdomain);
              return (
                <div key={`${sa.region}/${sa.subdomain}`} className="rounded-lg border border-border bg-card overflow-hidden">
                  <div
                    className={`px-4 py-2 border-b border-border bg-muted/20 flex items-center gap-2 ${fullSa ? 'cursor-pointer hover:bg-muted/40 transition-colors' : ''}`}
                    onClick={() => { if (fullSa) { savedOverviewUrl.current = window.location.pathname + window.location.search; setModalSa(fullSa); } }}
                    title={fullSa ? 'Open audit log details' : undefined}
                  >
                    <span className="text-xs font-semibold">{sa.alias}</span>
                    <span className="text-[10px] text-muted-foreground font-mono">{sa.region}/{sa.subdomain}</span>
                  </div>
                  <table className="w-full border-collapse text-xs">
                    <colgroup>
                      <col style={{ width: '160px' }} />
                      <col style={{ width: '123px' }} />
                      <col />
                    </colgroup>
                    <thead>
                      <tr className="bg-muted/10">
                        <th className="px-3 py-1.5 text-left text-[10px] font-medium text-muted-foreground border-b border-border">Time</th>
                        <th className="px-3 py-1.5 text-left text-[10px] font-medium text-muted-foreground border-b border-border">Category</th>
                        <th className="px-3 py-1.5 text-left text-[10px] font-medium text-muted-foreground border-b border-border">Message</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sa.entries.map((r, i) => {
                        const rowKey = `${sa.region}/${sa.subdomain}/${r.uuid ?? String(i)}`;
                        const prev   = previewMessage(r.message);
                        const isLong = prev.length > 120 || prev.includes('\n');
                        const isExp  = expandedRows.has(rowKey);
                        return (
                          <tr key={rowKey}
                            className={`hover:bg-muted/20 ${isLong ? 'cursor-pointer' : ''}`}
                            onClick={() => {
                              if (!isLong) return;
                              if (window.getSelection()?.toString()) return;
                              setExpandedRows(prev => {
                                const n = new Set(prev);
                                n.has(rowKey) ? n.delete(rowKey) : n.add(rowKey);
                                return n;
                              });
                            }}>
                            <td className="px-3 py-1 border-b border-border/50 font-mono text-[11px] text-muted-foreground whitespace-nowrap align-top">{r.time}</td>
                            <td className="px-3 py-1 border-b border-border/50 overflow-hidden align-top">
                              <span className={`text-[11px] font-medium ${categoryColor(r.category)}`}>{r.category.replace('audit.', '')}</span>
                            </td>
                            <td className="px-3 py-1 border-b border-border/50 min-w-0 align-top">
                              {isExp ? (
                                <pre className="text-[11px] font-mono whitespace-pre-wrap break-all">
                                  <HighlightText text={fullDetail(r)} keywords={keywords} />
                                </pre>
                              ) : (
                                <div className="text-[11px] text-muted-foreground/80 font-mono line-clamp-2 break-all">
                                  <HighlightText text={prev} keywords={keywords} />
                                </div>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              );
            })}
          </div>
        )}

        {!loading && latest.length === 0 && stats.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 text-center gap-3">
            <p className="text-sm text-muted-foreground">No audit log data found.</p>
            <p className="text-xs text-muted-foreground">Enable &quot;View Audit Logs&quot; for subaccounts in Config, then click Refresh.</p>
          </div>
        )}
      </div>

      {/* Custom date range picker */}
      <DateRangePicker
        open={datePickerOpen}
        onClose={() => setDatePickerOpen(false)}
        onApply={(from, until) => {
          setIsCustomRange(true);
          setCustomFrom(from);
          setCustomTo(until);
          void fetchData(undefined, undefined, undefined, undefined, from, until, true);
        }}
        fromDate={isCustomRange && customFrom ? customFrom : toYMD(new Date(Date.now() - 30 * 86400000))}
        untilDate={isCustomRange && customTo ? customTo : toYMD(new Date())}
        maxStorageDays={maxAuditDays > 0 ? maxAuditDays : 90}
        noteVariableName="MAX_AUDIT_LOG_STORAGE_DAYS"
      />

      {/* Subaccount modal opened from SA header click — inherits chart selection and categories */}
      {modalSa && (
        <SubaccountModal
          sa={modalSa}
          onClose={() => {
            setModalSa(null);
            history.replaceState(null, '', savedOverviewUrl.current ?? '/audit-logs');
            savedOverviewUrl.current = null;
          }}
          isAdmin={true}
          cockpit={cockpit}
          cockpitMenu={cockpitMenu}
          initialTab="audit"
          subaccounts={allSubaccounts}
          onSelectSubaccount={s => setModalSa(s)}
          initialAuditFrom={chartFrom}
          initialAuditTo={chartTo}
          initialAuditCategories={selectedCats}
        />
      )}
    </div>
  );
}
