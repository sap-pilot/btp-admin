import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { PanelLeft, Search, X } from 'lucide-react';
import { useSidebar, useSettings } from '@/components/AppLayout';
import HomepageContent, { matchesSaFilter, type HomepageData, type CockpitMenuItem } from '@/components/home/HomepageContent';
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
  const [filterQuery, setFilterQuery] = useState('');

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

  // Filter tabs to only those with at least one matching subaccount when query is active
  const visibleTabs = filterQuery
    ? tabs.filter(tab =>
        tab.sections.some(s => {
          if (s.type !== 'subaccountGroup') return false;
          const gid = (s as { groupId: string }).groupId;
          return subaccounts.some(
            sa => sa.inHomepage
              && sa.groupIds.split(',').map(g => g.trim()).some(g => g === gid)
              && matchesSaFilter(sa, filterQuery, mainSubscriptions),
          );
        })
      )
    : tabs;

  // If current active tab is filtered out, display the first visible tab instead
  const displayTab = visibleTabs.some(t => t.tab === activeTab)
    ? activeTab
    : (visibleTabs[0]?.tab ?? activeTab);

  const homepage: HomepageData | null = tabs.length
    ? { tabs: visibleTabs, subaccounts, cockpit, cockpitMenu, mainSubscriptions }
    : null;

  // Count matching subaccounts across ALL tabs (unique by SA)
  const allGroupIds = new Set(
    tabs.flatMap(t =>
      t.sections
        .filter(s => s.type === 'subaccountGroup')
        .map(s => (s as { groupId: string }).groupId),
    ),
  );
  const allTabSas = subaccounts.filter(
    sa => sa.inHomepage && [...allGroupIds].some(gid => sa.groupIds.split(',').map(g => g.trim()).includes(gid)),
  );
  const totalY = allTabSas.length;
  const matchX = filterQuery ? allTabSas.filter(sa => matchesSaFilter(sa, filterQuery, mainSubscriptions)).length : totalY;

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
        <div className="ml-auto flex items-center gap-3">
          {lastUpdated != null && (
            <span className="text-[11px] text-muted-foreground/60 shrink-0">
              Last updated at {new Date(lastUpdated).toLocaleString()}
            </span>
          )}
          {totalY > 0 && (
            <div className="relative flex items-center">
              <Search className="absolute left-2 h-3 w-3 text-muted-foreground/60 pointer-events-none" />
              <input
                type="text"
                value={filterQuery}
                onChange={e => setFilterQuery(e.target.value)}
                placeholder="Filter subaccounts…"
                className="h-7 pl-6 pr-[4.5rem] text-xs border border-border rounded bg-background text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-ring w-[200px]"
              />
              <div className="absolute right-1.5 flex items-center gap-0.5">
                {filterQuery && (
                  <button
                    onClick={() => setFilterQuery('')}
                    className="p-0.5 rounded hover:bg-accent text-muted-foreground/60 hover:text-foreground transition-colors"
                    title="Clear filter"
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
                <span className="text-[10px] text-muted-foreground/60 pointer-events-none whitespace-nowrap">
                  ({matchX}/{totalY})
                </span>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        {(loading || settings === null) && (
          <div className="flex items-center justify-center h-full text-sm text-muted-foreground">Loading…</div>
        )}
        {!loading && settings !== null && !homepage && (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-muted-foreground">
            <p className="text-sm">No tabs configured.</p>
            <p className="text-xs">Add tabs in <strong>Config → Tabs</strong>.</p>
          </div>
        )}
        {!loading && settings !== null && homepage && (
          <HomepageContent
            data={homepage}
            activeTab={displayTab}
            onTabChange={tab => navigate('/home/' + encodeURIComponent(tab), { replace: true })}
            filterQuery={filterQuery}
          />
        )}
      </div>
    </div>
  );
}
