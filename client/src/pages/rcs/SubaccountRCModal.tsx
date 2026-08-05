import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  ArrowUpDown, ChevronDown, ChevronUp,
  Download, Filter, Maximize2, Minimize2,
  PanelLeft, RefreshCw, Search, Trash2, UserPlus, X,
} from 'lucide-react';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
  DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useSettings } from '@/components/AppLayout';
import type { SubaccountEntry, SpaceEntry } from '@/components/config/SubaccountsTable';
import type { CockpitMenuItem } from '@/components/home/HomepageContent';

// ─── Types ────────────────────────────────────────────────────────────────────

interface RoleReference {
  roleTemplateAppId: string;
  roleTemplateName:  string;
  name:              string;
  description:       string;
}

interface UserReference {
  id:       string;
  userName: string;
  email:    string;
  origin:   string;
}

interface RoleCollection {
  name:           string;
  description:    string;
  isReadOnly:     boolean;
  roleReferences: RoleReference[];
}

type Tab         = 'details' | 'users' | 'changelog';
type SortField   = 'userName' | 'email' | 'origin';
type SortDir     = 'asc' | 'desc';
type SubProgress = {
  type:      'refreshing' | 'done' | 'error';
  created?:  number;
  updated?:  number;
  deleted?:  number;
  received?: number;
  errors?:   string[];
};

export interface SubaccountRCModalProps {
  sa:               SubaccountEntry;
  allNames:         string[];
  initialName?:     string;
  initialTab?:      Tab;
  initialShowList?: boolean;
  onClose:          () => void;
  onRcDataChange:   () => void;
}

// ─── Cockpit URL helpers ──────────────────────────────────────────────────────

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

// ─── Helpers ─────────────────────────────────────────────────────────────────

function highlightText(text: string | undefined | null, query: string): React.ReactNode {
  const safe = text ?? '';
  if (!query) return safe;
  const parts = safe.split(new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'));
  return parts.map((p, i) =>
    p.toLowerCase() === query.toLowerCase()
      ? <mark key={i} className="bg-yellow-200 dark:bg-yellow-800/50 text-inherit rounded-sm px-0">{p}</mark>
      : p
  );
}

function parseLinks(line: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  const re = /\[([^\]]*)\]\(([^)]+)\)/g;
  let last = 0, k = 0, m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    if (m.index > last) parts.push(line.slice(last, m.index));
    parts.push(<a key={k++} href={m[2]!} className="underline underline-offset-2 hover:text-foreground">{m[1]}</a>);
    last = m.index + m[0].length;
  }
  if (last < line.length) parts.push(line.slice(last));
  return parts.length ? parts : line;
}

