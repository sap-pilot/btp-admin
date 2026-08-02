import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { PanelLeft } from 'lucide-react';
import { useSidebar, useSettings } from '@/components/AppLayout';
import HomepageContent, { type HomepageData, type CockpitMenuItem } from '@/components/home/HomepageContent';
import type { TabEntry } from '@/components/config/TabsTable';
import type { SubaccountEntry } from '@/components/config/SubaccountsTable';

export default function Home() {
  const { toggle }    = useSidebar();
  const navigate      = useNavigate();
  const { tab: tabParam } = useParams<{ tab?: string }>();
  const { settings }  = useSettings();

  const [tabs,        setTabs]        = useState<TabEntry[]>([]);
  const [subaccounts, setSubaccounts] = useState<SubaccountEntry[]>([]);
  const [cockpitMenu, setCockpitMenu] = useState<CockpitMenuItem | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [loading,     setLoading]     = useState(true);

  const loadingRef = useRef(true);

  const fetchData = useCallback(() => {
    void Promise.all([
      fetch('/api/config/tabs').then(r => r.json() as Promise<{ ok: boolean; data: TabEntry[] }>),
      fetch('/api/config/subaccounts').then(r => r.json() as Promise<{ ok: boolean; data: SubaccountEntry[] }>),
      fetch('/api/config/cockpit-menu').then(r => r.json() as Promise<CockpitMenuItem | null>),
      fetch('/api/config/last-updated').then(r => r.json() as Promise<{ ok: boolean; ts: number | null }>),
    ]).then(([tabsRes, sasRes, menuRes, luRes]) => {
      if (tabsRes.ok)  setTabs(tabsRes.data);
      if (sasRes.ok)   setSubaccounts(sasRes.data);
      setCockpitMenu(menuRes);
      if (luRes.ok && luRes.ts != null) setLastUpdated(luRes.ts);
    }).catch(() => null)
      .finally(() => {
        if (loadingRef.current) { loadingRef.current = false; setLoading(false); }
      });
  }, []);

  useEffect(() => {
    fetchData();
    const es = new EventSource('/api/events?config=1');
    es.addEventListener('update', fetchData);
    return () => es.close();
  }, [fetchData]);

  // Keep URL in sync with first available tab
  useEffect(() => {
    if (!tabs.length) return;
    const urlTab = tabParam ? decodeURIComponent(tabParam) : '';
    const valid  = tabs.some(t => t.tab === urlTab);
    if (!valid) navigate('/home/' + encodeURIComponent(tabs[0].tab), { replace: true });
  }, [tabs, tabParam, navigate]);

  const urlTab    = tabParam ? decodeURIComponent(tabParam) : '';
  const activeTab = tabs.some(t => t.tab === urlTab) ? urlTab : (tabs[0]?.tab ?? '');

  const cockpit           = settings?.homepage.cockpit ?? { idp: '', host: '' };
  const mainSubscriptions = settings?.homepage.mainSubscriptions ?? [];

  const homepage: HomepageData | null = tabs.length
    ? { tabs, subaccounts, cockpit, cockpitMenu, mainSubscriptions }
    : null;

  return (
    <div className="flex flex-col h-full bg-background text-foreground">
      <div className="flex items-center gap-2 border-b border-border px-3 min-h-[52px] shrink-0">
        <button
          onClick={toggle}
          className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
          title="Toggle sidebar"
        >
          <PanelLeft className="h-4 w-4" />
        </button>
        <span className="text-sm font-medium">Home</span>
        {lastUpdated != null && (
          <span className="ml-auto text-[11px] text-muted-foreground/60">
            Last updated at {new Date(lastUpdated).toLocaleString()}
          </span>
        )}
      </div>

      <div className="flex-1 overflow-auto">
        {loading && (
          <div className="flex items-center justify-center h-full text-sm text-muted-foreground">Loading…</div>
        )}
        {!loading && !homepage && (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-muted-foreground">
            <p className="text-sm">No tabs configured.</p>
            <p className="text-xs">Add tabs in <strong>Config → Tabs</strong>.</p>
          </div>
        )}
        {!loading && homepage && (
          <HomepageContent
            data={homepage}
            activeTab={activeTab}
            onTabChange={tab => navigate('/home/' + encodeURIComponent(tab), { replace: true })}
          />
        )}
      </div>
    </div>
  );
}
