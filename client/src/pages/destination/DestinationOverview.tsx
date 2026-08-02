import { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router';
import { PanelLeft, RefreshCw, Search } from 'lucide-react';
import { useSidebar } from '@/components/AppLayout';
import type { SubaccountEntry } from '@/components/config/SubaccountsTable';
import type { TabEntry, TabSection } from '@/components/config/TabsTable';
import SubaccountDestModal from './SubaccountDestModal';

// ─── Types ────────────────────────────────────────────────────────────────────

interface DestItem { name: string; status: 'OK' }
type DestData = Record<string, DestItem[]>;

interface Buckets { generic: string[]; s4: string[]; cep: string[]; others: string[] }

interface ModalState { sa: SubaccountEntry; allNames: string[]; initialName?: string }

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

function fakeStatus(name: string, orgId: string): 'OK' | 'Failed' {
  let h = 0;
  for (const c of name + orgId) h = (h * 31 + c.charCodeAt(0)) & 0xffff;
  return h % 10 === 0 ? 'Failed' : 'OK';
}

function csvIncludes(csv: string, id: string): boolean {
  return csv.split(',').map(s => s.trim()).includes(id);
}

const CAT_META = {
  generic: { label: 'Generic',      pattern: 'API_[S4|MDG]_[HTTP|RFC]_*' },
  s4:      { label: 'Specific S/4', pattern: 'other API_*' },
  cep:     { label: 'Workzone',     pattern: 'cep-*-runtime' },
} as const;

// ─── Component ───────────────────────────────────────────────────────────────

export default function DestinationOverview() {
  const { toggle } = useSidebar();
  const { tab: tabParam, region: regionParam, subdomain: subdomainParam, name: nameParam } = useParams<{
    tab?: string; region?: string; subdomain?: string; name?: string;
  }>();
  const navigate = useNavigate();

  const [tabEntries, setTabEntries] = useState<TabEntry[]>([]);
  const [saData,     setSaData]     = useState<SubaccountEntry[]>([]);
  const [destData,   setDestData]   = useState<DestData>({});
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError]  = useState('');
  const [modal, setModal]  = useState<ModalState | null>(null);

  const deepLinkOpened = useRef(false);

  // Search
  const [searchQuery,   setSearchQuery]   = useState('');
  const [searchResults, setSearchResults] = useState<DestSearchResult[]>([]);
  const [isSearching,   setIsSearching]   = useState(false);
  const [showResults,   setShowResults]   = useState(false);
  const searchRef = useRef<HTMLDivElement>(null);

  async function loadData() {
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
  }

  useEffect(() => { void loadData().catch(() => setError('Failed to load data')); }, []);

  useEffect(() => {
    const es = new EventSource('/api/events?dest=1');
    es.addEventListener('update', () => {
      void fetch('/api/destinations')
        .then(r => r.json() as Promise<{ ok: boolean; data: DestData }>)
        .then(({ ok, data }) => { if (ok) setDestData(data); })
        .catch(() => {});
    });
    return () => es.close();
  }, []);

  // Open modal from deep-link URL: /destinations/:region/:subdomain/:name
  useEffect(() => {
    if (deepLinkOpened.current || !regionParam || !subdomainParam || saData.length === 0) return;
    const destSas = saData.filter(sa => sa.manageDestinations && !!sa.org?.orgId);
    const sa = destSas.find(sa => sa.region === regionParam && sa.subdomain === subdomainParam);
    if (!sa) return;
    deepLinkOpened.current = true;
    const names = (destData[saOrgId(sa)] ?? []).map(d => d.name).sort();
    setModal({ sa, allNames: names, initialName: nameParam ?? names[0] });
  }, [regionParam, subdomainParam, nameParam, saData, destData]);

  // Debounced search
  useEffect(() => {
    const q = searchQuery.trim();
    if (!q) { setSearchResults([]); setShowResults(false); return; }
    const id = setTimeout(async () => {
      setIsSearching(true);
      try {
        const res  = await fetch(`/api/destinations/search?q=${encodeURIComponent(q)}`);
        const json = await res.json() as { ok: boolean; data: DestSearchResult[] };
        if (json.ok) { setSearchResults(json.data); setShowResults(true); }
      } catch { /* ignore */ } finally { setIsSearching(false); }
    }, 300);
    return () => clearTimeout(id);
  }, [searchQuery]);

  // Close dropdown on outside click
  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) setShowResults(false);
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  async function handleRefresh() {
    setIsRefreshing(true);
    setError('');
    try {
      const res  = await fetch('/api/destinations/refresh', { method: 'POST' });
      const json = await res.json() as { ok: boolean; result?: { refreshed: number; errors: string[] }; error?: string };
      if (!json.ok) throw new Error(json.error ?? 'Refresh failed');
      if (json.result?.errors.length) setError(json.result.errors.join('; '));
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Refresh failed');
    } finally {
      setIsRefreshing(false);
    }
  }

  const allDestSas = saData.filter(sa => sa.manageDestinations && !!sa.org?.orgId);

  // Build visible tabs: only tabs that have at least one group with visible subaccounts
  const visibleTabs = tabEntries.filter(te =>
    te.sections.some(s => s.type === 'subaccountGroup' && allDestSas.some(sa => csvIncludes(sa.groupIds, s.groupId))),
  );

  const activeTabEntry = visibleTabs.find(te => te.tab === decodeURIComponent(tabParam ?? '')) ?? visibleTabs[0];

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

  return (
    <div className="flex flex-col h-full bg-background text-foreground">
      {/* Title bar */}
      <div className="border-b border-border bg-background px-3 flex items-center gap-2 shrink-0 min-h-[52px]">
        <button onClick={toggle} className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors" title="Toggle sidebar">
          <PanelLeft className="h-4 w-4" />
        </button>
        <span className="text-sm font-semibold">Destination Overview</span>

        {/* Search */}
        <div ref={searchRef} className="relative ml-auto">
          <div className="relative flex items-center">
            <Search className="absolute left-2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
            <input
              type="text"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              onFocus={() => { if (searchResults.length > 0) setShowResults(true); }}
              placeholder="Search destinations…"
              className="h-8 pl-7 pr-7 text-xs border border-border rounded bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring w-[220px]"
            />
            {isSearching && <RefreshCw className="absolute right-2 h-3 w-3 animate-spin text-muted-foreground" />}
          </div>
          {showResults && (
            <div className="absolute top-full mt-1 right-0 w-[420px] bg-popover border border-border rounded-md shadow-lg z-50 max-h-[400px] overflow-auto">
              {searchResults.length === 0
                ? <div className="px-3 py-4 text-xs text-muted-foreground text-center">No destinations found</div>
                : searchResults.map((r, i) => {
                  const sa = allDestSas.find(s => saOrgId(s) === r.org_id);
                  return (
                    <button
                      key={i}
                      className="w-full text-left px-3 py-2 border-b border-border last:border-0 hover:bg-muted/50"
                      onClick={() => {
                        if (!sa) return;
                        const baseNames = (destData[r.org_id] ?? []).map(d => d.name).sort();
                        const allNames  = baseNames.includes(r.name) ? baseNames : [...new Set([r.name, ...baseNames])].sort();
                        setModal({ sa, allNames, initialName: r.name });
                        setShowResults(false);
                        setSearchQuery('');
                      }}
                    >
                      <div className="font-mono text-xs font-medium text-foreground">{r.name}</div>
                      {r.matchField !== 'Name' && (
                        <div className="text-[10px] text-muted-foreground mt-0.5 truncate">
                          <span className="text-muted-foreground/60">{r.matchField}: </span>
                          {r.matchValue.length > 80 ? `${r.matchValue.slice(0, 80)}…` : r.matchValue}
                        </div>
                      )}
                      <div className="text-[10px] text-muted-foreground/50 mt-0.5">{r.region} / {r.subdomain}</div>
                    </button>
                  );
                })
              }
            </div>
          )}
        </div>

        <button onClick={handleRefresh} disabled={isRefreshing} className={btnOutline}>
          <RefreshCw className={`h-3.5 w-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />
          {isRefreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {/* Error banner */}
      {error && (
        <div className="shrink-0 px-4 py-2 bg-destructive/10 text-destructive text-xs border-b border-destructive/20">
          {error}
        </div>
      )}

      {/* Tab bar */}
      {visibleTabs.length > 0 && (
        <div className="flex items-center border-b border-border shrink-0 px-2 overflow-x-auto">
          {visibleTabs.map(te => (
            <button key={te.tab} className={tabCls(te === activeTabEntry)} onClick={() => navigate(`/destinations/${encodeURIComponent(te.tab)}`)}>
              {te.tab}
            </button>
          ))}
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-auto px-4 py-3 space-y-6">
        {visibleTabs.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-muted-foreground">
            <p className="text-sm">No destinations configured.</p>
            <p className="text-xs">Set <code className="bg-muted px-1 rounded">Manage Destinations</code> on subaccounts in Configuration, then click <strong>Refresh</strong>.</p>
          </div>
        )}

        {activeTabEntry?.sections
          .filter((s): s is Extract<TabSection, { type: 'subaccountGroup' }> => s.type === 'subaccountGroup')
          .map(grp => {
          const visibleSas = allDestSas
            .filter(sa => csvIncludes(sa.groupIds, grp.groupId))
            .sort((a, b) => a.pos - b.pos);
          if (visibleSas.length === 0) return null;

          const saBuckets = visibleSas.map(sa => ({
            sa,
            buckets: bucketSa(destData[saOrgId(sa)] ?? []),
          }));

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
                        <th className="sticky left-0 z-20 bg-muted/30 text-left text-xs font-medium text-muted-foreground px-3 py-2 w-[130px] border-r border-b border-border whitespace-nowrap"></th>
                        {visibleSas.map(sa => (
                          <th
                            key={sa.subaccountId}
                            className="text-center text-xs font-medium px-3 py-2 min-w-[160px] border-l border-b border-border text-muted-foreground cursor-pointer hover:bg-muted/40 transition-colors"
                            onClick={() => setModal({ sa, allNames: (destData[saOrgId(sa)] ?? []).map(d => d.name).sort() })}
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
                      {(['generic', 's4', 'cep'] as const).map(cat => {
                        const { label, pattern } = CAT_META[cat];

                        if (cat === 's4') {
                          const sortedPerSa = saBuckets.map(b => ({
                            sa:    b.sa,
                            names: [...b.buckets.s4].sort(),
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
                              {sortedPerSa.map(({ sa, names }) => {
                                const name = names[i];
                                if (!name) return (
                                  <td key={sa.subaccountId} className={`${tdCls} text-left`}>
                                    <span className="text-muted-foreground/30 text-[11px]">—</span>
                                  </td>
                                );
                                const orgId  = saOrgId(sa);
                                const status = fakeStatus(name, orgId);
                                return (
                                  <td key={sa.subaccountId} className={`${tdCls} text-left`}>
                                    <button
                                      className={`font-mono text-[11px] hover:underline text-left ${status === 'OK' ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}
                                      onClick={() => setModal({ sa, allNames: (destData[orgId] ?? []).map(d => d.name).sort(), initialName: name })}
                                    >
                                      {name}
                                    </button>
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
                            {saBuckets.map(({ sa, buckets }) => {
                              const present = buckets[cat].includes(name);
                              const orgId   = saOrgId(sa);
                              const status  = present ? fakeStatus(name, orgId) : null;
                              return (
                                <td key={sa.subaccountId} className={`${tdCls} text-left`}>
                                  {status === 'OK'     && <button className="text-green-600 dark:text-green-400 font-mono text-[11px] hover:underline text-left" onClick={() => setModal({ sa, allNames: (destData[orgId] ?? []).map(d => d.name).sort(), initialName: name })}>{name}</button>}
                                  {status === 'Failed' && <button className="text-red-600   dark:text-red-400   font-mono text-[11px] hover:underline text-left" onClick={() => setModal({ sa, allNames: (destData[orgId] ?? []).map(d => d.name).sort(), initialName: name })}>{name}</button>}
                                  {!status             && <span className="text-muted-foreground/30 text-[11px]">—</span>}
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
                        {saBuckets.map(({ sa, buckets }) => {
                          const orgId      = saOrgId(sa);
                          const others     = buckets.others;
                          const allSaNames = (destData[orgId] ?? []).map(d => d.name).sort();
                          return (
                            <td key={sa.subaccountId} className={`${tdCls} text-left`}>
                              {others.length > 0
                                ? (
                                  <button
                                    onClick={() => setModal({ sa, allNames: allSaNames, initialName: others[0] })}
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
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {modal && (
        <SubaccountDestModal
          org={modal.sa}
          allNames={modal.allNames}
          initialName={modal.initialName}
          onClose={() => {
            setModal(null);
            const base = activeTabEntry ? `/destinations/${encodeURIComponent(activeTabEntry.tab)}` : '/destinations';
            navigate(base, { replace: true });
          }}
        />
      )}
    </div>
  );
}
