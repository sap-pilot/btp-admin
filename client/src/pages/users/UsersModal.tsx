import { Fragment, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  ChevronDown, ChevronRight, Download, Filter,
  Maximize2, Minimize2, PanelLeft, RefreshCw, X,
} from 'lucide-react';
import { useSettings } from '@/components/AppLayout';
import type { SubaccountEntry, SpaceEntry } from '@/components/config/SubaccountsTable';
import type { CockpitMenuItem } from '@/components/home/HomepageContent';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

// ─── Types ────────────────────────────────────────────────────────────────────

interface XsuaaUserName  { familyName?: string; givenName?: string }
interface XsuaaUserEmail { value: string; primary: boolean }
interface XsuaaUserGroup { value: string; display: string; type: string }
interface XsuaaMeta      { version?: number; created?: string; lastModified?: string }

interface XsuaaUser {
  id:                    string;
  externalId?:           string;
  meta?:                 XsuaaMeta;
  userName:              string;
  name?:                 XsuaaUserName;
  emails?:               XsuaaUserEmail[];
  groups?:               XsuaaUserGroup[];
  active?:               boolean;
  verified?:             boolean;
  origin:                string;
  zoneId?:               string;
  passwordLastModified?: string;
  previousLogonTime?:    number;
  lastLogonTime?:        number;
}

interface GlobalAccessEntry {
  region:    string;
  subdomain: string;
  alias:     string;
  groups:    XsuaaUserGroup[];
}

type Tab = 'detail' | 'access' | 'history';

type SubProgress = {
  type:      'refreshing' | 'done' | 'error';
  created?:  number;
  updated?:  number;
  deleted?:  number;
  received?: number;
  errors?:   string[];
};

