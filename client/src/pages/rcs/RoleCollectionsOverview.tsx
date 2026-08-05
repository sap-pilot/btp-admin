import { Fragment, useEffect, useRef, useState } from 'react';
import { useParams, useNavigate, useLocation, Link } from 'react-router';
import { History, PanelLeft, RefreshCw, Search, ShieldCheck, X } from 'lucide-react';
import { useSidebar } from '@/components/AppLayout';
import type { SubaccountEntry } from '@/components/config/SubaccountsTable';
import type { TabEntry, TabSection } from '@/components/config/TabsTable';
import SubaccountRCModal from './SubaccountRCModal';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';

// ─── Types ────────────────────────────────────────────────────────────────────

interface RcSummary { name: string; userCount: number }
type RcData = Record<string, RcSummary[]>;

interface RefreshProgress {
  type:       'progress' | 'done';
  current?:   number;
  total:      number;
  name?:      string;
  received:   number;
  refreshed?: number;
  created?:   number;
  updated?:   number;
  deleted?:   number;
  issues?:    string[];
}

interface ModalState {
  sa:              SubaccountEntry;
  allNames:        string[];
  initialName?:    string;
  initialTab?:     'details' | 'users' | 'changelog';
  initialShowList?: boolean;
}

type RcCategory = 'standard' | 'custom' | 'workzone';

interface SaBucket {
  sa:         SubaccountEntry;
  cats:       Record<RcCategory, RcSummary[]>;
  total:      number;
  matchCount: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function csvIncludes(csv: string, id: string): boolean {
  return csv.split(',').map(s => s.trim()).includes(id);
}

function categorizeRc(name: string): RcCategory {
  if (/work.?zone/i.test(name) || name.startsWith('~')) return 'workzone';
  return name.includes(' ') ? 'standard' : 'custom';
}

const RC_CATS: { key: RcCategory; label: string }[] = [
  { key: 'standard', label: 'Top Standard Role Collections'  },
  { key: 'custom',   label: 'Top Custom Role Collections'    },
  { key: 'workzone', label: 'Top Work-Zone Role Collections' },
];

function buildSaBuckets(visibleSas: SubaccountEntry[], rcData: RcData, search: string): SaBucket[] {
  const searchLow = search.toLowerCase();
  return visibleSas.map(sa => {
    const allRcs = rcData[`${sa.region}/${sa.subdomain}`] ?? [];
    const cats: Record<RcCategory, RcSummary[]> = { standard: [], custom: [], workzone: [] };
    for (const rc of allRcs) cats[categorizeRc(rc.name)].push(rc);
    for (const k of Object.keys(cats) as RcCategory[]) {
      cats[k] = [...cats[k]]
        .filter(rc => !search || rc.name.toLowerCase().includes(searchLow))
        .sort((a, b) => b.userCount - a.userCount)
        .slice(0, 5);
    }
    const matchCount = search
      ? allRcs.filter(rc => rc.name.toLowerCase().includes(searchLow)).length
      : allRcs.length;
    return { sa, cats, total: allRcs.length, matchCount };
  });
}

function highlightText(text: string, query: string): React.ReactNode {
  if (!query) return text;
  const parts = text.split(new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'));
  return parts.map((p, i) =>
    p.toLowerCase() === query.toLowerCase()
      ? <mark key={i} className="bg-yellow-300/70 dark:bg-yellow-600/60 text-inherit rounded-sm">{p}</mark>
      : p
  );
}

function parseLinks(line: string, highlight?: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  const re = /\[([^\]]*)\]\(([^)]+)\)/g;
  let last = 0, k = 0, m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    if (m.index > last) parts.push(highlight ? highlightText(line.slice(last, m.index), highlight) : line.slice(last, m.index));
    parts.push(<Link key={k++} to={m[2]!} className="underline underline-offset-2 hover:text-foreground">{highlight ? highlightText(m[1]!, highlight) : m[1]}</Link>);
    last = m.index + m[0].length;
  }
  if (last < line.length) parts.push(highlight ? highlightText(line.slice(last), highlight) : line.slice(last));
  return parts.length ? parts : (highlight ? highlightText(line, highlight) : line);
}

