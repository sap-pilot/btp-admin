import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import WorldMap from './WorldMap';
import AccessListModal from './AccessListModal';

// ─── Types ────────────────────────────────────────────────────────────────────

interface AnalyticsCity { city: string; country: string; countryCode: string; lat: number; lon: number; count: number; }

// Mirrored from aodAnalyticsService RequestItem
export interface RequestItem {
  ts: number; region: string; subdomain: string; alias: string;
  spaceName: string; appName: string; appGuid: string;
  country: string; countryCode: string; city: string; userId: string;
}

interface AnalyticsRequest { ts: number; region: string; alias: string; subdomain: string; userId: string; appName?: string; spaceName?: string; appGuid?: string; city?: string; countryCode?: string; }
interface AnalyticsPayload {
  totalRequests: number; uniqueUsers: number; startedAppsGb: number; startedAppsCount: number;
  requestedAppsCount: number; latestRequestTs: number;
  lastUpdated: number; duration: number;
  cities: AnalyticsCity[]; latestRequests: AnalyticsRequest[];
}
interface AnalyticsUpdateMsg {
  type:    'analytics-update';
  request: AnalyticsRequest;
  city?:   { city: string; country: string; countryCode: string; lat: number; lon: number };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtTime(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}
function fmtLatestRequest(ts: number): string {
  if (!ts) return '—';
  return new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
}

const geoKey  = (lat: number, lon: number) => `${lat.toFixed(2)},${lon.toFixed(2)}`;
const cityKey = (countryCode: string, city: string) => `${countryCode}-${city}`;

function splitCityKey(key: string): { countryCode: string; city: string } {
  const dashIdx = key.indexOf('-');
  if (dashIdx <= 0) return { countryCode: '', city: key };
  return { countryCode: key.slice(0, dashIdx), city: key.slice(dashIdx + 1) };
}

function sseToItem(upd: AnalyticsUpdateMsg): RequestItem {
  return {
    ts:          upd.request.ts,
    region:      upd.request.region,
    subdomain:   upd.request.subdomain,
    alias:       upd.request.alias,
    spaceName:   upd.request.spaceName   ?? '',
    appName:     upd.request.appName     ?? '',
    appGuid:     upd.request.appGuid     ?? '',
    country:     upd.city?.country       ?? '',
    countryCode: upd.request.countryCode ?? upd.city?.countryCode ?? '',
    city:        upd.request.city        ?? upd.city?.city        ?? '',
    userId:      upd.request.userId,
  };
}

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
  req: RequestItem;
  onOpen: (e: React.MouseEvent, region: string, subdomain: string, appGuid: string, spaceName?: string, appName?: string) => void;
}
function RequestRow({ req, onOpen }: RequestRowProps) {
  return (
    <div className="flex items-baseline gap-2 py-1.5 border-b border-border/50 last:border-0 text-xs min-w-0">
      <span className="text-muted-foreground tabular-nums shrink-0">{fmtTime(req.ts)}</span>
      <button
        onClick={(e) => onOpen(e, req.region, req.subdomain, req.appGuid, req.spaceName, req.appName)}
        className="font-medium truncate text-foreground hover:text-primary hover:underline text-left min-w-0"
      >
        {req.appName || req.alias}
        {req.alias && (
          <span className="text-muted-foreground/60 ml-1 text-[11px]">({req.alias})</span>
        )}
      </button>
      <span className="text-muted-foreground truncate shrink-0 max-w-[7rem] ml-auto">{req.userId || '—'}</span>
    </div>
  );
}

interface TopAppEntry { appName: string; count: number; percent: number; region: string; subdomain: string; appGuid: string; spaceName: string; }
interface TopAppRowProps {
  app: TopAppEntry;
  onOpen: (e: React.MouseEvent, region: string, subdomain: string, appGuid: string, spaceName?: string, appName?: string) => void;
}
function TopAppRow({ app, onOpen }: TopAppRowProps) {
  return (
    <button
      className="relative w-full flex items-center text-xs py-1.5 px-2 rounded overflow-hidden hover:bg-accent/30 transition-colors text-left"
      onClick={(e) => onOpen(e, app.region, app.subdomain, app.appGuid, app.spaceName, app.appName)}
    >
      <div className="absolute inset-y-0 left-0 bg-primary/15 rounded transition-all" style={{ width: `${app.percent}%` }} />
      <span className="relative truncate">{app.appName}</span>
      <span className="relative ml-auto pl-2 tabular-nums text-muted-foreground shrink-0">{app.count} <span className="text-muted-foreground/60">({app.percent}%)</span></span>
    </button>
  );
}

