import { useEffect, useRef, useState } from 'react';
import {
  ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown,
  ExternalLink, Maximize2, Minimize2, PanelLeft, Play, RefreshCw, Square, X,
} from 'lucide-react';
import { useSettings } from '@/components/AppLayout';
import type { SubaccountEntry, SpaceEntry } from '@/components/config/SubaccountsTable';
import type { CockpitMenuItem } from '@/components/home/HomepageContent';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
  guid:        string;
  name:        string;
  state:       string;
  spaceGuid:   string;
  region:      string;
  subdomain:   string;
  spaceName:   string;
  process?:    AppProcess;
  aod?:        boolean;
  urls?:        string[];
  lastUpdated:  number;
  lastAccessed?: number;
}

export interface SubaccountAppsModalProps {
  initialRegion:    string;
  initialSubdomain: string;
  initialGuid?:     string;
  allSubaccounts:   SubaccountEntry[];
  onClose:          () => void;
}

type SortCol = 'name' | 'state' | 'memory_in_mb' | 'disk_in_mb';

// ─── Cockpit helpers (mirrors UsersModal / SubaccountDestModal) ───────────────

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
function stripProtocol(h: string): string { return h.replace(/^https?:\/\//i, ''); }
function resolve(tpl: string, ctx: Record<string, string>): string {
  return tpl.replace(/\{([^}]+)\}/g, (_, k: string) => ctx[k] ?? '');
}
function cleanUrl(url: string): string {
  const hi = url.indexOf('#');
  const before = hi >= 0 ? url.slice(0, hi) : url;
  const after  = hi >= 0 ? url.slice(hi) : '';
  const qi = before.indexOf('?');
  if (qi < 0) return url;
  const base   = before.slice(0, qi);
  const params = before.slice(qi + 1).split('&').filter(p => { const eq = p.indexOf('='); return eq < 0 || p.slice(eq + 1) !== ''; });
  return base + (params.length ? '?' + params.join('&') : '') + after;
}
function resolveUrl(tpl: string, ctx: Record<string, string>): string { return cleanUrl(resolve(tpl, ctx)); }
function buildCockpitCtx(sa: SubaccountEntry, cockpit: { idp: string; host: string }): Record<string, string> {
  return {
    'homepage.cockpit.host': cockpit.host ? stripProtocol(cockpit.host) : '',
    'homepage.cockpit.idp':  cockpit.idp,
    cockpitRegion:           deriveCockpitRegion(sa.region),
    globalAccountGUID:       sa.globalAccountGUID,
    subaccountId:            sa.subaccountId,
    orgId:                   sa.org?.orgId ?? '',
    subdomain:               sa.subdomain,
  };
}
function renderMenuItems(items: CockpitMenuItem[], ctx: Record<string, string>, spaces: SpaceEntry[]): React.ReactNode[] {
  return items.flatMap((item, i) => {
    if (item.name === '-') return [<DropdownMenuSeparator key={`sep-${i}`} />];
    if (item.repeatOn === 'spaces') {
      return spaces.flatMap(sp => {
        const spCtx = { ...ctx, spaceId: sp.spaceId, spaceName: sp.spaceName };
        const name  = resolve(item.name, spCtx);
        const url   = item.url ? resolveUrl(item.url, spCtx) : undefined;
        if (item.submenus?.length) {
          return [(<DropdownMenuSub key={sp.spaceId}>
            <DropdownMenuSubTrigger className="text-xs">{name}</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {url && <><DropdownMenuItem className="text-xs cursor-pointer" asChild><a href={url} target="_blank" rel="noopener noreferrer">{name}</a></DropdownMenuItem><DropdownMenuSeparator /></>}
              {renderMenuItems(item.submenus, spCtx, spaces)}
            </DropdownMenuSubContent>
          </DropdownMenuSub>)];
        }
        return url ? [<DropdownMenuItem key={sp.spaceId} className="text-xs cursor-pointer" asChild><a href={url} target="_blank" rel="noopener noreferrer">{name}</a></DropdownMenuItem>] : [];
      });
    }
    const name = resolve(item.name, ctx);
    const url  = item.url ? resolveUrl(item.url, ctx) : undefined;
    if (item.submenus?.length) {
      return [(<DropdownMenuSub key={i}>
        <DropdownMenuSubTrigger className="text-xs">{name}</DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          {url && <><DropdownMenuItem className="text-xs cursor-pointer" asChild><a href={url} target="_blank" rel="noopener noreferrer">{name}</a></DropdownMenuItem><DropdownMenuSeparator /></>}
          {renderMenuItems(item.submenus, ctx, spaces)}
        </DropdownMenuSubContent>
      </DropdownMenuSub>)];
    }
    return [url
      ? <DropdownMenuItem key={i} className="text-xs cursor-pointer" asChild><a href={url} target="_blank" rel="noopener noreferrer">{name}</a></DropdownMenuItem>
      : <DropdownMenuItem key={i} className="text-xs" disabled>{name}</DropdownMenuItem>
    ];
  });
}

function buildAppCockpitUrl(sa: SubaccountEntry, app: AppFileData, cockpitHost: string): string {
  const region  = deriveCockpitRegion(sa.region);
  const rawHost = cockpitHost || `cockpit.${region}.hana.ondemand.com`;
  const base    = rawHost.startsWith('http') ? rawHost : `https://${rawHost}`;
  return `${base}/cockpit#/globalaccount/${sa.globalAccountGUID}/subaccount/${sa.subaccountId}/org/${sa.org?.orgId ?? ''}/space/${app.spaceGuid}/applications/${app.guid}`;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

export default function SubaccountAppsModal({
  initialRegion,
  initialSubdomain,
  initialGuid,
  allSubaccounts,
  onClose,
}: SubaccountAppsModalProps) {
  const { settings, cockpitMenu } = useSettings();
  const cockpit = settings?.homepage.cockpit ?? { idp: '', host: '' };

  const [region,          setRegion]          = useState(initialRegion);
  const [subdomain,       setSubdomain]       = useState(initialSubdomain);
  const [apps,            setApps]            = useState<AppFileData[]>([]);
  const [loading,         setLoading]         = useState(false);
  const [selectedId,      setSelectedId]      = useState<string>(initialGuid ?? '');
  const [filterText,      setFilterText]      = useState('');
  const [expanded,        setExpanded]        = useState<Set<string>>(new Set());
  const [sortCol,         setSortCol]         = useState<SortCol>('memory_in_mb');
  const [sortDir,         setSortDir]         = useState<'asc' | 'desc'>('desc');
  const [maximized,       setMaximized]       = useState(false);
  const [leftVisible,     setLeftVisible]     = useState(true);
  const [splitPct,        setSplitPct]        = useState(40);
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
    fetch(`/api/apps/subaccount?region=${encodeURIComponent(region)}&subdomain=${encodeURIComponent(subdomain)}`)
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
  }, [region, subdomain]);

  // ── Per-subaccount refresh ────────────────────────────────────────────────

  async function handleSaRefresh() {
    if (saRefreshing) return;
    setSaRefreshing(true);
    setSaRefreshResult(null);
    try {
      const res  = await fetch(`/api/apps/refresh-subaccount?region=${encodeURIComponent(region)}&subdomain=${encodeURIComponent(subdomain)}`, { method: 'POST' });
      const data = await res.json() as { ok: boolean; updated: number; created: number; deleted: number };
      if (data.ok) {
        setSaRefreshResult({ updated: data.updated, created: data.created, deleted: data.deleted });
        // Reload apps list
        const appsRes  = await fetch(`/api/apps/subaccount?region=${encodeURIComponent(region)}&subdomain=${encodeURIComponent(subdomain)}`);
        const appsData = await appsRes.json() as { ok: boolean; data: AppFileData[] };
        if (appsData.ok) setApps(appsData.data);
      }
    } catch { /* ignore */ } finally {
      setSaRefreshing(false);
    }
  }

  // ── Keyboard ──────────────────────────────────────────────────────────────

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

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
      const res  = await fetch(`/api/apps/${selectedApp.guid}/${action}?region=${encodeURIComponent(region)}&subdomain=${encodeURIComponent(subdomain)}`, { method: 'POST' });
      const data = await res.json() as { ok: boolean; error?: string };
      if (!data.ok) { setAppActionError(data.error ?? `Failed to ${action} app`); return; }
      // Optimistically update local state
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
        case 'state':        av = a.state;                      bv = b.state;                      break;
        case 'memory_in_mb': av = (a.process?.memory_in_mb ?? 0) * (a.process?.instances ?? 1); bv = (b.process?.memory_in_mb ?? 0) * (b.process?.instances ?? 1); break;
        case 'disk_in_mb':   av = a.process?.disk_in_mb   ?? 0; bv = b.process?.disk_in_mb   ?? 0; break;
        default:             av = a.name.toLowerCase();         bv = b.name.toLowerCase();         break;
      }
      const cmp = av < bv ? -1 : av > bv ? 1 : 0;
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }

  const selectedApp        = apps.find(a => a.guid === selectedId) ?? null;
  const allSpacesExpanded  = sortedSpaces.length > 0 && sortedSpaces.every(s => expanded.has(s));

  function toggleAllExpanded() {
    if (allSpacesExpanded) setExpanded(new Set());
    else setExpanded(new Set(sortedSpaces));
  }

  // ── SA + cockpit context ──────────────────────────────────────────────────

  function switchSubaccount(sa: SubaccountEntry) {
    setRegion(sa.region);
    setSubdomain(sa.subdomain);
    setSelectedId('');
    setFilterText('');
    setAppActionError(null);
  }

  const currentSa   = allSubaccounts.find(s => s.region === region && s.subdomain === subdomain) ?? allSubaccounts[0];
  const saLabel     = currentSa ? (currentSa.alias || currentSa.subaccountName) : subdomain;
  const sameRegion  = allSubaccounts.filter(s => s.region === region && s.subdomain !== subdomain).sort((a, b) => a.pos - b.pos);
  const otherRegions = [...new Set(allSubaccounts.filter(s => s.region !== region).map(s => s.region))].sort();

  const appCockpitUrl = selectedApp && currentSa
    ? buildAppCockpitUrl(currentSa, selectedApp, cockpit.host)
    : null;

  // ── Render ────────────────────────────────────────────────────────────────

  const thCls    = 'px-2 py-1.5 text-left text-[10px] font-medium text-muted-foreground uppercase tracking-wide select-none cursor-pointer hover:text-foreground whitespace-nowrap';
  const tdCls    = 'px-2 py-1 text-xs border-b border-border';
  const iconBtn  = 'p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors shrink-0 disabled:opacity-40 disabled:cursor-not-allowed';

  function renderSaDropdownContent() {
    return <>
      {sameRegion.map(s => (
        <DropdownMenuItem key={s.subdomain} className="text-xs cursor-pointer" onClick={() => switchSubaccount(s)}>
          {s.alias || s.subaccountName}
          <span className="ml-1 font-mono text-muted-foreground">({s.subdomain})</span>
        </DropdownMenuItem>
      ))}
      {otherRegions.map(r => {
        const sas = allSubaccounts.filter(s => s.region === r).sort((a, b) => a.pos - b.pos);
        return (
          <DropdownMenuSub key={r}>
            <DropdownMenuSubTrigger className="text-xs">{r}</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {sas.map(s => (
                <DropdownMenuItem key={s.subdomain} className="text-xs cursor-pointer" onClick={() => switchSubaccount(s)}>
                  {s.alias || s.subaccountName}
                  <span className="ml-1 font-mono text-muted-foreground">({s.subdomain})</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        );
      })}
    </>;
  }

  return (
    <>
      <div
        className={`fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm ${maximized ? 'p-0' : 'p-4'}`}
        onClick={() => {}}
      >
        <div className={`flex flex-col bg-background border border-border shadow-2xl ${
          maximized ? 'w-full h-full rounded-none' : 'w-full max-w-6xl h-[90vh] rounded-xl'
        }`}>

          {/* Header */}
          <div className="flex items-center gap-2 px-4 border-b border-border min-h-[52px] shrink-0">
            <div className="text-sm font-semibold min-w-0 flex-1 flex items-center gap-1 overflow-hidden">
              <span className="text-muted-foreground font-normal shrink-0">{region} ›</span>
              {currentSa && cockpitMenu
                ? (() => {
                    const ctx     = buildCockpitCtx(currentSa, cockpit);
                    const url     = cockpitMenu.url ? resolveUrl(cockpitMenu.url, ctx) : undefined;
                    const spaces  = currentSa.org?.spaces ?? [];
                    const hasSubs = (cockpitMenu.submenus?.length ?? 0) > 0;
                    return (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button className="inline-flex items-center gap-0.5 hover:bg-accent/60 hover:text-foreground px-1 py-0.5 rounded transition-colors min-w-0 shrink truncate">
                            <span className="truncate">{saLabel}</span>
                            <span className="font-normal text-xs font-mono text-muted-foreground shrink-0">({subdomain})</span>
                            <ChevronDown className="h-3 w-3 shrink-0 opacity-60 ml-0.5" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start" className="max-h-[min(70vh,420px)] overflow-y-auto">
                          {url && <>
                            <DropdownMenuItem className="text-xs cursor-pointer" asChild>
                              <a href={url} target="_blank" rel="noopener noreferrer">{cockpitMenu.name}</a>
                            </DropdownMenuItem>
                            {hasSubs && <DropdownMenuSeparator />}
                          </>}
                          {hasSubs && renderMenuItems(cockpitMenu.submenus!, ctx, spaces)}
                          {(sameRegion.length > 0 || otherRegions.length > 0) && <DropdownMenuSeparator />}
                          {renderSaDropdownContent()}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    );
                  })()
                : allSubaccounts.length <= 1
                  ? <span className="truncate">{saLabel} <span className="font-normal text-xs font-mono text-muted-foreground">({subdomain})</span></span>
                  : (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button className="inline-flex items-center gap-0.5 hover:bg-accent/60 hover:text-foreground px-1 py-0.5 rounded transition-colors min-w-0 shrink truncate">
                          <span className="truncate">{saLabel}</span>
                          <span className="font-normal text-xs font-mono text-muted-foreground shrink-0">({subdomain})</span>
                          <ChevronDown className="h-3 w-3 shrink-0 opacity-60 ml-0.5" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start" className="max-h-[min(70vh,420px)] overflow-y-auto">
                        {renderSaDropdownContent()}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )
              }
              <span className="text-muted-foreground font-normal shrink-0">› Apps</span>
            </div>

            {!currentSa?.restricted && (
              <button
                onClick={() => { void handleSaRefresh(); }}
                disabled={saRefreshing}
                className={`${iconBtn} ${saRefreshing ? 'opacity-50 cursor-not-allowed' : ''}`}
                title="Refresh apps"
              >
                <RefreshCw className={`h-4 w-4 ${saRefreshing ? 'animate-spin' : ''}`} />
              </button>
            )}
            <button onClick={() => setMaximized(m => !m)} className={iconBtn} title={maximized ? 'Restore' : 'Maximize'}>
              {maximized ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
            </button>
            <button onClick={onClose} className={iconBtn} title="Close">
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Refresh progress bar */}
          {(saRefreshing || saRefreshResult) && (
            <div className="shrink-0 px-4 py-1.5 border-b border-border bg-muted/20 flex items-center gap-2 text-xs text-muted-foreground">
              {saRefreshing
                ? <>
                    <div className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse shrink-0" />
                    Refreshing apps under <span className="font-medium text-foreground">{saLabel}</span>…
                  </>
                : saRefreshResult && <>
                    <div className="h-1.5 w-1.5 rounded-full bg-emerald-500 shrink-0" />
                    Refreshed apps under <span className="font-medium text-foreground">{saLabel}</span>
                    {(saRefreshResult.updated + saRefreshResult.created + saRefreshResult.deleted) > 0
                      ? <> — Found <span className="text-foreground">{saRefreshResult.updated}</span> updated, <span className="text-foreground">{saRefreshResult.created}</span> created, <span className="text-foreground">{saRefreshResult.deleted}</span> deleted apps</>
                      : <> — No changes</>
                    }
                  </>
              }
            </div>
          )}

          {/* Body */}
          <div ref={bodyRef} className="flex flex-1 min-h-0 overflow-hidden">

            {/* Left panel */}
            {leftVisible && (
              <div className="flex flex-col min-h-0 border-r border-border shrink-0 overflow-hidden" style={{ width: `${splitPct}%` }}>
                {/* Filter + collapse/expand */}
                <div className="px-3 py-2 border-b border-border shrink-0 flex items-center gap-2">
                  <div className="relative flex-1">
                    <input
                      type="text"
                      value={filterText}
                      onChange={e => setFilterText(e.target.value)}
                      placeholder="Filter apps…"
                      className={`w-full h-7 px-2 text-xs border border-border rounded bg-background text-foreground outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground ${filterText ? 'pr-28' : ''}`}
                    />
                    {filterText && (
                      <>
                        <span className="absolute right-6 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground/60 pointer-events-none whitespace-nowrap">
                          Found {filteredApps.length} / {apps.length}
                        </span>
                        <button
                          onClick={() => setFilterText('')}
                          className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors p-0.5"
                          tabIndex={-1}
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </>
                    )}
                  </div>
                  <button
                    onClick={toggleAllExpanded}
                    className={iconBtn}
                    title={allSpacesExpanded ? 'Collapse all' : 'Expand all'}
                    disabled={sortedSpaces.length === 0}
                  >
                    {allSpacesExpanded
                      ? <ChevronsDownUp className="h-4 w-4" />
                      : <ChevronsUpDown className="h-4 w-4" />}
                  </button>
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
              {/* Right panel title */}
              <div className="flex items-center gap-1 px-3 py-2 border-b border-border min-h-[40px] shrink-0">
                <button onClick={() => setLeftVisible(v => !v)} className={iconBtn} title={leftVisible ? 'Hide left panel' : 'Show left panel'}>
                  <PanelLeft className="h-4 w-4" />
                </button>
                <span className="text-xs font-medium text-foreground truncate flex-1 mx-1">
                  {selectedApp ? selectedApp.name : <span className="text-muted-foreground">Select an app</span>}
                </span>
                {selectedApp && <>
                  {appCockpitUrl && (
                    <a href={appCockpitUrl} target="_blank" rel="noopener noreferrer" className={iconBtn} title="Open app in BTP Cockpit">
                      <ExternalLink className="h-4 w-4" />
                    </a>
                  )}
                  <button
                    onClick={() => void doAppAction('start')}
                    disabled={selectedApp.state === 'STARTED' || appActionLoading !== null}
                    className={iconBtn}
                    title="Start app"
                  >
                    {appActionLoading === 'start'
                      ? <span className="h-4 w-4 block rounded-full border-2 border-current border-t-transparent animate-spin" />
                      : <Play className="h-4 w-4" />}
                  </button>
                  <button
                    onClick={() => setShowStopConfirm(true)}
                    disabled={selectedApp.state === 'STOPPED' || appActionLoading !== null}
                    className={iconBtn}
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

                      {/* State row — styled badge */}
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
