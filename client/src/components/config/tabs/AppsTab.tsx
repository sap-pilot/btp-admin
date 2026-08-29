import { useEffect, useRef, useState } from 'react';
import {
  ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown,
  ExternalLink, PanelLeft, Play, RefreshCw, Square, X,
} from 'lucide-react';
import { useSettings } from '@/components/AppLayout';
import type { SubaccountEntry } from '@/components/config/SubaccountsTable';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';

// ─── Types ────────────────────────────────────────────────────────────────────

interface AppProcess {
  type:         string;
  instances:    number;
  memory_in_mb: number;
  disk_in_mb:   number;
}

interface AppFileData {
  guid:         string;
  name:         string;
  state:        string;
  spaceGuid:    string;
  region:       string;
  subdomain:    string;
  spaceName:    string;
  process?:     AppProcess;
  aod?:         boolean;
  urls?:        string[];
  lastUpdated:  number;
  lastAccessed?: number;
}

interface Props {
  sa:               SubaccountEntry;
  initialGuid?:     string;
  onAppDataChange?: () => void;
}

type SortCol = 'name' | 'state' | 'memory_in_mb' | 'disk_in_mb';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function deriveCockpitRegion(r: string): string {
  if (r.startsWith('us')) return 'amer';
  if (r.startsWith('eu')) return r.split('-')[0]!;
  if (r.startsWith('ap')) return 'ap21';
  if (r.startsWith('br')) return 'br10';
  if (r.startsWith('jp')) return 'jp10';
  if (r.startsWith('ca')) return 'ca10';
  if (r.startsWith('au')) return 'ap10';
  return r;
}

function buildAppCockpitUrl(sa: SubaccountEntry, app: AppFileData, cockpit: { idp: string; host: string }): string {
  const region   = deriveCockpitRegion(sa.region);
  const rawHost  = cockpit.host || `cockpit.${region}.hana.ondemand.com`;
  const base     = rawHost.startsWith('http') ? rawHost : `https://${rawHost}`;
  const idpParam = cockpit.idp ? `?idp=${encodeURIComponent(cockpit.idp)}` : '';
  return `${base}/cockpit${idpParam}#/globalaccount/${sa.globalAccountGUID}/subaccount/${sa.subaccountId}/org/${sa.org?.orgId ?? ''}/space/${app.spaceGuid}/applications/${app.guid}`;
}

