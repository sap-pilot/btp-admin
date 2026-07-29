import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLiveEvents } from '@/hooks/useLiveEvents';

function fmtUptime(n: number): string {
  return parseFloat(n.toFixed(2)) === 100 ? '100%' : `${n.toFixed(2)}%`;
}
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import type { EvaluationMode, HistoryFile, ServiceConfig, ServiceSummary } from '@shared/types';
import StatusDots from '@/components/status/StatusDots';
import ResponseTimeChart from '@/components/status/ResponseTimeChart';
import ResponseDetailModal from '@/components/status/ResponseDetailModal';
import TestModal from '@/components/status/TestModal';
import { useTimeRange, fmtDateRange } from '@/hooks/useTimeRange';
import DateRangePicker from '@/components/DateRangePicker';
import { parseFilename } from '@/lib/parseFilename';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ArrowLeft, AlertCircle, ChevronDown, ExternalLink, MoreHorizontal, PanelLeft, PlayCircle, Star } from 'lucide-react';
import { useWindowWidth } from '@/hooks/useWindowWidth';
import { useAuth } from '@/hooks/useAuth';
import { useSidebar } from '@/components/AppLayout';

const HOUR_OPTIONS = [
  { value: '1', label: 'Last 1 hour' },
  { value: '6', label: 'Last 6 hours' },
  { value: '12', label: 'Last 12 hours' },
  { value: '24', label: 'Last 24 hours' },
  { value: '48', label: 'Last 48 hours' },
  { value: '72', label: 'Last 72 hours' },
  { value: 'range', label: 'Date Range…' },
  { value: 'starred', label: 'All Time Starred' },
];

const SCHEDULE_OPTIONS = [
  { value: '300', label: 'Every 5 min' },
  { value: '600', label: 'Every 10 min' },
  { value: '900', label: 'Every 15 min' },
  { value: '1800', label: 'Every 30 min' },
  { value: '3600', label: 'Every 1 hour' },
  { value: '0', label: 'Disable autorun' },
];

function statusDotClass(status: ServiceSummary['rangeStatus']): string {
  if (status === 'ok') return 'bg-green-500';
  if (status === 'warning') return 'bg-amber-400';
  if (status === 'error') return 'bg-red-500';
  return 'bg-gray-500';
}

function evalTriggerClass(mode: EvaluationMode): string {
  if (mode === 'alwaysok') return 'bg-emerald-950 border-emerald-700 text-emerald-300 hover:bg-emerald-900';
  if (mode === 'alwayserror') return 'bg-red-950 border-red-700 text-red-400 hover:bg-red-900';
  return ''; // condition: default shadcn trigger styling
}

