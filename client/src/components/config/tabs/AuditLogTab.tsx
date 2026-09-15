import { useEffect, useRef, useState } from 'react';
import { Search, ChevronLeft, ChevronRight, X, Loader2, RefreshCw } from 'lucide-react';
import type { SubaccountEntry } from '@/components/config/SubaccountsTable';

interface AuditHourStat {
  hourKey:      string;
  dataAccess:   number;
  security:     number;
  config:       number;
  modification: number;
  other:        number;
}

interface AuditRecord {
  uuid?:     string;
  time:      string;
  category:  string;
  message:   unknown;
  [key: string]: unknown;
}

interface Props {
  sa:                 SubaccountEntry;
  initialFrom?:       string;
  initialTo?:         string;
  initialCategories?: Set<string>;
}

// ─── Category definitions ─────────────────────────────────────────────────────

const CATEGORIES = [
  { key: 'data-access',       label: 'Data Access',  onCls: 'border-blue-500/40 bg-blue-500/8 text-blue-600 dark:text-blue-400',     dotCls: 'bg-blue-500' },
  { key: 'security-events',   label: 'Security',     onCls: 'border-amber-500/40 bg-amber-500/8 text-amber-600 dark:text-amber-400',  dotCls: 'bg-amber-500' },
  { key: 'configuration',     label: 'Config',       onCls: 'border-purple-500/40 bg-purple-500/8 text-purple-600 dark:text-purple-400', dotCls: 'bg-purple-500' },
  { key: 'data-modification', label: 'Modification', onCls: 'border-green-500/40 bg-green-500/8 text-green-600 dark:text-green-400',  dotCls: 'bg-green-500' },
  { key: 'other',             label: 'Other',        onCls: 'border-slate-500/40 bg-slate-500/8 text-slate-600 dark:text-slate-400',  dotCls: 'bg-slate-500' },
] as const;

const ALL_CAT_KEYS = CATEGORIES.map(c => c.key);
const ALL_CATS     = new Set(ALL_CAT_KEYS);

// ─── Helpers ──────────────────────────────────────────────────────────────────

const PREVIEW_SKIP = new Set(['uuid', 'time', 'msgId', 'correlationId', 'category']);

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
    return JSON.stringify(filtered, null, 2);
  }
  return typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
}

