import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { Download, PanelLeft, Upload } from 'lucide-react';
import { useSidebar } from '@/components/AppLayout';
import SubaccountsTable, { type SubaccountEntry, type RefreshProgress } from '@/components/config/SubaccountsTable';
import SubaccountDetailModal from '@/components/config/SubaccountDetailModal';
import TabsTable, { type TabEntry } from '@/components/config/TabsTable';

type Tab = 'subaccounts' | 'tabs' | 'menus' | 'settings' | 'changelog';
const VALID_TABS = new Set<Tab>(['subaccounts', 'tabs', 'menus', 'settings', 'changelog']);

export default function ConfigPage() {
  const { tab: tabParam } = useParams<{ tab: string }>();
  const navigate          = useNavigate();
  const { toggle }        = useSidebar();
  const activeTab: Tab    = VALID_TABS.has(tabParam as Tab) ? (tabParam as Tab) : 'subaccounts';

  // Subaccounts state
  const [sasData, setSasData]         = useState<SubaccountEntry[]>([]);
  const [originalSas, setOriginalSas] = useState<SubaccountEntry[]>([]);
  const [isSasDirty, setIsSasDirty]   = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isSavingSas, setIsSavingSas] = useState(false);
  const [refreshProgress, setRefreshProgress] = useState<RefreshProgress | null>(null);
  const [selectedSa, setSelectedSa]   = useState<SubaccountEntry | null>(null);
  const progressTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Tabs state
  const [tabsData, setTabsData]         = useState<TabEntry[]>([]);
  const [originalTabs, setOriginalTabs] = useState<TabEntry[]>([]);
  const [isTabsDirty, setIsTabsDirty]   = useState(false);
  const [isSavingTabs, setIsSavingTabs] = useState(false);
  const [tabsSaveStatus, setTabsSaveStatus] = useState<{ message: string; ok: boolean } | null>(null);
  const tabsSaveTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Changelog state (lazy-loaded on first visit)
  const [changelog, setChangelog]          = useState<string | null>(null);
  const [isLoadingChangelog, setIsLoadingCl] = useState(false);

  const [error, setError]           = useState('');
  const [isImporting, setIsImporting] = useState(false);
  const importRef = useRef<HTMLInputElement>(null);

  function fetchChangelog() {
    setIsLoadingCl(true);
    void fetch('/api/config/changelog')
      .then(r => r.text())
      .then(text => setChangelog(text))
      .catch(() => setChangelog(''))
      .finally(() => setIsLoadingCl(false));
  }

  useEffect(() => {
    if (activeTab === 'changelog' && changelog === null) fetchChangelog();
  }, [activeTab]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    void fetch('/api/config/subaccounts')
      .then(r => r.json() as Promise<{ ok: boolean; data: SubaccountEntry[] }>)
      .then(({ data }) => { setSasData(data); setOriginalSas(data); })
      .catch(() => setError('Failed to load subaccounts'));

    void fetch('/api/config/tabs')
      .then(r => r.json() as Promise<{ ok: boolean; data: TabEntry[] }>)
      .then(({ data }) => { setTabsData(data); setOriginalTabs(data); })
      .catch(() => setError('Failed to load tabs'));
  }, []);

  const configStateRef = useRef({ sasDirty: false, tabsDirty: false, busy: false, tab: 'subaccounts' as Tab });
  configStateRef.current = {
    sasDirty:  isSasDirty,
    tabsDirty: isTabsDirty,
    busy:      isRefreshing || isSavingSas || isSavingTabs || isImporting,
    tab:       activeTab,
  };

  useEffect(() => {
    const es = new EventSource('/api/events?config=1');
    es.addEventListener('update', (e) => {
      let data: Record<string, unknown> = {};
      try { data = JSON.parse((e as MessageEvent).data) as Record<string, unknown>; } catch { /* ignore */ }

      if (data.type === 'progress') {
        const pct = typeof data.pct === 'number' ? data.pct : 0;
        setRefreshProgress(prev => {
          if (prev?.error || prev?.warning) return prev;
          return { pct, message: String(data.message ?? ''), error: null };
        });
        return;
      }
      if (data.type === 'progress-error') {
        setRefreshProgress(prev => prev ? { ...prev, error: String(data.message ?? 'Refresh failed') } : null);
        return;
      }

      const { sasDirty, tabsDirty, busy, tab: curTab } = configStateRef.current;
      if (busy) return;
      if (!sasDirty) {
        void fetch('/api/config/subaccounts')
          .then(r => r.json() as Promise<{ ok: boolean; data: SubaccountEntry[] }>)
          .then(({ ok, data: d }) => { if (ok) { setSasData(d); setOriginalSas(d); } })
          .catch(() => {});
      }
      if (!tabsDirty) {
        void fetch('/api/config/tabs')
          .then(r => r.json() as Promise<{ ok: boolean; data: TabEntry[] }>)
          .then(({ ok, data: d }) => { if (ok) { setTabsData(d); setOriginalTabs(d); } })
          .catch(() => {});
      }
      if (curTab === 'changelog') fetchChangelog();
    });
    return () => es.close();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function goTab(t: Tab) { navigate(`/config/${t}`, { replace: true }); }

  function handleSasChange(data: SubaccountEntry[]) { setSasData(data); setIsSasDirty(true); }

  async function handleRefresh() {
    if (!window.confirm('Refresh will re-fetch subaccounts from BTP CLI / CF API and merge with local edits. Continue?')) return;
    clearTimeout(progressTimerRef.current);
    setIsRefreshing(true);
    setError('');
    setRefreshProgress({ pct: 0, message: 'Starting refresh…', error: null });
    try {
      const res  = await fetch('/api/config/subaccounts/refresh', { method: 'POST' });
      const json = await res.json() as { ok: boolean; data?: SubaccountEntry[]; warnings?: string[]; error?: string };
      if (!json.ok) throw new Error(json.error ?? 'Refresh failed');
      setSasData(json.data ?? []);
      setOriginalSas(json.data ?? []);
      setIsSasDirty(false);
      const warnings = json.warnings ?? [];
      if (warnings.length > 0) {
        setRefreshProgress({ pct: 100, message: warnings.join(' · '), error: null, warning: true });
      } else {
        progressTimerRef.current = setTimeout(
          () => setRefreshProgress(prev => (prev?.error || prev?.warning ? prev : null)),
          3000,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Refresh failed';
      setRefreshProgress({ pct: 100, message: msg, error: msg });
    } finally {
      setIsRefreshing(false);
    }
  }

  function handleSasReset() {
    if (isSasDirty && !window.confirm('Discard unsaved changes?')) return;
    setSasData(originalSas);
    setIsSasDirty(false);
    setError('');
    setRefreshProgress(null);
  }

  async function handleSasSave() {
    setIsSavingSas(true);
    try {
      const res  = await fetch('/api/config/subaccounts/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: sasData }),
      });
      const json = await res.json() as { ok: boolean; error?: string };
      if (!json.ok) throw new Error(json.error ?? 'Save failed');
      setOriginalSas(sasData);
      setIsSasDirty(false);
      clearTimeout(progressTimerRef.current);
      setRefreshProgress({ pct: 100, message: 'Saved successfully', error: null });
      progressTimerRef.current = setTimeout(
        () => setRefreshProgress(prev => (prev?.error || prev?.warning ? prev : null)),
        3000,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Save failed';
      setRefreshProgress({ pct: 100, message: msg, error: msg });
    } finally {
      setIsSavingSas(false);
    }
  }

  function handleTabsChange(data: TabEntry[]) { setTabsData(data); setIsTabsDirty(true); }

  function handleTabsReset() {
    if (isTabsDirty && !window.confirm('Discard unsaved changes?')) return;
    setTabsData(originalTabs);
    setIsTabsDirty(false);
    setError('');
    clearTimeout(tabsSaveTimerRef.current);
    setTabsSaveStatus(null);
  }

  async function handleTabsSave() {
    clearTimeout(tabsSaveTimerRef.current);
    setIsSavingTabs(true);
    try {
      const res  = await fetch('/api/config/tabs/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: tabsData }),
      });
      const json = await res.json() as { ok: boolean; error?: string };
      if (!json.ok) throw new Error(json.error ?? 'Save failed');
      setOriginalTabs(tabsData);
      setIsTabsDirty(false);
      setTabsSaveStatus({ message: 'Saved successfully', ok: true });
      tabsSaveTimerRef.current = setTimeout(() => setTabsSaveStatus(null), 3000);
    } catch (err) {
      setTabsSaveStatus({ message: err instanceof Error ? err.message : 'Save failed', ok: false });
    } finally {
      setIsSavingTabs(false);
    }
  }

  async function handleImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!window.confirm('Import will overwrite all local config files. Continue?')) {
      e.target.value = '';
      return;
    }
    setIsImporting(true);
    setError('');
    try {
      const text = await file.text();
      const data = JSON.parse(text) as Record<string, unknown>;
      const res  = await fetch('/api/config/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      const json = await res.json() as { ok: boolean; error?: string };
      if (!json.ok) throw new Error(json.error ?? 'Import failed');
      const [sasRes, tabsRes] = await Promise.all([
        fetch('/api/config/subaccounts').then(r => r.json() as Promise<{ ok: boolean; data: SubaccountEntry[] }>),
        fetch('/api/config/tabs').then(r => r.json() as Promise<{ ok: boolean; data: TabEntry[] }>),
      ]);
      setSasData(sasRes.data);  setOriginalSas(sasRes.data);  setIsSasDirty(false);
      setTabsData(tabsRes.data); setOriginalTabs(tabsRes.data); setIsTabsDirty(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setIsImporting(false);
      e.target.value = '';
    }
  }

  const tabCls = (t: Tab) =>
    `px-4 py-2 text-sm transition-colors border-b-2 ${
      activeTab === t
        ? 'border-primary text-foreground font-medium'
        : 'border-transparent text-muted-foreground hover:text-foreground'
    }`;

  const totalSas  = sasData.length;
  const totalGroups = tabsData.reduce((n, t) => n + t.groups.length, 0);

  return (
    <div className="flex flex-col h-full">
      {/* Title bar */}
      <div className="border-b border-border bg-background px-3 flex items-center gap-2 shrink-0 min-h-[52px]">
        <button onClick={toggle} className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors" title="Toggle sidebar">
          <PanelLeft className="h-4 w-4" />
        </button>
        <span className="text-sm font-semibold">Configuration</span>
        <div className="ml-auto flex items-center gap-1.5">
          {(() => {
            const btn = 'inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs font-medium border border-border hover:bg-accent hover:text-accent-foreground transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
            return (<>
              <input ref={importRef} type="file" accept=".json" className="hidden" onChange={handleImport} />
              <button
                onClick={() => importRef.current?.click()}
                disabled={isImporting}
                className={btn}
                title="Import combined-config.json — overwrites all local config files"
              >
                <Upload className="h-3.5 w-3.5" />
                {isImporting ? 'Importing…' : 'Import'}
              </button>
              <a
                href="/api/config/export"
                download="combined-config.json"
                className={btn}
                title="Export all config files as combined-config.json"
              >
                <Download className="h-3.5 w-3.5" />
                Export
              </a>
            </>);
          })()}
        </div>
      </div>

      {/* Tab bar */}
      <div className="flex items-center border-b border-border shrink-0 px-2">
        <button className={tabCls('subaccounts')} onClick={() => goTab('subaccounts')}>
          Subaccounts
          {totalSas > 0 && <span className="ml-1.5 text-[10px] text-muted-foreground">({totalSas})</span>}
        </button>
        <button className={tabCls('tabs')} onClick={() => goTab('tabs')}>
          Tabs
          {totalGroups > 0 && <span className="ml-1.5 text-[10px] text-muted-foreground">({totalGroups})</span>}
        </button>
        <button className={tabCls('menus')} onClick={() => goTab('menus')}>
          Menu
        </button>
        <button className={tabCls('settings')} onClick={() => goTab('settings')}>
          Settings
        </button>
        <button className={tabCls('changelog')} onClick={() => { if (changelog === null) fetchChangelog(); goTab('changelog'); }}>
          Change Log
        </button>
      </div>

      {/* Error banner — save / import / load errors only */}
      {error && (
        <div className="shrink-0 px-4 py-2 bg-destructive/10 text-destructive text-xs border-b border-destructive/20">
          {error}
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        {activeTab === 'subaccounts' && (
          <SubaccountsTable
            data={sasData}
            onChange={handleSasChange}
            isDirty={isSasDirty}
            onRefresh={handleRefresh}
            isRefreshing={isRefreshing}
            onReset={handleSasReset}
            isSaving={isSavingSas}
            onSave={handleSasSave}
            refreshProgress={refreshProgress}
            onOpenDetail={setSelectedSa}
          />
        )}
        {activeTab === 'tabs' && (
          <TabsTable
            data={tabsData}
            onChange={handleTabsChange}
            isDirty={isTabsDirty}
            isSaving={isSavingTabs}
            onReset={handleTabsReset}
            onSave={handleTabsSave}
            saveStatus={tabsSaveStatus}
          />
        )}
        {activeTab === 'menus' && (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Menu configuration — coming soon
          </div>
        )}
        {activeTab === 'settings' && (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Settings — coming soon
          </div>
        )}
        {activeTab === 'changelog' && (
          <div className="flex flex-col h-full">
            <div className="flex items-center gap-2 px-3 py-2 border-b border-border shrink-0">
              <span className="text-xs text-muted-foreground flex-1">Config change history — updated on Refresh / Save</span>
              <button
                onClick={fetchChangelog}
                disabled={isLoadingChangelog}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium border border-border hover:bg-accent hover:text-accent-foreground transition-colors disabled:opacity-50"
              >
                {isLoadingChangelog ? 'Loading…' : 'Reload'}
              </button>
            </div>
            <div className="flex-1 overflow-auto p-4">
              {isLoadingChangelog && changelog === null
                ? <p className="text-xs text-muted-foreground">Loading…</p>
                : changelog
                  ? <div className="font-mono text-xs leading-relaxed">{renderConfigChangelog(changelog)}</div>
                  : <p className="text-xs text-muted-foreground">No changes recorded yet.</p>
              }
            </div>
          </div>
        )}
      </div>

      {/* Subaccount detail modal */}
      <SubaccountDetailModal sa={selectedSa} onClose={() => setSelectedSa(null)} />
    </div>
  );
}

function renderConfigChangelog(text: string): React.ReactNode {
  return text.split('\n').map((line, i) => {
    if (line.startsWith('## ')) {
      return <div key={i} className="font-bold mt-4 mb-1 text-foreground first:mt-0">{line.slice(3)}</div>;
    }
    if (line.startsWith('+ ')) {
      return <div key={i} className="text-green-600 dark:text-green-400">{line}</div>;
    }
    if (line.startsWith('- ')) {
      return <div key={i} className="text-red-500 dark:text-red-400">{line}</div>;
    }
    if (line.startsWith('~ ')) {
      return <div key={i} className="text-amber-600 dark:text-amber-400">{line}</div>;
    }
    if (line.startsWith('    ')) {
      const arrowIdx = line.indexOf(' → ');
      if (arrowIdx !== -1) {
        return (
          <div key={i} className="pl-4">
            <span className="text-red-400/80">{line.slice(0, arrowIdx)}</span>
            <span className="text-muted-foreground"> → </span>
            <span className="text-green-500/80">{line.slice(arrowIdx + 3)}</span>
          </div>
        );
      }
      return <div key={i} className="pl-4 text-muted-foreground">{line}</div>;
    }
    return <div key={i} className="text-muted-foreground">{line || ' '}</div>;
  });
}
