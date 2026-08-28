import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronUp, ChevronDown, ChevronsUpDown, Maximize2, Minimize2, X } from 'lucide-react';
import type { RequestItem } from './UsageAnalyticsView';

// ─── Types ────────────────────────────────────────────────────────────────────

interface RequestsResult { total: number; page: number; pageSize: number; items: RequestItem[]; }

interface Filters {
  alias: string; region: string; subdomain: string; spaceName: string;
  appName: string; country: string; city: string; userId: string;
}

interface Col {
  key:        keyof RequestItem | 'dateTime';
  label:      string;
  filterKey?: keyof Filters;
  sortKey:    string;
  initWidth:  number;
  minWidth:   number;
}

const COLS: Col[] = [
  { key: 'dateTime',  label: 'Date / Time', sortKey: 'ts',        initWidth: 125, minWidth: 80 },
  { key: 'region',    label: 'Region',      sortKey: 'region',    filterKey: 'region',    initWidth: 65,  minWidth: 50 },
  { key: 'subdomain', label: 'Subdomain',   sortKey: 'subdomain', filterKey: 'subdomain', initWidth: 100, minWidth: 60 },
  { key: 'alias',     label: 'Alias',       sortKey: 'alias',     filterKey: 'alias',     initWidth: 115, minWidth: 60 },
  { key: 'spaceName', label: 'Space',       sortKey: 'spaceName', filterKey: 'spaceName', initWidth: 110, minWidth: 60 },
  { key: 'appName',   label: 'App',         sortKey: 'appName',   filterKey: 'appName',   initWidth: 145, minWidth: 70 },
  { key: 'country',   label: 'Country',     sortKey: 'country',   filterKey: 'country',   initWidth: 100, minWidth: 60 },
  { key: 'city',      label: 'City',        sortKey: 'city',      filterKey: 'city',      initWidth: 95,  minWidth: 50 },
  { key: 'userId',    label: 'User',        sortKey: 'userId',    filterKey: 'userId',    initWidth: 140, minWidth: 80 },
];

const PAGE_SIZE = 50;
const ICON_BTN  = 'p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors shrink-0';

