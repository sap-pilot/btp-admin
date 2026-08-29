import { useEffect, useRef, useState } from 'react';
import {
  ArrowUpDown, ChevronUp, ChevronDown,
  Download, Filter, PanelLeft, RefreshCw, Trash2, UserPlus, X,
} from 'lucide-react';
import type { SubaccountEntry } from '@/components/config/SubaccountsTable';

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

interface Props {
  sa:               SubaccountEntry;
  allNames?:        string[];
  initialName?:     string;
  initialTab?:      Tab;
  initialShowList?: boolean;
  onRcDataChange?:  () => void;
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

export default function RolesTab({
  sa,
  allNames = [],
  initialName,
  initialTab = 'details',
  onRcDataChange,
}: Props) {

  const [names,        setNames]        = useState<string[]>(allNames);
  const [search,       setSearch]       = useState('');
  const [selectedName, setSelectedName] = useState<string>(initialName ?? allNames[0] ?? '');
  const [showList,     setShowList]     = useState(true);
  const [tab,          setTab]          = useState<Tab>(initialTab);

  const [rc,        setRc]        = useState<RoleCollection | null>(null);
  const [users,     setUsers]     = useState<UserReference[]>([]);
  const [changelog, setChangelog] = useState('');
  const [loading,   setLoading]   = useState(false);

  const [subProgress, setSubProgress] = useState<SubProgress | null>(null);
  const subProgressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const knownOriginsRef = useRef<Set<string>>(new Set(['sap.ids']));

  const [newUserName,   setNewUserName]   = useState('');
  const [newUserEmail,  setNewUserEmail]  = useState('');
  const [newUserOrigin, setNewUserOrigin] = useState('sap.ids');
  const [addUserError,  setAddUserError]  = useState('');

  const [userFilter,   setUserFilter]   = useState('');
  const [sortField,    setSortField]    = useState<SortField>('userName');
  const [sortDir,      setSortDir]      = useState<SortDir>('asc');
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const lastClickedKeyRef = useRef<string | null>(null);
  const selectAllRef      = useRef<HTMLInputElement>(null);

  const { region, subdomain } = sa;
  const loc = `${region}/${subdomain}`;

  const filtered = names.filter(n => !search || n.toLowerCase().includes(search.toLowerCase()));

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
    // Reset state when subaccount changes
    setNames([]);
    setSearch('');
    setSelectedName('');
    setRc(null);
    setUsers([]);
    setChangelog('');
    setSubProgress(null);
    setSelectedKeys(new Set());
    setShowList(true);
    setTab(initialTab);

    void (async () => {
      let localNames: string[] = [];
      let isStale = false;
      try {
        const r = await fetch(`/api/role-collections/${loc}?noRefresh=1`);
        const j = await r.json() as { ok: boolean; names: string[]; stale?: boolean };
        if (j.ok) { setNames(j.names); localNames = j.names; isStale = j.stale ?? false; }
      } catch { /* keep empty */ }

      const name = initialName ?? localNames[0] ?? '';
      setSelectedName(name);
      if (name) void loadRc(name, initialTab);

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
        const fresh = await loadNames();
        if (res.errors.length === 0) {
          if (name && !fresh.includes(name) && fresh.length > 0) {
            setSelectedName(fresh[0]!);
            void loadRc(fresh[0]!, initialTab);
          } else if (name) {
            void loadRc(name, initialTab);
          }
        }
        onRcDataChange?.();
      } catch (err) {
        setSubProgress({ type: 'error', errors: [err instanceof Error ? err.message : 'Refresh failed'] });
      }
    })();

    return () => {
      if (subProgressTimerRef.current) clearTimeout(subProgressTimerRef.current);
    };
  }, [sa.region, sa.subdomain]); // eslint-disable-line react-hooks/exhaustive-deps

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
    history.replaceState(null, '', `/role-collections/${region}/${subdomain}/${encodeURIComponent(name)}/${rcPath}`);
  }

  function changeTab(t: Tab) {
    setTab(t);
    if (t !== 'users') setUserFilter('');
    void loadRc(selectedName, t);
    const rcPath = t === 'changelog' ? 'history' : t;
    history.replaceState(null, '', `/role-collections/${region}/${subdomain}/${encodeURIComponent(selectedName)}/${rcPath}`);
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
      onRcDataChange?.();
    } catch (err) {
      setSubProgress({ type: 'error', errors: [err instanceof Error ? err.message : 'Refresh failed'] });
    }
  }

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

  const iconBtn   = 'p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors shrink-0 disabled:opacity-50';
  const btnNormal = 'inline-flex items-center gap-1.5 px-2 py-1.5 rounded text-xs font-medium hover:bg-accent hover:text-accent-foreground transition-colors shrink-0 disabled:opacity-50 disabled:cursor-not-allowed';

  const hasNoChange = subProgress?.type === 'done' &&
    (subProgress.created ?? 0) === 0 &&
    (subProgress.updated ?? 0) === 0 &&
    (subProgress.deleted ?? 0) === 0;

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden">

      {/* Progress banner */}
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
            {subProgress.type === 'refreshing' && 'Refreshing role collections…'}
            {subProgress.type === 'done' && (
              hasNoChange
                ? 'Refreshed — no change'
                : `Refreshed — received ${subProgress.received ?? 0}, created ${subProgress.created ?? 0}, updated ${subProgress.updated ?? 0}, deleted ${subProgress.deleted ?? 0}`
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
            <div className="px-2 py-2 border-b border-border shrink-0 flex items-center gap-1">
              <div className="relative flex-1">
                <input
                  type="text"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="Filter…"
                  className={`w-full h-7 pl-2 ${search ? 'pr-14' : 'pr-2'} text-xs border border-border rounded bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground`}
                />
                {search && (
                  <span className="absolute right-7 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground/60 pointer-events-none whitespace-nowrap">
                    {filtered.length}/{names.length}
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
              <button
                onClick={() => void doRefresh()}
                disabled={subProgress?.type === 'refreshing'}
                className={btnNormal}
                title="Refresh role collections"
              >
                <RefreshCw className={`h-4 w-4 ${subProgress?.type === 'refreshing' ? 'animate-spin' : ''}`} />
              </button>
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
              {/* Detail header */}
              <div className="shrink-0 px-4 py-2 border-b border-border flex items-center gap-2">
                <button
                  onClick={() => setShowList(v => !v)}
                  className={iconBtn}
                  title={showList ? 'Collapse list' : 'Expand list'}
                >
                  <PanelLeft className="h-4 w-4" />
                </button>
                <div className="min-w-0 flex-1 flex items-center gap-1.5">
                  <p className="font-semibold text-sm truncate" title={rc?.description || undefined}>
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
                  className={btnNormal}
                  title="Export as JSON"
                >
                  <Download className="h-4 w-4" />
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
                    {rc.description && (
                      <div>
                        <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1">Description</p>
                        <p className="text-xs text-foreground/80 leading-relaxed">{rc.description}</p>
                      </div>
                    )}
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

                    <div>
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
  );
}
