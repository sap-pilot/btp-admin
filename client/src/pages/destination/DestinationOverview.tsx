import { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate, useLocation, Link } from 'react-router';
import { ChevronDown, GitCompare, Globe, History, PanelLeft, RefreshCw, Search, X } from 'lucide-react';
import { useSidebar } from '@/components/AppLayout';
import type { SubaccountEntry } from '@/components/config/SubaccountsTable';
import type { TabEntry, TabSection } from '@/components/config/TabsTable';
import SubaccountDestModal from './SubaccountDestModal';
import type { SelectedDest } from './SubaccountDestModal';
import CompareModal from './CompareModal';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';

// ─── Types ────────────────────────────────────────────────────────────────────

interface DestItem { name: string; status: 'OK' }
type DestData = Record<string, DestItem[]>;

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
  errors?:    string[];
}

interface Buckets { generic: string[]; s4: string[]; cep: string[]; others: string[] }

interface ModalState { sa: SubaccountEntry; allNames: string[]; initialName?: string; initialTab?: 'properties' | 'changelog' | 'test'; initialShowList?: boolean }

interface DestSearchResult {
  region:     string;
  subdomain:  string;
  org_id:     string;
  name:       string;
  matchField: string;
  matchValue: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function saOrgId(sa: SubaccountEntry): string {
  return sa.org?.orgId ?? '';
}

function categorise(name: string): keyof Buckets {
  if (/^API_(S4|MDG)_(HTTP|RFC)_/i.test(name))  return 'generic';
  if (/^API_/i.test(name))                       return 's4';
  if (/^cep-.*-runtime$/i.test(name))            return 'cep';
  return 'others';
}

function bucketSa(dests: DestItem[]): Buckets {
  const b: Buckets = { generic: [], s4: [], cep: [], others: [] };
  for (const d of dests) b[categorise(d.name)].push(d.name);
  return b;
}

function csvIncludes(csv: string, id: string): boolean {
  return csv.split(',').map(s => s.trim()).includes(id);
}

function Highlight({ text, query }: { text: string; query: string }) {
  if (!query || !text) return <>{text}</>;
  const q = query.toLowerCase();
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = text.split(new RegExp(`(${escaped})`, 'gi'));
  return (
    <>
      {parts.map((part, i) =>
        part.toLowerCase() === q
          ? <mark key={i} className="bg-yellow-200 dark:bg-yellow-800/50 text-inherit rounded-sm not-italic px-0">{part}</mark>
          : part
      )}
    </>
  );
}

const CAT_META = {
  generic: { label: 'Generic',      pattern: 'API_[S4|MDG]_[HTTP|RFC]_*' },
  s4:      { label: 'Specific S/4', pattern: 'other API_*' },
  cep:     { label: 'Workzone',     pattern: 'cep-*-runtime' },
} as const;

// ─── Component ───────────────────────────────────────────────────────────────

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
    if (line.startsWith('## ')) {
      return <div key={i} className="font-bold mt-4 mb-1 text-foreground first:mt-0">{pl(line.slice(3))}</div>;
    }
    if (line.startsWith('- created:')) return <div key={i} className="text-green-600 dark:text-green-400 pl-1">{pl(line)}</div>;
    if (line.startsWith('- updated:')) return <div key={i} className="text-amber-600 dark:text-amber-400 pl-1">{pl(line)}</div>;
    if (line.startsWith('- deleted:')) return <div key={i} className="text-red-500 dark:text-red-400 pl-1">{pl(line)}</div>;
    if (line.startsWith('- '))        return <div key={i} className="text-muted-foreground pl-1">{pl(line)}</div>;
    return <div key={i} className="text-muted-foreground">{line ? pl(line) : ' '}</div>;
  });
}