function CategoryBadge({ cat }: { cat: string }) {
  const map: Record<string, string> = {
    'audit.data-access':       'bg-blue-500/10 text-blue-600 dark:text-blue-400',
    'audit.security-events':   'bg-amber-500/10 text-amber-600 dark:text-amber-400',
    'audit.configuration':     'bg-purple-500/10 text-purple-600 dark:text-purple-400',
    'audit.data-modification': 'bg-green-500/10 text-green-600 dark:text-green-400',
  };
  const cls = map[cat] ?? 'bg-slate-500/10 text-slate-600 dark:text-slate-400';
  return <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium ${cls}`}>{cat.replace('audit.', '')}</span>;
}

function splitKeywords(kw: string): string[] {
  return kw.trim().split(/\s+/).filter(Boolean);
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

// ─── Mini area chart ──────────────────────────────────────────────────────────

const CHART_COLORS = ['#3b82f6', '#f59e0b', '#a855f7', '#22c55e', '#64748b'] as const;

interface MiniChartProps {
  stats:    AuditHourStat[];
  from:     string;
  to:       string;
  onSelect: (from: string, to: string) => void;
}

function MiniAuditChart({ stats, from, to, onSelect }: MiniChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
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

  if (stats.length === 0) {
    return (
      <div ref={containerRef} className="flex items-center justify-center h-12 text-xs text-muted-foreground">
        No hourly data available
      </div>
    );
  }

  const W  = width;
  const H  = 96;
  const pl = 4, pr = 4, pt = 4, pb = 20;
  const cW = Math.max(W - pl - pr, 1);
  const cH = H - pt - pb;
  const n  = stats.length;

  const xOf     = (i: number) => pl + (n <= 1 ? cW / 2 : (i / (n - 1)) * cW);
  // offset is relative to the hit-rect's left edge (= pl in SVG coords)
  const pxToIdx = (offset: number) => Math.max(0, Math.min(n - 1, Math.round((offset / cW) * (n - 1))));

  const cumulative = stats.map(s => [
    s.dataAccess,
    s.dataAccess + s.security,
    s.dataAccess + s.security + s.config,
    s.dataAccess + s.security + s.config + s.modification,
    s.dataAccess + s.security + s.config + s.modification + s.other,
  ]);
  const maxTotal = Math.max(...cumulative.map(row => row[4]!), 1);
  const yOf      = (v: number) => pt + cH - (v / maxTotal) * cH;

  const xTicks = (() => {
    const tc = Math.min(n, 5);
    return Array.from({ length: tc }, (_, i) => {
      const idx   = Math.round(i * (n - 1) / Math.max(tc - 1, 1));
      const h     = stats[idx]?.hourKey ?? '';
      const label = h.length >= 13 ? h.slice(5, 13).replace('T', ' ') : h;
      return { idx, label };
    });
  })();

  function areaPath(si: number): string {
    const topPts = stats.map((_, i) => `${i === 0 ? 'M' : 'L'}${xOf(i).toFixed(1)},${yOf(cumulative[i]![si]!).toFixed(1)}`);
    const botPts = (si === 0
      ? stats.map((_, i) => ({ x: xOf(i), y: yOf(0) }))
      : stats.map((_, i) => ({ x: xOf(i), y: yOf(cumulative[i]![si - 1]!) }))
    ).reverse().map(p => `L${p.x.toFixed(1)},${p.y.toFixed(1)}`);
    return `${topPts.join(' ')} ${botPts.join(' ')} Z`;
  }

  function selRect(fStr: string, tStr: string) {
    if (!fStr && !tStr) return null;
    const fKey = fStr.slice(0, 13), tKey = tStr.slice(0, 13);
    let lo = 0, hi = n - 1;
    if (fKey) { const idx = stats.findIndex(s => s.hourKey >= fKey); if (idx >= 0) lo = idx; }
    if (tKey) { for (let i = n - 1; i >= 0; i--) { if (stats[i]!.hourKey <= tKey) { hi = i; break; } } }
    if (lo > hi) return null;
    return { x1: xOf(lo), x2: xOf(hi) };
  }

  const existingSel = selRect(from, to);
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
    const fKey = stats[lo]?.hourKey, tKey = stats[hi]?.hourKey;
    if (fKey && tKey) onSelect(`${fKey}:00`, `${tKey}:59`);
  }

  return (
    <div ref={containerRef} className="w-full select-none" title="Drag to select time range">
      <svg width={W} height={H} style={{ cursor: 'crosshair', display: 'block' }}>
        {[4, 3, 2, 1, 0].map(si => (
          <path key={si} d={areaPath(si)} fill={CHART_COLORS[si]} fillOpacity={0.75} />
        ))}
        {existingSel && !dragSel && (
          <rect x={existingSel.x1} y={pt} width={Math.max(existingSel.x2 - existingSel.x1, 2)} height={cH}
            fill="white" fillOpacity={0.15} stroke="white" strokeOpacity={0.5} strokeWidth={1} />
        )}
        {dragSel && (
          <rect x={dragSel.x1} y={pt} width={Math.max(dragSel.x2 - dragSel.x1, 2)} height={cH}
            fill="white" fillOpacity={0.25} stroke="white" strokeOpacity={0.8} strokeWidth={1} />
        )}
        {/* X axis */}
        <line x1={pl} y1={pt + cH} x2={pl + cW} y2={pt + cH} stroke="currentColor" strokeOpacity={0.15} strokeWidth={1} />
        {xTicks.map(({ idx, label }) => (
          <text key={idx} x={xOf(idx).toFixed(1)} y={H - pb + 13}
            textAnchor={idx === 0 ? 'start' : idx === n - 1 ? 'end' : 'middle'}
            fontSize={8} fill="currentColor" opacity={0.5}>{label}</text>
        ))}
        <rect x={pl} y={pt} width={cW} height={cH} fill="transparent"
          onMouseDown={onMD} onMouseMove={onMM} onMouseUp={onMU}
          onMouseLeave={() => { setDragAnchor(null); setDragCursor(null); }} />
      </svg>
    </div>
  );
}

// ─── catsParam ────────────────────────────────────────────────────────────────

function catsParam(cats: Set<string>): string | null {
  return cats.size < ALL_CATS.size ? [...cats].join(',') : null;
}

// ─── Main tab ─────────────────────────────────────────────────────────────────

export default function AuditLogTab({ sa, initialFrom, initialTo, initialCategories }: Props) {
  const [keyword,      setKeyword]      = useState('');
  const [committed,    setCommitted]    = useState('');
  const [selectedCats, setSelectedCats] = useState<Set<string>>(() =>
    initialCategories ? new Set(initialCategories) : new Set(ALL_CATS)
  );
  const [from,         setFrom]         = useState(initialFrom ?? '');
  const [to,           setTo]           = useState(initialTo ?? '');
  const [limit,        setLimit]        = useState(100);
  const [page,         setPage]         = useState(1);
  const [loading,      setLoading]      = useState(false);
  const [error,        setError]        = useState('');
  const [records,      setRecords]      = useState<AuditRecord[]>([]);
  const [total,        setTotal]        = useState(0);
  const [pages,        setPages]        = useState(0);
  const [expanded,     setExpanded]     = useState<Set<number>>(new Set());
  const [chartStats,   setChartStats]   = useState<AuditHourStat[]>([]);
  const [saRefreshing, setSaRefreshing] = useState(false);
  const [saProgress,   setSaProgress]   = useState<{ page: number; lastTime: string } | null>(null);
  const evsRef = useRef<EventSource | null>(null);

  async function load(p = page, cats = selectedCats, fromOvr?: string, toOvr?: string, kwOvr?: string) {
    const useFrom = fromOvr !== undefined ? fromOvr : from;
    const useTo   = toOvr   !== undefined ? toOvr   : to;
    const useKw   = kwOvr   !== undefined ? kwOvr   : committed;
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ limit: String(limit), page: String(p) });
      if (useKw.trim()) params.set('q', useKw.trim());
      if (useFrom) params.set('from', useFrom);
      if (useTo)   params.set('to', useTo);
      const cp = catsParam(cats);
      if (cp) params.set('categories', cp);
      const res  = await fetch(`/api/audit-log/records/${encodeURIComponent(sa.region)}/${encodeURIComponent(sa.subdomain)}?${params}`);
      const json = await res.json() as { ok: boolean; records: AuditRecord[]; total: number; page: number; pages: number; error?: string };
      if (!json.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setRecords(json.records);
      setTotal(json.total);
      setPage(json.page);
      setPages(json.pages);
      setExpanded(new Set());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function fetchChartStats(cats = selectedCats) {
    try {
      const params = new URLSearchParams({ duration: '90' });
      const cp = catsParam(cats);
      if (cp) params.set('categories', cp);
      const res = await fetch(`/api/audit-log/stats/${encodeURIComponent(sa.region)}/${encodeURIComponent(sa.subdomain)}?${params}`);
      const json = await res.json() as { ok: boolean; stats: AuditHourStat[] };
      if (json.ok) setChartStats(json.stats ?? []);
    } catch { /* ignore */ }
  }

  useEffect(() => {
    void load(1);
    void fetchChartStats();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function toggleCat(key: string) {
    const next = new Set(selectedCats);
    if (next.has(key)) { if (next.size <= 1) return; next.delete(key); }
    else                { next.add(key); }
    setSelectedCats(next);
    void load(1, next);
    void fetchChartStats(next);
  }

  function goPage(p: number) { setPage(p); void load(p); }

  function handleChartSelect(f: string, t: string) {
    setFrom(f); setTo(t); setPage(1);
    void load(1, selectedCats, f, t);
  }

  useEffect(() => {
    return () => { if (evsRef.current) { evsRef.current.close(); evsRef.current = null; } };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSaRefresh() {
    if (saRefreshing) return;
    setSaRefreshing(true);
    setSaProgress({ page: 0, lastTime: '' });

    if (evsRef.current) { evsRef.current.close(); evsRef.current = null; }
    const evs = new EventSource(
      `/api/events?audit-sa=1&region=${encodeURIComponent(sa.region)}&subdomain=${encodeURIComponent(sa.subdomain)}`,
    );
    evsRef.current = evs;

    evs.addEventListener('update', (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data as string) as { type?: string; page?: number; lastTime?: string };
        if (data.type === 'audit-sa-progress') {
          setSaProgress({ page: data.page ?? 0, lastTime: data.lastTime ?? '' });
        } else if (data.type === 'audit-sa-done' || data.type === 'audit-sa-error') {
          evs.close(); evsRef.current = null;
          setSaRefreshing(false); setSaProgress(null);
          void load(1); void fetchChartStats();
        }
      } catch { /* ignore */ }
    });
    evs.onerror = () => {
      evs.close(); evsRef.current = null;
      setSaRefreshing(false); setSaProgress(null);
    };

    try {
      const res  = await fetch(`/api/audit-log/refresh/${encodeURIComponent(sa.region)}/${encodeURIComponent(sa.subdomain)}`, { method: 'POST' });
      const json = await res.json() as { ok: boolean };
      if (!json.ok) { evs.close(); evsRef.current = null; setSaRefreshing(false); setSaProgress(null); }
    } catch {
      evs.close(); evsRef.current = null; setSaRefreshing(false); setSaProgress(null);
    }
  }

  const keywords = splitKeywords(committed);

  if (!sa.viewAuditLogs) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground p-8 text-center">
        Audit log is not enabled for this subaccount.<br /><br />
        Go to Config → Subaccounts and select the Audit Logs option to enable it.
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border shrink-0 flex-wrap">

        {/* Search with clear button */}
        <div className="relative flex-1 min-w-0" style={{ minWidth: '160px' }}>
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
          <input
            type="text" value={keyword}
            onChange={e => setKeyword(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { setCommitted(keyword); void load(1, selectedCats, undefined, undefined, keyword); } }}
            placeholder="Keywords (space-separated, all must match)…"
            className="w-full h-7 pl-7 pr-6 text-xs border border-border rounded bg-background focus:outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
          />
          {keyword && (
            <span className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5">
              {committed && loading
                ? <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
                : <button onClick={() => { setKeyword(''); setCommitted(''); void load(1, selectedCats, undefined, undefined, ''); }} title="Clear search"
                    className="text-muted-foreground hover:text-foreground transition-colors rounded">
                    <X className="h-3 w-3" />
                  </button>
              }
            </span>
          )}
        </div>

        {/* Category chips */}
        <div className="flex items-center gap-1 shrink-0">
          {CATEGORIES.map(cat => {
            const on = selectedCats.has(cat.key);
            return (
              <button key={cat.key} onClick={() => toggleCat(cat.key)}
                title={on ? `Hide ${cat.label}` : `Show ${cat.label}`}
                className={`inline-flex items-center gap-1 h-7 px-2 rounded border text-[11px] font-medium transition-colors ${
                  on ? cat.onCls : 'border-border text-muted-foreground/40 bg-transparent hover:text-muted-foreground'
                }`}>
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${on ? cat.dotCls : 'bg-muted-foreground/30'}`} />
                {cat.label}
              </button>
            );
          })}
        </div>

        {/* From / To — lang="en-GB" + step="60" forces 24h and hides seconds in Chromium */}
        <input type="datetime-local" lang="en-GB" step="60" value={from}
          onChange={e => { setFrom(e.target.value); setPage(1); void load(1, selectedCats, e.target.value, to); }}
          className="h-7 px-2 text-xs border border-border rounded bg-background focus:outline-none focus:ring-1 focus:ring-ring w-[10.5rem] [color-scheme:light] dark:[color-scheme:dark]"
          title="From" />
        <input type="datetime-local" lang="en-GB" step="60" value={to}
          onChange={e => { setTo(e.target.value); setPage(1); void load(1, selectedCats, from, e.target.value); }}
          className="h-7 px-2 text-xs border border-border rounded bg-background focus:outline-none focus:ring-1 focus:ring-ring w-[10.5rem] [color-scheme:light] dark:[color-scheme:dark]"
          title="To" />
        {(from || to) && (
          <button onClick={() => { setFrom(''); setTo(''); setPage(1); void load(1, selectedCats, '', ''); }}
            title="Clear time range"
            className="inline-flex items-center justify-center h-7 w-7 rounded border border-border hover:bg-accent hover:text-accent-foreground transition-colors text-muted-foreground hover:text-foreground shrink-0">
            <X className="h-3.5 w-3.5" />
          </button>
        )}

        {/* Refresh button — triggers delta sync with Audit Log API */}
        <button onClick={() => void handleSaRefresh()} disabled={loading || saRefreshing} title="Retrieve latest logs from Audit Log API"
          className="inline-flex items-center justify-center h-7 w-7 rounded border border-border hover:bg-accent hover:text-accent-foreground transition-colors disabled:opacity-50">
          {saRefreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
        </button>
      </div>

      {/* SA refresh progress */}
      {saRefreshing && (
        <div className="px-3 py-1.5 border-b border-border bg-muted/10 shrink-0 flex items-center justify-center gap-2">
          <Loader2 className="h-3 w-3 animate-spin shrink-0 text-muted-foreground" />
          <span className="text-xs text-muted-foreground">
            Retrieving logs from Audit Log API
            {saProgress && saProgress.page > 0
              ? `: Page ${saProgress.page}${saProgress.lastTime ? ` — ${saProgress.lastTime}` : ''}`
              : '…'}
          </span>
        </div>
      )}

      {/* Mini area chart */}
      <div className="shrink-0 border-b border-border bg-muted/5">
        <MiniAuditChart stats={chartStats} from={from} to={to} onSelect={handleChartSelect} />
      </div>

      {/* Error */}
      {error && (
        <div className="px-3 py-1.5 text-xs text-destructive bg-destructive/5 border-b border-destructive/20 shrink-0">
          {error}
        </div>
      )}

      {/* Records */}
      <div className="flex-1 overflow-auto min-h-0">
        {records.length === 0 && !loading && (
          <div className="flex items-center justify-center h-full text-xs text-muted-foreground">
            {total === 0 ? 'No audit entries found for this subaccount.' : 'No records match.'}
          </div>
        )}
        {records.length > 0 && (
          <table className="w-full border-collapse text-xs">
            <colgroup>
              <col style={{ width: '160px' }} />
              <col style={{ width: '105px' }} />
              <col />
            </colgroup>
            <thead className="sticky top-0 z-10">
              <tr className="bg-muted/40">
                <th className="px-2 py-1.5 text-left text-[10px] font-medium text-muted-foreground border-b border-border whitespace-nowrap">Time</th>
                <th className="px-2 py-1.5 text-left text-[10px] font-medium text-muted-foreground border-b border-border">Category</th>
                <th className="px-2 py-1.5 text-left text-[10px] font-medium text-muted-foreground border-b border-border">Message</th>
              </tr>
            </thead>
            <tbody>
              {records.map((r, i) => {
                const isExp  = expanded.has(i);
                const prev   = previewMessage(r.message);
                const isLong = prev.length > 150 || prev.includes('\n');
                return (
                  <tr key={r.uuid ?? i} className={`hover:bg-muted/20 ${isLong ? 'cursor-pointer' : ''}`}
                    onClick={() => {
                      if (!isLong) return;
                      if (window.getSelection()?.toString()) return;
                      setExpanded(prev => { const n = new Set(prev); n.has(i) ? n.delete(i) : n.add(i); return n; });
                    }}>
                    <td className="px-2 py-1 border-b border-border/50 font-mono text-[11px] text-muted-foreground whitespace-nowrap align-top">
                      {r.time}
                    </td>
                    <td className="px-2 py-1 border-b border-border/50 align-top">
                      <CategoryBadge cat={r.category} />
                    </td>
                    <td className="px-2 py-1 border-b border-border/50 align-top">
                      {isExp ? (
                        <pre className="text-[11px] font-mono whitespace-pre-wrap break-all">
                          <HighlightText text={prev} keywords={keywords} />
                        </pre>
                      ) : (
                        <div className="text-muted-foreground/80 font-mono text-[11px] line-clamp-3 break-all">
                          <HighlightText text={prev} keywords={keywords} />
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination + page size */}
      {records.length > 0 && (
        <div className="flex items-center justify-between px-3 py-2 border-t border-border shrink-0 gap-2 flex-wrap">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{total} records — page {page} of {pages}</span>
            <select value={limit} onChange={e => setLimit(Number(e.target.value))}
              className="h-6 px-1.5 text-[11px] border border-border rounded bg-background focus:outline-none focus:ring-1 focus:ring-ring">
              {[100, 200, 500, 1000].map(n => <option key={n} value={n}>{n} / page</option>)}
            </select>
          </div>
          {pages > 1 && (
            <div className="flex items-center gap-1">
              <button onClick={() => goPage(1)} disabled={page <= 1}
                className="inline-flex items-center h-6 px-1.5 rounded text-xs border border-border hover:bg-accent disabled:opacity-40">«</button>
              <button onClick={() => goPage(page - 1)} disabled={page <= 1}
                className="inline-flex items-center h-6 px-1.5 rounded text-xs border border-border hover:bg-accent disabled:opacity-40">
                <ChevronLeft className="h-3.5 w-3.5" />
              </button>
              {Array.from({ length: Math.min(pages, 9) }, (_, idx) => {
                let p = idx + 1;
                if (pages > 9) { const start = Math.max(1, Math.min(page - 4, pages - 8)); p = start + idx; }
                return (
                  <button key={p} onClick={() => goPage(p)}
                    className={`inline-flex items-center justify-center h-6 w-6 rounded text-xs border transition-colors ${
                      p === page ? 'bg-primary text-primary-foreground border-primary' : 'border-border hover:bg-accent'
                    }`}>{p}</button>
                );
              })}
              <button onClick={() => goPage(page + 1)} disabled={page >= pages}
                className="inline-flex items-center h-6 px-1.5 rounded text-xs border border-border hover:bg-accent disabled:opacity-40">
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
              <button onClick={() => goPage(pages)} disabled={page >= pages}
                className="inline-flex items-center h-6 px-1.5 rounded text-xs border border-border hover:bg-accent disabled:opacity-40">»</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
