import { useCallback, useEffect, useRef, useState } from 'react';
import type { SubaccountEntry } from '@/components/config/SubaccountsTable';
import type { TabEntry, TabSection } from '@/components/config/TabsTable';
import WorldMap from './WorldMap';

// ─── Types (mirrored from aodAnalyticsService) ────────────────────────────────

interface AnalyticsCity    { city: string; lat: number; lon: number; count: number; }
interface AnalyticsRequest { ts: number; region: string; alias: string; subdomain: string; userId: string; appName?: string; spaceName?: string; appGuid?: string; }
interface SubaccountAccess { region: string; subdomain: string; alias: string; appName: string; spaceName: string; lastAccessTs: number; appGuid?: string; }
interface AnalyticsPayload {
  totalRequests: number; uniqueUsers: number; startedAppsGb: number; startedAppsCount: number;
  lastUpdated: number; duration: number;
  cities: AnalyticsCity[]; latestRequests: AnalyticsRequest[]; subaccountAccess: SubaccountAccess[];
}

// SSE delta from analytics-update event
interface AnalyticsUpdateMsg {
  type:              'analytics-update';
  request:           AnalyticsRequest;
  city?:             { city: string; lat: number; lon: number };
  subaccountUpdate?: SubaccountAccess & { lastAccessTs: number };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtTime(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

function csvIncludes(csv: string, id: string): boolean {
  return !!id && csv.split(',').map(s => s.trim()).includes(id);
}

const geoKey = (lat: number, lon: number) => `${lat.toFixed(2)},${lon.toFixed(2)}`;

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

interface RequestRowProps {
  req: AnalyticsRequest;
  onOpen: (region: string, subdomain: string, appGuid: string, spaceName?: string, appName?: string) => void;
}

function RequestRow({ req, onOpen }: RequestRowProps) {
  return (
    <div className="flex items-baseline gap-2 py-1.5 border-b border-border/50 last:border-0 text-xs min-w-0">
      <span className="text-muted-foreground tabular-nums shrink-0">{fmtTime(req.ts)}</span>
      <button
        onClick={() => onOpen(req.region, req.subdomain, req.appGuid ?? '', req.spaceName, req.appName)}
        className="font-medium truncate text-foreground hover:text-primary hover:underline text-left min-w-0"
      >
        {req.appName ?? req.alias}
        {req.subdomain && (
          <span className="text-muted-foreground/60 ml-1 text-[11px]">({req.subdomain})</span>
        )}
      </button>
      <span className="text-muted-foreground truncate shrink-0 max-w-[7rem] ml-auto">{req.userId || '—'}</span>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

interface Props {
  saList:       SubaccountEntry[];
  tabs:         TabEntry[];
  isDarkMap?:   boolean;
  onOpenModal?: (region: string, subdomain: string, appGuid: string, spaceName?: string, appName?: string) => void;
}

export default function UsageAnalyticsView({ saList, tabs, isDarkMap, onOpenModal }: Props) {
  const [durationHours, setDurationHours] = useState(24);
  const [data,    setData]    = useState<AnalyticsPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState<string | null>(null);
  const [liveReqs, setLiveReqs] = useState<AnalyticsRequest[]>([]);
  const [activeTab, setActiveTab] = useState('');
  const esRef = useRef<EventSource | null>(null);

  const handleOpen = useCallback((region: string, subdomain: string, appGuid: string, spaceName?: string, appName?: string) => {
    onOpenModal?.(region, subdomain, appGuid, spaceName, appName);
  }, [onOpenModal]);

  const fetchAnalytics = useCallback(async (hours: number) => {
    setLoading(true);
    setError(null);
    try {
      const res  = await fetch(`/api/aod/analytics?duration=${hours}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json() as { ok: boolean; data: AnalyticsPayload };
      if (json.ok) { setData(json.data); setLiveReqs(json.data.latestRequests); }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load analytics');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void fetchAnalytics(durationHours); }, [durationHours, fetchAnalytics]);

  // ── SSE ───────────────────────────────────────────────────────────────────

  useEffect(() => {
    const es = new EventSource('/api/events?aod=1');
    esRef.current = es;

    es.addEventListener('update', (e: MessageEvent) => {
      try {
        const msg = JSON.parse(e.data as string) as { type?: string } & Record<string, unknown>;

        if (msg.type === 'analytics-update') {
          const upd = msg as unknown as AnalyticsUpdateMsg;

          // Prepend new request to live feed
          setLiveReqs(prev => [upd.request, ...prev].slice(0, 15));

          // Increment counts + apply city/subaccount delta
          setData(d => {
            if (!d) return d;

            // City update
            let cities = d.cities;
            if (upd.city) {
              const k   = geoKey(upd.city.lat, upd.city.lon);
              const idx = cities.findIndex(c => geoKey(c.lat, c.lon) === k);
              cities = idx >= 0
                ? cities.map((c, i) => i === idx ? { ...c, count: c.count + 1 } : c)
                : [...cities, { ...upd.city!, count: 1 }];
            }

            // Subaccount last-access update
            let subaccountAccess = d.subaccountAccess;
            if (upd.subaccountUpdate) {
              const su  = upd.subaccountUpdate;
              const idx = subaccountAccess.findIndex(a => a.region === su.region && a.subdomain === su.subdomain);
              if (idx >= 0) {
                subaccountAccess = subaccountAccess.map((a, i) =>
                  i === idx ? { ...a, appName: su.appName, spaceName: su.spaceName, lastAccessTs: su.lastAccessTs, appGuid: su.appGuid } : a,
                );
              } else {
                subaccountAccess = [...subaccountAccess, su];
              }
              subaccountAccess = [...subaccountAccess].sort((a, b) => b.lastAccessTs - a.lastAccessTs);
            }

            return { ...d, totalRequests: d.totalRequests + 1, lastUpdated: Date.now(), cities, subaccountAccess };
          });
        } else if (msg.type === 'apps-synced') {
          void fetchAnalytics(durationHours);
        }
      } catch { /* ignore parse errors */ }
    });

    return () => { es.close(); esRef.current = null; };
  }, [durationHours, fetchAnalytics]);

  // ── Subaccount access lookup map ──────────────────────────────────────────

  const accessByKey = new Map<string, SubaccountAccess>();
  for (const acc of (data?.subaccountAccess ?? [])) {
    accessByKey.set(`${acc.region}/${acc.subdomain}`, acc);
  }

  // ── Tab/group hierarchy (mirrors all/aod mode structure) ─────────────────

  // Filter tabs to only those that have at least one SA with access data
  const visibleTabs = tabs.filter(te =>
    te.sections.some(s =>
      s.type === 'subaccountGroup' &&
      saList.some(sa => csvIncludes(sa.groupIds, (s as Extract<TabSection, { type: 'subaccountGroup' }>).groupId) &&
        accessByKey.has(`${sa.region}/${sa.subdomain}`)),
    ),
  );

  const tabNames  = visibleTabs.map(te => te.tab);
  const currTab   = tabNames.includes(activeTab) ? activeTab : (tabNames[0] ?? '');
  const currEntry = visibleTabs.find(te => te.tab === currTab);

  // ── Render ────────────────────────────────────────────────────────────────

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
          value={data ? new Date(data.lastUpdated).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '—'}
        />
      </div>

      {error && (
        <div className="rounded-md border border-amber-500/50 bg-amber-500/10 px-4 py-2 text-sm text-amber-600 dark:text-amber-400">
          {error}
        </div>
      )}

      {/* Map + Live feed */}
      <div className="flex gap-4 min-h-0">
        <div className="flex-[3] min-w-0">
          <div className="text-xs font-medium text-muted-foreground mb-1.5">Requests by Location</div>
          <WorldMap cities={data?.cities ?? []} isDark={isDarkMap} />
          {!loading && (data?.cities ?? []).length === 0 && (
            <div className="text-xs text-muted-foreground text-center mt-2">No geo data for this period</div>
          )}
        </div>
        <div className="flex-1 min-w-0 flex flex-col">
          <div className="text-xs font-medium text-muted-foreground mb-1.5">Latest Requests</div>
          <div className="flex-1 rounded-lg border border-border bg-card px-3 py-2 overflow-auto">
            {liveReqs.length === 0
              ? <p className="text-xs text-muted-foreground text-center py-4">No requests yet</p>
              : liveReqs.map((req, i) => <RequestRow key={`${req.ts}-${i}`} req={req} onOpen={handleOpen} />)
            }
          </div>
        </div>
      </div>

      {/* Last Access by Subaccount — tabs → groups → SA rows */}
      {visibleTabs.length > 0 && (
        <div>
          <div className="text-xs font-medium text-muted-foreground mb-1.5">Last Access by Subaccount</div>
          <div className="rounded-lg border border-border bg-card overflow-hidden">

            {/* Tab bar */}
            {visibleTabs.length > 1 && (
              <div className="flex items-stretch border-b border-border overflow-x-auto">
                {visibleTabs.map(te => (
                  <button
                    key={te.tab}
                    onClick={() => setActiveTab(te.tab)}
                    className={`px-4 py-2 text-sm shrink-0 transition-colors border-b-2 ${
                      te.tab === currTab
                        ? 'border-primary text-foreground font-medium'
                        : 'border-transparent text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {te.tab}
                  </button>
                ))}
              </div>
            )}

            {/* Groups → SA rows */}
            {currEntry?.sections
              .filter((s): s is Extract<TabSection, { type: 'subaccountGroup' }> => s.type === 'subaccountGroup')
              .map(grp => {
                const grpSas = saList
                  .filter(sa => csvIncludes(sa.groupIds, grp.groupId) && accessByKey.has(`${sa.region}/${sa.subdomain}`))
                  .sort((a, b) => {
                    const ta = accessByKey.get(`${a.region}/${a.subdomain}`)?.lastAccessTs ?? 0;
                    const tb = accessByKey.get(`${b.region}/${b.subdomain}`)?.lastAccessTs ?? 0;
                    return tb - ta;
                  });
                if (grpSas.length === 0) return null;
                return (
                  <div key={grp.groupId}>
                    <div className="px-4 py-1.5 text-xs font-semibold text-muted-foreground bg-muted/30 border-b border-border">
                      {grp.title ?? grp.groupId}
                    </div>
                    <div className="divide-y divide-border/50">
                      {grpSas.map(sa => {
                        const acc = accessByKey.get(`${sa.region}/${sa.subdomain}`);
                        return (
                          <div key={sa.subaccountId} className="flex items-center gap-3 px-4 py-2 text-xs hover:bg-muted/20">
                            <span className="font-medium text-foreground min-w-[8rem] shrink-0">{sa.alias || sa.subdomain}</span>
                            {acc ? (
                              <>
                                <button
                                  onClick={() => handleOpen(acc.region, acc.subdomain, acc.appGuid ?? '', acc.spaceName, acc.appName)}
                                  className="truncate flex-1 text-foreground hover:text-primary hover:underline text-left"
                                >
                                  {acc.appName || '—'}
                                  {acc.spaceName && (
                                    <span className="text-muted-foreground/60 ml-1 text-[11px]">({acc.spaceName})</span>
                                  )}
                                </button>
                                <span className="text-muted-foreground tabular-nums shrink-0">{fmtTime(acc.lastAccessTs)}</span>
                              </>
                            ) : (
                              <span className="text-muted-foreground/50 flex-1">no activity</span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
          </div>
        </div>
      )}
    </div>
  );
}