function formatTs(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

export default function History() {
  const { name = '' } = useParams<{ name: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const backTo = new URLSearchParams(location.search).get('from') ?? '/status';
  const autoOpenFilename = (location.state as { autoOpenFilename?: string } | null)?.autoOpenFilename;
  const autoOpenHandled = useRef(false);
  const initialHash = useRef(location.hash.slice(1));
  const auth = useAuth();
  const { toggle: toggleSidebar } = useSidebar();
  const adminTooltip = auth.enabled && auth.loggedIn && !auth.isAdmin
    ? 'Condition and schedule change are available for BTP_Status_Admin only; Contact security to get this role collection assigned to enable them'
    : undefined;
  const windowWidth = useWindowWidth();
  const dotAreaWidth = Math.min(windowWidth, 1024) - 140 - 90;
  const maxDots = Math.max(8, Math.floor(dotAreaWidth / 12));
  const isMobile = windowWidth < 640;

  const { range, setRange: setRangeBase, queryString } = useTimeRange(location.search);
  const [starredMode, setStarredMode] = useState(false);
  function setRange(next: Parameters<typeof setRangeBase>[0]) {
    setStarredMode(false);
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
  const [summaries, setSummaries] = useState<ServiceSummary[]>([]);
  const [files, setFiles] = useState<HistoryFile[]>([]);
  const [service, setService] = useState<ServiceConfig | null>(null);
  const [selected, setSelected] = useState<HistoryFile | null>(null);
  const [testOpen, setTestOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Evaluation mode
  const [evalMode, setEvalMode] = useState<EvaluationMode>('condition');
  const [pendingEvalMode, setPendingEvalMode] = useState<EvaluationMode | null>(null);
  const [evalConfirmOpen, setEvalConfirmOpen] = useState(false);

  // Schedule
  const [scheduleInterval, setScheduleInterval] = useState<number | null>(null);
  const [lastChecked, setLastChecked] = useState<Date>(new Date());

  // Table filters — initialise from URL params so diagram node clicks pre-filter
  const lastFetchTsRef = useRef<number>(Date.now());

  const [filterEndpoint, setFilterEndpoint] = useState(() => new URLSearchParams(location.search).get('endpoint') ?? 'all');
  const [filterLocation, setFilterLocation] = useState(() => new URLSearchParams(location.search).get('location') ?? 'all');
  const [filterStatus, setFilterStatus] = useState(() => new URLSearchParams(location.search).get('status') ?? 'all');
  const [filterTag, setFilterTag] = useState(() => new URLSearchParams(location.search).get('tag') ?? 'all');

  // Re-apply URL params when navigating to same route with different params
  useEffect(() => {
    const p = new URLSearchParams(location.search);
    setFilterEndpoint(p.get('endpoint') ?? 'all');
    setFilterLocation(p.get('location') ?? 'all');
    setFilterStatus(p.get('status') ?? 'all');
    setFilterTag(p.get('tag') ?? 'all');
  // Only re-run when the search string itself changes
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.search]);

  useEffect(() => {
    fetch('/api/status/services')
      .then(r => r.json() as Promise<ServiceConfig[]>)
      .then(svcs => {
        const found = svcs.find(s => s.name === name);
        if (!found) { navigate('/status'); return; }
        setService(found);
      })
      .catch(() => null);
    fetch('/api/info')
      .then(r => r.json() as Promise<{ maxStorageDays?: number }>)
      .then(d => {
        if (d.maxStorageDays !== undefined) setMaxStorageDays(d.maxStorageDays);
      })
      .catch(() => null);
  }, [name, navigate]);

  useEffect(() => {
    fetch(`/api/status/eval-mode/${encodeURIComponent(name)}`)
      .then(r => r.json() as Promise<{ mode: EvaluationMode }>)
      .then(d => setEvalMode(d.mode))
      .catch(() => null);
    fetch(`/api/status/schedule/${encodeURIComponent(name)}`)
      .then(r => r.json() as Promise<{ intervalSeconds: number }>)
      .then(d => setScheduleInterval(d.intervalSeconds))
      .catch(() => null);
  }, [name]);

  const effectiveQueryString = starredMode ? 'tag=starred' : queryString;

  const fetchHistory = useCallback(() => {
    setLoading(true);
    setError(null);
    fetch(`/api/status/history/${encodeURIComponent(name)}?${effectiveQueryString}`)
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<{ lastModified: number; files: string[] }>;
      })
      .then(({ lastModified, files: d }) => {
        lastFetchTsRef.current = lastModified;
        setFiles(d.map(fn => parseFilename(fn) ?? { filename: fn + '.json', overallStatus: 200 as const }));
        setLastChecked(new Date());
      })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  }, [name, effectiveQueryString]);

  useEffect(() => { fetchHistory(); }, [fetchHistory]);

  const fetchDelta = useCallback(() => {
    const since = lastFetchTsRef.current - 5_000;
    fetch(`/api/status/history/${encodeURIComponent(name)}?since=${since}`)
      .then(r => r.ok ? r.json() as Promise<{ lastModified: number; files: string[] }> : null)
      .then(data => {
        if (data === null) return;
        lastFetchTsRef.current = data.lastModified;
        setLastChecked(new Date());
        const incoming = data.files.map(fn => parseFilename(fn) ?? { filename: fn + '.json', overallStatus: 200 as const });
        setFiles(prev => {
          const toCanonical = (fn: string) => fn.replace('.starred.', '.');
          const incomingNames = new Set(incoming.map(f => f.filename));
          const incomingCanonicals = new Set(incoming.map(f => toCanonical(f.filename)));
          const kept = prev.filter(f =>
            !incomingNames.has(f.filename) && !incomingCanonicals.has(toCanonical(f.filename)),
          );
          const merged = [...incoming, ...kept].sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
          // Drop files that have slid outside the current time window
          if (!starredMode && range.mode === 'hours') {
            const cutoff = Date.now() - range.hours * 3_600_000;
            return merged.filter(f => (f.timestamp ?? 0) >= cutoff);
          }
          return merged;
        });
      })
      .catch(() => null);
  }, [name, range, starredMode]);

  // Disable live updates when viewing a fixed date range (new files would be outside the range)
  useLiveEvents(range.mode === 'dateRange' ? null : name, fetchDelta);

  useEffect(() => {
    fetch(`/api/status/service-summary?${queryString}`)
      .then(r => r.json() as Promise<ServiceSummary[]>)
      .then(d => setSummaries(d))
      .catch(() => null);
  }, [queryString]);

  useEffect(() => {
    document.title = `${name} - BTP Service Status`;
  }, [name]);

  function openFile(file: HistoryFile | null) {
    setSelected(file);
    const base = `/status/${encodeURIComponent(name)}`;
    const search = window.location.search;
    if (file) {
      const hash = file.filename.replace(/\.(json|png)$/, '');
      window.history.replaceState(null, '', `${base}${search}#${hash}`);
    } else {
      window.history.replaceState(null, '', `${base}${search}`);
    }
  }

  useEffect(() => {
    if (autoOpenHandled.current || files.length === 0) return;
    const target = initialHash.current || autoOpenFilename;
    if (!target) return;
    const match = files.find(
      f => f.filename === target || f.filename === `${target}.json`,
    );
    if (match) {
      openFile(match);
      autoOpenHandled.current = true;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, autoOpenFilename]);

  async function applyEvalMode(m: EvaluationMode) {
    try {
      await fetch(`/api/status/eval-mode/${encodeURIComponent(name)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: m }),
      });
      setEvalMode(m);
    } catch { /* ignore */ }
  }

  function handleEvalModeChange(newMode: string) {
    const m = newMode as EvaluationMode;
    if (m === evalMode) return;
    if (m === 'condition') {
      void applyEvalMode('condition');
    } else {
      setPendingEvalMode(m);
      setEvalConfirmOpen(true);
    }
  }

  async function confirmEvalMode() {
    if (!pendingEvalMode) return;
    const m = pendingEvalMode;
    setPendingEvalMode(null);
    setEvalConfirmOpen(false);
    await applyEvalMode(m);
  }

  function cancelEvalMode() {
    setPendingEvalMode(null);
    setEvalConfirmOpen(false);
  }

  async function applySchedule(intervalSeconds: number) {
    try {
      await fetch(`/api/status/schedule/${encodeURIComponent(name)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ intervalSeconds }),
      });
      setScheduleInterval(intervalSeconds);
    } catch { /* ignore */ }
  }

  const failedCount = files.filter(f => f.overallStatus === 500 || f.overallStatus === 503 || f.overallStatus === 504).length;
  const partiallyFailedCount = files.filter(f => f.overallStatus === 400).length;

  const endpointLabel = (f: HistoryFile): string => {
    if (f.endpointSlug !== undefined) {
      // New-format file: try to match sanitized config name, else show slug as-is
      const match = service?.endpoints.find(
        e => (e.name ?? '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '') === f.endpointSlug,
      );
      return match?.name ?? f.endpointSlug;
    }
    return service?.endpoints[f.endpointIndex ?? 0]?.name ?? `Endpoint ${f.endpointIndex ?? 0}`;
  };


  const endpointOptions = useMemo(() => {
    const seen = new Set<string>();
    const opts: string[] = [];
    for (const f of files) {
      const label = endpointLabel(f);
      if (!seen.has(label)) { seen.add(label); opts.push(label); }
    }
    return opts.sort();
  // endpointLabel depends on service
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, service]);

  const locationOptions = useMemo(() => {
    const seen = new Set<string>();
    for (const f of files) if (f.city) seen.add(f.city);
    return [...seen].sort();
  }, [files]);

  const hasFilter = filterEndpoint !== 'all' || filterLocation !== 'all' || filterStatus !== 'all' || filterTag !== 'all';

  const filteredFiles = useMemo(() => {
    if (!hasFilter) return files;
    return files.filter(f => {
      if (filterEndpoint !== 'all' && endpointLabel(f) !== filterEndpoint) return false;
      if (filterLocation !== 'all' && (f.city ?? '—') !== filterLocation) return false;
      if (filterStatus !== 'all') {
        if (filterStatus === 'failed') {
          if (f.overallStatus !== 500 && f.overallStatus !== 503 && f.overallStatus !== 504) return false;
        } else if (filterStatus === 'partial') {
          if (f.overallStatus !== 400) return false;
        } else if (String(f.overallStatus) !== filterStatus) {
          return false;
        }
      }
      if (filterTag === 'starred' && !f.starred) return false;
      return true;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, service, filterEndpoint, filterLocation, filterStatus, filterTag, hasFilter]);

  // Files for the response time chart: filtered by endpoint + location only (status does not affect the chart)
  const chartFiles = useMemo(() => {
    if (filterEndpoint === 'all' && filterLocation === 'all') return files;
    return files.filter(f => {
      if (filterEndpoint !== 'all' && endpointLabel(f) !== filterEndpoint) return false;
      if (filterLocation !== 'all' && (f.city ?? '—') !== filterLocation) return false;
      return true;
    });
  // endpointLabel depends on service
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, service, filterEndpoint, filterLocation]);

  function setSearchParam(updates: Record<string, string | null>) {
    const p = new URLSearchParams(location.search);
    for (const [k, v] of Object.entries(updates)) {
      if (v === null) p.delete(k);
      else p.set(k, v);
    }
    const qs = p.toString();
    navigate(qs ? `?${qs}` : location.pathname, { replace: true });
  }

  function clearFilters() {
    setFilterEndpoint('all');
    setFilterLocation('all');
    setFilterStatus('all');
    setFilterTag('all');
    setStarredMode(false);
    setSearchParam({ endpoint: null, location: null, status: null, tag: null });
  }

  const canStar = !auth.enabled || auth.loggedIn;
  const starDisabledTooltip = 'Log in to star/unstar response files';

  async function toggleStar(f: HistoryFile) {
    const newStar = !f.starred;
    const newFilename = newStar
      ? f.filename.replace(/\.json$/, '.starred.json')
      : f.filename.replace('.starred.json', '.json');
    try {
      const res = await fetch(`/api/status/star/${encodeURIComponent(name)}/${encodeURIComponent(f.filename)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ star: newStar }),
      });
      if (!res.ok) return;
      setFiles(prev => prev.map(file =>
        file.filename === f.filename
          ? { ...file, starred: newStar, filename: newFilename }
          : file,
      ));
    } catch { /* ignore */ }
  }

  // Build schedule select value — may not match a preset if config uses a custom interval
  const scheduleValue = scheduleInterval !== null ? String(scheduleInterval) : '';
  const scheduleOptions = [...SCHEDULE_OPTIONS];
  if (
    scheduleInterval !== null &&
    !SCHEDULE_OPTIONS.find(o => o.value === String(scheduleInterval))
  ) {
    const mins = scheduleInterval / 60;
    scheduleOptions.unshift({ value: String(scheduleInterval), label: `Every ${mins}min (config)` });
  }

  return (
    <div className="flex flex-col h-full bg-background text-foreground">
      {/* Page toolbar */}
      <div className="border-b border-border bg-background px-3 flex items-center gap-2 shrink-0 min-h-[52px]">
        <button
          onClick={toggleSidebar}
          className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors shrink-0"
          title="Toggle sidebar"
        >
          <PanelLeft className="h-4 w-4" />
        </button>
        <Link
          to={backTo}
          className="flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors text-sm"
        >
          <ArrowLeft className="h-4 w-4" />
          Status Overview
        </Link>
        <span className="text-muted-foreground">/</span>
        <span className="font-semibold text-sm">{name}</span>
        {summaries.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="text-muted-foreground hover:text-foreground transition-colors" title="Switch service">
                <ChevronDown className="h-4 w-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-60 max-h-80 overflow-y-auto">
              {Object.entries(
                summaries.reduce<Record<string, ServiceSummary[]>>((acc, s) => {
                  (acc[s.group] ??= []).push(s);
                  return acc;
                }, {}),
              ).map(([group, svcs], gi) => (
                <div key={group}>
                  {gi > 0 && <DropdownMenuSeparator />}
                  <DropdownMenuLabel className="text-xs font-normal text-muted-foreground px-2 py-1">
                    {group}
                  </DropdownMenuLabel>
                  {svcs.map(s => (
                    <DropdownMenuItem
                      key={s.name}
                      onSelect={() => navigate(`/status/${encodeURIComponent(s.name)}`)}
                      className="flex items-center gap-2 cursor-pointer"
                    >
                      <span className={`w-2 h-2 rounded-full flex-shrink-0 ${statusDotClass(s.rangeStatus)}`} />
                      <span className={`truncate flex-1 ${s.name === name ? 'font-semibold' : ''}`}>{s.name}</span>
                      {s.name === name && <span className="text-muted-foreground text-xs ml-auto flex-shrink-0">current</span>}
                    </DropdownMenuItem>
                  ))}
                </div>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {service?.homepage && (
          <a href={service.homepage} target="_blank" rel="noopener noreferrer" title={`Open ${name} homepage`}
            className="text-muted-foreground hover:text-foreground transition-colors">
            <ExternalLink className="h-4 w-4" />
          </a>
        )}
        {/* Desktop controls */}
        <div className="ml-auto hidden sm:flex items-center gap-2">
          {(!auth.enabled || auth.loggedIn) && (
            <span title={adminTooltip}>
              <Select value={evalMode} onValueChange={handleEvalModeChange} disabled={auth.enabled && auth.loggedIn && !auth.isAdmin}>
                <SelectTrigger className={`h-8 text-xs w-36 ${evalTriggerClass(evalMode)}`}><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="condition" className="text-xs">Condition Based</SelectItem>
                  <SelectItem value="alwaysok" className="text-xs text-emerald-400">Always OK</SelectItem>
                  <SelectItem value="alwayserror" className="text-xs text-red-400">Always Error</SelectItem>
                </SelectContent>
              </Select>
            </span>
          )}
          {(!auth.enabled || auth.loggedIn) && (
            <span title={adminTooltip}>
              <Select value={scheduleValue} onValueChange={(v: string) => void applySchedule(Number(v))}
                disabled={scheduleInterval === null || (auth.enabled && auth.loggedIn && !auth.isAdmin)}>
                <SelectTrigger className="h-8 text-xs w-36"><SelectValue placeholder="Schedule…" /></SelectTrigger>
                <SelectContent>
                  {scheduleOptions.map(o => <SelectItem key={o.value} value={o.value} className="text-xs">{o.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </span>
          )}
          <Select
            value={starredMode ? 'starred' : (range.mode === 'dateRange' ? '' : String(range.hours))}
            onValueChange={(v: string) => {
              if (v === 'starred') { setStarredMode(true); setFilterTag('starred'); setSearchParam({ tag: 'starred', hours: null }); }
              else if (v === 'range') { setDatePickerOpen(true); }
              else setRange({ mode: 'hours', hours: Number(v) });
            }}
          >
            <SelectTrigger className="w-36 h-8 text-xs">
              {!starredMode && range.mode === 'dateRange'
                ? <span className="truncate">{fmtDateRange(range.fromDate, range.untilDate)}</span>
                : <SelectValue />
              }
            </SelectTrigger>
            <SelectContent>
              {HOUR_OPTIONS.map(o => <SelectItem key={o.value} value={o.value} className="text-xs">{o.label}</SelectItem>)}
            </SelectContent>
          </Select>
          {(!auth.enabled || auth.loggedIn) && (
            <Button size="sm" variant="outline" className="h-8 gap-1.5 text-xs" onClick={() => setTestOpen(true)}>
              <PlayCircle className="h-3.5 w-3.5" />Run Test
            </Button>
          )}
        </div>

        {/* Mobile collapsed menu */}
        <div className="ml-auto flex sm:hidden items-center">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors" title="More options">
                <MoreHorizontal className="h-4 w-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuLabel className="text-xs text-muted-foreground font-normal">Time Range</DropdownMenuLabel>
              {HOUR_OPTIONS.filter(o => o.value !== 'range' && o.value !== 'starred').map(o => (
                <DropdownMenuItem
                  key={o.value}
                  className={`text-xs cursor-pointer${!starredMode && range.mode === 'hours' && String(range.hours) === o.value ? ' font-semibold' : ''}`}
                  onSelect={() => { setStarredMode(false); setRange({ mode: 'hours', hours: Number(o.value) }); }}
                >
                  {o.label}
                </DropdownMenuItem>
              ))}
              <DropdownMenuItem className="text-xs cursor-pointer" onSelect={() => setDatePickerOpen(true)}>Date Range…</DropdownMenuItem>
              <DropdownMenuItem className={`text-xs cursor-pointer${starredMode ? ' font-semibold' : ''}`}
                onSelect={() => { setStarredMode(true); setFilterTag('starred'); setSearchParam({ tag: 'starred', hours: null }); }}>
                All Time Starred
              </DropdownMenuItem>
              {(!auth.enabled || auth.loggedIn) && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel className="text-xs text-muted-foreground font-normal">Evaluation Mode</DropdownMenuLabel>
                  {(['condition', 'alwaysok', 'alwayserror'] as const).map(m => (
                    <DropdownMenuItem
                      key={m}
                      className={`text-xs cursor-pointer${evalMode === m ? ' font-semibold' : ''}${auth.enabled && auth.loggedIn && !auth.isAdmin ? ' opacity-50 pointer-events-none' : ''}`}
                      onSelect={() => handleEvalModeChange(m)}
                    >
                      {m === 'condition' ? 'Condition Based' : m === 'alwaysok' ? 'Always OK' : 'Always Error'}
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel className="text-xs text-muted-foreground font-normal">Schedule</DropdownMenuLabel>
                  {scheduleOptions.map(o => (
                    <DropdownMenuItem
                      key={o.value}
                      className={`text-xs cursor-pointer${scheduleValue === o.value ? ' font-semibold' : ''}${scheduleInterval === null || (auth.enabled && auth.loggedIn && !auth.isAdmin) ? ' opacity-50 pointer-events-none' : ''}`}
                      onSelect={() => void applySchedule(Number(o.value))}
                    >
                      {o.label}
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem className="text-xs cursor-pointer" onSelect={() => setTestOpen(true)}>
                    <PlayCircle className="h-3.5 w-3.5 mr-2" />Run Test
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <DateRangePicker
        open={datePickerOpen}
        onClose={() => setDatePickerOpen(false)}
        onApply={(from, until) => setRange({ mode: 'dateRange', fromDate: from, untilDate: until })}
        fromDate={range.mode === 'dateRange' ? range.fromDate : new Date(Date.now() - 86400000).toISOString().slice(0, 10)}
        untilDate={range.mode === 'dateRange' ? range.untilDate : new Date().toISOString().slice(0, 10)}
        maxStorageDays={maxStorageDays}
      />

      <main className="flex-1 overflow-auto px-4 py-6 space-y-6">
        {error && (
          <div className="flex items-center gap-2 text-destructive text-sm">
            <AlertCircle className="h-4 w-4" />
            {error}
          </div>
        )}

        {/* Stats */}
        <div className="stat-grid grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4">
          <Card
            className="cursor-pointer hover:bg-muted/50 transition-colors"
            onClick={clearFilters}
            title="Clear all filters"
          >
            <CardContent className="pt-4 text-center">
              <div className="text-base sm:text-2xl font-bold">{files.length}</div>
              <div className="text-xs text-muted-foreground mt-1">Total Checks</div>
            </CardContent>
          </Card>
          <Card
            className={`transition-colors${failedCount > 0 ? ' cursor-pointer hover:bg-muted/50' : ''}${filterStatus === 'failed' ? ' ring-1 ring-red-500/60' : ''}`}
            onClick={failedCount > 0 ? () => { const next = filterStatus === 'failed' ? 'all' : 'failed'; setFilterStatus(next); setSearchParam({ status: next === 'all' ? null : next }); } : undefined}
            title={failedCount > 0 ? (filterStatus === 'failed' ? 'Clear filter' : 'Show completely failed checks') : undefined}
          >
            <CardContent className="pt-4 text-center">
              <div className={`text-base sm:text-2xl font-bold ${failedCount > 0 ? 'text-red-500' : ''}`}>{failedCount}</div>
              <div className="text-xs text-muted-foreground mt-1">Completely Failed</div>
            </CardContent>
          </Card>
          <Card
            className={`transition-colors${partiallyFailedCount > 0 ? ' cursor-pointer hover:bg-muted/50' : ''}${filterStatus === 'partial' ? ' ring-1 ring-orange-500/60' : ''}`}
            onClick={partiallyFailedCount > 0 ? () => { const next = filterStatus === 'partial' ? 'all' : 'partial'; setFilterStatus(next); setSearchParam({ status: next === 'all' ? null : next }); } : undefined}
            title={partiallyFailedCount > 0 ? (filterStatus === 'partial' ? 'Clear filter' : 'Show partially failed checks (initial failed, retry succeeded)') : undefined}
          >
            <CardContent className="pt-4 text-center">
              <div className={`text-base sm:text-2xl font-bold ${partiallyFailedCount > 0 ? 'text-orange-400' : ''}`}>{partiallyFailedCount}</div>
              <div className="text-xs text-muted-foreground mt-1">Partially Failed</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 text-center">
              <div className="text-base sm:text-2xl font-bold tabular-nums">
                {lastChecked.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}
              </div>
              <div className="text-xs text-muted-foreground mt-1">Last Checked</div>
            </CardContent>
          </Card>
        </div>

        {/* Timeline card — per-endpoint rows */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Status Timeline
            </CardTitle>
          </CardHeader>
          <CardContent>
            {service ? (
              <table className="w-full table-fixed">
                <colgroup>
                  <col className="w-[170px]" />
                  <col />
                  <col className="w-[110px]" />
                </colgroup>
                <tbody>
                  {service.endpoints.map((ep, ei) => {
                    const slug = (ep.name ?? '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'endpoint';
                    const epFiles = files.filter(f =>
                      f.endpointSlug !== undefined ? f.endpointSlug === slug : f.endpointIndex === ei,
                    );
                    const upCount = epFiles.filter(f => f.overallStatus === 200 || f.overallStatus === 203).length;
                    const epUptime = epFiles.length > 0 ? (upCount / epFiles.length) * 100 : 100;
                    const lastEpTs = epFiles.reduce((max, f) => Math.max(max, f.timestamp ?? 0), 0);
                    const lastEpFailed = epFiles.some(
                      f => Math.floor((f.timestamp ?? 0) / 1000) === Math.floor(lastEpTs / 1000) &&
                           (f.overallStatus === 500 || f.overallStatus === 503 || f.overallStatus === 504),
                    );
                    const lastEpPartial = epFiles.some(
                      f => Math.floor((f.timestamp ?? 0) / 1000) === Math.floor(lastEpTs / 1000) &&
                           f.overallStatus === 400,
                    );
                    const epBadgeCls = epFiles.length === 0 ? 'text-muted-foreground border-border' :
                      lastEpFailed ? 'border-red-600 text-red-400' :
                      lastEpPartial || epUptime < 100 ? 'border-yellow-600 text-yellow-400' :
                      'border-green-600 text-green-400';
                    return (
                      <tr key={ei} className="border-b border-border last:border-0">
                        <td className="py-2 pr-3 align-middle">
                          <div className="flex items-center gap-1 min-w-0">
                            <button
                              className="text-xs hover:underline truncate text-left flex-1 min-w-0"
                              title={`Filter by ${ep.name}`}
                              onClick={() => { setFilterEndpoint(ep.name ?? slug); setSearchParam({ endpoint: ep.name ?? slug }); }}
                            >
                              {ep.name ?? ep.url}
                            </button>
                            {ep.url.startsWith('http') && (
                              <a
                                href={ep.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="flex-shrink-0 text-muted-foreground hover:text-foreground"
                                title={ep.url}
                              >
                                <ExternalLink className="h-3 w-3" />
                              </a>
                            )}
                          </div>
                        </td>
                        <td className="py-2 px-0 align-middle">
                          <StatusDots history={epFiles} maxDots={maxDots} showUptime={false} showAvg={false} onDotClick={f => openFile(f)} />
                        </td>
                        <td className="py-2 pl-2 align-middle text-right">
                          <Badge variant="outline" className={`text-xs ${epBadgeCls}`}>
                            {epFiles.length > 0 ? `${fmtUptime(epUptime)} up` : 'no data'}
                          </Badge>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              <StatusDots history={files} maxDots={maxDots} showUptime={false} showAvg={false} onDotClick={f => openFile(f)} />
            )}
          </CardContent>
        </Card>

        {/* Response Time Chart */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Response Time
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ResponseTimeChart files={chartFiles} service={service} />
          </CardContent>
        </Card>

        {/* History table */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle className="text-sm font-medium text-muted-foreground shrink-0">
                History
              </CardTitle>
              {hasFilter && (
                <span className="text-xs text-muted-foreground shrink-0">
                  {filteredFiles.length} of {files.length}
                </span>
              )}
              {files.length > 0 && (
                <div className="ml-auto flex flex-wrap items-center gap-2">
                  {hasFilter && (
                    <button
                      onClick={clearFilters}
                      className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                    >
                      Clear filters
                    </button>
                  )}
                  <Select value={filterEndpoint} onValueChange={setFilterEndpoint}>
                    <SelectTrigger className="h-7 text-xs w-auto min-w-[9rem] max-w-[14rem]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all" className="text-xs">All endpoints</SelectItem>
                      {endpointOptions.map(ep => (
                        <SelectItem key={ep} value={ep} className="text-xs">{ep}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select value={filterLocation} onValueChange={(v: string) => { setFilterLocation(v); setSearchParam({ location: v === 'all' ? null : v }); }}>
                    <SelectTrigger className="h-7 text-xs w-auto min-w-[9rem] max-w-[14rem]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all" className="text-xs">All locations</SelectItem>
                      {locationOptions.map(loc => (
                        <SelectItem key={loc} value={loc} className="text-xs">{loc}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select value={filterStatus} onValueChange={(v: string) => { setFilterStatus(v); setSearchParam({ status: v === 'all' ? null : v }); }}>
                    <SelectTrigger className="h-7 text-xs w-40">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all" className="text-xs">All statuses</SelectItem>
                      <SelectItem value="failed" className="text-xs">Completely failed</SelectItem>
                      <SelectItem value="partial" className="text-xs">Partially failed</SelectItem>
                      <SelectItem value="200" className="text-xs">PASS</SelectItem>
                      <SelectItem value="203" className="text-xs">PASS (always ok)</SelectItem>
                      <SelectItem value="500" className="text-xs">FAIL</SelectItem>
                      <SelectItem value="503" className="text-xs">FAIL (always error)</SelectItem>
                      <SelectItem value="504" className="text-xs">TIMEOUT</SelectItem>
                    </SelectContent>
                  </Select>
                  <Select value={filterTag} onValueChange={(v: string) => { setFilterTag(v); setSearchParam({ tag: v === 'all' ? null : v }); }}>
                    <SelectTrigger className="h-7 text-xs w-28">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all" className="text-xs">All tags</SelectItem>
                      <SelectItem value="starred" className="text-xs">Starred</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {loading ? (
              <div className="text-muted-foreground text-sm p-4">Loading…</div>
            ) : files.length === 0 ? (
              <div className="text-muted-foreground text-sm p-4">
                No history in the selected time range.
              </div>
            ) : filteredFiles.length === 0 ? (
              <div className="text-muted-foreground text-sm p-4">
                No checks match the current filters.{' '}
                <button onClick={clearFilters} className="underline hover:text-foreground">
                  Clear filters
                </button>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Timestamp (local)</TableHead>
                    <TableHead>{isMobile ? 'Endpoint (Location)' : 'Endpoint'}</TableHead>
                    <TableHead className="hidden sm:table-cell">From Location</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="hidden sm:table-cell text-right">Response Time</TableHead>
                    <TableHead className="w-4" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredFiles.map(f => (
                    <TableRow
                      key={f.filename}
                      className={`cursor-pointer ${
                        f.overallStatus === 500 ? 'bg-red-950/20 hover:bg-red-950/30' :
                        f.overallStatus === 503 ? 'bg-red-950/30 hover:bg-red-950/40' :
                        f.overallStatus === 504 ? 'bg-orange-950/20 hover:bg-orange-950/30' :
                        f.overallStatus === 400 ? 'bg-orange-950/10 hover:bg-orange-950/20' :
                        'hover:bg-muted/30'
                      }`}
                      onClick={() => openFile(f)}
                    >
                      <TableCell className="text-xs font-mono">
                        {formatTs(f.timestamp ?? 0)}
                      </TableCell>
                      <TableCell className="text-sm">
                        {endpointLabel(f)}
                        {isMobile && (
                          <div className="text-xs text-muted-foreground mt-0.5">{f.city ?? '—'}</div>
                        )}
                      </TableCell>
                      <TableCell className="hidden sm:table-cell text-sm text-muted-foreground">
                        {f.city ?? '—'}
                      </TableCell>
                      <TableCell>
                        {f.overallStatus === 200 && (
                          <Badge variant="outline" className="text-xs border-green-600 text-green-400">PASS</Badge>
                        )}
                        {f.overallStatus === 203 && (
                          <Badge variant="outline" className="text-xs border-emerald-700 text-emerald-400">PASS (always ok)</Badge>
                        )}
                        {f.overallStatus === 400 && (
                          <Badge variant="outline" className="text-xs border-orange-500 text-orange-400">PARTIAL</Badge>
                        )}
                        {f.overallStatus === 500 && (
                          <Badge variant="destructive" className="text-xs">FAIL</Badge>
                        )}
                        {f.overallStatus === 503 && (
                          <Badge variant="destructive" className="text-xs bg-red-900 hover:bg-red-900">FAIL (always error)</Badge>
                        )}
                        {f.overallStatus === 504 && (
                          <Badge variant="outline" className="text-xs border-orange-600 text-orange-500">TIMEOUT</Badge>
                        )}
                        {isMobile && (
                          <div className="text-xs text-muted-foreground mt-0.5">{f.responseTime ?? 0}ms</div>
                        )}
                      </TableCell>
                      <TableCell className="hidden sm:table-cell text-right text-sm">
                        {f.responseTime ?? 0}ms
                      </TableCell>
                      <TableCell className="w-4 pl-0 pr-3 text-right">
                        <button
                          onClick={e => { e.stopPropagation(); if (canStar) void toggleStar(f); }}
                          title={canStar
                            ? (f.starred ? 'Unstar this record' : 'Star this record (retained indefinitely)')
                            : starDisabledTooltip}
                          className={`p-0.5 transition-colors ${
                            canStar
                              ? f.starred
                                ? 'text-yellow-400 hover:text-yellow-300 cursor-pointer'
                                : 'text-muted-foreground/40 hover:text-yellow-400 cursor-pointer'
                              : f.starred
                                ? 'text-yellow-400/50 cursor-not-allowed'
                                : 'text-muted-foreground/20 cursor-not-allowed'
                          }`}
                        >
                          <Star className={`h-3.5 w-3.5 ${f.starred ? 'fill-yellow-400' : ''} ${!canStar && f.starred ? 'opacity-50' : ''}`} />
                        </button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </main>

      <ResponseDetailModal
        file={selected}
        serviceName={name}
        onClose={() => openFile(null)}
        auth={auth}
      />

      <TestModal
        serviceName={name}
        open={testOpen}
        onClose={() => setTestOpen(false)}
        onComplete={fetchHistory}
      />

      {/* Confirmation dialog for evaluation mode changes */}
      <AlertDialog open={evalConfirmOpen} onOpenChange={(open: boolean) => { if (!open) cancelEvalMode(); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingEvalMode === 'alwaysok'
                ? 'Set evaluation mode to Always OK?'
                : 'Set evaluation mode to Always Error?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingEvalMode === 'alwaysok'
                ? `All executions for "${name}" — including scheduled checks, manual /health/${name} requests, and Run Test — will return 200 OK regardless of the actual condition check result. Results are still recorded with status 203. Select "Condition Based" to restore normal evaluation.`
                : `All executions for "${name}" — including scheduled checks, manual /health/${name} requests, and Run Test — will return 500 error regardless of the actual condition check result (a virtual failing condition is injected). Results are recorded with status 503. Select "Condition Based" to restore normal evaluation.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => { void confirmEvalMode(); }}
              className={pendingEvalMode === 'alwaysok'
                ? 'bg-emerald-700 hover:bg-emerald-800 text-white'
                : 'bg-red-700 hover:bg-red-800 text-white'}
            >
              Confirm
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