function renderGlobalChangelog(text: string, highlight?: string): React.ReactNode {
  const pl = (s: string) => parseLinks(s, highlight);
  return text.split('\n').map((line, i) => {
    if (line.startsWith('## ')) return <div key={i} className="font-bold mt-4 mb-1 text-foreground first:mt-0">{pl(line.slice(3))}</div>;
    if (line.startsWith('- created:')) return <div key={i} className="text-green-600 dark:text-green-400 pl-1">{pl(line)}</div>;
    if (line.startsWith('- updated:')) return <div key={i} className="text-amber-600 dark:text-amber-400 pl-1">{pl(line)}</div>;
    if (line.startsWith('- deleted:')) return <div key={i} className="text-red-500 dark:text-red-400 pl-1">{pl(line)}</div>;
    if (line.startsWith('- '))        return <div key={i} className="text-muted-foreground pl-1">{pl(line)}</div>;
    return <div key={i} className="text-muted-foreground">{line ? pl(line) : ' '}</div>;
  });
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function RoleCollectionsOverview() {
  const { toggle, collapsed } = useSidebar();
  const { tab: tabParam, region: regionParam, subdomain: subdomainParam, name: nameParam, rcTab } = useParams<{
    tab?: string; region?: string; subdomain?: string; name?: string; rcTab?: string;
  }>();
  const navigate  = useNavigate();
  const location  = useLocation();
  const returnUrl = useRef<string>('/role-collections');

  const [isLoading,       setIsLoading]       = useState(true);
  const [tabEntries,      setTabEntries]      = useState<TabEntry[]>([]);
  const [saData,          setSaData]          = useState<SubaccountEntry[]>([]);
  const [rcData,          setRcData]          = useState<RcData>({});
  const [globalRefreshTs, setGlobalRefreshTs] = useState<number | null>(null);
  const [isRefreshing,    setIsRefreshing]    = useState(false);
  const [progress,        setProgress]        = useState<RefreshProgress | null>(null);
  const [modal,           setModal]           = useState<ModalState | null>(null);
  const [showRefreshDialog,      setShowRefreshDialog]      = useState(false);
  const [showForceRefreshDialog, setShowForceRefreshDialog] = useState(false);
  const [overviewSearch,         setOverviewSearch]         = useState('');
  const [categoryFilter,         setCategoryFilter]         = useState<'all' | RcCategory>('all');

  // Global changelog
  const [globalChangelog,        setGlobalChangelog]        = useState('');
  const [globalChangelogLoading, setGlobalChangelogLoading] = useState(false);
  const [archivedChangelogFiles, setArchivedChangelogFiles] = useState<string[]>([]);
  const [selectedArchive,        setSelectedArchive]        = useState('');
  const [clSearch,               setClSearch]               = useState('');
  const [clSearchResults,        setClSearchResults]        = useState<{ files: string[]; matchCount: number } | null>(null);
  const [clSearching,            setClSearching]            = useState(false);

  const deepLinkKey      = useRef('');
  const autoHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const allRcSas = saData.filter(sa => sa.manageRoles);

  async function fetchStatus() {
    try {
      const r = await fetch('/api/rcs/status');
      const j = await r.json() as { ok: boolean; globalRefreshTs: number | null };
      if (j.ok) setGlobalRefreshTs(j.globalRefreshTs);
    } catch { /* ignore */ }
  }

  async function loadData() {
    try {
      const [tabsRes, sasRes, rcsRes] = await Promise.all([
        fetch('/api/config/tabs'),
        fetch('/api/config/subaccounts'),
        fetch('/api/rcs/'),
      ]);
      const tabs = await tabsRes.json() as { ok: boolean; data: TabEntry[] };
      const sas  = await sasRes.json()  as { ok: boolean; data: SubaccountEntry[] };
      const rcs  = await rcsRes.json()  as { ok: boolean; data: RcData };
      if (tabs.ok) setTabEntries(tabs.data);
      if (sas.ok)  setSaData(sas.data);
      if (rcs.ok)  setRcData(rcs.data);
    } finally {
      setIsLoading(false);
    }
  }

  async function fetchGlobalChangelog(archiveFile?: string) {
    setGlobalChangelogLoading(true);
    try {
      const url = archiveFile
        ? `/api/rcs/global-changelog?file=${encodeURIComponent(archiveFile)}`
        : '/api/rcs/global-changelog';
      const r = await fetch(url);
      const j = await r.json() as { ok: boolean; data: string; archivedFiles?: string[] };
      if (j.ok) {
        setGlobalChangelog(j.data);
        if (!archiveFile && j.archivedFiles) setArchivedChangelogFiles(j.archivedFiles);
      }
    } catch { /* ignore */ } finally { setGlobalChangelogLoading(false); }
  }

  useEffect(() => {
    void loadData().catch(() => {});
    void fetchStatus();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const es = new EventSource('/api/events?rcs=1');
    es.addEventListener('update', (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data as string) as Record<string, unknown>;
        if (data['type'] === 'progress' || data['type'] === 'done') {
          if (data['scope'] === 'subaccount') return;
          const p = data as unknown as RefreshProgress;
          if (autoHideTimerRef.current) { clearTimeout(autoHideTimerRef.current); autoHideTimerRef.current = null; }
          setProgress(p);
          if (p.type === 'done' && (!p.issues || p.issues.length === 0)) {
            autoHideTimerRef.current = setTimeout(() => setProgress(null), 5000);
          }
        } else {
          void fetch('/api/rcs/')
            .then(r => r.json() as Promise<{ ok: boolean; data: RcData }>)
            .then(({ ok, data: d }) => { if (ok) setRcData(d); })
            .catch(() => {});
          void fetch('/api/rcs/global-changelog')
            .then(r => r.json() as Promise<{ ok: boolean; data: string; archivedFiles: string[] }>)
            .then(j => { if (j.ok) { setGlobalChangelog(j.data); setArchivedChangelogFiles(j.archivedFiles); } })
            .catch(() => {});
        }
      } catch { /* ignore */ }
    });
    return () => {
      es.close();
      if (autoHideTimerRef.current) clearTimeout(autoHideTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!regionParam && !subdomainParam) {
      returnUrl.current = location.pathname;
    }
  }, [location.pathname, regionParam, subdomainParam]);

  useEffect(() => {
    if (!regionParam || !subdomainParam) {
      deepLinkKey.current = '';
      return;
    }
    const key = `${regionParam}/${subdomainParam}/${nameParam ?? ''}/${rcTab ?? ''}`;
    if (deepLinkKey.current === key) return;
    if (saData.length === 0) return;
    const sa = allRcSas.find(s => s.region === regionParam && s.subdomain === subdomainParam);
    if (!sa) return;
    deepLinkKey.current = key;
    const saKey      = `${sa.region}/${sa.subdomain}`;
    const names      = (rcData[saKey] ?? []).map(r => r.name).sort();
    const initialTab = rcTab === 'history' ? 'changelog' : rcTab === 'users' ? 'users' : 'details';
    setModal({ sa, allNames: names, initialName: nameParam ?? names[0], initialTab, initialShowList: !nameParam });
  }, [regionParam, subdomainParam, nameParam, rcTab, saData, rcData]); // eslint-disable-line react-hooks/exhaustive-deps

  async function doRefresh(force = false) {
    setShowRefreshDialog(false);
    setShowForceRefreshDialog(false);
    setIsRefreshing(true);
    if (autoHideTimerRef.current) { clearTimeout(autoHideTimerRef.current); autoHideTimerRef.current = null; }
    setProgress(null);
    try {
      const url = force ? '/api/rcs/refresh?force=true' : '/api/rcs/refresh';
      const r   = await fetch(url, { method: 'POST' });
      const j   = await r.json() as { ok: boolean; busy?: boolean; error?: string };
      if (!j.ok && !j.busy) {
        setProgress({ type: 'done', total: 0, received: 0, issues: [j.error ?? 'Refresh failed'] });
      }
      await loadData();
      void fetchStatus();
    } catch (err) {
      setProgress({ type: 'done', total: 0, received: 0, issues: [err instanceof Error ? err.message : 'Refresh failed'] });
    } finally {
      setIsRefreshing(false);
    }
  }

  function openModal(sa: SubaccountEntry, showList: boolean, name?: string) {
    const key   = `${sa.region}/${sa.subdomain}`;
    const names = (rcData[key] ?? []).map(r => r.name).sort();
    setModal({ sa, allNames: names, initialName: name, initialShowList: showList });
  }

  // ── Tab derivations ──────────────────────────────────────────────────────────

  const visibleTabs = tabEntries.filter(te =>
    te.sections.some(s => s.type === 'subaccountGroup' && allRcSas.some(sa => csvIncludes(sa.groupIds, s.groupId)))
  );

  const isChangeHistory = tabParam === 'change-history';
  const activeTabEntry  = visibleTabs.find(te => te.tab === decodeURIComponent(tabParam ?? '')) ?? visibleTabs[0];

  useEffect(() => {
    if (!isChangeHistory) return;
    void fetchGlobalChangelog();
  }, [isChangeHistory]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Category counts for active tab ───────────────────────────────────────────

  const catCounts: Record<RcCategory, { total: number; matched: number }> = {
    standard: { total: 0, matched: 0 },
    custom:   { total: 0, matched: 0 },
    workzone: { total: 0, matched: 0 },
  };
  if (activeTabEntry) {
    const overviewSearchLow = overviewSearch.toLowerCase();
    const tabSas = activeTabEntry.sections
      .filter((s): s is Extract<TabSection, { type: 'subaccountGroup' }> => s.type === 'subaccountGroup')
      .flatMap(grp => allRcSas.filter(sa => csvIncludes(sa.groupIds, grp.groupId)));
    for (const sa of tabSas) {
      for (const rc of rcData[`${sa.region}/${sa.subdomain}`] ?? []) {
        const cat = categorizeRc(rc.name);
        catCounts[cat].total++;
        if (!overviewSearch || rc.name.toLowerCase().includes(overviewSearchLow)) {
          catCounts[cat].matched++;
        }
      }
    }
  }

  function catOptionLabel(display: string, cat: RcCategory): string {
    const { total, matched } = catCounts[cat];
    const count = overviewSearch && matched !== total ? `${matched}/${total}` : String(total);
    return `${display} (${count})`;
  }

  // ── Styling ──────────────────────────────────────────────────────────────────

  const tabCls = (active: boolean) =>
    `px-4 py-2 text-sm transition-colors border-b-2 shrink-0 ${
      active
        ? 'border-primary text-foreground font-medium'
        : 'border-transparent text-muted-foreground hover:text-foreground'
    }`;

  const btnBase    = 'inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
  const btnOutline = `${btnBase} border border-border hover:bg-accent hover:text-accent-foreground`;

  const tdCls    = 'px-3 py-1.5 text-xs border-b border-border align-middle';
  const catTdCls = `${tdCls} sticky left-0 z-10 bg-background border-r border-border align-top w-[175px] min-w-[175px]`;

  return (
    <div className="flex flex-col h-full bg-background text-foreground">
      {/* Title bar */}
      <div className="border-b border-border bg-background px-3 flex items-center gap-2 shrink-0 min-h-[52px]">
        <button onClick={toggle} className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors" title="Toggle sidebar">
          <PanelLeft className="h-4 w-4" />
        </button>
        {collapsed && <ShieldCheck className="h-4 w-4 sm:hidden text-muted-foreground" aria-label="Role Collections" />}
        <div className="hidden sm:flex flex-col justify-center min-w-0">
          <span className="text-sm font-semibold leading-tight">Role Collections</span>
          {globalRefreshTs !== null && (
            <span className="text-[10px] text-muted-foreground/50 leading-tight">
              Updated at {new Date(globalRefreshTs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
        </div>
        <div className="ml-auto flex items-center gap-2">
          {/* Full-text search */}
          <div className="relative hidden sm:block">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
            <input
              type="text"
              value={overviewSearch}
              onChange={e => setOverviewSearch(e.target.value)}
              placeholder="Search role collections…"
              className={`h-7 pl-7 ${overviewSearch ? 'pr-6' : 'pr-2'} w-48 text-xs border border-border rounded bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground`}
            />
            {overviewSearch && (
              <button
                onClick={() => setOverviewSearch('')}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 h-4 w-4 flex items-center justify-center text-muted-foreground hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
          {/* Category filter */}
          {!isChangeHistory && (
            <select
              value={categoryFilter}
              onChange={e => setCategoryFilter(e.target.value as 'all' | RcCategory)}
              className="hidden sm:block h-7 text-xs border border-border rounded px-2 bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            >
              <option value="all">All Categories</option>
              <option value="standard">{catOptionLabel('Standard', 'standard')}</option>
              <option value="custom">{catOptionLabel('Custom', 'custom')}</option>
              <option value="workzone">{catOptionLabel('Work-Zone', 'workzone')}</option>
            </select>
          )}
          <button
            onClick={() => isRefreshing ? setShowForceRefreshDialog(true) : setShowRefreshDialog(true)}
            className={btnOutline}
            title={isRefreshing ? 'Refreshing… — click to force another refresh' : 'Refresh all role collections'}
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />
            <span className="hidden sm:inline">{isRefreshing ? 'Refreshing…' : 'Refresh'}</span>
          </button>
        </div>
      </div>

      {/* Progress bar */}
      {progress && (() => {
        const isDone    = progress.type === 'done';
        const hasIssues = isDone && !!progress.issues?.length;
        const pct       = isDone ? 100 : progress.total > 0 ? Math.round(((progress.current ?? 0) / progress.total) * 100) : 0;
        const barColor  = hasIssues ? 'bg-amber-500' : isDone ? 'bg-green-500' : 'bg-primary';
        const textColor = hasIssues ? 'text-amber-600 dark:text-amber-400' : isDone ? 'text-green-600 dark:text-green-400' : 'text-foreground';
        const bgColor   = hasIssues ? 'bg-amber-500/8' : isDone ? 'bg-green-500/8' : 'bg-muted/40';
        const msg = progress.type === 'progress'
          ? `Processing ${progress.current ?? 0} of ${progress.total} subaccounts: ${progress.name ?? ''}${progress.received > 0 ? `, received ${progress.received} role collections` : ''}`
          : `Refreshed ${progress.refreshed ?? 0} of ${progress.total} subaccounts, received ${progress.received} role collections, created ${progress.created ?? 0}, updated ${progress.updated ?? 0} and deleted ${progress.deleted ?? 0}`;
        return (
          <div className={`relative shrink-0 border-b border-border ${bgColor}`}>
            <div className="h-1 w-full"><div className={`h-full transition-all duration-300 ${barColor}`} style={{ width: `${pct}%` }} /></div>
            <div className={`px-4 py-1.5 text-xs text-center ${textColor} pr-8`}>{msg}</div>
            {hasIssues && (
              <div className="px-4 pb-2 flex flex-col gap-0.5">
                {progress.issues!.map((issue, i) => (
                  <div key={i} className="text-[11px] text-amber-600 dark:text-amber-400 text-center">{issue}</div>
                ))}
              </div>
            )}
            <button onClick={() => setProgress(null)} className="absolute top-1 right-1 p-0.5 rounded text-muted-foreground/60 hover:text-foreground hover:bg-black/10 dark:hover:bg-white/10 transition-colors" title="Dismiss">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })()}

      {/* Tab bar */}
      {(visibleTabs.length > 0 || allRcSas.length > 0) && (
        <div className="flex items-stretch border-b border-border shrink-0 px-2">
          <div className="flex items-center overflow-x-auto flex-1 min-w-0">
            {visibleTabs.map(te => (
              <button key={te.tab} className={tabCls(!isChangeHistory && te === activeTabEntry)} onClick={() => navigate(`/role-collections/${encodeURIComponent(te.tab)}`)}>
                {te.tab}
              </button>
            ))}
          </div>
          <button
            className={`${tabCls(isChangeHistory)} flex items-center gap-1 shrink-0`}
            onClick={() => navigate('/role-collections/change-history')}
            title="Change History"
          >
            <History className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Change History</span>
          </button>
        </div>
      )}

      {/* Change History panel */}
      {isChangeHistory && (
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
          <div className="shrink-0 px-4 py-2 border-b border-border flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
              <input
                type="text"
                value={clSearch}
                onChange={e => setClSearch(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && clSearch.trim()) {
                    setClSearching(true);
                    fetch(`/api/rcs/global-changelog/search?q=${encodeURIComponent(clSearch.trim())}`)
                      .then(r => r.json() as Promise<{ ok: boolean; files: string[]; matchCount: number }>)
                      .then(d => {
                        if (!d.ok) return;
                        setClSearchResults(d);
                        if (d.files.length === 1) { setSelectedArchive(d.files[0]!); void fetchGlobalChangelog(d.files[0] || undefined); }
                      })
                      .catch(() => {})
                      .finally(() => setClSearching(false));
                  } else if (e.key === 'Escape') { setClSearch(''); setClSearchResults(null); }
                }}
                placeholder="Search history…"
                className={`w-full h-7 pl-7 ${clSearch ? 'pr-6' : 'pr-3'} text-xs border border-border rounded bg-background text-foreground outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground`}
              />
              {clSearch && clSearchResults && (
                <span className="absolute right-7 top-1/2 -translate-y-1/2 text-xs text-muted-foreground pointer-events-none">
                  {clSearchResults.matchCount} match{clSearchResults.matchCount !== 1 ? 'es' : ''} in {clSearchResults.files.length} file{clSearchResults.files.length !== 1 ? 's' : ''}
                </span>
              )}
              {clSearch && (
                <button onClick={() => { setClSearch(''); setClSearchResults(null); }} className="absolute right-1 top-1/2 -translate-y-1/2 h-4 w-4 flex items-center justify-center text-muted-foreground hover:text-foreground" tabIndex={-1}>
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
            {(() => {
              const sel = clSearchResults ? clSearchResults.files : archivedChangelogFiles.length > 0 ? ['', ...archivedChangelogFiles] : null;
              return sel && sel.length > 1 ? (
                <select
                  value={selectedArchive}
                  onChange={e => { setSelectedArchive(e.target.value); void fetchGlobalChangelog(e.target.value || undefined); }}
                  className="text-xs border border-border rounded px-2 py-1 bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                >
                  {sel.map(f => <option key={f} value={f}>{f || 'changelog.md (current)'}</option>)}
                </select>
              ) : null;
            })()}
            <button
              onClick={() => void fetchGlobalChangelog(selectedArchive || undefined)}
              disabled={globalChangelogLoading || clSearching}
              className="inline-flex items-center gap-1.5 px-2 py-1 rounded text-xs border border-border hover:bg-accent transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`h-3 w-3 ${globalChangelogLoading ? 'animate-spin' : ''}`} />
              Reload
            </button>
          </div>
          <div className="flex-1 overflow-auto p-4">
            {globalChangelogLoading && <div className="text-xs text-muted-foreground text-center py-8">Loading…</div>}
            {!globalChangelogLoading && !globalChangelog && (
              <div className="text-xs text-muted-foreground text-center py-8">No global refresh has run yet. Click <strong>Refresh</strong> to generate the first changelog entry.</div>
            )}
            {!globalChangelogLoading && globalChangelog && (
              <div className="font-mono text-xs leading-relaxed">{renderGlobalChangelog(globalChangelog, clSearch && clSearchResults ? clSearch : undefined)}</div>
            )}
          </div>
        </div>
      )}

      {/* Overview content */}
      {!isChangeHistory && (
        <div className="flex-1 overflow-auto px-4 py-3 space-y-6">
          {visibleTabs.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full gap-2 text-muted-foreground">
              {isLoading
                ? <p className="text-sm">Loading role collections…</p>
                : <>
                    <p className="text-sm">No role collections configured.</p>
                    <p className="text-xs">Enable <code className="bg-muted px-1 rounded">Manage Roles</code> on subaccounts in Configuration, then click <strong>Refresh</strong>.</p>
                  </>
              }
            </div>
          )}

          {activeTabEntry?.sections
            .filter((s): s is Extract<TabSection, { type: 'subaccountGroup' }> => s.type === 'subaccountGroup')
            .map(grp => {
              const visibleSas = allRcSas
                .filter(sa => csvIncludes(sa.groupIds, grp.groupId))
                .sort((a, b) => a.pos - b.pos);
              if (visibleSas.length === 0) return null;

              const saBuckets = buildSaBuckets(visibleSas, rcData, overviewSearch);

              return (
                <div key={grp.groupId} className="space-y-1.5">
                  <div className="px-1">
                    <span className="text-xs font-semibold text-foreground">{grp.title ?? grp.groupId}</span>
                    <span className="text-xs text-muted-foreground ml-2">({grp.groupId})</span>
                  </div>

                  <div className="border border-border rounded-md overflow-hidden">
                    <div className="overflow-x-auto">
                      <table className="w-full border-collapse text-sm" style={{ tableLayout: 'auto' }}>
                        <thead className="sticky top-0 z-10">
                          <tr className="bg-muted/30">
                            <th className="sticky left-0 z-20 bg-muted/30 text-left text-xs font-medium text-muted-foreground px-3 py-2 w-[175px] border-r border-b border-border whitespace-nowrap">
                              Top Role Collections
                            </th>
                            {saBuckets.map(({ sa }) => (
                              <th
                                key={sa.subaccountId}
                                colSpan={2}
                                className="text-center text-xs font-medium px-3 py-2 min-w-[220px] border-l border-b border-border text-muted-foreground cursor-pointer hover:bg-muted/40 transition-colors"
                                onClick={() => openModal(sa, true)}
                              >
                                <div className="flex flex-col gap-0.5 items-center">
                                  <span>{sa.alias || sa.subaccountName}</span>
                                  {sa.subdomain && (
                                    <span className="text-[10px] font-normal font-mono text-muted-foreground/60 leading-tight">{sa.subdomain}</span>
                                  )}
                                </div>
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {RC_CATS
                            .filter(({ key }) => categoryFilter === 'all' || key === categoryFilter)
                            .map(({ key: cat, label }) =>
                              Array.from({ length: 5 }, (_, i) => (
                                <tr key={`${cat}-${i}`} className="hover:bg-muted/20">
                                  {i === 0 && (
                                    <td rowSpan={5} className={catTdCls}>
                                      <span className="text-[11px] font-semibold leading-tight">{label}</span>
                                    </td>
                                  )}
                                  {saBuckets.map(({ sa, cats }) => {
                                    const rc = cats[cat][i];
                                    return (
                                      <Fragment key={sa.subaccountId}>
                                        <td className="px-3 py-1.5 text-xs border-b border-border border-l max-w-[160px]">
                                          {rc ? (
                                            <button
                                              className="font-mono text-[11px] hover:underline text-left truncate block w-full text-foreground"
                                              title={rc.name}
                                              onClick={() => openModal(sa, false, rc.name)}
                                            >
                                              {overviewSearch
                                                ? highlightText(rc.name, overviewSearch)
                                                : rc.name}
                                            </button>
                                          ) : <span className="text-muted-foreground/30 text-[11px]">—</span>}
                                        </td>
                                        <td className="px-2 py-1.5 text-xs border-b border-border text-right font-mono tabular-nums text-muted-foreground w-10">
                                          {rc ? rc.userCount : ''}
                                        </td>
                                      </Fragment>
                                    );
                                  })}
                                </tr>
                              ))
                            )
                          }
                          {/* More row — one per subaccount after all 3 category groups */}
                          <tr className="hover:bg-muted/10">
                            <td className="sticky left-0 z-10 bg-background border-r border-border w-[175px] min-w-[175px]" />
                            {saBuckets.map(({ sa, total, matchCount }) => (
                              <td key={sa.subaccountId} colSpan={2} className="px-2 py-1.5 text-xs border-l border-border">
                                <button
                                  onClick={() => openModal(sa, true)}
                                  className="w-full text-center text-[11px] text-muted-foreground hover:text-foreground hover:bg-accent/50 py-1 px-2 rounded transition-colors"
                                >
                                  {overviewSearch
                                    ? `View all ${matchCount} matching in modal`
                                    : `More (${total}) Role Collections`}
                                </button>
                              </td>
                            ))}
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              );
            })}
        </div>
      )}

      {modal && (
        <SubaccountRCModal
          sa={modal.sa}
          allNames={modal.allNames}
          initialName={modal.initialName}
          initialTab={modal.initialTab}
          initialShowList={modal.initialShowList}
          onClose={() => {
            setModal(null);
            navigate(returnUrl.current, { replace: true });
          }}
          onRcDataChange={() => void loadData()}
        />
      )}

      <AlertDialog open={showRefreshDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Refresh all role collections?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                <p>Refreshing all subaccounts' role collections may take a while.</p>
                <p>For a faster result, open a subaccount and refresh there instead.</p>
                <p>Do you still want to refresh all subaccounts?</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setShowRefreshDialog(false)}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void doRefresh()}>Yes, proceed</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={showForceRefreshDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Refresh already in progress</AlertDialogTitle>
            <AlertDialogDescription>
              There is an ongoing global role collections refresh. Would you like to force another refresh on top of it?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setShowForceRefreshDialog(false)}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void doRefresh(true)}>Yes, force refresh</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
