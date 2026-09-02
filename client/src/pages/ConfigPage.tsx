import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams, useLocation } from 'react-router';
import { Building2, Clock, Download, Eye, Layers, PanelLeft, Search, Settings, Upload, X } from 'lucide-react';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useSidebar, useSettings } from '@/components/AppLayout';
import { useAuth } from '@/hooks/useAuth';
import SubaccountsTable, { type SubaccountEntry, type RefreshProgress } from '@/components/config/SubaccountsTable';
import SubaccountDetailModal from '@/components/SubaccountModal';
import TabsTable, { type TabEntry } from '@/components/config/TabsTable';
import SettingsPanel, { type SettingsData } from '@/components/config/SettingsPanel';
import HomePreviewPanel from '@/components/config/HomePreviewPanel';
import type { CockpitMenuItem } from '@/components/home/HomepageContent';

type Tab = 'subaccounts' | 'tabs' | 'settings' | 'changelog';
const VALID_TABS = new Set<Tab>(['subaccounts', 'tabs', 'settings', 'changelog']);

export default function ConfigPage() {
  const { tab: tabParam, region: regionParam, subdomain: subdomainParam } = useParams<{ tab?: string; region?: string; subdomain?: string }>();
  const navigate          = useNavigate();
  const location          = useLocation();
  const [searchParams]    = useSearchParams();
  const { toggle, collapsed } = useSidebar();
  const { refreshSettings } = useSettings();
  const { isAdmin }       = useAuth();
  const activeTab: Tab    = VALID_TABS.has(tabParam as Tab) ? (tabParam as Tab) : 'subaccounts';
  const initialSection    = searchParams.get('section') ?? undefined;

  // Subaccounts state
  const [sasData,        setSasData]       = useState<SubaccountEntry[]>([]);
  const [originalSas,    setOriginalSas]   = useState<SubaccountEntry[]>([]);
  const [isSasDirty,     setIsSasDirty]   = useState(false);
  const [isRefreshing,   setIsRefreshing] = useState(false);
  const [isSavingSas,    setIsSavingSas]  = useState(false);
  const [refreshProgress, setRefreshProgress] = useState<RefreshProgress | null>(null);
  const [selectedSa,     setSelectedSa]   = useState<SubaccountEntry | null>(null);
  const progressTimerRef  = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const autoOpenedRef     = useRef(false);

  const autoOpenTab: 'info' | 'services' | null = (() => {
    if (!regionParam || !subdomainParam) return null;
    if (location.pathname.startsWith('/subaccount/')) return 'info';
    if (location.pathname.startsWith('/services/')) return 'services';
    return null;
  })();

  // Tabs state
  const [tabsData,        setTabsData]        = useState<TabEntry[]>([]);
  const [originalTabs,    setOriginalTabs]    = useState<TabEntry[]>([]);
  const [isTabsDirty,     setIsTabsDirty]    = useState(false);
  const [isSavingTabs,    setIsSavingTabs]   = useState(false);
  const [tabsSaveStatus,  setTabsSaveStatus] = useState<{ message: string; ok: boolean } | null>(null);
  const tabsSaveTimerRef  = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Settings state
  const [settingsData,      setSettingsData]     = useState<SettingsData | null>(null);
  const [originalSettings,  setOriginalSettings] = useState<SettingsData | null>(null);
  const [isSettingsDirty,   setIsSettingsDirty]  = useState(false);
  const [isSavingSettings,  setIsSavingSettings] = useState(false);
  const [settingsSaveStatus, setSettingsSaveStatus] = useState<{ message: string; ok: boolean } | null>(null);
  const settingsSaveTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);


  // Changelog state (lazy-loaded)
  const [changelog,            setChangelog]        = useState<string | null>(null);
  const [isLoadingChangelog,   setIsLoadingCl]      = useState(false);
  const [archivedCls,          setArchivedCls]      = useState<string[]>([]);
  const [selectedChangelogFile, setSelectedChangelogFile] = useState<string | null>(null);
  const [clSearch,             setClSearch]         = useState('');
  const [clSearchResults,      setClSearchResults]  = useState<{ files: string[]; matchCount: number } | null>(null);
  const [clSearching,          setClSearching]      = useState(false);

  const [error,       setError]       = useState('');
  const [isImporting, setIsImporting] = useState(false);
  const importRef = useRef<HTMLInputElement>(null);

  // Confirmation dialogs
  const [showRefreshDialog,      setShowRefreshDialog]      = useState(false);
  const [showForceRefreshDialog, setShowForceRefreshDialog] = useState(false);
  const [showImportDialog,       setShowImportDialog]       = useState(false);
  const [importDialogBody,  setImportDialogBody]  = useState('');
  const [pendingImportData, setPendingImportData] = useState<Record<string, unknown> | null>(null);

  const [previewOpen,  setPreviewOpen]  = useState(false);
  const [previewWidth, setPreviewWidth] = useState(0);
  const [isDragging,   setIsDragging]   = useState(false);
  const [cockpitMenu,  setCockpitMenu]  = useState<CockpitMenuItem | null>(null);
  const dragRef  = useRef<{ startX: number; startW: number } | null>(null);
  const bodyRef  = useRef<HTMLDivElement>(null);

  function fetchChangelog(file: string | null = null) {
    setIsLoadingCl(true);
    const url = file
      ? `/api/config/changelog?file=${encodeURIComponent(file)}`
      : '/api/config/changelog';
    void fetch(url)
      .then(r => r.text())
      .then(text => setChangelog(text))
      .catch(() => setChangelog(''))
      .finally(() => setIsLoadingCl(false));
  }

  function fetchArchivedList() {
    void fetch('/api/config/changelogs')
      .then(r => r.json() as Promise<{ ok: boolean; files: string[] }>)
      .then(({ ok, files }) => { if (ok) setArchivedCls(files); })
      .catch(() => {});
  }

  function fetchSettings() {
    return fetch('/api/settings')
      .then(r => r.json() as Promise<{ ok: boolean; data: SettingsData }>)
      .then(({ data }) => { setSettingsData(data); setOriginalSettings(data); })
      .catch(() => setError('Failed to load settings'));
  }

  useEffect(() => {
    if (activeTab === 'changelog' && changelog === null) {
      fetchChangelog();
      fetchArchivedList();
    }
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

    void fetch('/api/config/cockpit-menu')
      .then(r => r.json() as Promise<CockpitMenuItem | null>)
      .then(menu => setCockpitMenu(menu))
      .catch(() => {});

    void fetchSettings();

  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-open modal for /subaccount/:region/:subdomain and /services/:region/:subdomain
  useEffect(() => {
    if (!autoOpenTab || !sasData.length || autoOpenedRef.current) return;
    const sa = sasData.find(s => s.region === regionParam && s.subdomain === subdomainParam);
    if (!sa) return;
    autoOpenedRef.current = true;
    setSelectedSa(sa);
  }, [sasData, autoOpenTab]); // eslint-disable-line react-hooks/exhaustive-deps

  const configStateRef = useRef({
    sasDirty: false, tabsDirty: false, settingsDirty: false,
    busy: false, tab: 'subaccounts' as Tab,
  });
  configStateRef.current = {
    sasDirty:      isSasDirty,
    tabsDirty:     isTabsDirty,
    settingsDirty: isSettingsDirty,
    busy:          isRefreshing || isSavingSas || isSavingTabs || isSavingSettings || isImporting,
    tab:           activeTab,
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

      const { sasDirty, tabsDirty, settingsDirty, busy, tab: curTab } = configStateRef.current;
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
      if (!settingsDirty) {
        void fetchSettings();
      }
      if (curTab === 'changelog') { fetchChangelog(); fetchArchivedList(); }
    });
    return () => es.close();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function goTab(t: Tab) { navigate(`/config/${t}`, { replace: true }); }

  // ── Subaccounts handlers ──────────────────────────────────────────────────────

  function handleSasChange(data: SubaccountEntry[]) { setSasData(data); setIsSasDirty(true); }

  async function handleRefresh(force = false) {
    setShowRefreshDialog(false);
    setShowForceRefreshDialog(false);
    clearTimeout(progressTimerRef.current);
    setIsRefreshing(true);
    setError('');
    setRefreshProgress({ pct: 0, message: 'Starting refresh…', error: null });
    try {
      const url  = force ? '/api/config/subaccounts/refresh?force=true' : '/api/config/subaccounts/refresh';
      const res  = await fetch(url, { method: 'POST' });
      const json = await res.json() as { ok: boolean; busy?: boolean; data?: SubaccountEntry[]; warnings?: string[]; error?: string };
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
      setRefreshProgress({ pct: 100, message: 'Saved', error: null });
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

  // ── Tabs handlers ─────────────────────────────────────────────────────────────

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
      setTabsSaveStatus({ message: 'Saved!', ok: true });
      tabsSaveTimerRef.current = setTimeout(() => setTabsSaveStatus(null), 3000);
    } catch (err) {
      setTabsSaveStatus({ message: err instanceof Error ? err.message : 'Save failed', ok: false });
    } finally {
      setIsSavingTabs(false);
    }
  }

  // ── Settings handlers ─────────────────────────────────────────────────────────

  function handleSettingsChange(data: SettingsData) {
    setSettingsData(data);
    setIsSettingsDirty(true);
  }

  function handleSettingsReset() {
    if (isSettingsDirty && !window.confirm('Discard unsaved changes?')) return;
    setSettingsData(originalSettings);
    setIsSettingsDirty(false);
  }

  async function handleSpaceSave(region: string, subdomain: string, spaces: { spaceId: string; manageDest: boolean; aod: boolean }[]) {
    const res = await fetch(`/api/config/subaccounts/${encodeURIComponent(region)}/${encodeURIComponent(subdomain)}/spaces`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ spaces }),
    });
    if (!res.ok) throw new Error(`Failed to save space settings: ${res.status}`);
    const json = await res.json() as { ok: boolean; data?: SubaccountEntry };
    if (json.data) {
      setSasData(prev => prev.map(sa =>
        sa.region === json.data!.region && sa.subdomain === json.data!.subdomain ? json.data! : sa,
      ));
      setSelectedSa(json.data);
    }
  }

  async function handleSettingsSave() {
    if (!settingsData) return;
    clearTimeout(settingsSaveTimerRef.current);
    setIsSavingSettings(true);
    try {
      const res  = await fetch('/api/settings/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: settingsData }),
      });
      const json = await res.json() as { ok: boolean; error?: string };
      if (!json.ok) throw new Error(json.error ?? 'Save failed');
      setOriginalSettings(settingsData);
      setIsSettingsDirty(false);
      refreshSettings();
      setSettingsSaveStatus({ message: 'New settings saved', ok: true });
      settingsSaveTimerRef.current = setTimeout(() => setSettingsSaveStatus(null), 3000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Save failed';
      setSettingsSaveStatus({ message: `Settings not saved due to error: ${msg}`, ok: false });
    } finally {
      setIsSavingSettings(false);
    }
  }

  // ── Import/Export ─────────────────────────────────────────────────────────────

  async function handleImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';

    let data: Record<string, unknown>;
    try {
      data = JSON.parse(await file.text()) as Record<string, unknown>;
    } catch {
      setError('Invalid JSON file');
      return;
    }

    const hasSubaccounts = Array.isArray(data['subaccounts']);
    const hasTabs        = Array.isArray(data['tabs']);
    const hasSettings    = !!data['settings'] && typeof data['settings'] === 'object' && !Array.isArray(data['settings']);
    if (!hasSubaccounts && !hasTabs && !hasSettings) {
      setError('Import file contains no recognised config keys (subaccounts, tabs, settings)');
      return;
    }

    // Build a summary of what the import contains and what will be cleared
    const lines: string[] = ['All three local config files will be completely replaced:'];
    if (hasSubaccounts) {
      lines.push(`• Subaccounts: ${(data['subaccounts'] as unknown[]).length} entries`);
    } else {
      lines.push('• Subaccounts: not in file — will be cleared');
    }
    if (hasTabs) {
      const tabs = data['tabs'] as Array<{ sections?: unknown[] }>;
      const totalSections = tabs.reduce((n, t) => n + (Array.isArray(t.sections) ? t.sections.length : 0), 0);
      lines.push(`• Tabs: ${tabs.length} tabs / ${totalSections} sections`);
    } else {
      lines.push('• Tabs: not in file — will be cleared');
    }
    if (hasSettings) {
      lines.push('• Settings: homepage + menus');
    } else {
      lines.push('• Settings: not in file — will be reset to defaults');
    }

    setImportDialogBody(lines.join('\n'));
    setPendingImportData(data);
    setShowImportDialog(true);
  }

  async function doImport(data: Record<string, unknown>) {
    setShowImportDialog(false);
    setPendingImportData(null);
    setIsImporting(true);
    setError('');
    try {
      const res  = await fetch('/api/config/import', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(data),
      });
      const json = await res.json() as { ok: boolean; error?: string };
      if (!json.ok) throw new Error(json.error ?? 'Import failed');

      // Reload all affected data
      const [sasRes, tabsRes] = await Promise.all([
        fetch('/api/config/subaccounts').then(r => r.json() as Promise<{ ok: boolean; data: SubaccountEntry[] }>),
        fetch('/api/config/tabs').then(r => r.json() as Promise<{ ok: boolean; data: TabEntry[] }>),
      ]);
      if (sasRes.ok)  { setSasData(sasRes.data);   setOriginalSas(sasRes.data);   setIsSasDirty(false); }
      if (tabsRes.ok) { setTabsData(tabsRes.data);  setOriginalTabs(tabsRes.data); setIsTabsDirty(false); }
      void fetchSettings(); setIsSettingsDirty(false); refreshSettings();
      if (activeTab === 'changelog') fetchChangelog();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setIsImporting(false);
    }
  }

  // ── Preview drag ─────────────────────────────────────────────────────────────

  function handlePreviewToggle() {
    if (!previewOpen && previewWidth === 0) {
      setPreviewWidth(Math.round((bodyRef.current?.offsetWidth ?? 840) / 2));
    }
    setPreviewOpen(o => !o);
  }

  function handleDragStart(e: React.MouseEvent) {
    e.preventDefault();
    const containerW = bodyRef.current?.offsetWidth ?? 1200;
    dragRef.current = { startX: e.clientX, startW: previewWidth };
    setIsDragging(true);

    function onMove(me: MouseEvent) {
      if (!dragRef.current) return;
      const next = Math.max(120, Math.min(containerW - 5, dragRef.current.startW + (dragRef.current.startX - me.clientX)));
      setPreviewWidth(next);
    }

    function onUp() {
      dragRef.current = null;
      setIsDragging(false);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    }

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  // ── Render ────────────────────────────────────────────────────────────────────

  const tabCls = (t: Tab) =>
    `flex items-center gap-1.5 px-2.5 sm:px-4 py-2 text-sm transition-colors border-b-2 ${
      activeTab === t
        ? 'border-primary text-foreground font-medium'
        : 'border-transparent text-muted-foreground hover:text-foreground'
    }`;

  const totalSas    = sasData.length;
  const totalGroups = tabsData.reduce((n, t) => n + t.sections.length, 0);

  return (
    <div className="flex flex-col h-full">
      {/* Title bar */}
      <div className="border-b border-border bg-background px-3 flex items-center gap-2 shrink-0 min-h-[52px]">
        <button onClick={toggle} className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors" title="Toggle sidebar">
          <PanelLeft className="h-4 w-4" />
        </button>
        <span className={`text-sm font-semibold${!collapsed ? ' hidden sm:block' : ''}`}>Configuration</span>
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
                <span className="hidden sm:inline">{isImporting ? 'Importing…' : 'Import'}</span>
              </button>
              <a
                href="/api/config/export"
                download="combined-config.json"
                className={btn}
                title="Export all config files as combined-config.json"
              >
                <Download className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Export</span>
              </a>
              <button
                onClick={handlePreviewToggle}
                className={`${btn} ${previewOpen ? 'bg-primary/10 border-primary/40 text-primary hover:bg-primary/15 hover:text-primary' : ''}`}
                title="Toggle home page preview panel"
              >
                <Eye className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Preview</span>
              </button>
            </>);
          })()}
        </div>
      </div>

      {/* Body: config left + preview right */}
      <div ref={bodyRef} className={`flex flex-1 min-h-0${isDragging ? ' select-none' : ''}`}>
      <div className="flex flex-col flex-1 min-w-0 min-h-0">

      {/* Tab bar */}
      <div className="flex items-center border-b border-border shrink-0 px-2">
        <button className={tabCls('subaccounts')} onClick={() => goTab('subaccounts')} title="Subaccounts">
          <Building2 className="h-3.5 w-3.5 sm:hidden" />
          <span className="hidden sm:inline">Subaccounts</span>
          {totalSas > 0 && <span className="hidden sm:inline text-[10px] text-muted-foreground">({totalSas})</span>}
        </button>
        <button className={tabCls('tabs')} onClick={() => goTab('tabs')} title="Tabs">
          <Layers className="h-3.5 w-3.5 sm:hidden" />
          <span className="hidden sm:inline">Tabs</span>
          {totalGroups > 0 && <span className="hidden sm:inline text-[10px] text-muted-foreground">({totalGroups})</span>}
        </button>
        <button className={tabCls('settings')} onClick={() => goTab('settings')} title="Settings">
          <Settings className="h-3.5 w-3.5 sm:hidden" />
          <span className="hidden sm:inline">Settings</span>
        </button>
        <button className={tabCls('changelog')} onClick={() => { if (changelog === null) { fetchChangelog(); fetchArchivedList(); } goTab('changelog'); }} title="History">
          <Clock className="h-3.5 w-3.5 sm:hidden" />
          <span className="hidden sm:inline">History</span>
        </button>
      </div>

      {/* Error banner */}
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
            onRefresh={() => isRefreshing ? setShowForceRefreshDialog(true) : setShowRefreshDialog(true)}
            isRefreshing={isRefreshing}
            onReset={handleSasReset}
            isSaving={isSavingSas}
            onSave={handleSasSave}
            refreshProgress={refreshProgress}
            onDismissProgress={() => setRefreshProgress(null)}
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
        {activeTab === 'settings' && settingsData && (
          <SettingsPanel
            data={settingsData}
            onChange={handleSettingsChange}
            isDirty={isSettingsDirty}
            isSaving={isSavingSettings}
            onReset={handleSettingsReset}
            onSave={() => void handleSettingsSave()}
            saveStatus={settingsSaveStatus}
            initialSection={initialSection}
          />
        )}
        {activeTab === 'settings' && !settingsData && (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Loading…</div>
        )}
        {activeTab === 'changelog' && (
          <div className="flex flex-col h-full">
            <div className="flex items-center gap-2 px-3 py-2 border-b border-border shrink-0">
              <div className="relative flex-1">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
                <input
                  type="text"
                  value={clSearch}
                  onChange={e => setClSearch(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && clSearch.trim()) {
                      setClSearching(true);
                      fetch(`/api/config/changelog/search?q=${encodeURIComponent(clSearch.trim())}`)
                        .then(r => r.json() as Promise<{ ok: boolean; files: string[]; matchCount: number }>)
                        .then(data => {
                          if (!data.ok) return;
                          setClSearchResults(data);
                          if (data.files.length === 1) {
                            const f = data.files[0]!;
                            setSelectedChangelogFile(f || null);
                            fetchChangelog(f || null);
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
                const selectFiles = clSearchResults ? clSearchResults.files : archivedCls.length > 0 ? ['', ...archivedCls] : null;
                return selectFiles && selectFiles.length > 1 ? (
                  <select
                    value={selectedChangelogFile ?? ''}
                    onChange={e => {
                      const val = e.target.value || null;
                      setSelectedChangelogFile(val);
                      fetchChangelog(val);
                    }}
                    className="h-7 px-2 text-xs border border-border rounded bg-background text-foreground outline-none focus:ring-1 focus:ring-ring"
                    title="Browse changelogs"
                  >
                    {selectFiles.map(f => (
                      <option key={f} value={f}>{f || 'Current'}</option>
                    ))}
                  </select>
                ) : null;
              })()}
              <button
                onClick={() => fetchChangelog(selectedChangelogFile)}
                disabled={isLoadingChangelog || clSearching}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium border border-border hover:bg-accent hover:text-accent-foreground transition-colors disabled:opacity-50"
              >
                {isLoadingChangelog || clSearching ? 'Loading…' : 'Reload'}
              </button>
            </div>
            <div className="flex-1 overflow-auto p-4">
              {isLoadingChangelog && changelog === null
                ? <p className="text-xs text-muted-foreground">Loading…</p>
                : changelog
                  ? <div className="font-mono text-xs leading-relaxed">{renderConfigChangelog(changelog, clSearch && clSearchResults ? clSearch : undefined)}</div>
                  : <p className="text-xs text-muted-foreground">No changes recorded yet.</p>
              }
            </div>
          </div>
        )}
      </div>

      </div>
      {previewOpen && (
        <>
          <div
            className={`w-[5px] shrink-0 cursor-col-resize transition-colors ${isDragging ? 'bg-primary/25' : 'hover:bg-primary/20'}`}
            onMouseDown={handleDragStart}
          />
          <div style={{ width: previewWidth }} className="shrink-0 flex flex-col min-h-0 overflow-hidden">
            <HomePreviewPanel
              tabs={tabsData}
              subaccounts={sasData}
              settings={settingsData}
              cockpitMenu={cockpitMenu}
            />
          </div>
        </>
      )}
      </div>

      {/* Subaccount detail modal */}
      <SubaccountDetailModal
        sa={selectedSa}
        onClose={() => setSelectedSa(null)}
        initialTab={autoOpenTab ?? undefined}
        cockpit={settingsData?.homepage.cockpit}
        cockpitMenu={cockpitMenu}
        isAdmin={isAdmin}
        onSpaceSave={handleSpaceSave}
        subaccounts={sasData}
        onSelectSubaccount={setSelectedSa}
        tabs={tabsData}
      />

      {/* Subaccounts refresh confirm dialog */}
      <AlertDialog open={showRefreshDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Refresh all subaccounts?</AlertDialogTitle>
            <AlertDialogDescription>
              This will re-fetch subaccount data from SAP BTP and CF API, then merge it with your local config matched by subaccount ID. User-editable fields (alias, group IDs, position, homepage/destinations/AOD flags) are preserved; all other fields are updated from the API. Are you certain?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setShowRefreshDialog(false)}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void handleRefresh()}>Yes, proceed</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Force subaccounts refresh dialog */}
      <AlertDialog open={showForceRefreshDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Subaccount refresh already in progress</AlertDialogTitle>
            <AlertDialogDescription>
              A subaccount refresh is already running. Would you like to force another refresh on top of it?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setShowForceRefreshDialog(false)}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void handleRefresh(true)}>Yes, force another subaccount refresh</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Import confirm dialog */}
      <AlertDialog open={showImportDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Replace all local configuration?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-1.5 text-sm">
                {importDialogBody.split('\n').map((line, i) => (
                  <p key={i} className="text-muted-foreground">{line}</p>
                ))}
                <p className="text-muted-foreground pt-1">All changes will be diffed and recorded in the Change Log. This cannot be undone.</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => { setShowImportDialog(false); setPendingImportData(null); }}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => { if (pendingImportData) void doImport(pendingImportData); }}>Yes, replace all</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function highlightText(text: string, query: string): React.ReactNode {
  if (!query) return text;
  const parts = text.split(new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'));
  return parts.map((p, i) =>
    p.toLowerCase() === query.toLowerCase()
      ? <mark key={i} className="bg-yellow-300/70 dark:bg-yellow-600/60 text-inherit rounded-sm">{p}</mark>
      : p
  );
}

function renderConfigChangelog(text: string, highlight?: string): React.ReactNode {
  const hl = (s: string) => highlight ? highlightText(s, highlight) : s;
  return text.split('\n').map((line, i) => {
    if (line.startsWith('## ')) {
      return <div key={i} className="font-bold mt-4 mb-1 text-foreground first:mt-0">{hl(line.slice(3))}</div>;
    }
    if (line.startsWith('+ ')) return <div key={i} className="text-green-600 dark:text-green-400">{hl(line)}</div>;
    if (line.startsWith('- ')) return <div key={i} className="text-red-500 dark:text-red-400">{hl(line)}</div>;
    if (line.startsWith('~ ')) return <div key={i} className="text-amber-600 dark:text-amber-400">{hl(line)}</div>;
    if (line.startsWith('    ')) {
      const arrowIdx = line.indexOf(' → ');
      if (arrowIdx !== -1) {
        return (
          <div key={i} className="pl-4">
            <span className="text-red-400/80">{hl(line.slice(0, arrowIdx))}</span>
            <span className="text-muted-foreground"> → </span>
            <span className="text-green-500/80">{hl(line.slice(arrowIdx + 3))}</span>
          </div>
        );
      }
      return <div key={i} className="pl-4 text-muted-foreground">{hl(line)}</div>;
    }
    return <div key={i} className="text-muted-foreground">{hl(line) || ' '}</div>;
  });
}