export default function DestinationOverview() {
  const { toggle, collapsed } = useSidebar();
  const { tab: tabParam, region: regionParam, subdomain: subdomainParam, name: nameParam, destTab } = useParams<{
    tab?: string; region?: string; subdomain?: string; name?: string; destTab?: string;
  }>();
  const navigate  = useNavigate();
  const location  = useLocation();
  const returnUrl = useRef<string>('/destinations');

  const [isLoading,    setIsLoading]    = useState(true);
  const [tabEntries,   setTabEntries]   = useState<TabEntry[]>([]);
  const [saData,       setSaData]       = useState<SubaccountEntry[]>([]);
  const [destData,     setDestData]     = useState<DestData>({});
  const [isRefreshing,    setIsRefreshing]    = useState(false);
  const [progress,        setProgress]        = useState<RefreshProgress | null>(null);
  const [globalRefreshTs, setGlobalRefreshTs] = useState<number | null>(null);
  const [modal,        setModal]        = useState<ModalState | null>(null);
  const [showRefreshDialog,      setShowRefreshDialog]      = useState(false);
  const [showForceRefreshDialog, setShowForceRefreshDialog] = useState(false);

  // Search
  const [filterInput,   setFilterInput]   = useState('');
  const [activeFilter,  setActiveFilter]  = useState('');
  const [filterResults, setFilterResults] = useState<DestSearchResult[] | null>(null);
  const [isSearching,   setIsSearching]   = useState(false);

  // Compare
  const [selectedDests,      setSelectedDests]      = useState<SelectedDest[]>([]);
  const [showCompareModal,   setShowCompareModal]   = useState(false);
  const [showCompareDropdown, setShowCompareDropdown] = useState(false);
  const compareDropdownRef = useRef<HTMLDivElement>(null);

  // Global changelog (Change History tab)
  const [globalChangelog,        setGlobalChangelog]        = useState('');
  const [globalChangelogLoading, setGlobalChangelogLoading] = useState(false);
  const [archivedChangelogFiles, setArchivedChangelogFiles] = useState<string[]>([]);
  const [selectedArchive,        setSelectedArchive]        = useState('');
  const [clSearch,               setClSearch]               = useState('');
  const [clSearchResults,        setClSearchResults]        = useState<{ files: string[]; matchCount: number } | null>(null);
  const [clSearching,            setClSearching]            = useState(false);

  const deepLinkKey      = useRef(''); // last URL key that opened the modal
  const autoHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function fetchStatus() {
    try {
      const res  = await fetch('/api/destinations/status');
      const json = await res.json() as { ok: boolean; globalRefreshTs: number | null };
      if (json.ok) setGlobalRefreshTs(json.globalRefreshTs);
    } catch { /* ignore */ }
  }

  async function fetchGlobalChangelog(archiveFile?: string) {
    setGlobalChangelogLoading(true);
    try {
      const url  = archiveFile ? `/api/destinations/global-changelog?file=${encodeURIComponent(archiveFile)}` : '/api/destinations/global-changelog';
      const res  = await fetch(url);
      const json = await res.json() as { ok: boolean; data: string; archivedFiles?: string[] };
      if (json.ok) {
        setGlobalChangelog(json.data);
        if (!archiveFile && json.archivedFiles) setArchivedChangelogFiles(json.archivedFiles);
      }
    } catch { /* ignore */ } finally { setGlobalChangelogLoading(false); }
  }

  async function loadData() {
    try {
      const [tabsRes, sasRes, destsRes] = await Promise.all([
        fetch('/api/config/tabs'),
        fetch('/api/config/subaccounts'),
        fetch('/api/destinations'),
      ]);
      const tabs  = await tabsRes.json()  as { ok: boolean; data: TabEntry[] };
      const sas   = await sasRes.json()   as { ok: boolean; data: SubaccountEntry[] };
      const dests = await destsRes.json() as { ok: boolean; data: DestData };
      if (tabs.ok)  setTabEntries(tabs.data);
      if (sas.ok)   setSaData(sas.data);
      if (dests.ok) setDestData(dests.data);
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    void loadData().catch(() => {});
    void fetchStatus();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const es = new EventSource('/api/events?dest=1');
    es.addEventListener('update', (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data as string) as Record<string, unknown>;
        if (data['type'] === 'progress' || data['type'] === 'done') {
          if (data['scope'] === 'subaccount') return; // handled by modal
          const p = data as unknown as RefreshProgress;
          if (autoHideTimerRef.current) { clearTimeout(autoHideTimerRef.current); autoHideTimerRef.current = null; }
          setProgress(p);
          if (p.type === 'done' && (!p.issues || p.issues.length === 0)) {
            autoHideTimerRef.current = setTimeout(() => setProgress(null), 5000);
          }
        } else {
          void fetch('/api/destinations')
            .then(r => r.json() as Promise<{ ok: boolean; data: DestData }>)
            .then(({ ok, data: d }) => { if (ok) setDestData(d); })
            .catch(() => {});
          void fetch('/api/destinations/global-changelog')
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

  // Track the last non-modal URL so modal close can return to the right screen
  useEffect(() => {
    if (!regionParam && !subdomainParam) {
      returnUrl.current = location.pathname;
    }
  }, [location.pathname, regionParam, subdomainParam]);

  // Open modal from deep-link URL: /destinations/:region/:subdomain/:name[/:destTab]
  useEffect(() => {
    if (!regionParam || !subdomainParam) {
      deepLinkKey.current = ''; // navigated away — reset so the next deep-link always works
      return;
    }
    const key = `${regionParam}/${subdomainParam}/${nameParam ?? ''}/${destTab ?? ''}`;
    if (deepLinkKey.current === key) return; // already opened this exact URL
    if (saData.length === 0) return; // wait for data
    const destSas = saData.filter(sa => sa.manageDestinations && !!sa.org?.orgId);
    const sa = destSas.find(sa => sa.region === regionParam && sa.subdomain === subdomainParam);
    if (!sa) return;
    deepLinkKey.current = key;
    const names = (destData[saOrgId(sa)] ?? []).map(d => d.name).sort();
    const initialTab = destTab === 'history' ? 'changelog' : destTab === 'test' ? 'test' : 'properties';
    setModal({ sa, allNames: names, initialName: nameParam ?? names[0], initialTab, initialShowList: !nameParam });
  }, [regionParam, subdomainParam, nameParam, destTab, saData, destData]);

  // Close compare dropdown on outside click
  useEffect(() => {
    if (!showCompareDropdown) return;
    function onDown(e: MouseEvent) {
      if (compareDropdownRef.current && !compareDropdownRef.current.contains(e.target as Node)) {
        setShowCompareDropdown(false);
      }
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [showCompareDropdown]);

  function toggleCompare(d: SelectedDest) {
    setSelectedDests(prev => {
      const exists = prev.some(x => x.region === d.region && x.subdomain === d.subdomain && x.name === d.name);
      return exists
        ? prev.filter(x => !(x.region === d.region && x.subdomain === d.subdomain && x.name === d.name))
        : [...prev, d];
    });
  }

  // ── Search ──────────────────────────────────────────────────────────────────

  async function applySearch(q: string) {
    if (!q) { clearFilter(); return; }
    setIsSearching(true);
    setActiveFilter(q);
    try {
      const res  = await fetch(`/api/destinations/search?q=${encodeURIComponent(q)}`);
      const json = await res.json() as { ok: boolean; data: DestSearchResult[] };
      if (json.ok) setFilterResults(json.data);
    } catch { /* ignore */ } finally { setIsSearching(false); }
  }

  function clearFilter() {
    setFilterInput('');
    setActiveFilter('');
    setFilterResults(null);
  }

  function handleFilterKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') void applySearch(filterInput.trim());
    if (e.key === 'Escape') clearFilter();
  }

  // ── Refresh ─────────────────────────────────────────────────────────────────

  async function doRefresh(force = false) {
    setShowRefreshDialog(false);
    setShowForceRefreshDialog(false);
    setIsRefreshing(true);
    if (autoHideTimerRef.current) { clearTimeout(autoHideTimerRef.current); autoHideTimerRef.current = null; }
    setProgress(null);
    try {
      const url  = force ? '/api/destinations/refresh?force=true' : '/api/destinations/refresh';
      const res  = await fetch(url, { method: 'POST' });
      const json = await res.json() as { ok: boolean; busy?: boolean; result?: { refreshed: number; errors: string[] }; error?: string };
      if (!json.ok) {
        setProgress({ type: 'done', total: 0, received: 0, errors: [json.error ?? 'Refresh failed'] });
      }
      await loadData();
      void fetchStatus();
    } catch (err) {
      setProgress({ type: 'done', total: 0, received: 0, errors: [err instanceof Error ? err.message : 'Refresh failed'] });
    } finally {
      setIsRefreshing(false);
    }
  }

  // ── Filter derivations ───────────────────────────────────────────────────────

  const allDestSas = saData.filter(sa => sa.manageDestinations && !!sa.org?.orgId);
  const isFiltered = filterResults !== null;

  // orgId → Set of matched destination names
  const matchedByOrg = new Map<string, Set<string>>();
  if (isFiltered) {
    for (const r of filterResults) {
      if (!matchedByOrg.has(r.org_id)) matchedByOrg.set(r.org_id, new Set());
      matchedByOrg.get(r.org_id)!.add(r.name);
    }
  }

  function saVisible(sa: SubaccountEntry): boolean {
    return !isFiltered || matchedByOrg.has(saOrgId(sa));
  }

  // null = no filter active (show all); Set = only these names
  function matchedForSa(sa: SubaccountEntry): Set<string> | null {
    if (!isFiltered) return null;
    return matchedByOrg.get(saOrgId(sa)) ?? new Set();
  }

  function filterDestItems(items: DestItem[], matched: Set<string> | null): DestItem[] {
    if (!matched) return items;
    return items.filter(d => matched.has(d.name));
  }

  const isChangeHistory = tabParam === 'change-history';

  // Load global changelog when navigating to change-history tab
  useEffect(() => {
    if (!isChangeHistory) return;
    void fetchGlobalChangelog();
  }, [isChangeHistory]); // eslint-disable-line react-hooks/exhaustive-deps

  // Build visible tabs (unfiltered)
  const visibleTabs = tabEntries.filter(te =>
    te.sections.some(s => s.type === 'subaccountGroup' && allDestSas.some(sa => csvIncludes(sa.groupIds, s.groupId))),
  );

  // Further restrict by search results
  const filteredTabs = isFiltered
    ? visibleTabs.filter(te =>
        te.sections.some(s =>
          s.type === 'subaccountGroup' &&
          allDestSas.some(sa => csvIncludes(sa.groupIds, s.groupId) && saVisible(sa))
        )
      )
    : visibleTabs;

  const activeTabEntry = filteredTabs.find(te => te.tab === decodeURIComponent(tabParam ?? '')) ?? filteredTabs[0];

  const tabCls = (active: boolean) =>
    `px-4 py-2 text-sm transition-colors border-b-2 shrink-0 ${
      active
        ? 'border-primary text-foreground font-medium'
        : 'border-transparent text-muted-foreground hover:text-foreground'
    }`;

  const btnBase    = 'inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
  const btnOutline = `${btnBase} border border-border hover:bg-accent hover:text-accent-foreground`;
  const tdCls      = 'px-3 py-2 text-xs border-b border-border align-middle';
  const catTdCls   = `${tdCls} sticky left-0 z-10 bg-background border-r border-border align-top w-[130px]`;

  const pendingSearch = filterInput.trim() !== '' && filterInput.trim() !== activeFilter;

  return (
    <div className="flex flex-col h-full bg-background text-foreground">
      {/* Title bar */}
      <div className="border-b border-border bg-background px-3 flex items-center gap-2 shrink-0 min-h-[52px]">
        <button onClick={toggle} className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors" title="Toggle sidebar">
          <PanelLeft className="h-4 w-4" />
        </button>
        {collapsed && <Globe className="h-4 w-4 sm:hidden text-muted-foreground" aria-label="Destinations" />}
        <div className="hidden sm:flex flex-col justify-center min-w-0">
          <span className="text-sm font-semibold leading-tight">Destination Overview</span>
          {globalRefreshTs !== null && (
            <span className="text-[10px] text-muted-foreground/50 leading-tight">
              Updated at {new Date(globalRefreshTs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
        </div>

        {/* Compare button + dropdown */}
        <div className="relative ml-auto" ref={compareDropdownRef}>
          <div className="flex items-center border border-border rounded overflow-hidden">
            <button
              onClick={() => { if (selectedDests.length > 0) setShowCompareModal(true); }}
              disabled={selectedDests.length === 0}
              title={selectedDests.length === 0
                ? 'Choose destinations, select them for comparison and click this to compare them side by side'
                : `Compare ${selectedDests.length} selected destination${selectedDests.length !== 1 ? 's' : ''}`}
              className={`${btnOutline} rounded-none border-0 gap-1.5 border-r border-border`}
            >
              <GitCompare className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Compare </span>
              {selectedDests.length > 0 && (
                <span className="sm:hidden text-[10px] font-bold leading-none">{selectedDests.length}</span>
              )}
              <span className="hidden sm:inline">{selectedDests.length > 0 && `(${selectedDests.length})`}</span>
            </button>
            <button
              onClick={() => setShowCompareDropdown(v => !v)}
              title="Show selected destinations"
              className={`${btnOutline} rounded-none border-0 px-1.5`}
            >
              <ChevronDown className="h-3.5 w-3.5" />
            </button>
          </div>
          {showCompareDropdown && (
            <div className="absolute right-0 top-full mt-1 z-50 bg-background border border-border rounded shadow-lg min-w-[280px]">
              {selectedDests.length === 0 ? (
                <div className="px-3 py-3 text-xs text-muted-foreground">
                  No destinations selected. Open a destination and click <strong>Select for Compare</strong>.
                </div>
              ) : (
                selectedDests.map(d => (
                  <div key={`${d.region}/${d.subdomain}/${d.name}`} className="flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted/40">
                    <span className="flex-1 font-mono truncate">
                      <span className="text-muted-foreground">{d.region} → {d.subdomain} → </span>{d.name}
                    </span>
                    <button
                      onClick={() => toggleCompare(d)}
                      className="shrink-0 text-muted-foreground/50 hover:text-destructive transition-colors"
                      title="Remove"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ))
              )}
              {selectedDests.length > 0 && (
                <div className="border-t border-border">
                  <button
                    onClick={() => { setSelectedDests([]); setShowCompareDropdown(false); }}
                    className="w-full px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted/40 text-left transition-colors"
                  >
                    Clear all
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Search input — Enter to search */}
        <div className="relative flex items-center">
          <Search className="absolute left-2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
          <input
            type="text"
            value={filterInput}
            onChange={e => setFilterInput(e.target.value)}
            onKeyDown={handleFilterKeyDown}
            placeholder="Full-text search"
            className="h-8 pl-7 pr-[4.5rem] text-xs border border-border rounded bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring w-[140px] sm:w-[240px]"
          />
          <div className="absolute right-1.5 flex items-center gap-1">
            {isSearching && <RefreshCw className="h-3 w-3 animate-spin text-muted-foreground shrink-0" />}
            {pendingSearch && !isSearching && (
              <span className="text-[10px] text-muted-foreground/50 pointer-events-none whitespace-nowrap">↵</span>
            )}
            {(filterInput || activeFilter) && (
              <button
                onClick={clearFilter}
                className="p-0.5 rounded text-muted-foreground/60 hover:text-foreground transition-colors"
                title="Clear search"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>

        <button
          onClick={() => isRefreshing ? setShowForceRefreshDialog(true) : setShowRefreshDialog(true)}
          className={btnOutline}
          title={isRefreshing ? 'Refreshing… — click to force another refresh' : 'Refresh all destinations'}
        >
          <RefreshCw className={`h-3.5 w-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />
          <span className="hidden sm:inline">{isRefreshing ? 'Refreshing…' : 'Refresh'}</span>
        </button>
      </div>

      {/* Active filter chip */}
      {isFiltered && (
        <div className="shrink-0 px-3 py-1.5 border-b border-border bg-muted/20 flex items-center gap-2 text-xs text-muted-foreground">
          <span>Search results for</span>
          <span className="font-mono bg-muted px-1.5 py-0.5 rounded text-foreground">{activeFilter}</span>
          <span>— {filterResults!.length} destination{filterResults!.length !== 1 ? 's' : ''} matched</span>
          <button onClick={clearFilter} className="ml-auto text-muted-foreground/60 hover:text-foreground transition-colors flex items-center gap-1">
            <X className="h-3 w-3" /> Clear
          </button>
        </div>
      )}

      {/* Progress bar */}
      {progress && (() => {
        const isDone    = progress.type === 'done';
        const hasIssues = isDone && !!progress.issues?.length;
        const pct       = isDone ? 100 : progress.total > 0 ? Math.round(((progress.current ?? 0) / progress.total) * 100) : 0;

        const barColor  = hasIssues ? 'bg-amber-500' : isDone ? 'bg-green-500' : 'bg-primary';
        const textColor = hasIssues ? 'text-amber-600 dark:text-amber-400' : isDone ? 'text-green-600 dark:text-green-400' : 'text-foreground';
        const bgColor   = hasIssues ? 'bg-amber-500/8' : isDone ? 'bg-green-500/8' : 'bg-muted/40';

        let msg: string;
        if (progress.type === 'progress') {
          msg = `Processing ${progress.current ?? 0} of ${progress.total} subaccounts: ${progress.name ?? ''}${progress.received > 0 ? `, received ${progress.received} destinations` : ''}`;
        } else {
          msg = `Refreshed ${progress.refreshed ?? 0} of ${progress.total} subaccounts, received ${progress.received} destinations, created ${progress.created ?? 0}, updated ${progress.updated ?? 0} and deleted ${progress.deleted ?? 0} destinations`;
        }

        return (
          <div className={`relative shrink-0 border-b border-border ${bgColor}`}>
            <div className="h-1 w-full bg-transparent">
              <div className={`h-full transition-all duration-300 ${barColor}`} style={{ width: `${pct}%` }} />
            </div>
            <div className={`px-4 py-1.5 text-xs text-center ${textColor} pr-8`}>{msg}</div>
            {hasIssues && (
              <div className="px-4 pb-2 flex flex-col gap-0.5">
                {progress.issues!.map((issue, i) => (
                  <div key={i} className="text-[11px] text-amber-600 dark:text-amber-400 text-center">{issue}</div>
                ))}
              </div>
            )}
            <button
              onClick={() => setProgress(null)}
              className="absolute top-1 right-1 p-0.5 rounded text-muted-foreground/60 hover:text-foreground hover:bg-black/10 dark:hover:bg-white/10 transition-colors"
              title="Dismiss"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })()}

      {/* Tab bar */}
      {(filteredTabs.length > 0 || visibleTabs.length > 0) && (
        <div className="flex items-stretch border-b border-border shrink-0 px-2">
          <div className="flex items-center overflow-x-auto flex-1 min-w-0">
            {filteredTabs.map(te => (
              <button key={te.tab} className={tabCls(!isChangeHistory && te === activeTabEntry)} onClick={() => navigate(`/destinations/${encodeURIComponent(te.tab)}`)}>
                {te.tab}
              </button>
            ))}
          </div>
          <button
            className={`${tabCls(isChangeHistory)} flex items-center gap-1 shrink-0`}
            onClick={() => navigate('/destinations/change-history')}
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
                    fetch(`/api/destinations/global-changelog/search?q=${encodeURIComponent(clSearch.trim())}`)
                      .then(r => r.json() as Promise<{ ok: boolean; files: string[]; matchCount: number }>)
                      .then(data => {
                        if (!data.ok) return;
                        setClSearchResults(data);
                        if (data.files.length === 1) {
                          const f = data.files[0]!;
                          setSelectedArchive(f);
                          void fetchGlobalChangelog(f || undefined);
                        }
                      })
                      .catch(() => {})
                      .finally(() => setClSearching(false));
                  } else if (e.key === 'Escape') {
                    setClSearch('');
                    setClSearchResults(null);
                  }
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
                <button
                  onClick={() => { setClSearch(''); setClSearchResults(null); }}
                  className="absolute right-1 top-1/2 -translate-y-1/2 h-4 w-4 flex items-center justify-center text-muted-foreground hover:text-foreground"
                  tabIndex={-1}
                  aria-label="Clear search"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
            {(() => {
              const selectFiles = clSearchResults
                ? clSearchResults.files
                : archivedChangelogFiles.length > 0 ? ['', ...archivedChangelogFiles] : null;
              return selectFiles && selectFiles.length > 1 ? (
                <select
                  value={selectedArchive}
                  onChange={e => {
                    const val = e.target.value;
                    setSelectedArchive(val);
                    void fetchGlobalChangelog(val || undefined);
                  }}
                  className="text-xs border border-border rounded px-2 py-1 bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                >
                  {selectFiles.map(f => (
                    <option key={f} value={f}>{f || 'changelog.md (current)'}</option>
                  ))}
                </select>
              ) : null;
            })()}
            <button
              onClick={() => void fetchGlobalChangelog(selectedArchive || undefined)}
              disabled={globalChangelogLoading || clSearching}
              className="inline-flex items-center gap-1.5 px-2 py-1 rounded text-xs border border-border hover:bg-accent transition-colors disabled:opacity-50"
              title="Reload changelog"
            >
              <RefreshCw className={`h-3 w-3 ${globalChangelogLoading ? 'animate-spin' : ''}`} />
              Reload
            </button>
          </div>
          <div className="flex-1 overflow-auto p-4">
            {globalChangelogLoading && (
              <div className="text-xs text-muted-foreground text-center py-8">Loading…</div>
            )}
            {!globalChangelogLoading && !globalChangelog && (
              <div className="text-xs text-muted-foreground text-center py-8">No global refresh has run yet. Click <strong>Refresh</strong> to generate the first changelog entry.</div>
            )}
            {!globalChangelogLoading && globalChangelog && (
              <div className="font-mono text-xs leading-relaxed">{renderGlobalChangelog(globalChangelog, clSearch && clSearchResults ? clSearch : undefined)}</div>
            )}
          </div>
        </div>
      )}

      {/* Content */}
      {!isChangeHistory && <div className="flex-1 overflow-auto px-4 py-3 space-y-6">
        {visibleTabs.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-muted-foreground">
            {isLoading
              ? <p className="text-sm">Loading destinations…</p>
              : <>
                  <p className="text-sm">No destinations configured.</p>
                  <p className="text-xs">Set <code className="bg-muted px-1 rounded">Manage Destinations</code> on subaccounts in Configuration, then click <strong>Refresh</strong>.</p>
                </>
            }
          </div>
        )}
        {visibleTabs.length > 0 && isFiltered && filteredTabs.length === 0 && (
          <div className="flex items-center justify-center h-32 text-sm text-muted-foreground">
            No matching destinations found for "{activeFilter}".
          </div>
        )}

        {activeTabEntry?.sections
          .filter((s): s is Extract<TabSection, { type: 'subaccountGroup' }> => s.type === 'subaccountGroup')
          .map(grp => {
            const visibleSas = allDestSas
              .filter(sa => csvIncludes(sa.groupIds, grp.groupId) && saVisible(sa))
              .sort((a, b) => a.pos - b.pos);
            if (visibleSas.length === 0) return null;

            const saBuckets = visibleSas.map(sa => {
              const matched  = matchedForSa(sa);
              const filtered = filterDestItems(destData[saOrgId(sa)] ?? [], matched);
              return { sa, buckets: bucketSa(filtered), allDests: destData[saOrgId(sa)] ?? [] };
            });

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
                          <th className="sticky left-0 z-20 bg-muted/30 text-left text-xs font-medium text-muted-foreground px-3 py-2 w-[130px] border-r border-b border-border whitespace-nowrap">
                            {isFiltered ? 'Destination' : ''}
                          </th>
                          {visibleSas.map(sa => (
                            <th
                              key={sa.subaccountId}
                              className="text-center text-xs font-medium px-3 py-2 min-w-[160px] border-l border-b border-border text-muted-foreground cursor-pointer hover:bg-muted/40 transition-colors"
                              onClick={() => setModal({ sa, allNames: (destData[saOrgId(sa)] ?? []).map(d => d.name).sort(), initialShowList: true })}
                            >
                              <div className="flex flex-col gap-0.5 items-center">
                                <span><Highlight text={sa.alias || sa.subaccountName} query={activeFilter} /></span>
                                {sa.subdomain && (
                                  <span className="text-[10px] font-normal font-mono text-muted-foreground/60 leading-tight">
                                    <Highlight text={sa.subdomain} query={activeFilter} />
                                  </span>
                                )}
                              </div>
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {isFiltered ? (() => {
                          // Flat search view: one row per matched destination name (union across all SAs)
                          const allMatchedNames = [
                            ...new Set(
                              saBuckets.flatMap(({ sa }) => {
                                const m = matchedByOrg.get(saOrgId(sa));
                                return m ? [...m] : [];
                              })
                            ),
                          ].sort();
                          if (allMatchedNames.length === 0) {
                            return (
                              <tr>
                                <td colSpan={visibleSas.length + 1} className={`${tdCls} text-center text-muted-foreground`}>
                                  No matching destinations
                                </td>
                              </tr>
                            );
                          }
                          return allMatchedNames.map(name => (
                            <tr key={name} className="hover:bg-muted/20">
                              <td className={`${catTdCls} font-mono text-[11px] text-foreground`}>
                                <Highlight text={name} query={activeFilter} />
                              </td>
                              {saBuckets.map(({ sa, allDests }) => {
                                const matched = matchedByOrg.get(saOrgId(sa));
                                const present = matched?.has(name) ?? false;
                                return (
                                  <td key={sa.subaccountId} className={`${tdCls} text-left`}>
                                    {present
                                      ? (
                                        <button
                                          className="font-mono text-[11px] hover:underline text-left text-foreground"
                                          onClick={() => setModal({ sa, allNames: allDests.map(d => d.name).sort(), initialName: name, initialShowList: false })}
                                        >
                                          <Highlight text={name} query={activeFilter} />
                                        </button>
                                      )
                                      : <span className="text-muted-foreground/30 text-[11px]">—</span>
                                    }
                                  </td>
                                );
                              })}
                            </tr>
                          ));
                        })() : (
                          <>
                            {(['generic', 's4', 'cep'] as const).map(cat => {
                              const { label, pattern } = CAT_META[cat];

                              if (cat === 's4') {
                                const sortedPerSa = saBuckets.map(b => ({
                                  sa:       b.sa,
                                  names:    [...b.buckets.s4].sort(),
                                  allDests: b.allDests,
                                }));
                                const maxRows = Math.max(0, ...sortedPerSa.map(b => b.names.length));
                                if (maxRows === 0) return null;
                                return Array.from({ length: maxRows }, (_, i) => (
                                  <tr key={`s4-${i}`} className="hover:bg-muted/20">
                                    {i === 0 && (
                                      <td rowSpan={maxRows} className={catTdCls}>
                                        <div className="flex flex-col gap-0.5">
                                          <span className="font-semibold">{label}</span>
                                          <span className="text-[10px] text-muted-foreground/60">{pattern}</span>
                                        </div>
                                      </td>
                                    )}
                                    {sortedPerSa.map(({ sa, names, allDests }) => {
                                      const name = names[i];
                                      return (
                                        <td key={sa.subaccountId} className={`${tdCls} text-left`}>
                                          {name
                                            ? (
                                              <button
                                                className="font-mono text-[11px] hover:underline text-left text-foreground"
                                                onClick={() => setModal({ sa, allNames: allDests.map(d => d.name).sort(), initialName: name, initialShowList: false })}
                                              >
                                                <Highlight text={name} query={activeFilter} />
                                              </button>
                                            )
                                            : <span className="text-muted-foreground/30 text-[11px]">—</span>
                                          }
                                        </td>
                                      );
                                    })}
                                  </tr>
                                ));
                              }

                              const allNames = [...new Set(saBuckets.flatMap(b => [...b.buckets[cat]]))].sort();
                              if (allNames.length === 0) return null;
                              return allNames.map((name, i) => (
                                <tr key={`${cat}-${name}`} className="hover:bg-muted/20">
                                  {i === 0 && (
                                    <td rowSpan={allNames.length} className={catTdCls}>
                                      <div className="flex flex-col gap-0.5">
                                        <span className="font-semibold">{label}</span>
                                        <span className="text-[10px] text-muted-foreground/60">{pattern}</span>
                                      </div>
                                    </td>
                                  )}
                                  {saBuckets.map(({ sa, buckets, allDests }) => {
                                    const present = buckets[cat].includes(name);
                                    return (
                                      <td key={sa.subaccountId} className={`${tdCls} text-left`}>
                                        {present
                                          ? <button className="text-foreground font-mono text-[11px] hover:underline text-left" onClick={() => setModal({ sa, allNames: allDests.map(d => d.name).sort(), initialName: name, initialShowList: false })}><Highlight text={name} query={activeFilter} /></button>
                                          : <span className="text-muted-foreground/30 text-[11px]">—</span>
                                        }
                                      </td>
                                    );
                                  })}
                                </tr>
                              ));
                            })}

                            {/* OTHERS row */}
                            <tr className="hover:bg-muted/20">
                              <td className={catTdCls}>
                                <div className="flex flex-col gap-0.5">
                                  <span className="font-semibold">OTHERS</span>
                                  <span className="text-[10px] text-muted-foreground/60">all other destinations</span>
                                </div>
                              </td>
                              {saBuckets.map(({ sa, buckets, allDests }) => {
                                const others     = buckets.others;
                                const allSaNames = allDests.map(d => d.name).sort();
                                return (
                                  <td key={sa.subaccountId} className={`${tdCls} text-left`}>
                                    {others.length > 0
                                      ? (
                                        <button
                                          onClick={() => setModal({ sa, allNames: allSaNames, initialName: others[0], initialShowList: true })}
                                          className="w-full flex items-center justify-between px-2 py-1 rounded bg-muted/60 text-muted-foreground hover:bg-accent hover:text-accent-foreground text-[11px] font-medium transition-colors"
                                        >
                                          <span>{others.length} destinations</span>
                                          <span className="opacity-60">→</span>
                                        </button>
                                      )
                                      : <span className="text-muted-foreground/30 text-[11px]">—</span>
                                    }
                                  </td>
                                );
                              })}
                            </tr>
                          </>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            );
          })}
      </div>}

      {modal && (
        <SubaccountDestModal
          org={modal.sa}
          allNames={modal.allNames}
          initialName={modal.initialName}
          initialTab={modal.initialTab}
          initialShowList={modal.initialShowList}
          onClose={() => {
            setModal(null);
            navigate(returnUrl.current, { replace: true });
          }}
          selectedDests={selectedDests}
          onToggleCompare={toggleCompare}
        />
      )}

      {showCompareModal && selectedDests.length > 0 && (
        <CompareModal
          selected={selectedDests}
          onClose={() => setShowCompareModal(false)}
        />
      )}

      {/* Refresh confirmation dialog */}
      <AlertDialog open={showRefreshDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Refresh all destination data?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                <p>Refreshing all subaccounts destinations may take quite a while.</p>
                <p>For a faster result, click on a subaccount name to open its destination panel and refresh there instead.</p>
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
              There is an ongoing global destination refresh. Would you like to force another refresh on top of it?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setShowForceRefreshDialog(false)}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void doRefresh(true)}>Yes, force another global destination refresh</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
