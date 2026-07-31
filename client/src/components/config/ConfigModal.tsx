import { useEffect, useState } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import OrgsTable, { type OrgEntry } from './OrgsTable';
import DirsTable, { type DirTab } from './DirsTable';

interface Props {
  open: boolean;
  onClose: () => void;
}

type Tab = 'orgs' | 'dirs' | 'menus';

export default function ConfigModal({ open, onClose }: Props) {
  const [activeTab, setActiveTab]         = useState<Tab>('orgs');

  // Orgs state
  const [orgsData, setOrgsData]           = useState<OrgEntry[]>([]);
  const [originalOrgs, setOriginalOrgs]   = useState<OrgEntry[]>([]);
  const [isOrgsDirty, setIsOrgsDirty]     = useState(false);
  const [isRefreshing, setIsRefreshing]   = useState(false);
  const [isSavingOrgs, setIsSavingOrgs]   = useState(false);

  // Dirs state
  const [dirsData, setDirsData]           = useState<DirTab[]>([]);
  const [originalDirs, setOriginalDirs]   = useState<DirTab[]>([]);
  const [isDirsDirty, setIsDirsDirty]     = useState(false);
  const [isSavingDirs, setIsSavingDirs]   = useState(false);

  const [error, setError]                 = useState('');

  useEffect(() => {
    if (!open) return;
    setActiveTab('orgs');
    setIsOrgsDirty(false);
    setIsDirsDirty(false);
    setError('');

    void fetch('/api/config/orgs')
      .then(r => r.json() as Promise<{ ok: boolean; data: OrgEntry[] }>)
      .then(({ data }) => { setOrgsData(data); setOriginalOrgs(data); })
      .catch(() => setError('Failed to load orgs'));

    void fetch('/api/config/dirs')
      .then(r => r.json() as Promise<{ ok: boolean; data: DirTab[] }>)
      .then(({ data }) => { setDirsData(data); setOriginalDirs(data); })
      .catch(() => setError('Failed to load dirs'));
  }, [open]);

  function handleOrgsChange(data: OrgEntry[]) { setOrgsData(data); setIsOrgsDirty(true); }

  async function handleRefresh() {
    if (!window.confirm('Refresh will re-fetch orgs from CF API and merge with local edits. Continue?')) return;
    setIsRefreshing(true);
    setError('');
    try {
      const res  = await fetch('/api/config/orgs/refresh', { method: 'POST' });
      const json = await res.json() as { ok: boolean; data?: OrgEntry[]; error?: string };
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

  function handleClose() {
    if ((isOrgsDirty || isDirsDirty) && !window.confirm('You have unsaved changes. Close anyway?')) return;
    onClose();
  }

  const tabCls = (t: Tab) =>
    `px-4 py-2 text-sm transition-colors border-b-2 ${
      activeTab === t
        ? 'border-primary text-foreground font-medium'
        : 'border-transparent text-muted-foreground hover:text-foreground'
    }`;

  const totalOrgs = orgsData.length;
  const totalDirs = dirsData.reduce((n, t) => n + t.dirs.length, 0);

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
          {/* Top bar: tabs + close only */}
          <div className="flex items-center justify-between border-b border-border shrink-0 px-2">
            <div className="flex items-center">
              <button className={tabCls('orgs')} onClick={() => setActiveTab('orgs')}>
                Subaccounts / Orgs
                {totalOrgs > 0 && <span className="ml-1.5 text-[10px] text-muted-foreground">({totalOrgs})</span>}
              </button>
              <button className={tabCls('dirs')} onClick={() => setActiveTab('dirs')}>
                Tabs / Directories
                {totalDirs > 0 && <span className="ml-1.5 text-[10px] text-muted-foreground">({totalDirs})</span>}
              </button>
              <button className={tabCls('menus')} onClick={() => setActiveTab('menus')}>
                Menu / Links
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

          {/* Body */}
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
            {activeTab === 'menus' && (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                Menu / Links configuration — coming soon
              </div>
            )}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