function renderChangelog(text: string): React.ReactNode {
  return text.split('\n').map((line, i) => {
    if (line.startsWith('## ')) return <div key={i} className="font-bold mt-4 mb-1 text-foreground first:mt-0">{line.slice(3)}</div>;
    if (line.startsWith('+ '))  return <div key={i} className="text-green-600 dark:text-green-400 pl-1">{parseLinks(line)}</div>;
    if (line.startsWith('- '))  return <div key={i} className="text-red-500 dark:text-red-400 pl-1">{parseLinks(line)}</div>;
    return <div key={i} className="text-muted-foreground">{line ? parseLinks(line) : ' '}</div>;
  });
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function SubaccountRCModal({
  sa,
  allNames,
  initialName,
  initialTab = 'details',
  initialShowList = true,
  onClose,
  onRcDataChange,
}: SubaccountRCModalProps) {
  const navigate = useNavigate();
  const { settings, cockpitMenu } = useSettings();
  const cockpit = settings?.homepage.cockpit ?? { idp: '', host: '' };

  const [names,        setNames]        = useState<string[]>(allNames);
  const [search,       setSearch]       = useState('');
  const [selectedName, setSelectedName] = useState<string>(initialName ?? allNames[0] ?? '');
  const [showList,     setShowList]     = useState(initialShowList ?? true);
  const [tab,          setTab]          = useState<Tab>(initialTab);
  const [maximized,    setMaximized]    = useState(false);

  const [rc,        setRc]        = useState<RoleCollection | null>(null);
  const [users,     setUsers]     = useState<UserReference[]>([]);
  const [changelog, setChangelog] = useState('');
  const [loading,   setLoading]   = useState(false);

  const [subProgress, setSubProgress] = useState<SubProgress | null>(null);
  const subProgressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Accumulated unique origins seen across all user loads for this subaccount
  const knownOriginsRef = useRef<Set<string>>(new Set(['sap.ids']));

  const [newUserName,   setNewUserName]   = useState('');
  const [newUserEmail,  setNewUserEmail]  = useState('');
  const [newUserOrigin, setNewUserOrigin] = useState('sap.ids');
  const [addUserError,  setAddUserError]  = useState('');

  // Users table state
  const [userFilter,    setUserFilter]    = useState('');
  const [sortField,     setSortField]     = useState<SortField>('userName');
  const [sortDir,       setSortDir]       = useState<SortDir>('asc');
  const [selectedKeys,  setSelectedKeys]  = useState<Set<string>>(new Set());
  const lastClickedKeyRef = useRef<string | null>(null);
  const selectAllRef      = useRef<HTMLInputElement>(null);

  const { region, subdomain } = sa;
  const loc      = `${region}/${subdomain}`;
  const saLabel  = sa.alias || sa.subaccountName || sa.subdomain;

  const filtered = names.filter(n => !search || n.toLowerCase().includes(search.toLowerCase()));

  // Derived: filtered + sorted users
  const userFilterLow  = userFilter.toLowerCase();
  const filteredUsers  = userFilter
    ? users.filter(u =>
        (u.userName ?? '').toLowerCase().includes(userFilterLow) ||
        (u.email    ?? '').toLowerCase().includes(userFilterLow) ||
        (u.origin   ?? '').toLowerCase().includes(userFilterLow)
      )
    : users;
  const sortedUsers = [...filteredUsers].sort((a, b) => {
    const av = (a[sortField] ?? '').toLowerCase();
    const bv = (b[sortField] ?? '').toLowerCase();
    return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
  });

  function userKey(u: UserReference): string { return `${u.userName}:::${u.origin}`; }

  const allFilteredSelected  = filteredUsers.length > 0 && filteredUsers.every(u => selectedKeys.has(userKey(u)));
  const someFilteredSelected = filteredUsers.some(u => selectedKeys.has(userKey(u)));
  const selectedCount        = selectedKeys.size;

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = someFilteredSelected && !allFilteredSelected;
    }
  }, [someFilteredSelected, allFilteredSelected]);

  // Known origins for the origin select (deduplicated, sorted)
  const originOptions = [...knownOriginsRef.current].sort();

  function toggleSort(field: SortField) {
    if (sortField === field) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortField(field); setSortDir('asc'); }
  }

  function toggleSelectAll() {
    setSelectedKeys(prev => {
      const next = new Set(prev);
      if (allFilteredSelected) filteredUsers.forEach(u => next.delete(userKey(u)));
      else filteredUsers.forEach(u => next.add(userKey(u)));
      return next;
    });
  }

  function handleRowClick(e: React.MouseEvent, idx: number) {
    const u   = sortedUsers[idx]!;
    const key = userKey(u);
    if (e.shiftKey && lastClickedKeyRef.current !== null) {
      const anchorIdx = sortedUsers.findIndex(su => userKey(su) === lastClickedKeyRef.current);
      const start = Math.min(anchorIdx !== -1 ? anchorIdx : idx, idx);
      const end   = Math.max(anchorIdx !== -1 ? anchorIdx : idx, idx);
      setSelectedKeys(prev => {
        const next = new Set(prev);
        for (let i = start; i <= end; i++) next.add(userKey(sortedUsers[i]!));
        return next;
      });
      return;
    }
    lastClickedKeyRef.current = key;
    setSelectedKeys(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  function SortIcon({ field }: { field: SortField }) {
    if (sortField !== field) return <ArrowUpDown className="h-3 w-3 ml-1 opacity-40" />;
    return sortDir === 'asc'
      ? <ChevronUp   className="h-3 w-3 ml-1" />
      : <ChevronDown className="h-3 w-3 ml-1" />;
  }

  async function loadRc(name: string, activeTab: Tab) {
    if (!name) return;
    setLoading(true);
    try {
      const setError = (msg: string) => {
        if (subProgressTimerRef.current) { clearTimeout(subProgressTimerRef.current); subProgressTimerRef.current = null; }
        setSubProgress({ type: 'error', errors: [msg] });
      };
      if (activeTab === 'details') {
        const r = await fetch(`/api/role-collections/${loc}/${encodeURIComponent(name)}`);
        const j = await r.json() as { ok: boolean; rc: RoleCollection; error?: string };
        if (!j.ok) {
          setError(j.error ?? 'Failed to load role collection details');
        } else {
          setRc(j.rc);
          setSubProgress(p => p?.type === 'error' ? null : p);
        }
      } else if (activeTab === 'users') {
        const r = await fetch(`/api/role-collections/${loc}/${encodeURIComponent(name)}/users`);
        const j = await r.json() as { ok: boolean; data: UserReference[]; error?: string };
        if (!j.ok) {
          setError(j.error ?? 'Failed to load users');
        } else {
          setUsers(j.data);
          for (const u of j.data) if (u.origin) knownOriginsRef.current.add(u.origin);
          setSubProgress(p => p?.type === 'error' ? null : p);
        }
      } else if (activeTab === 'changelog') {
        const r = await fetch(`/api/role-collections/${loc}/${encodeURIComponent(name)}/changelog`);
        const j = await r.json() as { ok: boolean; data: string; error?: string };
        if (!j.ok) {
          setError(j.error ?? 'Failed to load changelog');
        } else {
          setChangelog(j.data);
          setSubProgress(p => p?.type === 'error' ? null : p);
        }
      }
    } catch (err) {
      if (subProgressTimerRef.current) { clearTimeout(subProgressTimerRef.current); subProgressTimerRef.current = null; }
      setSubProgress({ type: 'error', errors: [err instanceof Error ? err.message : 'Failed to load data'] });
    } finally {
      setLoading(false);
    }
  }

  async function loadNames() {
    const r = await fetch(`/api/role-collections/${loc}?noRefresh=1`);
    const j = await r.json() as { ok: boolean; names: string[] };
    if (j.ok) { setNames(j.names); return j.names; }
    return names;
  }

  useEffect(() => {
    void (async () => {
      // Phase 1: show local names immediately without blocking on a proactive refresh
      let localNames = allNames;
      let isStale    = false;
      try {
        const r = await fetch(`/api/role-collections/${loc}?noRefresh=1`);
        const j = await r.json() as { ok: boolean; names: string[]; stale?: boolean };
        if (j.ok) { setNames(j.names); localNames = j.names; isStale = j.stale ?? false; }
      } catch { /* keep allNames */ }

      const name = initialName ?? localNames[0] ?? '';
      setSelectedName(name);
      if (name) void loadRc(name, initialTab);

      // Phase 2: if refresh is due, run it in the background
      if (!isStale) return;
      setSubProgress({ type: 'refreshing' });
      try {
        const r  = await fetch(`/api/role-collections/${loc}/refresh`, { method: 'POST' });
        const j  = await r.json() as { ok: boolean; result?: { created: number; updated: number; deleted: number; received: number; errors: string[] }; error?: string };
        if (!j.ok) {
          setSubProgress({ type: 'error', errors: [j.error ?? 'Refresh failed'] });
          return;
        }
        const res = j.result ?? { created: 0, updated: 0, deleted: 0, received: 0, errors: [] };
        if (res.errors.length > 0) {
          setSubProgress({ type: 'error', errors: res.errors });
        } else {
          setSubProgress({ type: 'done', created: res.created, updated: res.updated, deleted: res.deleted, received: res.received });
          subProgressTimerRef.current = setTimeout(clearSubProgress, 3000);
        }
        // Reload names after refresh; reload selected RC only when no errors (loadRc
        // success path clears error banners, so calling it on error would wipe the message)
        const fresh = await loadNames();
        if (res.errors.length === 0) {
          if (name && !fresh.includes(name) && fresh.length > 0) {
            setSelectedName(fresh[0]!);
            void loadRc(fresh[0]!, initialTab);
          } else if (name) {
            void loadRc(name, initialTab);
          }
        }
        onRcDataChange();
      } catch (err) {
        setSubProgress({ type: 'error', errors: [err instanceof Error ? err.message : 'Refresh failed'] });
      }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function selectRc(name: string) {
    setSelectedName(name);
    setRc(null);
    setUsers([]);
    setChangelog('');
    setUserFilter('');
    setSelectedKeys(new Set());
    lastClickedKeyRef.current = null;
    void loadRc(name, tab);
    const rcPath = tab === 'changelog' ? 'history' : tab;
    navigate(`/role-collections/${region}/${subdomain}/${encodeURIComponent(name)}/${rcPath}`, { replace: true });
  }

  function changeTab(t: Tab) {
    setTab(t);
    if (t !== 'users') setUserFilter('');
    void loadRc(selectedName, t);
    const rcPath = t === 'changelog' ? 'history' : t;
    navigate(`/role-collections/${region}/${subdomain}/${encodeURIComponent(selectedName)}/${rcPath}`, { replace: true });
  }

  function clearSubProgress() {
    if (subProgressTimerRef.current) { clearTimeout(subProgressTimerRef.current); subProgressTimerRef.current = null; }
    setSubProgress(null);
  }

  async function doRefresh() {
    clearSubProgress();
    setSubProgress({ type: 'refreshing' });
    try {
      const r = await fetch(`/api/role-collections/${loc}/refresh`, { method: 'POST' });
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
        subProgressTimerRef.current = setTimeout(clearSubProgress, 3000);
      }
      const fresh = await loadNames();
      if (res.errors.length === 0) {
        const cur = selectedName;
        if (!fresh.includes(cur) && fresh.length > 0) selectRc(fresh[0]!);
        else if (cur) void loadRc(cur, tab);
      }
      onRcDataChange();
    } catch (err) {
      setSubProgress({ type: 'error', errors: [err instanceof Error ? err.message : 'Refresh failed'] });
    }
  }

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('keydown', handleKey);
      if (subProgressTimerRef.current) clearTimeout(subProgressTimerRef.current);
    };
  }, [onClose]);

  async function handleExport() {
    if (!selectedName) return;
    const r    = await fetch(`/api/role-collections/${loc}/${encodeURIComponent(selectedName)}/export`);
    const blob = await r.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `${region}_${subdomain}_${selectedName}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleAddUser(e: React.FormEvent) {
    e.preventDefault();
    if (!newUserEmail.trim() && !newUserName.trim()) return;
    setAddUserError('');
    try {
      const r = await fetch(`/api/role-collections/${loc}/${encodeURIComponent(selectedName)}/users`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          email:    newUserEmail.trim(),
          userName: newUserName.trim() || newUserEmail.trim(),
          origin:   newUserOrigin,
        }),
      });
      const j = await r.json() as { ok: boolean; data?: UserReference[]; error?: string };
      if (!j.ok) { setAddUserError(j.error ?? 'Failed to add user'); return; }
      if (j.data) {
        setUsers(j.data);
        for (const u of j.data) if (u.origin) knownOriginsRef.current.add(u.origin);
      } else void loadRc(selectedName, 'users');
      setNewUserName('');
      setNewUserEmail('');
    } catch (err) {
      setAddUserError(err instanceof Error ? err.message : 'Failed to add user');
    }
  }

const tabCls = (active: boolean) =>
    `px-4 py-2 text-xs transition-colors border-b-2 ${
      active
        ? 'border-primary text-foreground font-medium'
        : 'border-transparent text-muted-foreground hover:text-foreground'
    }`;

  const thCls = 'px-3 py-1.5 text-left font-medium text-muted-foreground border-b border-border';
  const thBtn = `${thCls} cursor-pointer select-none hover:text-foreground group`;

  const hasNoChange = subProgress?.type === 'done' &&
    (subProgress.created ?? 0) === 0 &&
    (subProgress.updated ?? 0) === 0 &&
    (subProgress.deleted ?? 0) === 0;

  return (
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm ${maximized ? 'p-0' : 'p-4'}`}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className={`flex flex-col bg-background border border-border shadow-2xl h-[90vh] ${
        maximized ? 'w-full h-full rounded-none' : 'w-full max-w-5xl rounded-xl'
      }`}>

        {/* Header */}
        <div className="flex items-center gap-2 px-4 border-b border-border min-h-[52px] shrink-0">
          <div className="text-sm font-semibold min-w-0 flex-1 flex items-center gap-1 overflow-hidden">
            <span className="text-muted-foreground font-normal shrink-0">{region} ›</span>
            {cockpitMenu
              ? (() => {
                  const ctx    = buildCockpitCtx(sa, cockpit);
                  const url    = cockpitMenu.url ? resolveUrl(cockpitMenu.url, ctx) : undefined;
                  const spaces = sa.org?.spaces ?? [];
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
            <span className="text-muted-foreground font-normal shrink-0">› Role Collections</span>
          </div>
          <button
            onClick={() => void doRefresh()}
            disabled={subProgress?.type === 'refreshing'}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-xs border border-border hover:bg-accent hover:text-accent-foreground transition-colors disabled:opacity-50 shrink-0"
            title="Refresh subaccount role collections from XSUAA"
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
            subProgress.type === 'refreshing' ? 'bg-muted/40 animate-pulse' :
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
              {subProgress.type === 'refreshing' && 'Refreshing subaccount role collections…'}
              {subProgress.type === 'done' && (
                hasNoChange
                  ? 'Refreshed — no change'
                  : `Refreshed — received ${subProgress.received ?? 0}, created ${subProgress.created ?? 0}, updated ${subProgress.updated ?? 0}, deleted ${subProgress.deleted ?? 0} role collections`
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

        {/* Body: list + detail */}
        <div className="flex flex-1 min-h-0 overflow-hidden">

          {/* Left: RC list */}
          {showList && (
            <div className="w-56 shrink-0 border-r border-border flex flex-col min-h-0">
              <div className="px-2 py-2 border-b border-border shrink-0">
                <div className="relative">
                  <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
                  <input
                    type="text"
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    placeholder="Filter…"
                    className={`w-full h-7 pl-7 ${search ? 'pr-14' : 'pr-2'} text-xs border border-border rounded bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground`}
                  />
                  {search && (
                    <span className="absolute right-7 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground/60 pointer-events-none whitespace-nowrap">
                      {filtered.length} of {names.length}
                    </span>
                  )}
                  {search && (
                    <button
                      onClick={() => setSearch('')}
                      className="absolute right-1.5 top-1/2 -translate-y-1/2 h-4 w-4 flex items-center justify-center text-muted-foreground hover:text-foreground"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </div>
              </div>
              <div className="flex-1 overflow-y-auto py-1">
                {filtered.length === 0 && (
                  <div className="px-3 py-4 text-xs text-muted-foreground text-center">
                    {names.length === 0 ? 'No role collections. Click Refresh.' : 'No results.'}
                  </div>
                )}
                {filtered.map(name => (
                  <button
                    key={name}
                    onClick={() => selectRc(name)}
                    className={`w-full text-left px-3 py-1.5 text-xs truncate transition-colors ${
                      name === selectedName
                        ? 'bg-accent text-accent-foreground font-medium'
                        : 'text-foreground hover:bg-accent/50'
                    }`}
                    title={name}
                  >
                    {highlightText(name, search)}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Right: detail */}
          <div className="flex-1 flex flex-col min-h-0 min-w-0">
            {!selectedName && (
              <div className="flex-1 flex flex-col items-center justify-center text-sm text-muted-foreground gap-3">
                {!showList && (
                  <button
                    onClick={() => setShowList(true)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-xs border border-border hover:bg-accent hover:text-accent-foreground transition-colors"
                  >
                    <PanelLeft className="h-3.5 w-3.5" />
                    Show list
                  </button>
                )}
                <span className="text-xs">
                  {names.length === 0 ? 'Click Refresh to load role collections.' : 'Select a role collection.'}
                </span>
              </div>
            )}

            {selectedName && (
              <>
                {/* Detail header — same height as filter row (py-2 + h-7 content) */}
                <div className="shrink-0 px-4 py-2 border-b border-border flex items-center gap-2">
                  <button
                    onClick={() => setShowList(v => !v)}
                    className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors shrink-0"
                    title={showList ? 'Collapse list' : 'Expand list'}
                  >
                    <PanelLeft className="h-4 w-4" />
                  </button>
                  <div className="min-w-0 flex-1 flex items-center gap-1.5">
                    <p
                      className="font-semibold text-sm truncate"
                      title={rc?.description || undefined}
                    >
                      {selectedName}
                    </p>
                    {rc?.isReadOnly && (
                      <span className="inline-flex items-center shrink-0 text-[10px] text-muted-foreground/70 border border-border px-1.5 py-0.5 rounded-sm leading-none">
                        Read-only
                      </span>
                    )}
                  </div>
                  <button
                    onClick={() => void handleExport()}
                    className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors shrink-0"
                    title="Export as JSON"
                  >
                    <Download className="h-3.5 w-3.5" />
                  </button>
                </div>

                {/* Tabs */}
                <div className="flex items-stretch border-b border-border shrink-0">
                  {(['details', 'users', 'changelog'] as const).map(t => (
                    <button key={t} onClick={() => changeTab(t)} className={tabCls(tab === t)}>
                      {t === 'details' ? 'Details' : t === 'users' ? `Users${users.length ? ` (${users.length})` : ''}` : 'Changelog'}
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

                  {!loading && tab === 'details' && rc && (
                    <div className="px-4 py-4 space-y-4">
                      {/* Description */}
                      {rc.description && (
                        <div>
                          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1">Description</p>
                          <p className="text-xs text-foreground/80 leading-relaxed">{rc.description}</p>
                        </div>
                      )}
                      {/* Roles */}
                      <div>
                        <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-2">Roles ({(rc.roleReferences ?? []).length})</p>
                        {(rc.roleReferences ?? []).length === 0
                          ? <p className="text-xs text-muted-foreground">No roles assigned.</p>
                          : (
                            <div className="border border-border rounded-md overflow-hidden">
                              <table className="w-full text-xs border-collapse">
                                <thead>
                                  <tr className="bg-muted/30">
                                    <th className={thCls}>Role Template</th>
                                    <th className={thCls}>App</th>
                                    <th className={thCls}>Description</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {(rc.roleReferences ?? []).map((r, i) => (
                                    <tr key={i} className="border-b border-border last:border-0 hover:bg-muted/10">
                                      <td className="px-3 py-1.5 font-mono">{r.roleTemplateName || r.name}</td>
                                      <td className="px-3 py-1.5 text-muted-foreground truncate max-w-[200px]" title={r.roleTemplateAppId}>{r.roleTemplateAppId}</td>
                                      <td className="px-3 py-1.5 text-muted-foreground">{r.description}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          )
                        }
                      </div>
                    </div>
                  )}

                  {!loading && tab === 'users' && (
                    <div className="px-4 py-4 space-y-4">
                      {/* Add user form */}
                      <form onSubmit={e => void handleAddUser(e)} className="flex flex-col gap-2">
                        <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Add User</p>
                        <div className="flex items-center gap-2 flex-wrap">
                          <input
                            type="text"
                            value={newUserName}
                            onChange={e => setNewUserName(e.target.value)}
                            placeholder="Username"
                            className="h-7 px-2 text-xs border border-border rounded bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-ring flex-1 min-w-[130px]"
                          />
                          <input
                            type="text"
                            value={newUserEmail}
                            onChange={e => setNewUserEmail(e.target.value)}
                            placeholder="Email"
                            className="h-7 px-2 text-xs border border-border rounded bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-ring flex-1 min-w-[160px]"
                          />
                          <select
                            value={newUserOrigin}
                            onChange={e => setNewUserOrigin(e.target.value)}
                            className="h-7 px-2 text-xs border border-border rounded bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-ring w-[130px]"
                          >
                            {originOptions.map(o => <option key={o} value={o}>{o}</option>)}
                          </select>
                          <button
                            type="submit"
                            disabled
                            className="h-7 inline-flex items-center gap-1.5 px-3 text-xs border border-border rounded transition-colors opacity-50 cursor-not-allowed"
                          >
                            <UserPlus className="h-3 w-3" />
                            Add user (wip)
                          </button>
                        </div>
                        {addUserError && <p className="text-xs text-destructive">{addUserError}</p>}
                      </form>

                      {/* Users list */}
                      <div>
                        {/* Filter bar + Remove button */}
                        <div className="flex items-center gap-2 mb-2">
                          <div className="relative flex-1 min-w-0">
                            <Filter className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground pointer-events-none" />
                            <input
                              type="text"
                              value={userFilter}
                              onChange={e => setUserFilter(e.target.value)}
                              placeholder="Filter users…"
                              className={`w-full h-6 pl-6 ${userFilter ? 'pr-[200px]' : 'pr-28'} text-[11px] border border-border rounded bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground`}
                            />
                            {userFilter ? (
                              <>
                                <span className="absolute right-6 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground/60 pointer-events-none whitespace-nowrap">
                                  {filteredUsers.length} user{filteredUsers.length !== 1 ? 's' : ''} matched
                                </span>
                                <button
                                  type="button"
                                  onClick={() => setUserFilter('')}
                                  className="absolute right-1.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 flex items-center justify-center text-muted-foreground hover:text-foreground"
                                >
                                  <X className="h-2.5 w-2.5" />
                                </button>
                              </>
                            ) : (
                              <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground/60 pointer-events-none whitespace-nowrap">
                                {users.length} users assigned
                              </span>
                            )}
                          </div>
                          <button
                            type="button"
                            disabled
                            className="h-6 shrink-0 inline-flex items-center gap-1.5 px-2.5 text-[11px] border border-border rounded opacity-50 cursor-not-allowed whitespace-nowrap"
                          >
                            <Trash2 className="h-3 w-3" />
                            Remove ({selectedCount}) users (wip)
                          </button>
                        </div>

                        {users.length === 0
                          ? <p className="text-xs text-muted-foreground">{loading ? 'Loading…' : 'No users assigned.'}</p>
                          : (
                            <div className="border border-border rounded-md overflow-hidden">
                              <table className="w-full text-xs border-collapse">
                                <thead>
                                  <tr className="bg-muted/30">
                                    <th className="px-2 py-1.5 text-left font-medium text-muted-foreground border-b border-border w-8">
                                      <input
                                        ref={selectAllRef}
                                        type="checkbox"
                                        checked={allFilteredSelected}
                                        onChange={toggleSelectAll}
                                        className="h-3.5 w-3.5 accent-primary"
                                        title={allFilteredSelected ? 'Deselect all' : 'Select all'}
                                      />
                                    </th>
                                    <th className={thBtn} onClick={() => toggleSort('userName')}>
                                      <span className="inline-flex items-center">Username <SortIcon field="userName" /></span>
                                    </th>
                                    <th className={thBtn} onClick={() => toggleSort('email')}>
                                      <span className="inline-flex items-center">Email <SortIcon field="email" /></span>
                                    </th>
                                    <th className={thBtn} onClick={() => toggleSort('origin')}>
                                      <span className="inline-flex items-center">Origin <SortIcon field="origin" /></span>
                                    </th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {sortedUsers.length === 0 && (
                                    <tr>
                                      <td colSpan={4} className="px-3 py-3 text-xs text-muted-foreground text-center">No matches.</td>
                                    </tr>
                                  )}
                                  {sortedUsers.map((u, i) => {
                                    const isSelected = selectedKeys.has(userKey(u));
                                    return (
                                      <tr
                                        key={i}
                                        onClick={e => handleRowClick(e, i)}
                                        className={`border-b border-border last:border-0 cursor-pointer select-none ${
                                          isSelected ? 'bg-primary/10 hover:bg-primary/15' : 'hover:bg-muted/10'
                                        }`}
                                      >
                                        <td className="px-2 py-1.5">
                                          <input
                                            type="checkbox"
                                            checked={isSelected}
                                            onChange={() => {}}
                                            className="h-3.5 w-3.5 accent-primary pointer-events-none"
                                          />
                                        </td>
                                        <td className="px-3 py-1.5 font-mono text-[11px]">
                                          {userFilter ? highlightText(u.userName, userFilter) : u.userName}
                                        </td>
                                        <td className="px-3 py-1.5">
                                          {userFilter ? highlightText(u.email || '—', userFilter) : (u.email || '—')}
                                        </td>
                                        <td className="px-3 py-1.5 text-muted-foreground">
                                          {userFilter ? highlightText(u.origin, userFilter) : u.origin}
                                        </td>
                                      </tr>
                                    );
                                  })}
                                </tbody>
                              </table>
                            </div>
                          )
                        }
                      </div>
                    </div>
                  )}

                  {!loading && tab === 'changelog' && (
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