export interface UsersModalProps {
  sa:                   SubaccountEntry;
  initialUserEmail?:    string;
  initialUserOrigin?:   string;
  initialTab?:          Tab;
  onClose:              () => void;
  onUserDataChange:     () => void;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function renderChangelog(text: string): React.ReactNode {
  return text.split('\n').map((line, i) => {
    if (line.startsWith('## ')) return <div key={i} className="font-bold mt-4 mb-1 text-foreground first:mt-0">{line.slice(3)}</div>;
    if (line.startsWith('+ '))  return <div key={i} className="text-green-600 dark:text-green-400 pl-1">{line}</div>;
    if (line.startsWith('- '))  return <div key={i} className="text-red-500 dark:text-red-400 pl-1">{line}</div>;
    return <div key={i} className="text-muted-foreground">{line || ' '}</div>;
  });
}

function fmtDate(ts: number | string | undefined): string {
  if (ts === undefined || ts === null || ts === '') return '—';
  const ms = typeof ts === 'number' ? ts : Date.parse(ts);
  if (isNaN(ms)) return String(ts);
  return new Date(ms).toLocaleString();
}

function fmtLoginTime(ts: number | undefined): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

// ─── Cockpit helpers ─────────────────────────────────────────────────────────

function deriveCockpitRegion(region: string): string {
  if (region.startsWith('us')) return 'amer';
  if (region.startsWith('eu')) return region.split('-')[0]!;
  if (region.startsWith('ap')) return 'ap21';
  if (region.startsWith('br')) return 'br10';
  if (region.startsWith('jp')) return 'jp10';
  if (region.startsWith('ca')) return 'ca10';
  if (region.startsWith('au')) return 'ap10';
  return region;
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

// ─── Component ───────────────────────────────────────────────────────────────

function userKey(u: XsuaaUser): string {
  return `${u.origin}/${u.emails?.[0]?.value || u.id}`;
}

function splitKey(key: string): [string, string] {
  const slash = key.indexOf('/');
  if (slash === -1) return ['', key];
  return [key.slice(0, slash), key.slice(slash + 1)];
}

export default function UsersModal({
  sa,
  initialUserEmail,
  initialUserOrigin,
  initialTab = 'detail',
  onClose,
  onUserDataChange,
}: UsersModalProps) {
  const navigate = useNavigate();
  const { settings, cockpitMenu } = useSettings();
  const cockpit = settings?.homepage.cockpit ?? { idp: '', host: '' };

  const [users,        setUsers]        = useState<XsuaaUser[]>([]);
  const [filter,       setFilter]       = useState('');
  const [selectedKey,  setSelectedKey]  = useState<string>(
    initialUserEmail && initialUserOrigin ? `${initialUserOrigin}/${initialUserEmail}` : '',
  );
  const [tab,          setTab]          = useState<Tab>(initialTab);
  const [maximized,    setMaximized]    = useState(false);
  const [loading,      setLoading]      = useState(false);
  const [globalAccess, setGlobalAccess] = useState<GlobalAccessEntry[]>([]);
  const [changelog,    setChangelog]    = useState('');
  const [expanded,     setExpanded]     = useState<Set<string>>(new Set());
  const [subProgress,  setSubProgress]  = useState<SubProgress | null>(null);
  const [leftVisible,  setLeftVisible]  = useState(true);
  const [sortCol,      setSortCol]      = useState<'userName' | 'email' | 'origin' | 'lastLogonTime'>('lastLogonTime');
  const [sortDir,      setSortDir]      = useState<'asc' | 'desc'>('desc');
  const [colWidths,    setColWidths]    = useState<[number, number, number, number]>([12, 20, 12, 20]);
  const [splitPct, setSplitPct] = useState(50);
  const subProgressTimer  = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tableContainerRef = useRef<HTMLDivElement>(null);
  const bodyRef           = useRef<HTMLDivElement>(null);
  const splitResizeRef    = useRef<{ startX: number; startPct: number; containerW: number } | null>(null);
  const resizeState       = useRef<{
    col: number; startX: number;
    startWidths: [number, number, number, number]; tableWidth: number;
  } | null>(null);

  const { region, subdomain } = sa;
  const loc     = `${region}/${subdomain}`;
  const saLabel = sa.alias || sa.subaccountName || sa.subdomain;

  useEffect(() => {
    void (async () => {
      try {
        const r = await fetch(`/api/users/${loc}`);
        const j = await r.json() as { ok: boolean; users: XsuaaUser[] };
        if (!j.ok) return;
        setUsers(j.users);
        const initKey = initialUserEmail && initialUserOrigin
          ? `${initialUserOrigin}/${initialUserEmail}`
          : j.users[0] ? userKey(j.users[0]) : '';
        setSelectedKey(initKey);
        if (initKey) void loadTabData(initKey, initialTab);
      } catch { /* ignore */ }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadTabData(key: string, activeTab: Tab) {
    if (!key || activeTab === 'detail') return; // detail uses in-memory users[]
    const [keyOrigin, keyEmail] = splitKey(key);
    if (!keyOrigin || !keyEmail) return;
    setLoading(true);
    try {
      if (activeTab === 'access') {
        const r = await fetch(`/api/users/${loc}/${encodeURIComponent(keyOrigin)}/${encodeURIComponent(keyEmail)}/access`);
        const j = await r.json() as { ok: boolean; data: GlobalAccessEntry[] };
        if (j.ok) {
          setGlobalAccess(j.data);
          setExpanded(new Set(j.data.map(e => `${e.region}/${e.subdomain}`)));
        }
      } else {
        const r = await fetch(`/api/users/${loc}/${encodeURIComponent(keyOrigin)}/${encodeURIComponent(keyEmail)}/history`);
        const j = await r.json() as { ok: boolean; data: string };
        if (j.ok) setChangelog(j.data);
      }
    } catch { /* ignore */ } finally {
      setLoading(false);
    }
  }

  function selectUser(u: XsuaaUser) {
    const key   = userKey(u);
    const email = u.emails?.[0]?.value || u.id;
    setSelectedKey(key);
    setGlobalAccess([]);
    setChangelog('');
    void loadTabData(key, tab);
    navigate(
      `/users/${region}/${subdomain}/${encodeURIComponent(u.origin)}/${encodeURIComponent(email)}${tab !== 'detail' ? `/${tab}` : ''}`,
      { replace: true },
    );
  }

  function changeTab(t: Tab) {
    setTab(t);
    setGlobalAccess([]);
    setChangelog('');
    void loadTabData(selectedKey, t);
    const [kOrigin, kEmail] = splitKey(selectedKey);
    if (kOrigin && kEmail) {
      navigate(
        `/users/${region}/${subdomain}/${encodeURIComponent(kOrigin)}/${encodeURIComponent(kEmail)}${t !== 'detail' ? `/${t}` : ''}`,
        { replace: true },
      );
    }
  }

  async function handleExport() {
    const [kOrigin, kEmail] = splitKey(selectedKey);
    if (!kOrigin || !kEmail) return;
    const r    = await fetch(`/api/users/${loc}/${encodeURIComponent(kOrigin)}/${encodeURIComponent(kEmail)}/export`);
    const blob = await r.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `${region}_${subdomain}_${kOrigin}_${kEmail}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function clearSubProgress() {
    if (subProgressTimer.current) { clearTimeout(subProgressTimer.current); subProgressTimer.current = null; }
    setSubProgress(null);
  }

  async function doRefresh() {
    clearSubProgress();
    setSubProgress({ type: 'refreshing' });
    try {
      const r = await fetch(`/api/users/${loc}/refresh`, { method: 'POST' });
      const j = await r.json() as { ok: boolean; result?: { created: number; updated: number; deleted: number; received: number; errors: string[] }; error?: string };
      if (!j.ok) {
        setSubProgress({ type: 'error', errors: [j.error ?? 'Refresh failed'] });
        return;
      }
      const res = j.result ?? { created: 0, updated: 0, deleted: 0, received: 0, errors: [] };
      if (res.errors.length > 0) {
        setSubProgress({ type: 'error', errors: res.errors });
      } else {
        setSubProgress({ type: 'done', created: res.created, updated: res.updated, deleted: res.deleted, received: res.received });
        subProgressTimer.current = setTimeout(clearSubProgress, 3000);
      }
      const lr = await fetch(`/api/users/${loc}`);
      const lj = await lr.json() as { ok: boolean; users: XsuaaUser[] };
      if (lj.ok) {
        setUsers(lj.users);
        if (selectedKey && res.errors.length === 0) void loadTabData(selectedKey, tab);
      }
      onUserDataChange();
    } catch (err) {
      setSubProgress({ type: 'error', errors: [err instanceof Error ? err.message : 'Refresh failed'] });
    }
  }

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('keydown', handleKey);
      if (subProgressTimer.current) clearTimeout(subProgressTimer.current);
    };
  }, [onClose]);

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
      const deltaPct = ((me.clientX - r.startX) / r.containerW) * 100;
      setSplitPct(Math.min(75, Math.max(20, r.startPct + deltaPct)));
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

  function handleSort(col: typeof sortCol) {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortCol(col); setSortDir('asc'); }
  }

  function startResize(e: React.MouseEvent, colIdx: number) {
    e.preventDefault();
    e.stopPropagation();
    const el = tableContainerRef.current;
    if (!el) return;
    const tableWidth = el.getBoundingClientRect().width;
    resizeState.current = { col: colIdx, startX: e.clientX, startWidths: [...colWidths] as [number, number, number, number], tableWidth };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMove = (me: MouseEvent) => {
      const r = resizeState.current;
      if (!r) return;
      const deltaPct = ((me.clientX - r.startX) / r.tableWidth) * 100;
      const MIN = 8;
      const a   = Math.max(MIN, r.startWidths[r.col]     + deltaPct);
      const b   = Math.max(MIN, r.startWidths[r.col + 1] - deltaPct);
      const next = [...r.startWidths] as [number, number, number, number];
      next[r.col]     = a;
      next[r.col + 1] = b;
      setColWidths(next);
    };

    const onUp = () => {
      resizeState.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  const filterLow     = filter.toLowerCase();
  const filteredUsers = filter
    ? users.filter(u =>
        u.userName.toLowerCase().includes(filterLow) ||
        (u.emails?.[0]?.value ?? '').toLowerCase().includes(filterLow) ||
        (u.name?.givenName  ?? '').toLowerCase().includes(filterLow) ||
        (u.name?.familyName ?? '').toLowerCase().includes(filterLow) ||
        u.origin.toLowerCase().includes(filterLow),
      )
    : users;

  const sortedUsers = [...filteredUsers].sort((a, b) => {
    let av: string | number;
    let bv: string | number;
    switch (sortCol) {
      case 'email':         av = (a.emails?.[0]?.value ?? '').toLowerCase(); bv = (b.emails?.[0]?.value ?? '').toLowerCase(); break;
      case 'origin':        av = a.origin.toLowerCase();                     bv = b.origin.toLowerCase(); break;
      case 'lastLogonTime': av = a.lastLogonTime ?? 0;                       bv = b.lastLogonTime ?? 0; break;
      default:              av = a.userName.toLowerCase();                   bv = b.userName.toLowerCase(); break;
    }
    const cmp = av < bv ? -1 : av > bv ? 1 : 0;
    return sortDir === 'asc' ? cmp : -cmp;
  });

  const selectedUser = users.find(u => userKey(u) === selectedKey) ?? null;

  const hasNoChange = subProgress?.type === 'done' &&
    (subProgress.created ?? 0) === 0 &&
    (subProgress.updated ?? 0) === 0 &&
    (subProgress.deleted ?? 0) === 0;

  const tabCls = (active: boolean) =>
    `px-4 py-2 text-xs transition-colors border-b-2 ${
      active
        ? 'border-primary text-foreground font-medium'
        : 'border-transparent text-muted-foreground hover:text-foreground'
    }`;

  const tdLabel = 'px-3 py-1.5 text-xs border-b border-border w-[160px] font-medium text-muted-foreground';
  const tdValue = 'px-3 py-1.5 text-xs border-b border-border break-all';

  return (
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm ${maximized ? 'p-0' : 'p-4'}`}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className={`flex flex-col bg-background border border-border shadow-2xl ${
        maximized ? 'w-full h-full rounded-none' : 'w-full max-w-5xl h-[90vh] rounded-xl'
      }`}>

        {/* Header */}
        <div className="flex items-center gap-2 px-4 border-b border-border min-h-[52px] shrink-0">
          <div className="text-sm font-semibold min-w-0 flex-1 flex items-center gap-1 overflow-hidden">
            <span className="text-muted-foreground font-normal shrink-0">{region} ›</span>
            {cockpitMenu
              ? (() => {
                  const ctx     = buildCockpitCtx(sa, cockpit);
                  const url     = cockpitMenu.url ? resolveUrl(cockpitMenu.url, ctx) : undefined;
                  const spaces  = sa.org?.spaces ?? [];
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
                      </DropdownMenuContent>
                    </DropdownMenu>
                  );
                })()
              : <span className="truncate">{saLabel} <span className="font-normal text-xs font-mono text-muted-foreground">({subdomain})</span></span>
            }
            <span className="text-muted-foreground font-normal shrink-0">› Users</span>
          </div>
          {selectedKey && (
            <button
              onClick={() => void handleExport()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-xs border border-border hover:bg-accent hover:text-accent-foreground transition-colors shrink-0"
              title="Export user as JSON"
            >
              <Download className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Export</span>
            </button>
          )}
          <button
            onClick={() => void doRefresh()}
            disabled={subProgress?.type === 'refreshing'}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-xs border border-border hover:bg-accent hover:text-accent-foreground transition-colors disabled:opacity-50 shrink-0"
            title="Refresh subaccount users from XSUAA"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${subProgress?.type === 'refreshing' ? 'animate-spin' : ''}`} />
            <span className="hidden sm:inline">{subProgress?.type === 'refreshing' ? 'Refreshing…' : 'Refresh'}</span>
          </button>
          <button
            onClick={() => setMaximized(v => !v)}
            className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors shrink-0"
            title={maximized ? 'Restore' : 'Maximize'}
          >
            {maximized ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </button>
          <button onClick={onClose} className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors shrink-0">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Sub-progress banner */}
        {subProgress && (
          <div className={`shrink-0 border-b border-border relative ${
            subProgress.type === 'refreshing' ? 'bg-muted/40' :
            subProgress.type === 'done'       ? 'bg-green-500/8' :
                                                 'bg-amber-500/8'
          }`}>
            {subProgress.type === 'refreshing' && (
              <div className="h-1 bg-primary/30 w-full">
                <div className="h-full bg-primary animate-pulse" style={{ width: '100%' }} />
              </div>
            )}
            <div className={`px-4 py-1.5 text-xs text-center ${
              subProgress.type === 'refreshing' ? 'text-foreground' :
              subProgress.type === 'done'       ? 'text-green-600 dark:text-green-400' :
                                                   'text-amber-600 dark:text-amber-400'
            }`}>
              {subProgress.type === 'refreshing' && 'Refreshing subaccount users…'}
              {subProgress.type === 'done' && (
                hasNoChange
                  ? 'Refreshed — no change'
                  : `Refreshed — received ${subProgress.received ?? 0}, created ${subProgress.created ?? 0}, updated ${subProgress.updated ?? 0}, deleted ${subProgress.deleted ?? 0} users`
              )}
              {subProgress.type === 'error' && (subProgress.errors?.join('; ') ?? 'Error')}
            </div>
            {subProgress.type !== 'refreshing' && (
              <button onClick={clearSubProgress} className="absolute top-1 right-1 p-0.5 rounded text-muted-foreground/60 hover:text-foreground transition-colors">
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        )}

        {/* Body */}
        <div className="flex flex-1 min-h-0 overflow-hidden" ref={bodyRef}>

          {/* Left panel: user table */}
          {leftVisible && (
            <div style={{ width: `${splitPct}%` }} className="shrink-0 flex flex-col min-h-0">
              <div className="px-2 py-2 border-b border-border shrink-0">
                <div className="relative">
                  <Filter className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
                  <input
                    type="text"
                    value={filter}
                    onChange={e => setFilter(e.target.value)}
                    placeholder="Filter users…"
                    className="w-full h-7 pl-7 pr-2 text-xs border border-border rounded bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground"
                  />
                  {filter && (
                    <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground/50 pointer-events-none select-none">
                      {filteredUsers.length} of {users.length} matched
                    </span>
                  )}
                </div>
              </div>
              <div className="flex-1 overflow-y-auto min-h-0" ref={tableContainerRef}>
                {filteredUsers.length === 0 ? (
                  <div className="px-3 py-4 text-xs text-muted-foreground text-center">
                    {users.length === 0 ? 'No users. Click Refresh.' : 'No results.'}
                  </div>
                ) : (
                  <table className="w-full text-xs border-collapse table-fixed">
                    <colgroup>
                      {colWidths.map((w, i) => <col key={i} style={{ width: `${w}%` }} />)}
                    </colgroup>
                    <thead className="sticky top-0 bg-background z-10">
                      <tr className="border-b border-border bg-muted/20">
                        {([
                          ['userName',      'User'],
                          ['email',         'Email'],
                          ['origin',        'Origin'],
                          ['lastLogonTime', 'Last Login'],
                        ] as const).map(([col, label], i) => (
                          <th
                            key={col}
                            onClick={() => handleSort(col)}
                            className="px-2 py-1 text-left text-[10px] font-medium text-muted-foreground uppercase tracking-wide cursor-pointer hover:text-foreground select-none relative"
                            style={{ overflow: 'visible' }}
                          >
                            <span className="inline-flex items-center gap-0.5">
                              {label}
                              <span className={`text-[9px] ${sortCol === col ? 'text-primary' : 'text-muted-foreground/30'}`}>
                                {sortCol === col ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ' ⇅'}
                              </span>
                            </span>
                            {i < 3 && (
                              <div
                                onMouseDown={e => startResize(e, i)}
                                className="absolute top-0 right-0 h-full w-1.5 hover:bg-primary/25 transition-colors"
                                style={{ cursor: 'col-resize' }}
                              />
                            )}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {sortedUsers.map(u => {
                        const email = u.emails?.[0]?.value ?? '';
                        const isSelected = userKey(u) === selectedKey;
                        return (
                          <tr
                            key={userKey(u)}
                            onClick={() => selectUser(u)}
                            className={`cursor-pointer border-b border-border/60 transition-colors ${
                              isSelected ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/40'
                            }`}
                          >
                            <td className="px-2 py-1 overflow-hidden text-ellipsis whitespace-nowrap" title={u.userName}>{u.userName}</td>
                            <td className="px-2 py-1 overflow-hidden text-ellipsis whitespace-nowrap text-muted-foreground" title={email}>{email}</td>
                            <td className="px-2 py-1 overflow-hidden text-ellipsis whitespace-nowrap text-muted-foreground" title={u.origin}>{u.origin}</td>
                            <td className="px-2 py-1 whitespace-nowrap tabular-nums text-muted-foreground">{fmtLoginTime(u.lastLogonTime)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          )}

          {/* Draggable split divider */}
          {leftVisible && (
            <div
              onMouseDown={startSplitResize}
              className="w-1 shrink-0 bg-border hover:bg-primary/50 active:bg-primary/70 cursor-col-resize transition-colors"
            />
          )}

          {/* Right panel */}
          <div className="flex-1 flex flex-col min-h-0 min-w-0">
            {!selectedKey && (
              <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
                <span className="text-xs">{users.length === 0 ? 'Click Refresh to load users.' : 'Select a user.'}</span>
              </div>
            )}

            {selectedKey && (
              <>
                {/* Name bar */}
                <div className="shrink-0 px-3 py-2 border-b border-border flex items-center gap-2 min-w-0">
                  <button
                    onClick={() => setLeftVisible(v => !v)}
                    className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors shrink-0"
                    title={leftVisible ? 'Collapse user list' : 'Expand user list'}
                  >
                    <PanelLeft className="h-4 w-4" />
                  </button>
                  {selectedUser && (() => {
                    const fullName = [selectedUser.name?.givenName, selectedUser.name?.familyName].filter(Boolean).join(' ') || selectedUser.userName;
                    const email    = selectedUser.emails?.[0]?.value ?? '';
                    const origin   = selectedUser.origin;
                    const titleStr = `${fullName}${email ? ` <${email}>` : ''} (${origin})`;
                    return (
                      <p className="text-sm font-semibold truncate min-w-0 flex-1" title={titleStr}>
                        {fullName}
                        {email && <span className="font-normal text-muted-foreground"> &lt;{email}&gt;</span>}
                        <span className="font-normal text-muted-foreground"> ({origin})</span>
                      </p>
                    );
                  })()}
                </div>

                {/* Tabs */}
                <div className="flex items-stretch border-b border-border shrink-0">
                  {(['detail', 'access', 'history'] as const).map(t => (
                    <button key={t} onClick={() => changeTab(t)} className={tabCls(tab === t)}>
                      {t === 'detail' ? 'User Detail' : t === 'access' ? 'Global Access' : 'Change History'}
                    </button>
                  ))}
                </div>

                {/* Tab content */}
                <div className="flex-1 overflow-auto">
                  {loading && (
                    <div className="flex items-center justify-center py-8">
                      <RefreshCw className="h-4 w-4 animate-spin text-muted-foreground" />
                    </div>
                  )}

                  {/* User Detail */}
                  {!loading && tab === 'detail' && selectedUser && (
                    <div className="p-4">
                      <div className="border border-border rounded-md overflow-hidden">
                        <table className="w-full text-xs border-collapse">
                          <tbody>
                            {([
                              ['ID',                selectedUser.id],
                              ['External ID',       selectedUser.externalId],
                              ['Username',          selectedUser.userName],
                              ['Given Name',        selectedUser.name?.givenName],
                              ['Family Name',       selectedUser.name?.familyName],
                              ['Email(s)',          selectedUser.emails?.map(e => e.value).join(', ')],
                              ['Active',           selectedUser.active  !== undefined ? String(selectedUser.active)   : undefined],
                              ['Verified',         selectedUser.verified !== undefined ? String(selectedUser.verified) : undefined],
                              ['Origin',           selectedUser.origin],
                              ['Zone ID',          selectedUser.zoneId],
                              ['Groups',           selectedUser.groups ? `${selectedUser.groups.length} assigned` : undefined],
                              ['Password Modified', selectedUser.passwordLastModified ? fmtDate(selectedUser.passwordLastModified) : undefined],
                              ['Last Logon',       selectedUser.lastLogonTime     ? fmtDate(selectedUser.lastLogonTime)     : undefined],
                              ['Previous Logon',   selectedUser.previousLogonTime ? fmtDate(selectedUser.previousLogonTime) : undefined],
                              ['Created',          selectedUser.meta?.created],
                              ['Last Modified',    selectedUser.meta?.lastModified],
                            ] as [string, string | undefined][])
                              .filter(([, v]) => v !== undefined && v !== '')
                              .map(([label, value]) => (
                                <tr key={label} className="border-b border-border last:border-0 hover:bg-muted/10">
                                  <td className={tdLabel}>{label}</td>
                                  <td className={tdValue}>{value}</td>
                                </tr>
                              ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  {/* Global Access */}
                  {!loading && tab === 'access' && (
                    <div className="p-4">
                      {globalAccess.length === 0 && (
                        <p className="text-xs text-muted-foreground">No cross-subaccount access found.</p>
                      )}
                      {globalAccess.length > 0 && (
                        <div className="border border-border rounded-md overflow-hidden">
                          <table className="w-full text-xs border-collapse">
                            <thead>
                              <tr className="bg-muted/30">
                                <th className="px-3 py-1.5 text-left font-medium text-muted-foreground border-b border-border">Subaccount &gt; Groups</th>
                                <th className="px-3 py-1.5 text-left font-medium text-muted-foreground border-b border-border">Type</th>
                              </tr>
                            </thead>
                            <tbody>
                              {globalAccess.map(entry => {
                                const eKey      = `${entry.region}/${entry.subdomain}`;
                                const isExpanded = expanded.has(eKey);
                                return (
                                  <Fragment key={eKey}>
                                    <tr
                                      onClick={() => setExpanded(prev => {
                                        const next = new Set(prev);
                                        if (next.has(eKey)) next.delete(eKey); else next.add(eKey);
                                        return next;
                                      })}
                                      className="hover:bg-muted/20 cursor-pointer"
                                    >
                                      <td colSpan={2} className="px-3 py-1.5 border-b border-border font-medium">
                                        <span className="inline-flex items-center gap-1">
                                          {isExpanded
                                            ? <ChevronDown  className="h-3 w-3 shrink-0" />
                                            : <ChevronRight className="h-3 w-3 shrink-0" />}
                                          {entry.alias} ({entry.subdomain})
                                          <span className="text-muted-foreground font-normal text-[10px]">
                                            · {entry.region} · {entry.groups.length} group{entry.groups.length !== 1 ? 's' : ''}
                                          </span>
                                        </span>
                                      </td>
                                    </tr>
                                    {isExpanded && entry.groups.map((g, gi) => (
                                      <tr key={`${eKey}-${gi}`} className="hover:bg-muted/10">
                                        <td className="px-3 py-1 border-b border-border pl-8 font-mono text-[11px]">{g.value}</td>
                                        <td className="px-3 py-1 border-b border-border text-muted-foreground">{g.type}</td>
                                      </tr>
                                    ))}
                                  </Fragment>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Change History */}
                  {!loading && tab === 'history' && (
                    <div className="px-4 py-4">
                      {!changelog && <p className="text-xs text-muted-foreground">No changelog yet.</p>}
                      {changelog && <div className="font-mono text-xs leading-relaxed">{renderChangelog(changelog)}</div>}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
