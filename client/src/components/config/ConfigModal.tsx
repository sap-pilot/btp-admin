import { useEffect, useState } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import SubaccountsTable, { type SubaccountEntry } from './SubaccountsTable';
import SubaccountDetailModal from './SubaccountDetailModal';
import TabsTable, { type TabEntry } from './TabsTable';

interface Props {
  open: boolean;
  onClose: () => void;
}

type Tab = 'subaccounts' | 'tabs';

export default function ConfigModal({ open, onClose }: Props) {
  const [activeTab, setActiveTab] = useState<Tab>('subaccounts');

  // Subaccounts state
  const [sasData, setSasData]             = useState<SubaccountEntry[]>([]);
  const [originalSas, setOriginalSas]     = useState<SubaccountEntry[]>([]);
  const [isSasDirty, setIsSasDirty]       = useState(false);
  const [isRefreshing, setIsRefreshing]   = useState(false);
  const [isSavingSas, setIsSavingSas]     = useState(false);
  const [selectedSa, setSelectedSa]       = useState<SubaccountEntry | null>(null);
  const [refreshWarnings, setRefreshWarnings] = useState<string[]>([]);

  // Tabs state
  const [tabsData, setTabsData]           = useState<TabEntry[]>([]);
  const [originalTabs, setOriginalTabs]   = useState<TabEntry[]>([]);
  const [isTabsDirty, setIsTabsDirty]     = useState(false);
  const [isSavingTabs, setIsSavingTabs]   = useState(false);

  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setActiveTab('subaccounts');
    setIsSasDirty(false);
    setIsTabsDirty(false);
    setError('');

    void fetch('/api/config/subaccounts')
      .then(r => r.json() as Promise<{ ok: boolean; data: SubaccountEntry[] }>)
      .then(({ data }) => { setSasData(data); setOriginalSas(data); })
      .catch(() => setError('Failed to load subaccounts'));

    void fetch('/api/config/tabs')
      .then(r => r.json() as Promise<{ ok: boolean; data: TabEntry[] }>)
      .then(({ data }) => { setTabsData(data); setOriginalTabs(data); })
      .catch(() => setError('Failed to load tabs'));
  }, [open]);

  function handleSasChange(data: SubaccountEntry[]) { setSasData(data); setIsSasDirty(true); }

  async function handleRefresh() {
    if (!window.confirm('Refresh will re-fetch subaccounts from BTP CLI / CF API and merge with local edits. Continue?')) return;
    setIsRefreshing(true);
    setError('');
    try {
      const res  = await fetch('/api/config/subaccounts/refresh', { method: 'POST' });
      const json = await res.json() as { ok: boolean; data?: SubaccountEntry[]; warnings?: string[]; error?: string };
      if (!json.ok) throw new Error(json.error ?? 'Refresh failed');
      setSasData(json.data ?? []);
      setOriginalSas(json.data ?? []);
      setIsSasDirty(false);
      setRefreshWarnings(json.warnings ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Refresh failed');
    } finally {
      setIsRefreshing(false);
    }
  }

  function handleSasReset() {
    if (isSasDirty && !window.confirm('Discard unsaved changes?')) return;
    setSasData(originalSas);
    setIsSasDirty(false);
    setError('');
    setRefreshWarnings([]);
  }

  async function handleSasSave() {
    setIsSavingSas(true);
    setError('');
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
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
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
  }

  async function handleTabsSave() {
    setIsSavingTabs(true);
    setError('');
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
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setIsSavingTabs(false);
    }
  }

  function handleClose() {
    if ((isSasDirty || isTabsDirty) && !window.confirm('You have unsaved changes. Close anyway?')) return;
    onClose();
  }

  const tabCls = (t: Tab) =>
    `px-4 py-2 text-sm transition-colors border-b-2 ${
      activeTab === t
        ? 'border-primary text-foreground font-medium'
        : 'border-transparent text-muted-foreground hover:text-foreground'
    }`;

  const totalSas    = sasData.length;
  const totalGroups = tabsData.reduce((n, t) => n + t.sections.length, 0);

  return (
    <DialogPrimitive.Root open={open} onOpenChange={v => { if (!v) handleClose(); }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <DialogPrimitive.Content
          className="fixed inset-4 z-50 flex flex-col bg-background rounded-lg shadow-xl outline-none overflow-hidden"
          onInteractOutside={e => e.preventDefault()}
          onEscapeKeyDown={handleClose}
          aria-describedby={undefined}
        >
          {/* Top bar */}
          <div className="flex items-center justify-between border-b border-border shrink-0 px-2">
            <div className="flex items-center">
              <button className={tabCls('subaccounts')} onClick={() => setActiveTab('subaccounts')}>
                Subaccounts
                {totalSas > 0 && <span className="ml-1.5 text-[10px] text-muted-foreground">({totalSas})</span>}
              </button>
              <button className={tabCls('tabs')} onClick={() => setActiveTab('tabs')}>
                Tabs / Groups
                {totalGroups > 0 && <span className="ml-1.5 text-[10px] text-muted-foreground">({totalGroups})</span>}
              </button>
            </div>
            <div className="flex items-center px-2 py-2">
              <DialogPrimitive.Title className="sr-only">Configuration</DialogPrimitive.Title>
              <DialogPrimitive.Close asChild>
                <button
                  onClick={handleClose}
                  className="p-1.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
                  title="Close"
                >
                  <X className="h-4 w-4" />
                </button>
              </DialogPrimitive.Close>
            </div>
          </div>

          {/* Error banner */}
          {error && (
            <div className="shrink-0 px-4 py-2 bg-destructive/10 text-destructive text-xs border-b border-destructive/20">
              {error}
            </div>
          )}
          {refreshWarnings.length > 0 && (
            <div className="shrink-0 px-4 py-2 bg-yellow-500/10 text-yellow-700 dark:text-yellow-400 text-xs border-b border-yellow-500/20">
              {refreshWarnings.map((w, i) => <p key={i}>{w}</p>)}
            </div>
          )}

          {/* Body */}
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
                refreshProgress={null}
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
              />
            )}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>

      {/* Subaccount detail modal (layered above ConfigModal) */}
      <SubaccountDetailModal sa={selectedSa} onClose={() => setSelectedSa(null)} />
    </DialogPrimitive.Root>
  );
}
