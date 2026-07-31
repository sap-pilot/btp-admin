import { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router';
import { PanelLeft, RefreshCw, Search } from 'lucide-react';
import { useSidebar } from '@/components/AppLayout';
import type { OrgEntry, OrgRegion } from '@/components/config/OrgsTable';
import type { DirTab } from '@/components/config/DirsTable';
import SubaccountDestModal from './SubaccountDestModal';

// ─── Types ────────────────────────────────────────────────────────────────────

interface DestItem { name: string; status: 'OK' }
type DestData = Record<string, DestItem[]>;

interface Buckets { generic: string[]; s4: string[]; cep: string[]; others: string[] }

interface ModalState { org: OrgEntry & { region: string }; allNames: string[]; initialName?: string }

interface DestSearchResult {
  region:     string;
  subdomain:  string;
  org_id:     string;
  name:       string;
  matchField: string;
  matchValue: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function categorise(name: string): keyof Buckets {
  if (/^API_(S4|MDG)_(HTTP|RFC)_/i.test(name))   return 'generic';
  if (/^API_/i.test(name))             return 's4';
  if (/^cep-.*-runtime$/i.test(name))  return 'cep';
  return 'others';
}

function bucketOrg(dests: DestItem[]): Buckets {
  const b: Buckets = { generic: [], s4: [], cep: [], others: [] };
  for (const d of dests) b[categorise(d.name)].push(d.name);
  return b;
}

// Stable deterministic fake status: ~90% OK, ~10% Failed (seeded by name+org)
function fakeStatus(name: string, orgId: string): 'OK' | 'Failed' {
  let h = 0;
  for (const c of name + orgId) h = (h * 31 + c.charCodeAt(0)) & 0xffff;
  return h % 10 === 0 ? 'Failed' : 'OK';
}

function csvIncludes(csv: string, alias: string): boolean {
  return csv.split(',').map(s => s.trim()).includes(alias);
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

  const [dirTabs,  setDirTabs]  = useState<DirTab[]>([]);
  const [orgData,  setOrgData]  = useState<OrgRegion[]>([]);
  const [destData, setDestData] = useState<DestData>({});
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError]   = useState('');
  const [modal, setModal]   = useState<ModalState | null>(null);

  const deepLinkOpened = useRef(false);

  // Search
  const [searchQuery,   setSearchQuery]   = useState('');
  const [searchResults, setSearchResults] = useState<DestSearchResult[]>([]);
  const [isSearching,   setIsSearching]   = useState(false);
  const [showResults,   setShowResults]   = useState(false);
  const searchRef = useRef<HTMLDivElement>(null);

  async function loadData() {
    const [dirsRes, orgsRes, destsRes] = await Promise.all([
      fetch('/api/config/dirs'),
      fetch('/api/config/orgs'),
      fetch('/api/destinations'),
    ]);
    const dirs  = await dirsRes.json()  as { ok: boolean; data: DirTab[] };
    const orgs  = await orgsRes.json()  as { ok: boolean; data: OrgRegion[] };
    const dests = await destsRes.json() as { ok: boolean; data: DestData };
    if (dirs.ok)  setDirTabs(dirs.data);
    if (orgs.ok)  setOrgData(orgs.data);
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
    if (deepLinkOpened.current || !regionParam || !subdomainParam || orgData.length === 0) return;
    const destOrgs = orgData.flatMap(r =>
      r.orgs.filter(o => o.manageDestination).map(o => ({ ...o, region: r.region })),
    );
    const org = destOrgs.find(o => o.region === regionParam && o.subdomain === subdomainParam);
    if (!org) return;
    deepLinkOpened.current = true;
    const names = (destData[org.org_id] ?? []).map(d => d.name).sort();
    setModal({ org, allNames: names, initialName: nameParam ?? names[0] });
  }, [regionParam, subdomainParam, nameParam, orgData, destData]);

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
      } catch { /* ignore */ } finally {
        setIsSearching(false);
      }
    }, 300);
    return () => clearTimeout(id);
  }, [searchQuery]);

  // Close dropdown on outside click
  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setShowResults(false);
      }
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

  // Flatten all orgs with their region, filtered to manageDestination=true
  const allDestOrgs: Array<OrgEntry & { region: string }> = orgData.flatMap(r =>
    r.orgs.filter(o => o.manageDestination).map(o => ({ ...o, region: r.region })),
  );

  // Build visible tabs: only tabs that have at least one directory with visible orgs
  const visibleTabs = dirTabs.filter(dt =>
    dt.dirs.some(dir =>
      allDestOrgs.some(o => csvIncludes(o.directories, dir.alias)),
    ),
  );

  const activeTab = visibleTabs.find(dt => dt.tab === decodeURIComponent(tabParam ?? '')) ?? visibleTabs[0];

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
            {isSearching && (
              <RefreshCw className="absolute right-2 h-3 w-3 animate-spin text-muted-foreground" />
            )}
          </div>
          {showResults && (
            <div className="absolute top-full mt-1 right-0 w-[420px] bg-popover border border-border rounded-md shadow-lg z-50 max-h-[400px] overflow-auto">
              {searchResults.length === 0
                ? <div className="px-3 py-4 text-xs text-muted-foreground text-center">No destinations found</div>
                : searchResults.map((r, i) => {
                  const org = allDestOrgs.find(o => o.org_id === r.org_id);
                  return (
                    <button
                      key={i}
                      className="w-full text-left px-3 py-2 border-b border-border last:border-0 hover:bg-muted/50"
                      onClick={() => {
                        if (!org) return;
                        setModal({ org, allNames: (destData[r.org_id] ?? []).map(d => d.name).sort(), initialName: r.name });
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
          {visibleTabs.map(dt => (
            <button key={dt.tab} className={tabCls(dt === activeTab)} onClick={() => navigate(`/destinations/${encodeURIComponent(dt.tab)}`)}>
              {dt.tab}
            </button>
          ))}
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-auto px-4 py-3 space-y-6">
        {visibleTabs.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-muted-foreground">
            <p className="text-sm">No destinations configured.</p>
            <p className="text-xs">Set <code className="bg-muted px-1 rounded">manageDestination=true</code> on orgs in Configuration, then click <strong>Refresh</strong>.</p>
          </div>
        )}

        {activeTab?.dirs.map(dir => {
          const visibleOrgs = allDestOrgs
            .filter(o => csvIncludes(o.directories, dir.alias))
            .sort((a, b) => a.pos - b.pos);
          if (visibleOrgs.length === 0) return null;

          const orgBuckets = visibleOrgs.map(org => ({
            org,
            buckets: bucketOrg(destData[org.org_id] ?? []),
          }));

          return (
            <div key={dir.alias} className="space-y-1.5">
              {/* Directory name outside the table — like the home page */}
              <div className="px-1">
                <span className="text-xs font-semibold text-foreground">{dir.title}</span>
                <span className="text-xs text-muted-foreground ml-2">({dir.alias})</span>
              </div>

              <div className="border border-border rounded-md overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse text-sm" style={{ tableLayout: 'auto' }}>
                    <thead className="sticky top-0 z-10">
                      <tr className="bg-muted/30">
                        <th className="sticky left-0 z-20 bg-muted/30 text-left text-xs font-medium text-muted-foreground px-3 py-2 w-[130px] border-r border-b border-border whitespace-nowrap"></th>
                        {visibleOrgs.map(org => (
                          <th
                            key={org.org_id}
                            className="text-center text-xs font-medium px-3 py-2 min-w-[160px] border-l border-b border-border text-muted-foreground cursor-pointer hover:bg-muted/40 transition-colors"
                            onClick={() => setModal({ org, allNames: (destData[org.org_id] ?? []).map(d => d.name).sort() })}
                          >
                            <div className="flex flex-col gap-0.5 items-center">
                              <span>{org.alias || org.org_name}</span>
                              {org.subdomain && (
                                <span className="text-[10px] font-normal font-mono text-muted-foreground/60 leading-tight">{org.subdomain}</span>
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
                          // Positional rows: each org shows its Nth sorted S/4 destination independently
                          const sortedPerOrg = orgBuckets.map(b => ({
                            org:   b.org,
                            names: [...b.buckets.s4].sort(),
                          }));
                          const maxRows = Math.max(0, ...sortedPerOrg.map(b => b.names.length));
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
                              {sortedPerOrg.map(({ org, names }) => {
                                const name = names[i];
                                if (!name) return (
                                  <td key={org.org_id} className={`${tdCls} text-left`}>
                                    <span className="text-muted-foreground/30 text-[11px]">—</span>
                                  </td>
                                );
                                const status = fakeStatus(name, org.org_id);
                                return (
                                  <td key={org.org_id} className={`${tdCls} text-left`}>
                                    <button
                                      className={`font-mono text-[11px] hover:underline text-left ${status === 'OK' ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}
                                      onClick={() => setModal({ org, allNames: (destData[org.org_id] ?? []).map(d => d.name).sort(), initialName: name })}
                                    >
                                      {name}
                                    </button>
                                  </td>
                                );
                              })}
                            </tr>
                          ));
                        }

                        // Union-matched rows for Generic and Workzone (names standardised across orgs)
                        const allNames = [...new Set(orgBuckets.flatMap(b => [...b.buckets[cat]]))].sort();
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
                            {orgBuckets.map(({ org, buckets }) => {
                              const present = buckets[cat].includes(name);
                              const status  = present ? fakeStatus(name, org.org_id) : null;
                              return (
                                <td key={org.org_id} className={`${tdCls} text-left`}>
                                  {status === 'OK'     && <button className="text-green-600 dark:text-green-400 font-mono text-[11px] hover:underline text-left" onClick={() => setModal({ org, allNames: (destData[org.org_id] ?? []).map(d => d.name).sort(), initialName: name })}>{name}</button>}
                                  {status === 'Failed' && <button className="text-red-600   dark:text-red-400   font-mono text-[11px] hover:underline text-left" onClick={() => setModal({ org, allNames: (destData[org.org_id] ?? []).map(d => d.name).sort(), initialName: name })}>{name}</button>}
                                  {!status             && <span className="text-muted-foreground/30 text-[11px]">—</span>}
                                </td>
                              );
                            })}
                          </tr>
                        ));
                      })}

                      {/* OTHERS row — full-width button per org cell */}
                      <tr className="hover:bg-muted/20">
                        <td className={catTdCls}>
                          <div className="flex flex-col gap-0.5">
                            <span className="font-semibold">OTHERS</span>
                            <span className="text-[10px] text-muted-foreground/60">all other destinations</span>
                          </div>
                        </td>
                        {orgBuckets.map(({ org, buckets }) => {
                          const others   = buckets.others;
                          const allOrgNames = (destData[org.org_id] ?? []).map(d => d.name).sort();
                          return (
                            <td key={org.org_id} className={`${tdCls} text-left`}>
                              {others.length > 0
                                ? (
                                  <button
                                    onClick={() => setModal({ org, allNames: allOrgNames, initialName: others[0] })}
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
          org={modal.org}
          allNames={modal.allNames}
          initialName={modal.initialName}
          onClose={() => {
            setModal(null);
            const base = activeTab ? `/destinations/${encodeURIComponent(activeTab.tab)}` : '/destinations';
            navigate(base, { replace: true });
          }}
        />
      )}
    </div>
  );
}