interface TopUserEntry { userId: string; count: number; percent: number; }
function TopUserRow({ user }: { user: TopUserEntry }) {
  return (
    <div className="relative w-full flex items-center text-xs py-1.5 px-2 rounded overflow-hidden">
      <div className="absolute inset-y-0 left-0 bg-emerald-500/15 rounded transition-all" style={{ width: `${user.percent}%` }} />
      <span className="relative truncate text-foreground">{user.userId}</span>
      <span className="relative ml-auto pl-2 tabular-nums text-muted-foreground shrink-0">{user.count} <span className="text-muted-foreground/60">({user.percent}%)</span></span>
    </div>
  );
}

type ListTab = 'requests' | 'topApps' | 'topUsers';
const TAB_LABELS: Record<ListTab, string> = { requests: 'Latest Req', topApps: 'Top Apps', topUsers: 'Top Users' };
const ALL_TABS: ListTab[] = ['requests', 'topApps', 'topUsers'];

// ─── Main component ───────────────────────────────────────────────────────────

interface Props {
  isDarkMap?:    boolean;
  durationHours: number;
  onOpenModal?:  (e: React.MouseEvent, region: string, subdomain: string, appGuid: string, spaceName?: string, appName?: string) => void;
}

export default function UsageAnalyticsView({ isDarkMap, durationHours, onOpenModal }: Props) {
  const [data,         setData]         = useState<AnalyticsPayload | null>(null);
  const [loading,      setLoading]      = useState(false);
  const [error,        setError]        = useState<string | null>(null);
  const [reqItems,     setReqItems]     = useState<RequestItem[]>([]);
  const [selectedCity, setSelectedCity] = useState<string>('');
  const [showModal,    setShowModal]    = useState(false);
  const [listTab,      setListTab]      = useState<ListTab>('requests');
  const [topApps,      setTopApps]      = useState<TopAppEntry[]>([]);
  const [topUsers,     setTopUsers]     = useState<TopUserEntry[]>([]);
  const [tabsCollapsed, setTabsCollapsed] = useState(false);
  const esRef       = useRef<EventSource | null>(null);
  const mapColRef   = useRef<HTMLDivElement>(null);
  const tabHeaderRef = useRef<HTMLDivElement>(null);
  const [mapColH, setMapColH] = useState(0);

  useEffect(() => {
    const el = mapColRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setMapColH(entry?.contentRect.height ?? 0));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Collapse tabs to select when the right panel is too narrow
  useEffect(() => {
    const el = tabHeaderRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setTabsCollapsed((entry?.contentRect.width ?? 999) < 220));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const handleOpen = useCallback((e: React.MouseEvent, region: string, subdomain: string, appGuid: string, spaceName?: string, appName?: string) => {
    onOpenModal?.(e, region, subdomain, appGuid, spaceName, appName);
  }, [onOpenModal]);

  // ── Analytics (map + stats) fetch ─────────────────────────────────────────

  const fetchAnalytics = useCallback(async (hours: number) => {
    setLoading(true);
    setError(null);
    try {
      const res  = await fetch(`/api/aod/analytics?duration=${hours}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json() as { ok: boolean; data: AnalyticsPayload };
      if (json.ok) setData(json.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load analytics');
    } finally {
      setLoading(false);
    }
  }, []);

  // ── Requests (inline list) fetch from API ─────────────────────────────────

  const fetchRequests = useCallback(async (cityFilter: string) => {
    const params = new URLSearchParams({ pageSize: '500', sortBy: 'ts', sortDir: 'desc' });
    if (cityFilter) {
      const { countryCode, city } = splitCityKey(cityFilter);
      if (countryCode) params.set('countryCode', countryCode);
      if (city)        params.set('city', city);
    }
    try {
      const res  = await fetch(`/api/aod/requests?${params.toString()}`);
      if (!res.ok) return;
      const json = await res.json() as { ok: boolean; data: { items: RequestItem[] } };
      if (json.ok) setReqItems(json.data.items);
    } catch { /* silently ignore */ }
  }, []);

  const fetchTopApps = useCallback(async (hours: number, cityFilter: string) => {
    const params = new URLSearchParams({ duration: String(hours) });
    if (cityFilter) {
      const { countryCode, city } = splitCityKey(cityFilter);
      if (countryCode) params.set('countryCode', countryCode);
      if (city)        params.set('city', city);
    }
    try {
      const res  = await fetch(`/api/aod/top-apps?${params.toString()}`);
      if (!res.ok) return;
      const json = await res.json() as { ok: boolean; data: TopAppEntry[] };
      if (json.ok) setTopApps(json.data);
    } catch { /* silently ignore */ }
  }, []);

  const fetchTopUsers = useCallback(async (hours: number, cityFilter: string) => {
    const params = new URLSearchParams({ duration: String(hours) });
    if (cityFilter) {
      const { countryCode, city } = splitCityKey(cityFilter);
      if (countryCode) params.set('countryCode', countryCode);
      if (city)        params.set('city', city);
    }
    try {
      const res  = await fetch(`/api/aod/top-users?${params.toString()}`);
      if (!res.ok) return;
      const json = await res.json() as { ok: boolean; data: TopUserEntry[] };
      if (json.ok) setTopUsers(json.data);
    } catch { /* silently ignore */ }
  }, []);

  useEffect(() => { void fetchAnalytics(durationHours); }, [durationHours, fetchAnalytics]);
  useEffect(() => { void fetchRequests(selectedCity); }, [selectedCity, fetchRequests]);
  useEffect(() => { void fetchTopApps(durationHours, selectedCity); }, [durationHours, selectedCity, fetchTopApps]);
  useEffect(() => { void fetchTopUsers(durationHours, selectedCity); }, [durationHours, selectedCity, fetchTopUsers]);

  // ── SSE ───────────────────────────────────────────────────────────────────

  useEffect(() => {
    const es = new EventSource('/api/events?aod=1');
    esRef.current = es;

    es.addEventListener('update', (e: MessageEvent) => {
      try {
        const msg = JSON.parse(e.data as string) as { type?: string } & Record<string, unknown>;

        if (msg.type === 'analytics-update') {
          const upd = msg as unknown as AnalyticsUpdateMsg;

          // Prepend to inline list if no filter or request matches current city filter
          const item = sseToItem(upd);
          const matchesFilter = !selectedCity || (item.countryCode && item.city && cityKey(item.countryCode, item.city) === selectedCity);
          if (matchesFilter) {
            setReqItems(prev => [item, ...prev].slice(0, 100));
          }

          // Update city counts and global stats
          setData(d => {
            if (!d) return d;
            let cities = d.cities;
            if (upd.city) {
              const k   = geoKey(upd.city.lat, upd.city.lon);
              const idx = cities.findIndex(c => geoKey(c.lat, c.lon) === k);
              cities = idx >= 0
                ? cities.map((c, i) => i === idx ? { ...c, count: c.count + 1 } : c)
                : [...cities, { ...upd.city!, count: 1 }];
            }
            const newLatestTs = upd.request.ts > d.latestRequestTs ? upd.request.ts : d.latestRequestTs;
            return { ...d, totalRequests: d.totalRequests + 1, lastUpdated: Date.now(), latestRequestTs: newLatestTs, cities };
          });
        } else if (msg.type === 'apps-synced') {
          void fetchAnalytics(durationHours);
          void fetchRequests(selectedCity);
          void fetchTopApps(durationHours, selectedCity);
          void fetchTopUsers(durationHours, selectedCity);
        }
      } catch { /* ignore parse errors */ }
    });

    return () => { es.close(); esRef.current = null; };
  }, [durationHours, selectedCity, fetchAnalytics, fetchRequests, fetchTopApps, fetchTopUsers]);

  // ── City filter options ───────────────────────────────────────────────────

  const cityOptions = useMemo(() => {
    const cities = data?.cities ?? [];
    return [...cities]
      .filter(c => c.countryCode && c.city)
      .sort((a, b) => b.count - a.count)
      .map(c => ({ key: cityKey(c.countryCode, c.city), label: `${c.countryCode}-${c.city}` }));
  }, [data?.cities]);

  useEffect(() => {
    if (selectedCity && !cityOptions.some(o => o.key === selectedCity)) setSelectedCity('');
  }, [cityOptions, selectedCity]);

  // ── Render ────────────────────────────────────────────────────────────────

  const durationLabel = durationHours >= 168 ? '7 days' : durationHours >= 48 ? `${durationHours / 24} days` : '24 hrs';

  return (
    <div className="flex flex-col gap-6 p-6">

      {/* Info blocks */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <InfoBlock
          label={`Requests (last ${durationLabel})`}
          value={loading ? '…' : (data?.totalRequests.toLocaleString() ?? '—')}
          accent="text-orange-500"
        />
        <InfoBlock
          label={`Requested Apps (last ${durationLabel})`}
          value={loading ? '…' : (data?.requestedAppsCount.toLocaleString() ?? '—')}
          accent="text-blue-500"
        />
        <InfoBlock
          label="Unique Users"
          value={loading ? '…' : (data?.uniqueUsers.toLocaleString() ?? '—')}
          accent="text-emerald-500"
        />
        <InfoBlock
          label="Latest Request"
          value={data ? fmtLatestRequest(data.latestRequestTs) : '—'}
        />
      </div>

      {error && (
        <div className="rounded-md border border-amber-500/50 bg-amber-500/10 px-4 py-2 text-sm text-amber-600 dark:text-amber-400">
          {error}
        </div>
      )}

      {/* Map + Live feed */}
      <div className="flex gap-4 items-start">
        <div ref={mapColRef} className="flex-[3] min-w-0">
          <div className="text-xs font-medium text-muted-foreground mb-1.5">Requests by Location</div>
          <WorldMap
            cities={data?.cities ?? []}
            isDark={isDarkMap}
            selectedCity={selectedCity}
            onCityClick={key => setSelectedCity(prev => prev === key ? '' : key)}
          />
          {!loading && (data?.cities ?? []).length === 0 && (
            <div className="text-xs text-muted-foreground text-center mt-2">No geo data for this period</div>
          )}
        </div>
        <div className="flex-1 min-w-0 flex flex-col" style={mapColH ? { height: mapColH } : undefined}>
          {/* Tab bar + city filter */}
          <div ref={tabHeaderRef} className="flex items-center gap-1 mb-1.5 min-w-0">
            {tabsCollapsed ? (
              <select
                value={listTab}
                onChange={e => setListTab(e.target.value as ListTab)}
                className="text-[11px] rounded border border-border bg-background text-foreground px-1.5 py-0.5 focus:outline-none focus:ring-1 focus:ring-ring shrink-0"
              >
                {ALL_TABS.map(t => <option key={t} value={t}>{TAB_LABELS[t]}</option>)}
              </select>
            ) : (
              ALL_TABS.map(t => (
                <button
                  key={t}
                  onClick={() => setListTab(t)}
                  className={`text-xs font-medium px-1 pb-0.5 border-b-2 transition-colors shrink-0 ${
                    listTab === t ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {TAB_LABELS[t]}
                </button>
              ))
            )}
            <button
              onClick={() => setShowModal(true)}
              className="p-0.5 text-muted-foreground/50 hover:text-primary transition-colors shrink-0"
              title="View all requests"
            >
              <ExternalLink className="h-3 w-3" />
            </button>
            {cityOptions.length > 0 && (
              <select
                value={selectedCity}
                onChange={e => setSelectedCity(e.target.value)}
                className="ml-auto text-[11px] rounded border border-border bg-background text-foreground px-1.5 py-0.5 min-w-0 max-w-[9rem] truncate focus:outline-none focus:ring-1 focus:ring-ring"
              >
                <option value="">All cities</option>
                {cityOptions.map(o => (
                  <option key={o.key} value={o.key}>{o.label}</option>
                ))}
              </select>
            )}
          </div>
          {/* List panel — hidden scrollbar, wheel-scrollable */}
          <div className="flex-1 min-h-0 rounded-lg border border-border bg-card px-3 py-2 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {listTab === 'requests' && (
              reqItems.length === 0
                ? <p className="text-xs text-muted-foreground text-center py-4">{selectedCity ? `No requests from ${selectedCity}` : 'No requests yet'}</p>
                : reqItems.map((req, i) => <RequestRow key={`${req.ts}-${i}`} req={req} onOpen={handleOpen} />)
            )}
            {listTab === 'topApps' && (
              topApps.length === 0
                ? <p className="text-xs text-muted-foreground text-center py-4">{selectedCity ? `No requests from ${selectedCity}` : 'No requests yet'}</p>
                : topApps.map(app => <TopAppRow key={app.appName} app={app} onOpen={handleOpen} />)
            )}
            {listTab === 'topUsers' && (
              topUsers.length === 0
                ? <p className="text-xs text-muted-foreground text-center py-4">{selectedCity ? `No requests from ${selectedCity}` : 'No users yet'}</p>
                : topUsers.map(user => <TopUserRow key={user.userId} user={user} />)
            )}
          </div>
        </div>
      </div>

      <AccessListModal
        open={showModal}
        onClose={() => setShowModal(false)}
        onOpenApp={onOpenModal}
      />
    </div>
  );
}
