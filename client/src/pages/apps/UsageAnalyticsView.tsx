import { useCallback, useEffect, useRef, useState } from 'react';
import type { SubaccountEntry } from '@/components/config/SubaccountsTable';
import type { TabEntry } from '@/components/config/TabsTable';
import WorldMap from './WorldMap';

interface AnalyticsCity    { city: string; lat: number; lon: number; count: number; }
interface AnalyticsRequest { ts: number; region: string; alias: string; subdomain: string; userId: string; appName?: string; spaceName?: string; }
interface SubaccountAccess { region: string; subdomain: string; alias: string; appName: string; spaceName: string; lastAccessTs: number; }
interface AnalyticsPayload {
  totalRequests: number; uniqueUsers: number; startedAppsGb: number; startedAppsCount: number;
  lastUpdated: number; duration: number;
  cities: AnalyticsCity[]; latestRequests: AnalyticsRequest[]; subaccountAccess: SubaccountAccess[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtTime(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

function fmtLastUpdate(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

function csvIncludes(csv: string, id: string): boolean {
  if (!id) return false;
  return csv.split(',').map(s => s.trim()).includes(id);
}

const DURATIONS: { label: string; hours: number }[] = [
  { label: '1 h',  hours: 1   },
  { label: '6 h',  hours: 6   },
  { label: '24 h', hours: 24  },
  { label: '7 d',  hours: 168 },
];

// ─── Sub-components ───────────────────────────────────────────────────────────

function InfoBlock({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="rounded-lg border border-border bg-card px-4 pt-4 pb-3 min-w-0 text-center">
      <div className={`text-2xl font-bold tabular-nums truncate ${accent ?? ''}`}>{value}</div>
      <div className="text-xs text-muted-foreground mt-1">{label}</div>
    </div>
  );
}

function RequestRow({ req }: { req: AnalyticsRequest }) {
  return (
    <div className="flex items-center gap-2 py-1.5 border-b border-border/50 last:border-0 text-xs min-w-0">
      <span className="text-muted-foreground tabular-nums shrink-0">{fmtTime(req.ts)}</span>
      <span className="font-medium truncate text-foreground">{req.region}/{req.alias}</span>
      <span className="text-muted-foreground truncate shrink-0 max-w-[7rem]">{req.userId || '—'}</span>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

interface Props {
  saList:     SubaccountEntry[];
  tabs:       TabEntry[];
  isDarkMap?: boolean;
}

export default function UsageAnalyticsView({ saList, tabs, isDarkMap }: Props) {
  const [durationHours, setDurationHours] = useState(24);
  const [data,   setData]   = useState<AnalyticsPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error,  setError]  = useState<string | null>(null);
  const [liveReqs, setLiveReqs] = useState<AnalyticsRequest[]>([]);
  const esRef = useRef<EventSource | null>(null);

  const fetchAnalytics = useCallback(async (hours: number) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/aod/analytics?duration=${hours}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json() as { ok: boolean; data: AnalyticsPayload };
      if (json.ok) {
        setData(json.data);
        setLiveReqs(json.data.latestRequests);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load analytics');
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch on duration change
  useEffect(() => { void fetchAnalytics(durationHours); }, [durationHours, fetchAnalytics]);

  // SSE subscription
  useEffect(() => {
    const es = new EventSource('/api/events?aod=1');
    esRef.current = es;

    es.onmessage = (e: MessageEvent) => {
      try {
        const msg = JSON.parse(e.data as string) as { type?: string } & Record<string, unknown>;

        if (msg.type === 'analytics-request') {
          const req = msg as unknown as AnalyticsRequest;
          setLiveReqs(prev => [req, ...prev].slice(0, 15));
          // Invalidate counts — re-fetch stats block only, not full data
          setData(d => d ? { ...d, totalRequests: d.totalRequests + 1, lastUpdated: Date.now() } : d);
        } else if (msg.type === 'apps-synced') {
          void fetchAnalytics(durationHours);
        }
      } catch { /* ignore parse errors */ }
    };

    return () => { es.close(); esRef.current = null; };
  }, [durationHours, fetchAnalytics]);

  // ── Build hierarchy: tab → group → subaccounts ──────────────────────────────

  interface HierarchyRow { tab: string; group: string; sa: SubaccountEntry; access?: SubaccountAccess; }
  const hierarchy: HierarchyRow[] = [];

  if (data) {
    const accessByKey = new Map<string, SubaccountAccess>();
    for (const acc of data.subaccountAccess) accessByKey.set(`${acc.region}/${acc.subdomain}`, acc);

    for (const te of tabs) {
      for (const section of te.sections) {
        if (section.type !== 'subaccountGroup') continue;
        const groupSas = saList.filter(sa => csvIncludes(sa.groupIds, section.groupId));
        for (const sa of groupSas) {
          const access = accessByKey.get(`${sa.region}/${sa.subdomain}`);
          if (access) hierarchy.push({ tab: te.tab, group: section.title ?? section.groupId, sa, access });
        }
      }
    }
    // Sort by last access desc within each tab/group
    hierarchy.sort((a, b) => {
      const tabDiff = a.tab.localeCompare(b.tab) || a.group.localeCompare(b.group);
      if (tabDiff !== 0) return tabDiff;
      return (b.access?.lastAccessTs ?? 0) - (a.access?.lastAccessTs ?? 0);
    });
  }

  // Group by tab
  const byTab = new Map<string, { group: string; rows: HierarchyRow[] }[]>();
  for (const row of hierarchy) {
    let tabGroups = byTab.get(row.tab);
    if (!tabGroups) { tabGroups = []; byTab.set(row.tab, tabGroups); }
    let grp = tabGroups.find(g => g.group === row.group);
    if (!grp) { grp = { group: row.group, rows: [] }; tabGroups.push(grp); }
    grp.rows.push(row);
  }

  const [activeHierTab, setActiveHierTab] = useState<string>('');
  const hierTabs = [...byTab.keys()];
  const currentHierTab = hierTabs.includes(activeHierTab) ? activeHierTab : (hierTabs[0] ?? '');

  // ── Render ──────────────────────────────────────────────────────────────────

  const cities: AnalyticsCity[] = data?.cities ?? [];

  return (
    <div className="flex flex-col gap-6 p-6">

      {/* Duration selector */}
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-muted-foreground">Usage Analytics</span>
        <div className="flex h-8 rounded-md border border-input overflow-hidden text-sm">
          {DURATIONS.map((d, i) => (
            <button
              key={d.hours}
              onClick={() => setDurationHours(d.hours)}
              className={`px-3 transition-colors ${i > 0 ? 'border-l border-input' : ''} ${
                durationHours === d.hours
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-background text-foreground hover:bg-accent hover:text-accent-foreground'
              }`}
            >
              {d.label}
            </button>
          ))}
        </div>
      </div>

      {/* Info blocks */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <InfoBlock
          label={`Started Apps: ${data?.startedAppsCount ?? '—'}`}
          value={data ? `${data.startedAppsGb} GB` : '—'}
          accent="text-blue-500"
        />
        <InfoBlock
          label={`Requests (last ${durationHours >= 168 ? '7 d' : durationHours >= 24 ? '24 h' : `${durationHours} h`})`}
          value={loading ? '…' : (data?.totalRequests.toLocaleString() ?? '—')}
          accent="text-orange-500"
        />
        <InfoBlock
          label="Unique Users"
          value={loading ? '…' : (data?.uniqueUsers.toLocaleString() ?? '—')}
          accent="text-emerald-500"
        />
        <InfoBlock
          label="Last Update"
          value={data ? fmtLastUpdate(data.lastUpdated) : '—'}
        />
      </div>

      {error && (
        <div className="rounded-md border border-amber-500/50 bg-amber-500/10 px-4 py-2 text-sm text-amber-600 dark:text-amber-400">
          {error}
        </div>
      )}

      {/* Map + Live feed */}
      <div className="flex gap-4 min-h-0">

        {/* World map (75%) */}
        <div className="flex-[3] min-w-0">
          <div className="text-xs font-medium text-muted-foreground mb-1.5">Requests by Location</div>
          <WorldMap cities={cities} isDark={isDarkMap} />
          {cities.length === 0 && !loading && (
            <div className="text-xs text-muted-foreground text-center mt-2">
              No geo data for this period
            </div>
          )}
        </div>

        {/* Latest requests (25%) */}
        <div className="flex-1 min-w-0 flex flex-col">
          <div className="text-xs font-medium text-muted-foreground mb-1.5">Latest Requests</div>
          <div className="flex-1 rounded-lg border border-border bg-card px-3 py-2 overflow-auto">
            {liveReqs.length === 0
              ? <p className="text-xs text-muted-foreground text-center py-4">No requests yet</p>
              : liveReqs.map((req, i) => <RequestRow key={`${req.ts}-${i}`} req={req} />)
            }
          </div>
        </div>
      </div>

      {/* Subaccount hierarchy */}
      {hierarchy.length > 0 && (
        <div>
          <div className="text-xs font-medium text-muted-foreground mb-1.5">Last Access by Subaccount</div>
          <div className="rounded-lg border border-border bg-card overflow-hidden">

            {/* Tab bar */}
            {hierTabs.length > 1 && (
              <div className="flex border-b border-border overflow-x-auto">
                {hierTabs.map(tab => (
                  <button
                    key={tab}
                    onClick={() => setActiveHierTab(tab)}
                    className={`px-4 py-2 text-xs shrink-0 transition-colors border-b-2 ${
                      tab === currentHierTab
                        ? 'border-primary text-foreground font-medium'
                        : 'border-transparent text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {tab}
                  </button>
                ))}
              </div>
            )}

            {/* Groups + subaccounts */}
            {(byTab.get(currentHierTab) ?? []).map(grp => (
              <div key={grp.group}>
                <div className="px-4 py-1.5 text-xs font-semibold text-muted-foreground bg-muted/30 border-b border-border">
                  {grp.group}
                </div>
                <div className="divide-y divide-border/50">
                  {grp.rows.map(row => (
                    <div key={`${row.sa.region}/${row.sa.subdomain}`} className="flex items-center gap-3 px-4 py-2 text-xs">
                      <span className="font-medium text-foreground min-w-[8rem]">{row.sa.alias || row.sa.subdomain}</span>
                      {row.access ? (
                        <>
                          <span className="text-muted-foreground truncate flex-1">
                            {row.access.appName}
                            {row.access.spaceName && <span className="ml-1 opacity-60">({row.access.spaceName})</span>}
                          </span>
                          <span className="text-muted-foreground tabular-nums shrink-0">{fmtTime(row.access.lastAccessTs)}</span>
                        </>
                      ) : (
                        <span className="text-muted-foreground/50">no activity</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