// Stable reference — prevents Object.is() mismatch from triggering duplicate fetches on open
const EMPTY_FILTERS: Filters = { alias: '', region: '', subdomain: '', spaceName: '', appName: '', country: '', city: '', userId: '' };

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtDateTime(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toLocaleDateString([], { month: '2-digit', day: '2-digit' })
    + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  open:       boolean;
  onClose:    () => void;
  onOpenApp?: (region: string, subdomain: string, appGuid: string, spaceName?: string, appName?: string) => void;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function AccessListModal({ open, onClose, onOpenApp }: Props) {
  // All hooks unconditional — early return for rendering only (after hooks section)
  const [result,    setResult]    = useState<RequestsResult | null>(null);
  const [loading,   setLoading]   = useState(false);
  const [page,      setPage]      = useState(1);
  const [sortBy,    setSortBy]    = useState('ts');
  const [sortDir,   setSortDir]   = useState<'asc' | 'desc'>('desc');
  const [filters,   setFilters]   = useState<Filters>(EMPTY_FILTERS);
  const [pending,   setPending]   = useState<Filters>(EMPTY_FILTERS);
  const [colWidths, setColWidths] = useState<number[]>(() => COLS.map(c => c.initWidth));
  const [maximized, setMaximized] = useState(false);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragRef     = useRef<{ colIdx: number; startX: number; startWidth: number } | null>(null);

  const fetchData = useCallback(async (pg: number, sb: string, sd: 'asc' | 'desc', f: Filters) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(pg), pageSize: String(PAGE_SIZE), sortBy: sb, sortDir: sd });
      if (f.alias)     params.set('alias',     f.alias);
      if (f.region)    params.set('region',    f.region);
      if (f.subdomain) params.set('subdomain', f.subdomain);
      if (f.spaceName) params.set('spaceName', f.spaceName);
      if (f.appName)   params.set('appName',   f.appName);
      if (f.country)   params.set('country',   f.country);
      if (f.city)      params.set('city',       f.city);
      if (f.userId)    params.set('userId',     f.userId);
      const res  = await fetch(`/api/aod/requests?${params.toString()}`);
      if (!res.ok) return;
      const json = await res.json() as { ok: boolean; data: RequestsResult };
      if (json.ok) setResult(json.data);
    } finally { setLoading(false); }
  }, []);

  // Re-fetch on open or any query param change.
  // EMPTY_FILTERS is a stable module-level constant so React's Object.is() correctly
  // detects no change when the reset effect writes it back to its initial value,
  // preventing a second fetch on open.
  useEffect(() => {
    if (!open) return;
    void fetchData(page, sortBy, sortDir, filters);
  }, [open, page, sortBy, sortDir, filters, fetchData]);

  // Reset pagination/filters/layout when the modal is opened
  useEffect(() => {
    if (!open) return;
    setPage(1);
    setFilters(EMPTY_FILTERS);   // stable ref → no re-render if already EMPTY_FILTERS
    setPending(EMPTY_FILTERS);
    setMaximized(false);
  }, [open]);

  // ── Column resize ────────────────────────────────────────────────────────────

  function startResize(e: React.MouseEvent, colIdx: number) {
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = { colIdx, startX: e.clientX, startWidth: colWidths[colIdx] };
    document.body.style.userSelect = 'none';
    document.body.style.cursor     = 'col-resize';

    function onMove(mv: MouseEvent) {
      if (!dragRef.current) return;
      const newWidth = Math.max(COLS[dragRef.current.colIdx]!.minWidth, dragRef.current.startWidth + mv.clientX - dragRef.current.startX);
      setColWidths(prev => prev.map((w, i) => i === dragRef.current!.colIdx ? newWidth : w));
    }
    function onUp() {
      dragRef.current = null;
      document.body.style.userSelect = '';
      document.body.style.cursor     = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onUp);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
  }

  // ── Sort ─────────────────────────────────────────────────────────────────────

  function handleSort(key: string) {
    if (sortBy === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortBy(key); setSortDir('desc'); }
    setPage(1);
  }

  // ── Filter ───────────────────────────────────────────────────────────────────

  function handleFilterChange(field: keyof Filters, value: string) {
    const next = { ...pending, [field]: value };
    setPending(next);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => { setFilters(next); setPage(1); }, 350);
  }

  function clearFilters() { setPending(EMPTY_FILTERS); setFilters(EMPTY_FILTERS); setPage(1); }

  // ── Early return after all hooks ─────────────────────────────────────────────

  if (!open) return null;

  // ── Derived ──────────────────────────────────────────────────────────────────

  const totalPages = result ? Math.max(1, Math.ceil(result.total / PAGE_SIZE)) : 1;
  const hasFilters = Object.values(pending).some(Boolean);

  function SortIcon({ colKey }: { colKey: string }) {
    if (sortBy !== colKey) return <ChevronsUpDown className="h-3 w-3 opacity-30 shrink-0" />;
    return sortDir === 'asc'
      ? <ChevronUp   className="h-3 w-3 text-primary shrink-0" />
      : <ChevronDown className="h-3 w-3 text-primary shrink-0" />;
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm ${maximized ? 'p-0' : 'p-4'}`}
      onClick={() => {}}
    >
      <div className={`flex flex-col bg-background border border-border shadow-2xl ${
        maximized ? 'w-full h-full rounded-none' : 'w-full max-w-6xl h-[90vh] rounded-xl'
      }`}>

        {/* Header */}
        <div className="flex items-center gap-2 px-4 border-b border-border min-h-[52px] shrink-0">
          <div className="flex-1 min-w-0 flex items-center gap-2">
            <span className="text-sm font-semibold">Access Log</span>
            {result && (
              <span className="text-xs text-muted-foreground">{result.total.toLocaleString()} entries</span>
            )}
            {loading && <span className="text-[11px] text-muted-foreground">Loading…</span>}
          </div>
          {hasFilters && (
            <button
              onClick={clearFilters}
              className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground px-2 py-1 rounded hover:bg-accent/50 transition-colors"
            >
              <X className="h-3 w-3" /> Clear filters
            </button>
          )}
          <button onClick={() => setMaximized(m => !m)} className={ICON_BTN} title={maximized ? 'Restore' : 'Maximize'}>
            {maximized ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </button>
          <button onClick={onClose} className={ICON_BTN} title="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Table */}
        <div className="flex-1 overflow-auto min-h-0">
          <table className="w-full text-xs border-collapse" style={{ tableLayout: 'fixed' }}>
            <colgroup>
              {colWidths.map((w, i) => <col key={i} style={{ width: `${w}px` }} />)}
            </colgroup>
            <thead className="sticky top-0 z-10">
              <tr className="bg-muted/90 backdrop-blur-sm">
                {COLS.map((col, ci) => (
                  <th
                    key={col.key}
                    onClick={() => handleSort(col.sortKey)}
                    className="relative px-3 py-2 text-left font-medium text-muted-foreground whitespace-nowrap cursor-pointer hover:text-foreground select-none border-b border-border overflow-hidden"
                  >
                    <div className="flex items-center gap-1 overflow-hidden">
                      <span className="truncate">{col.label}</span>
                      <SortIcon colKey={col.sortKey} />
                    </div>
                    <div
                      className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize hover:bg-primary/40 active:bg-primary/60 z-10"
                      onMouseDown={e => startResize(e, ci)}
                    />
                  </th>
                ))}
              </tr>
              <tr className="bg-muted/60 backdrop-blur-sm">
                {COLS.map(col => (
                  <th key={col.key} className="px-2 py-1 border-b border-border overflow-hidden">
                    {col.filterKey ? (
                      <input
                        type="text"
                        value={pending[col.filterKey]}
                        onChange={e => handleFilterChange(col.filterKey!, e.target.value)}
                        placeholder="Filter…"
                        className="w-full text-[11px] bg-background border border-border rounded px-1.5 py-0.5 text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-ring"
                      />
                    ) : (
                      <div className="h-[22px]" />
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result?.items.length === 0 && (
                <tr>
                  <td colSpan={COLS.length} className="px-3 py-8 text-center text-muted-foreground">
                    No entries match the current filters
                  </td>
                </tr>
              )}
              {result?.items.map((item, i) => (
                <tr key={`${item.ts}-${i}`} className="border-b border-border/40 hover:bg-muted/30 transition-colors">
                  <td className="px-3 py-1.5 tabular-nums whitespace-nowrap overflow-hidden text-ellipsis text-muted-foreground">{fmtDateTime(item.ts)}</td>
                  <td className="px-3 py-1.5 overflow-hidden text-ellipsis whitespace-nowrap">{item.region}</td>
                  <td className="px-3 py-1.5 overflow-hidden text-ellipsis whitespace-nowrap">{item.subdomain}</td>
                  <td className="px-3 py-1.5 overflow-hidden text-ellipsis whitespace-nowrap text-muted-foreground" title={item.alias}>{item.alias}</td>
                  <td className="px-3 py-1.5 overflow-hidden text-ellipsis whitespace-nowrap" title={item.spaceName}>{item.spaceName}</td>
                  <td className="px-3 py-1.5 overflow-hidden text-ellipsis whitespace-nowrap">
                    {item.appGuid && onOpenApp ? (
                      <button
                        onClick={() => onOpenApp(item.region, item.subdomain, item.appGuid, item.spaceName, item.appName)}
                        className="text-primary hover:underline text-left w-full truncate block"
                        title={item.appName}
                      >
                        {item.appName || item.appGuid}
                      </button>
                    ) : (
                      <span title={item.appName}>{item.appName}</span>
                    )}
                  </td>
                  <td className="px-3 py-1.5 overflow-hidden text-ellipsis whitespace-nowrap">{item.country}</td>
                  <td className="px-3 py-1.5 overflow-hidden text-ellipsis whitespace-nowrap">{item.city}</td>
                  <td className="px-3 py-1.5 overflow-hidden text-ellipsis whitespace-nowrap text-muted-foreground" title={item.userId}>{item.userId || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        <div className="px-6 py-2.5 border-t border-border shrink-0 flex items-center gap-4 text-xs text-muted-foreground">
          <span>
            {result
              ? `${((page - 1) * PAGE_SIZE + 1).toLocaleString()}–${Math.min(page * PAGE_SIZE, result.total).toLocaleString()} of ${result.total.toLocaleString()}`
              : '—'}
          </span>
          <div className="flex items-center gap-1 ml-auto">
            <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1}
              className="px-2 py-1 rounded border border-border hover:bg-accent disabled:opacity-40 disabled:cursor-not-allowed">
              ‹ Prev
            </button>
            <span className="px-2 tabular-nums">{page} / {totalPages}</span>
            <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page >= totalPages}
              className="px-2 py-1 rounded border border-border hover:bg-accent disabled:opacity-40 disabled:cursor-not-allowed">
              Next ›
            </button>
          </div>
        </div>

      </div>
    </div>
  );
}
