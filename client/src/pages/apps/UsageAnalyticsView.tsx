import { useCallback, useEffect, useRef, useState } from 'react';
import WorldMap from './WorldMap';

// ─── Types (mirrored from aodAnalyticsService) ────────────────────────────────

interface AnalyticsCity    { city: string; lat: number; lon: number; count: number; }
interface AnalyticsRequest { ts: number; region: string; alias: string; subdomain: string; userId: string; appName?: string; spaceName?: string; appGuid?: string; }
interface AnalyticsPayload {
  totalRequests: number; uniqueUsers: number; startedAppsGb: number; startedAppsCount: number;
  requestedAppsCount: number; latestRequestTs: number;
  lastUpdated: number; duration: number;
  cities: AnalyticsCity[]; latestRequests: AnalyticsRequest[];
}

// SSE delta from analytics-update event
interface AnalyticsUpdateMsg {
  type:    'analytics-update';
  request: AnalyticsRequest;
  city?:   { city: string; lat: number; lon: number };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtTime(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

function fmtLatestRequest(ts: number): string {
  if (!ts) return '—';
  return new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
}

const geoKey = (lat: number, lon: number) => `${lat.toFixed(2)},${lon.toFixed(2)}`;

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
  isDarkMap?:     boolean;
  durationHours:  number;
  onOpenModal?:   (region: string, subdomain: string, appGuid: string, spaceName?: string, appName?: string) => void;
}

export default function UsageAnalyticsView({ isDarkMap, durationHours, onOpenModal }: Props) {
  const [data,    setData]    = useState<AnalyticsPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState<string | null>(null);
  const [liveReqs, setLiveReqs] = useState<AnalyticsRequest[]>([]);
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

          // Increment totalRequests + apply city delta
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
        }
      } catch { /* ignore parse errors */ }
    });

    return () => { es.close(); esRef.current = null; };
  }, [durationHours, fetchAnalytics]);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-6 p-6">

      {/* Info blocks */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <InfoBlock
          label={`Requests (last ${durationHours >= 168 ? '7 days' : durationHours >= 48 ? `${durationHours / 24} days` : '24 hrs'})`}
          value={loading ? '…' : (data?.totalRequests.toLocaleString() ?? '—')}
          accent="text-orange-500"
        />
        <InfoBlock
          label={`Requested Apps (last ${durationHours >= 168 ? '7 days' : durationHours >= 48 ? `${durationHours / 24} days` : '24 hrs'})`}
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

    </div>
  );
}