function fmtMB(mb: number): string {
  if (mb >= 1000) return `${(mb / 1024).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
}

function fmtTs(secs: number): string {
  return new Date(secs * 1000).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function fmtShortDate(secs: number): string {
  return new Date(secs * 1000).toLocaleDateString([], { month: 'numeric', day: 'numeric', year: 'numeric' });
}

function StateBadge({ state, instances }: { state: string; instances?: number }) {
  const started = state === 'STARTED';
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] font-medium ${started ? 'text-green-600 dark:text-green-400' : 'text-muted-foreground'}`}>
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${started ? 'bg-green-500' : 'bg-muted-foreground/40'}`} />
      {state}{instances !== undefined ? ` ×${instances}` : ''}
    </span>
  );
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function AppsTab({ sa, initialGuid, onAppDataChange }: Props) {
  const { settings } = useSettings();
  const cockpit = settings?.homepage.cockpit ?? { idp: '', host: '' };

  const [apps,             setApps]             = useState<AppFileData[]>([]);
  const [loading,          setLoading]          = useState(false);
  const [selectedId,       setSelectedId]       = useState<string>(initialGuid ?? '');
  const [filterText,       setFilterText]       = useState('');
  const [expanded,         setExpanded]         = useState<Set<string>>(new Set());
  const [sortCol,          setSortCol]          = useState<SortCol>('memory_in_mb');
  const [sortDir,          setSortDir]          = useState<'asc' | 'desc'>('desc');
  const [leftVisible,      setLeftVisible]      = useState(true);
  const [splitPct,         setSplitPct]         = useState(40);
  const [appActionLoading, setAppActionLoading] = useState<'start' | 'stop' | null>(null);
  const [appActionError,   setAppActionError]   = useState<string | null>(null);
  const [showStopConfirm,  setShowStopConfirm]  = useState(false);
  const [saRefreshing,     setSaRefreshing]     = useState(false);
  const [saRefreshResult,  setSaRefreshResult]  = useState<{ updated: number; created: number; deleted: number } | null>(null);

  const bodyRef        = useRef<HTMLDivElement>(null);
  const splitResizeRef = useRef<{ startX: number; startPct: number; containerW: number } | null>(null);

  // ── Load apps ─────────────────────────────────────────────────────────────

  useEffect(() => {
    setSaRefreshResult(null);
    setLoading(true);
    fetch(`/api/apps/subaccount?region=${encodeURIComponent(sa.region)}&subdomain=${encodeURIComponent(sa.subdomain)}`)
      .then(r => r.json() as Promise<{ ok: boolean; data: AppFileData[] }>)
      .then(d => {
        if (!d.ok) return;
        setApps(d.data);
        const spaces = new Set(d.data.map(a => a.spaceName));
        setExpanded(spaces);
        if (initialGuid && d.data.some(a => a.guid === initialGuid)) {
          setSelectedId(initialGuid);
        } else if (!selectedId && d.data.length > 0) {
          setSelectedId(d.data[0]!.guid);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sa.region, sa.subdomain]);

  // ── Per-subaccount refresh ────────────────────────────────────────────────

  async function handleSaRefresh() {
    if (saRefreshing) return;
    setSaRefreshing(true);
    setSaRefreshResult(null);
    try {
      const res  = await fetch(`/api/apps/refresh-subaccount?region=${encodeURIComponent(sa.region)}&subdomain=${encodeURIComponent(sa.subdomain)}`, { method: 'POST' });
      const data = await res.json() as { ok: boolean; updated: number; created: number; deleted: number };
      if (data.ok) {
        setSaRefreshResult({ updated: data.updated, created: data.created, deleted: data.deleted });
        const appsRes  = await fetch(`/api/apps/subaccount?region=${encodeURIComponent(sa.region)}&subdomain=${encodeURIComponent(sa.subdomain)}`);
        const appsData = await appsRes.json() as { ok: boolean; data: AppFileData[] };
        if (appsData.ok) setApps(appsData.data);
        onAppDataChange?.();
      }
    } catch { /* ignore */ } finally {
      setSaRefreshing(false);
    }
  }

  // ── Split resize ──────────────────────────────────────────────────────────

  function startSplitResize(e: React.MouseEvent) {
    e.preventDefault();
    const el = bodyRef.current;
    if (!el) return;
    const containerW = el.getBoundingClientRect().width;
    splitResizeRef.current = { startX: e.clientX, startPct: splitPct, containerW };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    const onMove = (me: MouseEvent) => {
      const r = splitResizeRef.current;
      if (!r) return;
      setSplitPct(Math.min(80, Math.max(20, r.startPct + ((me.clientX - r.startX) / r.containerW) * 100)));
    };
    const onUp = () => {
      splitResizeRef.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  // ── Sort ──────────────────────────────────────────────────────────────────

  function handleSort(col: SortCol) {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortCol(col); setSortDir(col === 'name' || col === 'state' ? 'asc' : 'desc'); }
  }

  function sortIndicator(col: SortCol) {
    if (sortCol !== col) return <span className="ml-0.5 opacity-20">↕</span>;
    return <span className="ml-0.5">{sortDir === 'asc' ? '↑' : '↓'}</span>;
  }

  // ── App actions ───────────────────────────────────────────────────────────

  async function doAppAction(action: 'start' | 'stop') {
    if (!selectedApp || appActionLoading) return;
    setAppActionLoading(action);
    setAppActionError(null);
    try {
      const res  = await fetch(`/api/apps/${selectedApp.guid}/${action}?region=${encodeURIComponent(sa.region)}&subdomain=${encodeURIComponent(sa.subdomain)}`, { method: 'POST' });
      const data = await res.json() as { ok: boolean; error?: string };
      if (!data.ok) { setAppActionError(data.error ?? `Failed to ${action} app`); return; }
      setApps(prev => prev.map(a => a.guid === selectedApp.guid ? { ...a, state: action === 'start' ? 'STARTED' : 'STOPPED' } : a));
    } catch {
      setAppActionError(`Network error while trying to ${action} app`);
    } finally {
      setAppActionLoading(null);
    }
  }

  // ── Tree computation ──────────────────────────────────────────────────────

  const filterLow    = filterText.toLowerCase();
  const filteredApps = filterText
    ? apps.filter(a => a.name.toLowerCase().includes(filterLow) || a.spaceName.toLowerCase().includes(filterLow))
    : apps;

  const spaceGroups = new Map<string, AppFileData[]>();
  for (const app of filteredApps) {
    const list = spaceGroups.get(app.spaceName);
    if (list) list.push(app);
    else spaceGroups.set(app.spaceName, [app]);
  }

  const sortedSpaces = [...spaceGroups.keys()].sort();

  for (const [, list] of spaceGroups) {
    list.sort((a, b) => {
      let av: number | string;
      let bv: number | string;
      switch (sortCol) {
        case 'state':        av = a.state;                                                          bv = b.state;                                                          break;
        case 'memory_in_mb': av = (a.process?.memory_in_mb ?? 0) * (a.process?.instances ?? 1);    bv = (b.process?.memory_in_mb ?? 0) * (b.process?.instances ?? 1);    break;
        case 'disk_in_mb':   av = a.process?.disk_in_mb   ?? 0;                                    bv = b.process?.disk_in_mb   ?? 0;                                    break;
        default:             av = a.name.toLowerCase();                                             bv = b.name.toLowerCase();                                             break;
      }
      const cmp = av < bv ? -1 : av > bv ? 1 : 0;
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }

  const selectedApp       = apps.find(a => a.guid === selectedId) ?? null;
  const allSpacesExpanded = sortedSpaces.length > 0 && sortedSpaces.every(s => expanded.has(s));

  function toggleAllExpanded() {
    if (allSpacesExpanded) setExpanded(new Set());
    else setExpanded(new Set(sortedSpaces));
  }

  const appCockpitUrl = selectedApp ? buildAppCockpitUrl(sa, selectedApp, cockpit) : null;

  // ── Render ────────────────────────────────────────────────────────────────

  const thCls   = 'px-2 py-1.5 text-left text-[10px] font-medium text-muted-foreground uppercase tracking-wide select-none cursor-pointer hover:text-foreground whitespace-nowrap';
  const tdCls   = 'px-2 py-1 text-xs border-b border-border';
  const iconBtn   = 'p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors shrink-0 disabled:opacity-40 disabled:cursor-not-allowed';
  const btnNormal = 'inline-flex items-center gap-1.5 px-2 py-1.5 rounded text-xs font-medium hover:bg-accent hover:text-accent-foreground transition-colors shrink-0 disabled:opacity-40 disabled:cursor-not-allowed';

  return (
    <>
      {/* Refresh progress bar */}
      {(saRefreshing || saRefreshResult) && (
        <div className={`relative px-4 py-2 border-b text-xs flex items-center justify-center gap-2 shrink-0 overflow-hidden ${
          saRefreshResult
            ? 'bg-green-500/5 border-green-500/20 text-green-700 dark:text-green-400'
            : 'bg-muted/30 border-border text-muted-foreground'
        }`}>
          {saRefreshing && <div className="absolute bottom-0 left-0 h-0.5 bg-primary/40 animate-pulse w-full" />}
          <span className="text-center">
            {saRefreshing && 'Refreshing apps…'}
            {saRefreshResult && (
              (saRefreshResult.updated + saRefreshResult.created + saRefreshResult.deleted) > 0
                ? `Refreshed — ${saRefreshResult.updated} updated, ${saRefreshResult.created} created, ${saRefreshResult.deleted} deleted`
                : 'Refreshed — no change'
            )}
          </span>
          {saRefreshResult && (
            <button
              onClick={() => setSaRefreshResult(null)}
              className="absolute right-2 shrink-0 p-0.5 rounded hover:opacity-70 transition-opacity"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      )}

      {/* Body */}
      <div ref={bodyRef} className="flex flex-1 min-h-0 overflow-hidden">

        {/* Left panel */}
        {leftVisible && (
          <div className="flex flex-col min-h-0 border-r border-border shrink-0 overflow-hidden" style={{ width: `${splitPct}%` }}>
            {/* Filter + collapse/expand + refresh */}
            <div className="px-3 py-2 border-b border-border shrink-0 flex items-center gap-2">
              <div className="relative flex-1">
                <input
                  type="text"
                  value={filterText}
                  onChange={e => setFilterText(e.target.value)}
                  placeholder="Filter apps…"
                  className={`w-full h-7 px-2 text-xs border border-border rounded bg-background text-foreground outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground ${filterText ? 'pr-7' : ''}`}
                />
                {filterText && (
                  <button
                    onClick={() => setFilterText('')}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors p-0.5"
                    tabIndex={-1}
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </div>
              <button
                onClick={toggleAllExpanded}
                className={btnNormal}
                title={allSpacesExpanded ? 'Collapse all' : 'Expand all'}
                disabled={sortedSpaces.length === 0}
              >
                {allSpacesExpanded
                  ? <ChevronsDownUp className="h-4 w-4" />
                  : <ChevronsUpDown className="h-4 w-4" />}
              </button>
              {!sa.restricted && (
                <button
                  onClick={() => { void handleSaRefresh(); }}
                  disabled={saRefreshing}
                  className={btnNormal}
                  title="Refresh apps"
                >
                  <RefreshCw className={`h-4 w-4 ${saRefreshing ? 'animate-spin' : ''}`} />
                </button>
              )}
            </div>

            {/* Tree table */}
            <div className="flex-1 overflow-auto">
              {loading && <div className="text-xs text-muted-foreground text-center py-8">Loading…</div>}
              {!loading && sortedSpaces.length === 0 && (
                <div className="text-xs text-muted-foreground text-center py-8">
                  {filterText ? 'No matching apps' : 'No apps scanned yet'}
                </div>
              )}
              {!loading && sortedSpaces.length > 0 && (
                <table className="w-full border-collapse text-sm" style={{ tableLayout: 'fixed' }}>
                  <colgroup>
                    <col style={{ width: '27%' }} />
                    <col style={{ width: '20%' }} />
                    <col style={{ width: '17%' }} />
                    <col style={{ width: '15%' }} />
                    <col style={{ width: '21%' }} />
                  </colgroup>
                  <thead className="sticky top-0 z-10 bg-muted/30">
                    <tr>
                      <th className={thCls} onClick={() => handleSort('name')}>Name{sortIndicator('name')}</th>
                      <th className={thCls} onClick={() => handleSort('state')}>State{sortIndicator('state')}</th>
                      <th className={`${thCls} text-right`} onClick={() => handleSort('memory_in_mb')}>Mem{sortIndicator('memory_in_mb')}</th>
                      <th className={`${thCls} text-right`} onClick={() => handleSort('disk_in_mb')}>Disk{sortIndicator('disk_in_mb')}</th>
                      <th className={thCls}>Last Access</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedSpaces.map(spaceName => {
                      const spaceApps  = spaceGroups.get(spaceName) ?? [];
                      const isExpanded = expanded.has(spaceName);
                      return [
                        <tr
                          key={`space:${spaceName}`}
                          className="bg-muted/20 cursor-pointer select-none hover:bg-muted/40 transition-colors"
                          onClick={() => setExpanded(prev => {
                            const next = new Set(prev);
                            if (next.has(spaceName)) next.delete(spaceName); else next.add(spaceName);
                            return next;
                          })}
                        >
                          <td colSpan={5} className="px-2 py-1 text-xs border-b border-border font-medium">
                            <span className="inline-flex items-center gap-1">
                              {isExpanded
                                ? <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
                                : <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />}
                              {spaceName}
                              <span className="text-muted-foreground font-normal ml-1">({spaceApps.length})</span>
                            </span>
                          </td>
                        </tr>,
                        ...(isExpanded ? spaceApps.map(app => (
                          <tr
                            key={app.guid}
                            className={`cursor-pointer hover:bg-muted/30 transition-colors ${selectedId === app.guid ? 'bg-primary/10' : ''}`}
                            onClick={() => { setSelectedId(app.guid); setAppActionError(null); }}
                          >
                            <td className={`${tdCls} pl-6 truncate`} title={app.name}>{app.name}</td>
                            <td className={tdCls}><StateBadge state={app.state} instances={app.process?.instances} /></td>
                            <td className={`${tdCls} text-right tabular-nums text-muted-foreground`}>{app.process ? fmtMB(app.process.memory_in_mb * app.process.instances) : '—'}</td>
                            <td className={`${tdCls} text-right tabular-nums text-muted-foreground`}>{app.process ? fmtMB(app.process.disk_in_mb) : '—'}</td>
                            <td className={`${tdCls} tabular-nums text-muted-foreground`}>{app.lastAccessed ? fmtShortDate(app.lastAccessed) : '—'}</td>
                          </tr>
                        )) : []),
                      ];
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}

        {/* Divider */}
        {leftVisible && (
          <div className="w-1 bg-border hover:bg-primary/40 cursor-col-resize shrink-0 transition-colors" onMouseDown={startSplitResize} />
        )}

        {/* Right panel */}
        <div className="flex flex-col flex-1 min-w-0 min-h-0 overflow-hidden">
          {/* Right panel title bar */}
          <div className="flex items-center gap-1 px-3 py-2 border-b border-border min-h-[40px] shrink-0">
            <button onClick={() => setLeftVisible(v => !v)} className={iconBtn} title={leftVisible ? 'Hide left panel' : 'Show left panel'}>
              <PanelLeft className="h-4 w-4" />
            </button>
            <span className="text-xs font-medium text-foreground truncate flex-1 mx-1">
              {selectedApp ? selectedApp.name : <span className="text-muted-foreground">Select an app</span>}
            </span>
            {selectedApp && <>
              {appCockpitUrl && (
                <a href={appCockpitUrl} target="_blank" rel="noopener noreferrer" className={btnNormal} title="Open app in BTP Cockpit">
                  <ExternalLink className="h-4 w-4" />
                </a>
              )}
              <button
                onClick={() => void doAppAction('start')}
                disabled={selectedApp.state === 'STARTED' || appActionLoading !== null}
                className={btnNormal}
                title="Start app"
              >
                {appActionLoading === 'start'
                  ? <span className="h-4 w-4 block rounded-full border-2 border-current border-t-transparent animate-spin" />
                  : <Play className="h-4 w-4" />}
              </button>
              <button
                onClick={() => setShowStopConfirm(true)}
                disabled={selectedApp.state === 'STOPPED' || appActionLoading !== null}
                className={btnNormal}
                title="Stop app"
              >
                {appActionLoading === 'stop'
                  ? <span className="h-4 w-4 block rounded-full border-2 border-current border-t-transparent animate-spin" />
                  : <Square className="h-4 w-4" />}
              </button>
            </>}
          </div>

          {/* Action error */}
          {appActionError && (
            <div className="px-4 py-2 text-xs text-amber-600 dark:text-amber-400 bg-amber-500/8 border-b border-border flex items-center gap-2">
              <span className="flex-1">{appActionError}</span>
              <button onClick={() => setAppActionError(null)} className="shrink-0 hover:text-foreground"><X className="h-3.5 w-3.5" /></button>
            </div>
          )}

          {/* App detail */}
          <div className="flex-1 overflow-auto p-4">
            {!selectedApp && (
              <div className="flex items-center justify-center h-full text-xs text-muted-foreground">
                Click an app in the list to view details
              </div>
            )}
            {selectedApp && (
              <table className="w-full border-collapse text-xs">
                <tbody>
                  {([
                      ['GUID',       selectedApp.guid],
                      ['Name',       selectedApp.name],
                      ['Space',      selectedApp.spaceName],
                      ['Space GUID', selectedApp.spaceGuid],
                      ['Region',     selectedApp.region],
                      ['Subdomain',  selectedApp.subdomain],
                    ] as [string, string][]).map(([label, value]) => (
                    <tr key={label} className="hover:bg-muted/20">
                      <td className="py-1.5 pr-3 pl-1 font-medium text-muted-foreground whitespace-nowrap w-[140px] border-b border-border/50">{label}</td>
                      <td className="py-1.5 pl-1 border-b border-border/50 break-all font-mono">{value}</td>
                    </tr>
                  ))}

                  <tr className="hover:bg-muted/20">
                    <td className="py-1.5 pr-3 pl-1 font-medium text-muted-foreground whitespace-nowrap w-[140px] border-b border-border/50">State</td>
                    <td className="py-1.5 pl-1 border-b border-border/50"><StateBadge state={selectedApp.state} /></td>
                  </tr>

                  {selectedApp.process && <>
                    <tr><td colSpan={2} className="py-1.5 pl-1 font-semibold text-muted-foreground border-b border-border/50 pt-3">Process</td></tr>
                    {[
                      ['Type',      selectedApp.process.type],
                      ['Instances', String(selectedApp.process.instances)],
                      ['Memory',    fmtMB(selectedApp.process.memory_in_mb * selectedApp.process.instances)],
                      ['Disk',      fmtMB(selectedApp.process.disk_in_mb)],
                    ].map(([label, value]) => (
                      <tr key={`proc-${label}`} className="hover:bg-muted/20">
                        <td className="py-1.5 pr-3 pl-1 font-medium text-muted-foreground whitespace-nowrap w-[140px] border-b border-border/50">{label}</td>
                        <td className="py-1.5 pl-1 border-b border-border/50 font-mono">{value}</td>
                      </tr>
                    ))}
                  </>}

                  <tr className="hover:bg-muted/20">
                    <td className="py-1.5 pr-3 pl-1 font-medium text-muted-foreground whitespace-nowrap border-b border-border/50">AOD</td>
                    <td className="py-1.5 pl-1 border-b border-border/50">
                      <span className={`inline-flex items-center gap-1 ${selectedApp.aod ? 'text-green-600 dark:text-green-400' : 'text-muted-foreground'}`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${selectedApp.aod ? 'bg-green-500' : 'bg-muted-foreground/40'}`} />
                        {selectedApp.aod ? 'Enabled' : 'Disabled'}
                      </span>
                    </td>
                  </tr>

                  <tr className="hover:bg-muted/20">
                    <td className="py-1.5 pr-3 pl-1 font-medium text-muted-foreground whitespace-nowrap border-b border-border/50">Last Updated</td>
                    <td className="py-1.5 pl-1 border-b border-border/50 font-mono">{fmtTs(selectedApp.lastUpdated)}</td>
                  </tr>

                  {selectedApp.lastAccessed != null && (
                    <tr className="hover:bg-muted/20">
                      <td className="py-1.5 pr-3 pl-1 font-medium text-muted-foreground whitespace-nowrap border-b border-border/50">Last Accessed</td>
                      <td className="py-1.5 pl-1 border-b border-border/50 font-mono">{fmtTs(selectedApp.lastAccessed)}</td>
                    </tr>
                  )}

                  {(selectedApp.urls?.length ?? 0) > 0 && <>
                    <tr><td colSpan={2} className="py-1.5 pl-1 font-semibold text-muted-foreground border-b border-border/50 pt-3">URLs</td></tr>
                    {selectedApp.urls!.map((url, i) => (
                      <tr key={i} className="hover:bg-muted/20">
                        <td className="py-1.5 pr-3 pl-1 font-medium text-muted-foreground whitespace-nowrap border-b border-border/50">{i + 1}</td>
                        <td className="py-1.5 pl-1 border-b border-border/50 break-all">
                          <a href={url} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline font-mono">{url}</a>
                        </td>
                      </tr>
                    ))}
                  </>}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>

      {/* Stop confirmation dialog */}
      <AlertDialog open={showStopConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Stop "{selectedApp?.name}"?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                <p>Stopping this app will immediately terminate all running instances.</p>
                <p className="font-medium text-foreground">Any ongoing transactions or user sessions within the app will be disrupted without a graceful shutdown.</p>
                <p>Do you want to proceed?</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setShowStopConfirm(false)}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => { setShowStopConfirm(false); void doAppAction('stop'); }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Stop app
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
