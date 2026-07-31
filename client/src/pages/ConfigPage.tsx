import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { Download, PanelLeft, Upload } from 'lucide-react';
import { useSidebar } from '@/components/AppLayout';
import OrgsTable, { type OrgRegion } from '@/components/config/OrgsTable';
import DirsTable, { type DirTab } from '@/components/config/DirsTable';

type Tab = 'orgs' | 'dirs' | 'systems' | 'menus' | 'links';
const VALID_TABS = new Set<Tab>(['orgs', 'dirs', 'systems', 'menus', 'links']);

export default function ConfigPage() {
  const { tab: tabParam } = useParams<{ tab: string }>();
  const navigate          = useNavigate();
  const { toggle }        = useSidebar();
  const activeTab: Tab    = VALID_TABS.has(tabParam as Tab) ? (tabParam as Tab) : 'orgs';

  // Orgs state
  const [orgsData, setOrgsData]         = useState<OrgRegion[]>([]);
  const [originalOrgs, setOriginalOrgs] = useState<OrgRegion[]>([]);
  const [isOrgsDirty, setIsOrgsDirty]   = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isSavingOrgs, setIsSavingOrgs] = useState(false);

  // Dirs state
  const [dirsData, setDirsData]         = useState<DirTab[]>([]);
  const [originalDirs, setOriginalDirs] = useState<DirTab[]>([]);
  const [isDirsDirty, setIsDirsDirty]   = useState(false);
  const [isSavingDirs, setIsSavingDirs] = useState(false);

  const [error, setError]       = useState('');
  const [isImporting, setIsImporting] = useState(false);
  const importRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void fetch('/api/config/orgs')
      .then(r => r.json() as Promise<{ ok: boolean; data: OrgRegion[] }>)
      .then(({ data }) => { setOrgsData(data); setOriginalOrgs(data); })
      .catch(() => setError('Failed to load orgs'));

    void fetch('/api/config/dirs')
      .then(r => r.json() as Promise<{ ok: boolean; data: DirTab[] }>)
      .then(({ data }) => { setDirsData(data); setOriginalDirs(data); })
      .catch(() => setError('Failed to load dirs'));
  }, []);

  // Track latest dirty/busy state in a ref so the SSE handler can read it without re-subscribing
  const configStateRef = useRef({ orgsDirty: false, dirsDirty: false, busy: false });
  configStateRef.current = {
    orgsDirty: isOrgsDirty,
    dirsDirty: isDirsDirty,
    busy: isRefreshing || isSavingOrgs || isSavingDirs || isImporting,
  };

  useEffect(() => {
    const es = new EventSource('/api/events?config=1');
    es.addEventListener('update', () => {
      const { orgsDirty, dirsDirty, busy } = configStateRef.current;
      if (busy) return;
      if (!orgsDirty) {
        void fetch('/api/config/orgs')
          .then(r => r.json() as Promise<{ ok: boolean; data: OrgRegion[] }>)
          .then(({ ok, data }) => { if (ok) { setOrgsData(data); setOriginalOrgs(data); } })
          .catch(() => {});
      }
      if (!dirsDirty) {
        void fetch('/api/config/dirs')
          .then(r => r.json() as Promise<{ ok: boolean; data: DirTab[] }>)
          .then(({ ok, data }) => { if (ok) { setDirsData(data); setOriginalDirs(data); } })
          .catch(() => {});
      }
    });
    return () => es.close();
  }, []);

  function goTab(t: Tab) { navigate(`/config/${t}`, { replace: true }); }

  function handleOrgsChange(data: OrgRegion[]) { setOrgsData(data); setIsOrgsDirty(true); }

  async function handleRefresh() {
    if (!window.confirm('Refresh will re-fetch orgs from CF API and merge with local edits. Continue?')) return;
    setIsRefreshing(true);
    setError('');
    try {
      const res  = await fetch('/api/config/orgs/refresh', { method: 'POST' });
      const json = await res.json() as { ok: boolean; data?: OrgRegion[]; error?: string };
      if (!json.ok) throw new Error(json.error ?? 'Refresh failed');
      setOrgsData(json.data ?? []);
      setOriginalOrgs(json.data ?? []);
      setIsOrgsDirty(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Refresh failed');
    } finally {
      setIsRefreshing(false);
    }
  }

  function handleOrgsReset() {
    if (isOrgsDirty && !window.confirm('Discard unsaved changes?')) return;
    setOrgsData(originalOrgs);
    setIsOrgsDirty(false);
    setError('');
  }

  async function handleOrgsSave() {
    setIsSavingOrgs(true);
    setError('');
    try {
      const res  = await fetch('/api/config/orgs/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: orgsData }),
      });
      const json = await res.json() as { ok: boolean; error?: string };
      if (!json.ok) throw new Error(json.error ?? 'Save failed');
      setOriginalOrgs(orgsData);
      setIsOrgsDirty(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setIsSavingOrgs(false);
    }
  }

  function handleDirsChange(data: DirTab[]) { setDirsData(data); setIsDirsDirty(true); }

  function handleDirsReset() {
    if (isDirsDirty && !window.confirm('Discard unsaved changes?')) return;
    setDirsData(originalDirs);
    setIsDirsDirty(false);
    setError('');
  }

  async function handleDirsSave() {
    setIsSavingDirs(true);
    setError('');
    try {
      const res  = await fetch('/api/config/dirs/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: dirsData }),
      });
      const json = await res.json() as { ok: boolean; error?: string };
      if (!json.ok) throw new Error(json.error ?? 'Save failed');
      setOriginalDirs(dirsData);
      setIsDirsDirty(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setIsSavingDirs(false);
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
      const [orgsRes, dirsRes] = await Promise.all([
        fetch('/api/config/orgs').then(r => r.json() as Promise<{ ok: boolean; data: OrgRegion[] }>),
        fetch('/api/config/dirs').then(r => r.json() as Promise<{ ok: boolean; data: DirTab[] }>),
      ]);
      setOrgsData(orgsRes.data); setOriginalOrgs(orgsRes.data); setIsOrgsDirty(false);
      setDirsData(dirsRes.data); setOriginalDirs(dirsRes.data); setIsDirsDirty(false);
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

  const totalOrgs = orgsData.reduce((n, r) => n + r.orgs.length, 0);
  const totalDirs = dirsData.reduce((n, t) => n + t.dirs.length, 0);

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
        <button className={tabCls('orgs')} onClick={() => goTab('orgs')}>
          Orgs
          {totalOrgs > 0 && <span className="ml-1.5 text-[10px] text-muted-foreground">({totalOrgs})</span>}
        </button>
        <button className={tabCls('dirs')} onClick={() => goTab('dirs')}>
          Tabs / Dirs
          {totalDirs > 0 && <span className="ml-1.5 text-[10px] text-muted-foreground">({totalDirs})</span>}
        </button>
        <button className={tabCls('systems')} onClick={() => goTab('systems')}>
          Other Systems
        </button>
        <button className={tabCls('menus')} onClick={() => goTab('menus')}>
          Menus
        </button>
        <button className={tabCls('links')} onClick={() => goTab('links')}>
          Link Templates
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
        {activeTab === 'orgs' && (
          <OrgsTable
            data={orgsData}
            onChange={handleOrgsChange}
            isDirty={isOrgsDirty}
            onRefresh={handleRefresh}
            isRefreshing={isRefreshing}
            onReset={handleOrgsReset}
            isSaving={isSavingOrgs}
            onSave={handleOrgsSave}
          />
        )}
        {activeTab === 'dirs' && (
          <DirsTable
            data={dirsData}
            onChange={handleDirsChange}
            isDirty={isDirsDirty}
            isSaving={isSavingDirs}
            onReset={handleDirsReset}
            onSave={handleDirsSave}
          />
        )}
        {(activeTab === 'systems' || activeTab === 'menus' || activeTab === 'links') && (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Under construction
          </div>
        )}
      </div>
    </div>
  );
}
