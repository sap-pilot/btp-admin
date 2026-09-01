import { useEffect, useRef, useState } from 'react';
import {
  ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, CheckSquare, Copy, Download, Eye, EyeOff, GitCompare, Lock, PanelLeft, Plus, RefreshCw, RotateCcw, Save, Search, Square, Trash2, Upload, X,
} from 'lucide-react';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/useAuth';
import type { SubaccountEntry } from '@/components/config/SubaccountsTable';
import TestTab from './DestTestTab';

const enc = encodeURIComponent;

export interface SelectedDest {
  region:        string;
  subdomain:     string;
  name:          string;
  spaceName?:    string;
  instanceName?: string;
  instanceGuid?: string;
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface DestProp {
  key:         string;
  value:       string;
  isSensitive: boolean;
  revealed:    boolean;
}

interface DestSearchResult { name: string; matchField: string; matchValue: string; spaceName?: string; instanceName?: string; instanceGuid?: string }
type Tab        = 'properties' | 'changelog' | 'test';
type ImportTarget = { type: 'sa' } | { type: 'inst'; spaceName: string; instanceGuid: string; instanceName: string };

export interface DestTabProps {
  sa:                  SubaccountEntry;
  allNames?:           string[];
  initialName?:        string;
  initialTab?:         Tab;
  initialShowList?:    boolean;
  initialSpaceName?:   string;
  initialInstName?:    string;
  initialInstGuid?:    string;
  selectedDests?:      SelectedDest[];
  onToggleCompare?:    (d: SelectedDest) => void;
  onOpenCompare?:      (dests: SelectedDest[]) => void;
  onDestDataChange?:   () => void;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const REDACTED    = '***';
const FIELD_ORDER = ['Description', 'Type', 'URL', 'Authentication', 'User', 'Password', 'sap-client', 'ProxyType', 'ProxyHost', 'ProxyPort'];

const DEFAULT_CREATE_PROPS: DestProp[] = [
  { key: 'Description',    value: '', isSensitive: false, revealed: false },
  { key: 'Type',           value: '', isSensitive: false, revealed: false },
  { key: 'URL',            value: '', isSensitive: false, revealed: false },
  { key: 'Authentication', value: '', isSensitive: false, revealed: false },
  { key: 'User',           value: '', isSensitive: false, revealed: false },
  { key: 'Password',       value: '', isSensitive: true,  revealed: false },
];

function isSensitive(key: string): boolean {
  const k = key.toLowerCase();
  return k.includes('secret') || k.includes('password') || k.includes('passwd') || k.includes('credential');
}

function toProps(data: Record<string, unknown>, sensitiveFields: string[]): DestProp[] {
  const sensitiveSet = new Set(sensitiveFields);
  const entries = Object.entries(data).filter(([k]) => k !== 'Name');
  const ordered: [string, unknown][] = [];
  for (const k of FIELD_ORDER) {
    const e = entries.find(([key]) => key === k);
    if (e) ordered.push(e);
  }
  for (const e of entries) {
    if (!FIELD_ORDER.includes(e[0])) ordered.push(e);
  }
  return ordered.map(([key, value]) => ({
    key,
    value:       String(value ?? ''),
    isSensitive: sensitiveSet.has(key),
    revealed:    false,
  }));
}

function fromProps(name: string, props: DestProp[]): Record<string, unknown> {
  const result: Record<string, unknown> = { Name: name };
  for (const p of props) if (p.key.trim()) result[p.key.trim()] = p.value;
  return result;
}

// ─── Shared properties table ──────────────────────────────────────────────────

interface DestPropsTableProps {
  props:    DestProp[];
  onUpdate: (idx: number, patch: Partial<DestProp>) => void;
  onDelete: (idx: number) => void;
  onAdd:    () => void;
}

function DestPropsTable({ props, onUpdate, onDelete, onAdd }: DestPropsTableProps) {
  return (
    <div className="flex-1 overflow-auto px-4">
      <table className="w-full border-collapse text-xs" style={{ tableLayout: 'fixed' }}>
        <colgroup>
          <col style={{ width: '200px' }} />
          <col />
          <col style={{ width: '36px' }} />
        </colgroup>
        <thead className="sticky top-0 z-10">
          <tr className="bg-muted/40">
            <th className="px-3 py-2 text-left font-medium text-muted-foreground border-b border-border whitespace-nowrap">Property</th>
            <th className="px-3 py-2 text-left font-medium text-muted-foreground border-b border-border">Value</th>
            <th className="border-b border-border" />
          </tr>
        </thead>
        <tbody>
          {props.map((prop, idx) => (
            <tr key={idx} className="hover:bg-muted/20 group">
              <td className="px-3 py-1.5 border-b border-border align-middle">
                <div className="flex items-center gap-1.5">
                  {prop.isSensitive && <Lock className="h-3 w-3 text-amber-500 shrink-0" />}
                  <input
                    className="w-full bg-transparent outline-none border-b border-transparent hover:border-border focus:border-primary py-0.5 font-mono placeholder:text-muted-foreground/40"
                    value={prop.key}
                    onChange={e => {
                      const k = e.target.value;
                      onUpdate(idx, { key: k, isSensitive: isSensitive(k) });
                    }}
                    placeholder="property"
                  />
                </div>
              </td>
              <td className="px-3 py-1.5 border-b border-border align-middle">
                <div className="flex items-center gap-1">
                  {prop.isSensitive ? (
                    <>
                      <input
                        type={prop.revealed ? 'text' : 'password'}
                        className="flex-1 bg-transparent outline-none border-b border-transparent hover:border-border focus:border-primary py-0.5 font-mono placeholder:text-muted-foreground/40"
                        value={prop.value}
                        onChange={e => onUpdate(idx, { value: e.target.value })}
                        placeholder={REDACTED}
                      />
                      <button
                        onClick={() => onUpdate(idx, { revealed: !prop.revealed })}
                        className="shrink-0 text-muted-foreground hover:text-foreground p-0.5"
                        title={prop.revealed ? 'Hide' : 'Reveal'}
                      >
                        {prop.revealed ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                      </button>
                    </>
                  ) : (
                    <input
                      className="w-full bg-transparent outline-none border-b border-transparent hover:border-border focus:border-primary py-0.5 font-mono placeholder:text-muted-foreground/40"
                      value={prop.value}
                      onChange={e => onUpdate(idx, { value: e.target.value })}
                      placeholder="value"
                    />
                  )}
                </div>
              </td>
              <td className="px-1 py-1.5 border-b border-border align-middle text-center">
                <button
                  onClick={() => onDelete(idx)}
                  className="text-muted-foreground/40 hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity p-0.5"
                  title="Delete property"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="py-2">
        <button onClick={onAdd} className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors">
          <Plus className="h-3.5 w-3.5" />
          Add property
        </button>
      </div>
    </div>
  );
}

// ─── PropertiesTab ────────────────────────────────────────────────────────────

interface SaveBanner { type: 'success' | 'error'; message: string }

interface PropsTabProps {
  name:          string;
  props:         DestProp[];
  loading:       boolean;
  banner:        SaveBanner | null;
  onUpdate:      (idx: number, patch: Partial<DestProp>) => void;
  onDelete:      (idx: number) => void;
  onAdd:         () => void;
  onClearBanner: () => void;
}

function PropertiesTab({
  name, props, loading, banner,
  onUpdate, onDelete, onAdd, onClearBanner,
}: PropsTabProps) {
  return (
    <div className="flex flex-col h-full">
      {banner && (
        <div className={`px-4 py-1.5 text-xs flex items-center gap-2 border-b shrink-0 ${
          banner.type === 'success'
            ? 'bg-green-500/10 border-green-500/20 text-green-600 dark:text-green-400'
            : 'bg-destructive/5 border-destructive/20 text-destructive'
        }`}>
          <span className="flex-1">{banner.message}</span>
          {banner.type === 'error' && (
            <button onClick={onClearBanner} className="shrink-0 text-destructive/60 hover:text-destructive">
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      )}

      {loading && (
        <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground">Loading…</div>
      )}
      {!loading && !name && (
        <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground">
          Select a destination from the list
        </div>
      )}
      {!loading && name && (
        <DestPropsTable props={props} onUpdate={onUpdate} onDelete={onDelete} onAdd={onAdd} />
      )}
    </div>
  );
}

// ─── CreateTab ────────────────────────────────────────────────────────────────

interface CreateTabProps {
  name:         string;
  props:        DestProp[];
  saving:       boolean;
  error:        string;
  onNameChange: (name: string) => void;
  onUpdate:     (idx: number, patch: Partial<DestProp>) => void;
  onDelete:     (idx: number) => void;
  onAdd:        () => void;
  onSave:       () => void;
  onCancel:     () => void;
}

function CreateTab({ name, props, saving, error, onNameChange, onUpdate, onDelete, onAdd, onSave, onCancel }: CreateTabProps) {
  const btnBase    = 'inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
  const btnOutline = `${btnBase} hover:bg-accent hover:text-accent-foreground`;
  const btnPrimary = `${btnBase} bg-primary text-primary-foreground hover:bg-primary/90`;

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar: name input | Cancel | Create Destination */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border shrink-0">
        <input
          autoFocus
          value={name}
          onChange={e => onNameChange(e.target.value)}
          placeholder="Destination name (e.g. API_S4_HTTP_001)"
          className="flex-1 min-w-0 text-sm font-mono bg-transparent border-b border-border focus:border-primary outline-none py-0.5 placeholder:text-muted-foreground/40"
        />
        <div className="flex items-center gap-1.5 shrink-0">
          <button onClick={onCancel} disabled={saving} className={btnOutline}>Cancel</button>
          <button onClick={onSave} disabled={!name.trim() || saving} className={btnPrimary}>
            <Plus className="h-3.5 w-3.5" />
            {saving ? 'Creating…' : 'Create Destination'}
          </button>
        </div>
      </div>

      {error && (
        <div className="px-4 py-1.5 text-xs text-destructive border-b border-destructive/20 bg-destructive/5 shrink-0">
          {error}
        </div>
      )}

      <DestPropsTable props={props} onUpdate={onUpdate} onDelete={onDelete} onAdd={onAdd} />
    </div>
  );
}

// ─── ChangelogTab ─────────────────────────────────────────────────────────────

function renderDestChangelog(text: string): React.ReactNode {
  return text.split('\n').map((line, i) => {
    if (line.startsWith('## ')) {
      return <div key={i} className="font-bold mt-4 mb-1 text-foreground first:mt-0">{line.slice(3)}</div>;
    }
    if (line.startsWith('- ')) {
      const body     = line.slice(2);
      const colonIdx = body.indexOf(': ');
      if (colonIdx !== -1) {
        const key      = body.slice(0, colonIdx);
        const rest     = body.slice(colonIdx + 2);
        const arrowIdx = rest.indexOf(' → ');
        if (arrowIdx !== -1) {
          return (
            <div key={i} className="pl-1">
              <span className="text-muted-foreground">- {key}: </span>
              <span className="text-red-500 dark:text-red-400">{rest.slice(0, arrowIdx)}</span>
              <span className="text-muted-foreground"> → </span>
              <span className="text-green-600 dark:text-green-400">{rest.slice(arrowIdx + 3)}</span>
            </div>
          );
        }
      }
      return <div key={i} className="text-muted-foreground pl-1">{line}</div>;
    }
    return <div key={i} className="text-muted-foreground">{line || ' '}</div>;
  });
}

function ChangelogTab({ changelog, loading }: { changelog: string; loading: boolean }) {
  if (loading) return <div className="flex items-center justify-center h-full text-xs text-muted-foreground">Loading…</div>;
  if (!changelog) return <div className="flex items-center justify-center h-full text-xs text-muted-foreground">No change history yet.</div>;
  return (
    <div className="h-full overflow-auto p-4">
      <div className="font-mono text-xs leading-relaxed">{renderDestChangelog(changelog)}</div>
    </div>
  );
}

// ─── getImportTargets ─────────────────────────────────────────────────────────

function getImportTargets(
  treeSelectedKeys: Set<string>,
  spaceInstances: Map<string, Array<{ instanceGuid: string; instanceName: string }>>,
  sa: SubaccountEntry,
): ImportTarget[] {
  const result: ImportTarget[] = [];
  const hasSa   = treeSelectedKeys.size === 0 || treeSelectedKeys.has('sa:root');
  const hasInst = [...treeSelectedKeys].some(k => k.startsWith('space:') || k.startsWith('inst:'));
  if (hasSa || !hasInst) result.push({ type: 'sa' });
  const seenGuids = new Set<string>();
  for (const key of treeSelectedKeys) {
    if (key.startsWith('inst:')) {
      const guid = key.slice(5);
      if (seenGuids.has(guid)) continue; seenGuids.add(guid);
      let spaceName = ''; let instanceName = '';
      for (const [sid, insts] of spaceInstances) {
        const i = insts.find(x => x.instanceGuid === guid);
        if (i) { spaceName = (sa.org?.spaces ?? []).find(s => s.spaceId === sid)?.spaceName ?? ''; instanceName = i.instanceName; break; }
      }
      result.push({ type: 'inst', spaceName, instanceGuid: guid, instanceName });
    } else if (key.startsWith('space:')) {
      const sid = key.slice(6);
      const spaceName = (sa.org?.spaces ?? []).find(s => s.spaceId === sid)?.spaceName ?? '';
      for (const inst of spaceInstances.get(sid) ?? []) {
        if (seenGuids.has(inst.instanceGuid)) continue; seenGuids.add(inst.instanceGuid);
        result.push({ type: 'inst', spaceName, instanceGuid: inst.instanceGuid, instanceName: inst.instanceName });
      }
    }
  }
  return result;
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function DestTab({ sa, allNames = [], initialName, initialTab, initialSpaceName, initialInstName, initialInstGuid, selectedDests, onToggleCompare, onOpenCompare, onDestDataChange }: DestTabProps) {
  const auth     = useAuth();
  const username = auth.email || auth.firstName || 'admin';

  // Left panel
  const [localAllNames,    setLocalAllNames]    = useState<string[]>(allNames);
  const [searchQuery,      setSearchQuery]      = useState('');
  const [filteredNames,    setFilteredNames]    = useState<string[]>(allNames);
  const [matchedInstKeys,  setMatchedInstKeys]  = useState<Set<string> | null>(null);
  const [isSearching,      setIsSearching]      = useState(false);
  const [selectedName,  setSelectedName]  = useState(initialName ?? allNames[0] ?? '');
  const [selectedNames, setSelectedNames] = useState<Set<string>>(
    () => new Set(initialName ? [initialName] : allNames[0] ? [allNames[0]] : []),
  );
  const [lastClickName, setLastClickName] = useState(initialName ?? allNames[0] ?? '');

  // Right panel
  const [activeTab, setActiveTab] = useState<Tab>(initialTab ?? 'properties');

  // Properties (existing destination)
  const [serverProps, setServerProps] = useState<DestProp[]>([]);
  const [editedProps, setEditedProps] = useState<DestProp[]>([]);
  const [isLoading,   setIsLoading]   = useState(false);
  const [isSaving,    setIsSaving]    = useState(false);

  // Import dialog state
  const [importItems,      setImportItems]      = useState<Record<string, unknown>[]>([]);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [importProgress,   setImportProgress]   = useState<{ done: number; total: number; lastDest?: string; lastAction?: 'created' | 'updated' | 'error' } | null>(null);
  const [importSummary,    setImportSummary]     = useState<{ created: number; updated: number; errors: string[] } | null>(null);
  const isImportRunning = importProgress !== null && importSummary === null;

  // Delete dialog state
  const [deleteTargets,   setDeleteTargets]   = useState<DeleteTarget[]>([]);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteProgress,   setDeleteProgress]   = useState<{ done: number; total: number; lastName?: string } | null>(null);
  const [deleteSummary,    setDeleteSummary]     = useState<{ deleted: number; errors: string[] } | null>(null);

  // Left-panel visibility toggle
  const [showList, setShowList] = useState(true);

  // Space destination tree
  const hasSpaceDests = (sa.org?.spaces ?? []).some(s => s.manageDest);
  const [treeSelectedKeys,  setTreeSelectedKeys]  = useState<Set<string>>(new Set());
  const [lastTreeClickKey,  setLastTreeClickKey]  = useState<string>('');
  const [treeExpanded,      setTreeExpanded]      = useState<Set<string>>(new Set(['__sa__']));
  const [treeFilter,        setTreeFilter]        = useState('');
  const [instanceNames,     setInstanceNames]     = useState<Map<string, string[]>>(new Map());
  const [spaceInstances,    setSpaceInstances]    = useState<Map<string, Array<{ instanceGuid: string; instanceName: string }>>>(new Map());
  const [allInstancesLoaded, setAllInstancesLoaded] = useState(false);
  const [selectedDestKeys,  setSelectedDestKeys]  = useState<Set<string>>(new Set());
  const [lastClickDestKey,  setLastClickDestKey]  = useState<string>('');

  // Horizontal split (left panel width as % of total)
  const [splitPct,  setSplitPct]  = useState(40);
  // Vertical split within left panel (tree height as % of left panel)
  const [treeSplitPct, setTreeSplitPct] = useState(40);
  const bodyRef              = useRef<HTMLDivElement>(null);
  const splitResizeRef       = useRef<{ startX: number; startPct: number; containerW: number } | null>(null);
  const treeSplitResizeRef   = useRef<{ startY: number; startPct: number; containerH: number } | null>(null);

  function startSplitResize(e: React.MouseEvent) {
    e.preventDefault();
    if (!bodyRef.current) return;
    splitResizeRef.current = { startX: e.clientX, startPct: splitPct, containerW: bodyRef.current.offsetWidth };
    function onMove(ev: MouseEvent) {
      if (!splitResizeRef.current) return;
      const { startX, startPct, containerW } = splitResizeRef.current;
      const deltaPct = ((ev.clientX - startX) / containerW) * 100;
      setSplitPct(Math.min(75, Math.max(20, startPct + deltaPct)));
    }
    function onUp() {
      splitResizeRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  function startTreeSplitResize(e: React.MouseEvent) {
    e.preventDefault();
    const container = (e.target as HTMLElement).closest('.tree-split-container') as HTMLElement | null;
    if (!container) return;
    treeSplitResizeRef.current = { startY: e.clientY, startPct: treeSplitPct, containerH: container.offsetHeight };
    function onMove(ev: MouseEvent) {
      if (!treeSplitResizeRef.current) return;
      const { startY, startPct, containerH } = treeSplitResizeRef.current;
      const deltaPct = ((ev.clientY - startY) / containerH) * 100;
      setTreeSplitPct(Math.min(70, Math.max(15, startPct + deltaPct)));
    }
    function onUp() {
      treeSplitResizeRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  // Load all space instances from local store in one shot (keyed by spaceId from sa.spaces)
  async function loadAllSpaceInstances(force = false) {
    if (allInstancesLoaded && !force) return;
    try {
      const res  = await fetch(`/api/destinations/${enc(sa.region)}/${enc(sa.subdomain)}/spaces`);
      const json = await res.json() as { ok: boolean; data: Array<{ spaceName: string; instanceGuid: string; instanceName: string }> };
      if (!json.ok) return;
      const nameToId = new Map((sa.org?.spaces ?? []).map(s => [s.spaceName, s.spaceId]));
      const bySpace = new Map<string, Array<{ instanceGuid: string; instanceName: string }>>();
      for (const item of (json.data ?? [])) {
        const spaceId = nameToId.get(item.spaceName);
        if (!spaceId) continue;
        const arr = bySpace.get(spaceId) ?? [];
        arr.push({ instanceGuid: item.instanceGuid, instanceName: item.instanceName });
        bySpace.set(spaceId, arr);
      }
      setSpaceInstances(bySpace);
      setAllInstancesLoaded(true);
      for (const item of (json.data ?? [])) {
        void loadInstanceDestNames(item.instanceGuid, item.spaceName, force);
      }
    } catch { /* ignore */ }
  }

  async function loadInstanceDestNames(instanceGuid: string, spaceName: string, force = false) {
    if (!force && instanceNames.has(instanceGuid)) return;
    try {
      const res  = await fetch(`/api/destinations/${enc(sa.region)}/${enc(sa.subdomain)}/spaces/${enc(spaceName)}/instances/${enc(instanceGuid)}`);
      const json = await res.json() as { ok: boolean; names: string[] };
      if (json.ok) setInstanceNames(prev => new Map(prev).set(instanceGuid, json.names ?? []));
    } catch { /* ignore */ }
  }

  const [activeInstScope, setActiveInstScope] = useState<{ spaceName: string; instanceGuid: string; instanceName: string } | null>(
    initialInstGuid && initialSpaceName && initialInstName
      ? { spaceName: initialSpaceName, instanceGuid: initialInstGuid, instanceName: initialInstName }
      : null,
  );

  function loadInstDest(spaceName: string, instanceGuid: string, instanceName: string, name: string) {
    setActiveInstScope({ spaceName, instanceGuid, instanceName });
    setSelectedName(name);
    setSelectedNames(new Set([name]));
    setIsCreating(false);
    void loadInstDestData(spaceName, instanceGuid, name);
  }

  async function loadInstDestData(spaceName: string, instanceGuid: string, name: string) {
    setIsLoading(true);
    try {
      const res  = await fetch(`/api/destinations/${enc(sa.region)}/${enc(sa.subdomain)}/spaces/${enc(spaceName)}/instances/${enc(instanceGuid)}/${enc(name)}`);
      const json = await res.json() as { ok: boolean; data: Record<string, unknown>; sensitiveFields: string[] };
      if (json.ok) {
        const props = toProps(json.data, json.sensitiveFields);
        setServerProps(props);
        setEditedProps(structuredClone(props));
      }
    } catch { /* ignore */ } finally { setIsLoading(false); }
  }

  // Create mode (new destination from scratch)
  const [isCreating,    setIsCreating]    = useState(false);
  const [newName,       setNewName]       = useState('');
  const [newProps,      setNewProps]      = useState<DestProp[]>(() => structuredClone(DEFAULT_CREATE_PROPS));
  const [isCreatingSave, setIsCreatingSave] = useState(false);
  const [createError,   setCreateError]   = useState('');
  const [createScope,   setCreateScope]   = useState<{ spaceName: string; instanceGuid: string; instanceName: string } | null>(null);

  // Changelog
  const [changelog,          setChangelog]          = useState('');
  const [isLoadingChangelog, setIsLoadingChangelog] = useState(false);

  // Per-subaccount refresh progress
  type SubProgress = { type: 'refreshing' | 'done' | 'error'; created?: number; updated?: number; deleted?: number; received?: number; errors?: string[]; current?: number; total?: number; progressName?: string };
  const [subProgress, setSubProgress] = useState<SubProgress | null>(null);
  const subProgressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Save banner
  const [saveBanner,     setSaveBanner]     = useState<SaveBanner | null>(null);
  const bannerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const listRef      = useRef<HTMLDivElement>(null);
  const isDirty      = JSON.stringify(editedProps) !== JSON.stringify(serverProps);

  // Load destination on primary selection change
  useEffect(() => {
    if (!selectedName) return;
    void loadDest(selectedName);
    if (activeTab === 'changelog') void loadChangelog(selectedName);
  }, [selectedName]); // eslint-disable-line react-hooks/exhaustive-deps

  // Scroll selected item into view on mount (for deep-link / search-result opens)
  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>('[data-selected="true"]');
    el?.scrollIntoView({ block: 'nearest' });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Enter-triggered full-text search scoped to this subdomain
  async function runSearch(q: string) {
    if (!q.trim()) { setFilteredNames(localAllNames); setMatchedInstKeys(null); return; }
    setIsSearching(true);
    try {
      const url = `/api/destinations/search?q=${encodeURIComponent(q.trim())}&region=${encodeURIComponent(sa.region)}&subdomain=${encodeURIComponent(sa.subdomain)}`;
      const res  = await fetch(url);
      const json = await res.json() as { ok: boolean; data: DestSearchResult[] };
      if (json.ok) {
        const saMatched   = new Set(json.data.filter(r => !r.spaceName).map(r => r.name));
        const instMatched = new Set(json.data.filter(r => r.spaceName && r.instanceGuid).map(r => `${r.instanceGuid}/${r.name}`));
        setFilteredNames(localAllNames.filter(n => saMatched.has(n)));
        setMatchedInstKeys(instMatched);
      }
    } catch { /* ignore */ } finally { setIsSearching(false); }
  }

  // Sync browser URL with selected destination and active tab
  useEffect(() => {
    if (!selectedName) return;
    const tabSuffix = activeTab === 'changelog' ? '/history' : activeTab === 'test' ? '/test' : '';
    const base = `/destinations/${encodeURIComponent(sa.region)}/${encodeURIComponent(sa.subdomain)}`;
    const path = activeInstScope
      ? `${base}/${encodeURIComponent(activeInstScope.spaceName)}/${encodeURIComponent(activeInstScope.instanceName)}/${encodeURIComponent(activeInstScope.instanceGuid)}/${encodeURIComponent(selectedName)}${tabSuffix}`
      : `${base}/${encodeURIComponent(selectedName)}${tabSuffix}`;
    history.replaceState(null, '', path);
  }, [selectedName, activeTab, activeInstScope, sa.region, sa.subdomain]);

  // Proactive destination load — re-runs when SA changes, resets state and loads fresh data
  useEffect(() => {
    setLocalAllNames(allNames);
    setSearchQuery('');
    setFilteredNames(allNames);
    setMatchedInstKeys(null);
    setSelectedName(initialName ?? allNames[0] ?? '');
    setSelectedNames(new Set(initialName ? [initialName] : allNames[0] ? [allNames[0]] : []));
    setLastClickName(initialName ?? allNames[0] ?? '');
    setActiveTab(initialTab ?? 'properties');
    setServerProps([]);
    setEditedProps([]);
    setSubProgress(null);
    setSaveBanner(null);
    setActiveInstScope(
      initialInstGuid && initialSpaceName && initialInstName
        ? { spaceName: initialSpaceName, instanceGuid: initialInstGuid, instanceName: initialInstName }
        : null,
    );
    setIsCreating(false);
    setNewName('');
    setNewProps(structuredClone(DEFAULT_CREATE_PROPS));
    setChangelog('');
    setTreeSelectedKeys(new Set());
    setLastTreeClickKey('');
    setTreeExpanded(new Set(['__sa__']));
    setSpaceInstances(new Map());
    setInstanceNames(new Map());
    setAllInstancesLoaded(false);
    setSelectedDestKeys(new Set());

    void (async () => {
      try {
        const res  = await fetch(`/api/destinations/${enc(sa.region)}/${enc(sa.subdomain)}`);
        const json = await res.json() as { ok: boolean; names: string[]; refreshed: boolean; errors: string[]; created?: number; updated?: number; deleted?: number; received?: number };
        if (!json.ok) {
          setSubProgress({ type: 'error', errors: json.errors?.length ? json.errors : ['Failed to load destinations'] });
          return;
        }
        if (json.names.length > 0) { setLocalAllNames(json.names); setFilteredNames(json.names); }
        if (json.refreshed) {
          if (json.errors?.length) {
            setSubProgress({ type: 'error', errors: json.errors });
          } else {
            setSubProgress({ type: 'done', created: json.created ?? 0, updated: json.updated ?? 0, deleted: json.deleted ?? 0, received: json.received });
            subProgressTimerRef.current = setTimeout(() => setSubProgress(null), 3000);
          }
        }
      } catch (err) {
        setSubProgress({ type: 'error', errors: [String(err)] });
      }
    })();

    const currentHasSpaceDests = (sa.org?.spaces ?? []).some(s => s.manageDest);
    if (currentHasSpaceDests) void loadAllSpaceInstances(true);
  }, [sa.region, sa.subdomain]); // eslint-disable-line react-hooks/exhaustive-deps

  // When opened with an initial instance dest (from deep-link or global search click):
  // once spaceInstances are loaded, select the instance node in the tree + load the dest content.
  useEffect(() => {
    if (!initialInstGuid || !initialSpaceName || !initialName) return;
    if (!allInstancesLoaded) return;
    setTreeSelectedKeys(new Set([`inst:${initialInstGuid}`]));
    setLastTreeClickKey(`inst:${initialInstGuid}`);
    const space = (sa.org?.spaces ?? []).find(s => s.spaceName === initialSpaceName);
    if (space) setTreeExpanded(prev => new Set([...prev, space.spaceId]));
    void loadInstDestData(initialSpaceName, initialInstGuid, initialName);
  }, [allInstancesLoaded]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    for (const key of treeSelectedKeys) {
      if (!key.startsWith('inst:')) continue;
      const instanceGuid = key.slice(5);
      if (instanceNames.has(instanceGuid)) continue;
      for (const [spaceId, insts] of spaceInstances) {
        const inst = insts.find(i => i.instanceGuid === instanceGuid);
        if (inst) {
          const space = (sa.org?.spaces ?? []).find(s => s.spaceId === spaceId);
          if (space) void loadInstanceDestNames(instanceGuid, space.spaceName);
          break;
        }
      }
    }
    for (const key of treeSelectedKeys) {
      if (!key.startsWith('space:')) continue;
      const spaceId = key.slice(6);
      const insts = spaceInstances.get(spaceId) ?? [];
      const space = (sa.org?.spaces ?? []).find(s => s.spaceId === spaceId);
      if (!space) continue;
      for (const inst of insts) {
        if (!instanceNames.has(inst.instanceGuid)) void loadInstanceDestNames(inst.instanceGuid, space.spaceName);
      }
    }
  }, [treeSelectedKeys, spaceInstances]); // eslint-disable-line react-hooks/exhaustive-deps

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      if (bannerTimerRef.current)      clearTimeout(bannerTimerRef.current);
      if (subProgressTimerRef.current) clearTimeout(subProgressTimerRef.current);
    };
  }, []);

  // Track body container width to drive left-panel responsive text hiding
  const [bodyWidth, setBodyWidth] = useState(0);
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    setBodyWidth(el.offsetWidth);
    const obs = new ResizeObserver(entries => {
      setBodyWidth(entries[0]?.contentRect.width ?? el.offsetWidth);
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  async function loadDest(name: string) {
    setIsLoading(true);
    try {
      const res  = await fetch(`/api/destinations/${enc(sa.region)}/${enc(sa.subdomain)}/${enc(name)}`);
      const json = await res.json() as { ok: boolean; data: Record<string, unknown>; sensitiveFields: string[] };
      if (json.ok) {
        const props = toProps(json.data, json.sensitiveFields);
        setServerProps(props);
        setEditedProps(structuredClone(props));
      }
    } catch { /* ignore */ } finally { setIsLoading(false); }
  }

  async function loadChangelog(name: string) {
    setIsLoadingChangelog(true);
    try {
      const url = activeInstScope
        ? `/api/destinations/${enc(sa.region)}/${enc(sa.subdomain)}/spaces/${enc(activeInstScope.spaceName)}/instances/${enc(activeInstScope.instanceGuid)}/${enc(name)}/changelog`
        : `/api/destinations/${enc(sa.region)}/${enc(sa.subdomain)}/${enc(name)}/changelog`;
      const res  = await fetch(url);
      const json = await res.json() as { ok: boolean; data: string };
      if (json.ok) setChangelog(json.data);
    } catch { /* ignore */ } finally { setIsLoadingChangelog(false); }
  }

  function handleTabChange(tab: Tab) {
    setActiveTab(tab);
    if (tab === 'changelog' && selectedName) void loadChangelog(selectedName);
  }

  function selectDest(name: string) {
    setSelectedName(name);
    setSelectedNames(new Set([name]));
    setLastClickName(name);
    setChangelog('');
  }

  function handleDestClick(name: string, idx: number, e: React.MouseEvent) {
    if (e.ctrlKey || e.metaKey) {
      setSelectedNames(prev => {
        const next = new Set(prev);
        if (next.has(name)) next.delete(name); else next.add(name);
        return next;
      });
      setSelectedName(name);
      setLastClickName(name);
    } else if (e.shiftKey) {
      const anchorIdx = filteredNames.indexOf(lastClickName);
      const [a, b]   = anchorIdx <= idx
        ? [anchorIdx < 0 ? 0 : anchorIdx, idx]
        : [idx, anchorIdx];
      setSelectedNames(new Set(filteredNames.slice(a, b + 1)));
      setSelectedName(name);
    } else {
      selectDest(name);
    }
    setIsCreating(false);
  }

  async function handleSave() {
    if (!selectedName || !isDirty) return;
    setIsSaving(true);
    if (bannerTimerRef.current) { clearTimeout(bannerTimerRef.current); bannerTimerRef.current = null; }
    setSaveBanner(null);
    try {
      const url = activeInstScope
        ? `/api/destinations/${enc(sa.region)}/${enc(sa.subdomain)}/spaces/${enc(activeInstScope.spaceName)}/instances/${enc(activeInstScope.instanceGuid)}/${enc(selectedName)}`
        : `/api/destinations/${enc(sa.region)}/${enc(sa.subdomain)}/${enc(selectedName)}`;
      const res  = await fetch(url, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ data: fromProps(selectedName, editedProps), username }),
      });
      const json = await res.json() as { ok: boolean; error?: string };
      if (!json.ok) throw new Error(json.error ?? 'Save failed');
      if (activeInstScope) {
        await loadInstDestData(activeInstScope.spaceName, activeInstScope.instanceGuid, selectedName);
      } else {
        await loadDest(selectedName);
        if (activeTab === 'changelog') await loadChangelog(selectedName);
      }
      setSaveBanner({ type: 'success', message: `${sa.region} → ${sa.subdomain} → ${selectedName} saved` });
      bannerTimerRef.current = setTimeout(() => setSaveBanner(null), 3000);
    } catch (err) {
      setSaveBanner({ type: 'error', message: err instanceof Error ? err.message : 'Save failed' });
    } finally { setIsSaving(false); }
  }

  async function handleExport() {
    const toExport = selectedNames.size > 0 ? [...selectedNames] : selectedName ? [selectedName] : [];
    if (toExport.length === 0) return;

    if (toExport.length === 1) {
      window.open(`/api/destinations/${enc(sa.region)}/${enc(sa.subdomain)}/${enc(toExport[0]!)}/export`, '_blank');
      return;
    }

    const all: Record<string, unknown>[] = [];
    for (const name of [...toExport].sort()) {
      try {
        const res = await fetch(`/api/destinations/${enc(sa.region)}/${enc(sa.subdomain)}/${enc(name)}/export`);
        if (res.ok) all.push(await res.json() as Record<string, unknown>);
      } catch { /* skip */ }
    }
    const blob = new Blob([JSON.stringify(all, null, 2)], { type: 'application/json' });
    const href = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement('a'), {
      href, download: `${sa.region}_${sa.subdomain}_multi_destinations.json`,
    });
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(href);
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    try {
      const text   = await file.text();
      const parsed = JSON.parse(text) as Record<string, unknown> | Record<string, unknown>[];
      const items  = (Array.isArray(parsed) ? parsed : [parsed]).filter(i => typeof i['Name'] === 'string' && (i['Name'] as string).trim());
      if (items.length === 0) { setSaveBanner({ type: 'error', message: 'No valid destinations in file' }); return; }
      setImportItems(items);
      setImportProgress(null);
      setImportSummary(null);
      setImportDialogOpen(true);
    } catch {
      setSaveBanner({ type: 'error', message: 'Invalid JSON file' });
    }
  }

  async function runImport(targets: ImportTarget[]) {
    const total = importItems.length * targets.length;
    setImportProgress({ done: 0, total });
    setImportSummary(null);
    let done = 0; let created = 0; let updated = 0;
    const errors: string[]  = [];
    const changes: Array<{ region: string; subdomain: string; name: string; action: 'created' | 'updated'; spaceName?: string; instanceGuid?: string; instanceName?: string }> = [];

    for (const item of importItems) {
      const name = String(item['Name']).trim();
      for (const target of targets) {
        let lastAction: 'created' | 'updated' | 'error' = 'updated';
        try {
          const url = target.type === 'sa'
            ? `/api/destinations/${enc(sa.region)}/${enc(sa.subdomain)}/${enc(name)}`
            : `/api/destinations/${enc(sa.region)}/${enc(sa.subdomain)}/spaces/${enc(target.spaceName)}/instances/${enc(target.instanceGuid)}/${enc(name)}`;
          const isNew = target.type === 'sa'
            ? !localAllNames.includes(name)
            : !(instanceNames.get(target.instanceGuid) ?? []).includes(name);
          const res  = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: item, username, action: 'import' }) });
          const json = await res.json() as { ok: boolean; error?: string };
          if (!json.ok) throw new Error(json.error ?? 'PUT failed');
          lastAction = isNew ? 'created' : 'updated';
          if (isNew) { created++; } else { updated++; }
          changes.push({ region: sa.region, subdomain: sa.subdomain, name, action: isNew ? 'created' : 'updated', ...(target.type === 'inst' ? { spaceName: target.spaceName, instanceGuid: target.instanceGuid, instanceName: target.instanceName } : {}) });
          if (target.type === 'sa') setLocalAllNames(prev => [...new Set([...prev, name])].sort());
          else setInstanceNames(prev => { const m = new Map(prev); m.set(target.instanceGuid, [...new Set([...(m.get(target.instanceGuid) ?? []), name])].sort()); return m; });
        } catch (err) {
          lastAction = 'error';
          errors.push(`${name}${target.type === 'inst' ? ` (${target.instanceName})` : ''}: ${err instanceof Error ? err.message : 'error'}`);
        }
        done++;
        setImportProgress({ done, total, lastDest: name, lastAction });
      }
    }

    if (changes.length > 0) {
      try {
        await fetch('/api/destinations/batch-changelog', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ changes }),
        });
      } catch { /* non-fatal */ }
    }

    setImportSummary({ created, updated, errors });
  }

  async function runDelete(targets: DeleteTarget[]) {
    setDeleteProgress({ done: 0, total: targets.length });
    setDeleteSummary(null);
    let done = 0; let deleted = 0;
    const errors: string[] = [];
    for (const t of targets) {
      try {
        const url = t.instanceGuid && t.spaceName
          ? `/api/destinations/${enc(sa.region)}/${enc(sa.subdomain)}/spaces/${enc(t.spaceName)}/instances/${enc(t.instanceGuid)}/${enc(t.name)}`
          : `/api/destinations/${enc(sa.region)}/${enc(sa.subdomain)}/${enc(t.name)}`;
        const res  = await fetch(url, { method: 'DELETE' });
        const json = await res.json() as { ok: boolean; error?: string };
        if (!json.ok) throw new Error(json.error ?? 'DELETE failed');
        deleted++;
        if (t.instanceGuid) setInstanceNames(prev => { const m = new Map(prev); m.set(t.instanceGuid!, (m.get(t.instanceGuid!) ?? []).filter(n => n !== t.name)); return m; });
        else {
          setLocalAllNames(prev => prev.filter(n => n !== t.name));
          setFilteredNames(prev => prev.filter(n => n !== t.name));
          if (selectedName === t.name) selectDest('');
        }
      } catch (err) {
        errors.push(`${t.name}${t.instanceName ? ` (${t.instanceName})` : ''}: ${err instanceof Error ? err.message : 'error'}`);
      }
      done++;
      setDeleteProgress({ done, total: targets.length, lastName: t.name });
    }
    setDeleteSummary({ deleted, errors });
    if (errors.length === 0) {
      setSelectedDestKeys(new Set());
      setSelectedNames(new Set());
    }
  }

  async function handleCreateSave() {
    const name = newName.trim();
    if (!name) { setCreateError('Destination name is required'); return; }
    setIsCreatingSave(true); setCreateError('');
    try {
      const url = createScope
        ? `/api/destinations/${enc(sa.region)}/${enc(sa.subdomain)}/spaces/${enc(createScope.spaceName)}/instances/${enc(createScope.instanceGuid)}/${enc(name)}`
        : `/api/destinations/${enc(sa.region)}/${enc(sa.subdomain)}/${enc(name)}`;
      const res  = await fetch(url, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ data: fromProps(name, newProps), username }),
      });
      const json = await res.json() as { ok: boolean; error?: string };
      if (!json.ok) throw new Error(json.error ?? 'Create failed');
      if (createScope) {
        setInstanceNames(prev => {
          const m = new Map(prev);
          m.set(createScope.instanceGuid, [...new Set([...(m.get(createScope.instanceGuid) ?? []), name])].sort());
          return m;
        });
        loadInstDest(createScope.spaceName, createScope.instanceGuid, createScope.instanceName, name);
      } else {
        setLocalAllNames(prev => [...new Set([...prev, name])].sort());
        selectDest(name);
      }
      setIsCreating(false);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Create failed');
    } finally { setIsCreatingSave(false); }
  }

  function handleCreateClick() {
    setIsCreating(true);
    setCreateScope(null);
    setNewName('');
    setNewProps(structuredClone(DEFAULT_CREATE_PROPS));
    setCreateError('');
    setActiveTab('properties');
  }

  function handleCopyClick() {
    setIsCreating(true);
    setCreateScope(activeInstScope);
    setNewName(selectedName ? `${selectedName}_COPY` : '_COPY');
    setNewProps(structuredClone(editedProps));
    setCreateError('');
    setActiveTab('properties');
  }

  async function handleRefresh() {
    if (subProgressTimerRef.current) clearTimeout(subProgressTimerRef.current);
    setSubProgress({ type: 'refreshing' });

    const sse = new EventSource('/api/events?dest=1');
    sse.addEventListener('update', (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data as string) as { type?: string; scope?: string; region?: string; subdomain?: string; current?: number; total?: number; name?: string };
        if (data.type === 'inst-progress' && data.scope === 'subaccount' && data.region === sa.region && data.subdomain === sa.subdomain) {
          setSubProgress(prev => ({ ...(prev ?? { type: 'refreshing' }), type: 'refreshing', current: data.current, total: data.total, progressName: data.name }));
        }
      } catch { /* ignore */ }
    });

    try {
      const res  = await fetch(`/api/destinations/${enc(sa.region)}/${enc(sa.subdomain)}?force=1`);
      const json = await res.json() as { ok: boolean; names: string[]; refreshed: boolean; errors: string[]; created?: number; updated?: number; deleted?: number; received?: number };
      if (!res.ok || !json.ok) {
        setSubProgress({ type: 'error', errors: json.errors?.length ? json.errors : [`HTTP ${res.status}`] });
        return;
      }
      if (json.names.length > 0) setLocalAllNames(json.names);
      if (json.errors?.length) {
        setSubProgress({ type: 'error', errors: json.errors });
        return;
      }
      if (selectedName) await loadDest(selectedName);
      if (activeTab === 'changelog' && selectedName) await loadChangelog(selectedName);
      if (hasSpaceDests) void loadAllSpaceInstances(true);
      setSubProgress({ type: 'done', created: json.created ?? 0, updated: json.updated ?? 0, deleted: json.deleted ?? 0, received: json.received });
      subProgressTimerRef.current = setTimeout(() => setSubProgress(null), 3000);
      onDestDataChange?.();
    } catch (err) {
      setSubProgress({ type: 'error', errors: [String(err)] });
    } finally {
      sse.close();
    }
  }

  const tabCls = (active: boolean) =>
    `px-4 py-2 text-xs transition-colors border-b-2 shrink-0 font-medium ${
      active ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'
    }`;

  const btnBase   = 'inline-flex items-center gap-1.5 px-2 sm:px-3 py-1.5 rounded text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
  const btnNormal = 'inline-flex items-center gap-1.5 px-2 py-1.5 rounded text-xs font-medium hover:bg-accent hover:text-accent-foreground transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
  const groupBtn  = 'inline-flex items-center gap-1.5 px-2 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed hover:bg-accent hover:text-accent-foreground';

  const leftPanelWidth = showList ? bodyWidth * splitPct / 100 : 0;
  const showBtnText = leftPanelWidth >= 700;

  const exportCount = selectedNames.size;
  const exportTitle = exportCount > 1
    ? `Download ${exportCount} selected destinations as ${sa.region}_${sa.subdomain}_multi_destinations.json`
    : 'Download destination JSON — Ctrl/⌘+click or Shift+click to select multiple for bulk export';

  // Inline filter-row toolbar helper ([Compare] [Export·Delete count] [Refresh])
  function renderFilterToolbar(opts: {
    onExport: () => void;
    exportDisabled: boolean;
    exportTitle: string;
    compareCount: number;
    onCompare: () => void;
    deleteCount: number;
    onDelete: () => void;
    onClearSelection: () => void;
  }) {
    const { onExport, exportDisabled, compareCount, onCompare, deleteCount, onDelete, onClearSelection } = opts;
    const selCount = deleteCount;
    return (
      <>
        {/* Import — standalone */}
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={isImportRunning}
          className={btnNormal}
          title="Import destination(s) from JSON"
        >
          <Upload className="h-4 w-4" />
          {showBtnText && <span className="ml-1">Import</span>}
        </button>
        {/* Export / Compare / Delete button group with shared count badge */}
        <div className="inline-flex items-stretch rounded overflow-hidden shrink-0">
          <button
            onClick={onExport}
            disabled={exportDisabled}
            className={groupBtn}
            title={opts.exportTitle}
          >
            <Download className="h-4 w-4" />
            {showBtnText && <span>Export</span>}
          </button>
          <div className="w-px bg-border shrink-0" />
          <button
            onClick={onCompare}
            disabled={compareCount < 2}
            className={groupBtn}
            title={compareCount >= 2 ? `Compare ${compareCount} selected destinations` : 'Select 2+ destinations to compare'}
          >
            <GitCompare className="h-4 w-4" />
            {showBtnText && <span>Compare</span>}
          </button>
          <div className="w-px bg-border shrink-0" />
          <button
            onClick={onDelete}
            disabled={deleteCount === 0}
            className={`${groupBtn} ${deleteCount > 0 ? 'text-destructive hover:bg-destructive/10 hover:text-destructive' : ''}`}
            title={deleteCount > 0 ? `Delete ${deleteCount} selected destination${deleteCount !== 1 ? 's' : ''}` : 'Select destinations to delete'}
          >
            <Trash2 className="h-4 w-4" />
            {showBtnText && <span>Delete</span>}
          </button>
          {selCount > 0 && (
            <>
              <div className="w-px bg-border shrink-0" />
              <button
                onClick={onClearSelection}
                className="inline-flex items-center px-2 text-xs font-medium text-muted-foreground tabular-nums hover:bg-accent hover:text-foreground transition-colors"
                title="Click to clear selection"
              >
                {selCount}
              </button>
            </>
          )}
        </div>
        {/* Refresh */}
        <button
          onClick={() => void handleRefresh()}
          disabled={isImportRunning}
          className={btnNormal}
          title="Refresh subaccount destinations"
        >
          <RefreshCw className="h-4 w-4" />
        </button>
      </>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">

      {/* Sub-refresh progress banner */}
      {subProgress && (
        <div className={`relative px-4 py-2 border-b text-xs flex items-center justify-center gap-2 shrink-0 overflow-hidden ${
          subProgress.type === 'error' ? 'bg-amber-500/5 border-amber-500/20 text-amber-700 dark:text-amber-400'
          : subProgress.type === 'done' ? 'bg-green-500/5 border-green-500/20 text-green-700 dark:text-green-400'
          : 'bg-muted/30 border-border text-muted-foreground'
        }`}>
          {subProgress.type === 'refreshing' && subProgress.total != null ? (
            <div className="absolute bottom-0 left-0 h-0.5 bg-primary/40 w-full">
              <div
                className="h-full bg-primary transition-all duration-300"
                style={{ width: `${Math.round(((subProgress.current ?? 0) / subProgress.total) * 100)}%` }}
              />
            </div>
          ) : subProgress.type === 'refreshing' ? (
            <div className="absolute bottom-0 left-0 h-0.5 bg-primary/40 animate-pulse w-full" />
          ) : null}
          <span className="text-center">
            {subProgress.type === 'refreshing' && subProgress.total != null
              ? `Refreshing ${subProgress.current ?? 0}/${subProgress.total} — ${subProgress.progressName ?? '…'}`
              : subProgress.type === 'refreshing' && 'Refreshing subaccount destinations…'}
            {subProgress.type === 'done' && (
              (subProgress.created ?? 0) === 0 && (subProgress.updated ?? 0) === 0 && (subProgress.deleted ?? 0) === 0
                ? 'Refreshed — no change'
                : `Refreshed — created ${subProgress.created ?? 0}, updated ${subProgress.updated ?? 0}, deleted ${subProgress.deleted ?? 0} destinations since last check`
            )}
            {subProgress.type === 'error' && (subProgress.errors ?? []).join('; ')}
          </span>
          {subProgress.type !== 'refreshing' && (
            <button
              onClick={() => { if (subProgressTimerRef.current) clearTimeout(subProgressTimerRef.current); setSubProgress(null); }}
              className="absolute right-2 shrink-0 p-0.5 rounded hover:opacity-70 transition-opacity"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      )}

      {/* Body */}
      <div ref={bodyRef} className="flex flex-1 min-h-0">
        {/* Left panel: destination list (or tree + list when hasSpaceDests) */}
        {showList && (
          hasSpaceDests ? (
            <>
              <div
                className="tree-split-container border-r border-border flex flex-col shrink-0 min-w-0"
                style={{ width: `${splitPct}%` }}
              >
                {/* Tree (top pane) */}
                <div className="flex flex-col overflow-hidden" style={{ height: `${treeSplitPct}%` }}>
                  {/* Tree title bar */}
                  <div className="flex items-center gap-1 px-2 border-b border-border shrink-0 min-h-[44px]">
                    {/* Filter input */}
                    <div className="relative flex-1 min-w-0">
                      <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
                      <input
                        type="text"
                        value={treeFilter}
                        onChange={e => setTreeFilter(e.target.value)}
                        placeholder="Filter spaces / instances…"
                        className={`w-full h-7 pl-7 text-xs border border-border rounded bg-background focus:outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50 ${treeFilter ? 'pr-6' : 'pr-2'}`}
                      />
                      {treeFilter && (
                        <button onClick={() => setTreeFilter('')} className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors p-0.5" tabIndex={-1}>
                          <X className="h-3 w-3" />
                        </button>
                      )}
                    </div>
                    {/* Toolbar: Expand/Collapse toggle · Select All · Unselect All */}
                    <div className="flex items-center gap-0.5 shrink-0">
                      {(() => {
                        const managedSpaceIds = (sa.org?.spaces ?? []).filter(s => s.manageDest).map(s => s.spaceId);
                        const allTreeExp = managedSpaceIds.length > 0 && managedSpaceIds.every(id => treeExpanded.has(id));
                        return (
                          <button
                            onClick={() => {
                              if (allTreeExp) {
                                setTreeExpanded(new Set(['__sa__']));
                              } else {
                                setTreeExpanded(new Set(['__sa__', ...managedSpaceIds]));
                                if (!allInstancesLoaded) void loadAllSpaceInstances();
                              }
                            }}
                            className={btnNormal}
                            title={allTreeExp ? 'Collapse to space level' : 'Expand all spaces'}
                          >
                            {allTreeExp ? <ChevronsDownUp className="h-4 w-4" /> : <ChevronsUpDown className="h-4 w-4" />}
                            {showBtnText && <span className="ml-1">{allTreeExp ? 'Collapse' : 'Expand'}</span>}
                          </button>
                        );
                      })()}
                      <button
                        onClick={() => {
                          const keys: string[] = ['sa:root'];
                          for (const sp of (sa.org?.spaces ?? []).filter(s => s.manageDest)) {
                            keys.push(`space:${sp.spaceId}`);
                            for (const i of (spaceInstances.get(sp.spaceId) ?? [])) keys.push(`inst:${i.instanceGuid}`);
                          }
                          setTreeSelectedKeys(new Set(keys));
                          setLastTreeClickKey(keys[keys.length - 1] ?? '');
                        }}
                        className={btnNormal}
                        title="Select all"
                      >
                        <CheckSquare className="h-4 w-4" />
                        {showBtnText && <span>All</span>}
                      </button>
                      <button
                        onClick={() => { setTreeSelectedKeys(new Set()); setLastTreeClickKey(''); }}
                        className={btnNormal}
                        title="Unselect all"
                      >
                        <Square className="h-4 w-4" />
                        {showBtnText && <span>None</span>}
                      </button>
                    </div>
                  </div>
                  {/* Tree table */}
                  <div
                    className="flex-1 overflow-auto"
                    tabIndex={0}
                    onKeyDown={e => {
                      if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
                        e.preventDefault();
                        const keys: string[] = ['sa:root'];
                        for (const sp of (sa.org?.spaces ?? []).filter(s => s.manageDest)) {
                          keys.push(`space:${sp.spaceId}`);
                          for (const i of (spaceInstances.get(sp.spaceId) ?? [])) keys.push(`inst:${i.instanceGuid}`);
                        }
                        setTreeSelectedKeys(new Set(keys));
                        setLastTreeClickKey(keys[keys.length - 1] ?? '');
                      }
                    }}
                  >
                    <table className="w-full border-collapse text-xs" style={{ tableLayout: 'fixed' }}>
                      <colgroup>
                        <col />
                        <col style={{ width: '52px' }} />
                      </colgroup>
                      <thead className="sticky top-0 z-10">
                        <tr className="bg-muted/40">
                          <th className="px-2 py-1 text-left text-[10px] font-medium text-muted-foreground border-b border-border">Subaccount › Spaces › Destination Instances</th>
                          <th className="px-2 py-1 text-right text-[10px] font-medium text-muted-foreground border-b border-border">Dests</th>
                        </tr>
                      </thead>
                      <tbody>
                    {(() => {
                      const filterLc = treeFilter.toLowerCase();
                      const orderedKeys: string[] = ['sa:root'];
                      const visibleSpaces = (sa.org?.spaces ?? []).filter(s => s.manageDest && (
                        !filterLc || s.spaceName.toLowerCase().includes(filterLc) ||
                        (spaceInstances.get(s.spaceId) ?? []).some(i => i.instanceName.toLowerCase().includes(filterLc))
                      ));
                      for (const sp of visibleSpaces) {
                        orderedKeys.push(`space:${sp.spaceId}`);
                        if (treeExpanded.has(sp.spaceId)) {
                          for (const i of (spaceInstances.get(sp.spaceId) ?? [])) {
                            if (!filterLc || i.instanceName.toLowerCase().includes(filterLc) || sp.spaceName.toLowerCase().includes(filterLc)) {
                              orderedKeys.push(`inst:${i.instanceGuid}`);
                            }
                          }
                        }
                      }

                      function handleTreeClick(nodeKey: string, e: React.MouseEvent) {
                        if (e.ctrlKey || e.metaKey) {
                          setTreeSelectedKeys(prev => {
                            const next = new Set(prev);
                            if (next.has(nodeKey)) next.delete(nodeKey); else next.add(nodeKey);
                            return next;
                          });
                          setLastTreeClickKey(nodeKey);
                        } else if (e.shiftKey && lastTreeClickKey) {
                          const a = orderedKeys.indexOf(lastTreeClickKey);
                          const b = orderedKeys.indexOf(nodeKey);
                          if (a >= 0 && b >= 0) {
                            const [lo, hi] = a <= b ? [a, b] : [b, a];
                            setTreeSelectedKeys(new Set(orderedKeys.slice(lo, hi + 1)));
                          }
                          setLastTreeClickKey(nodeKey);
                        } else {
                          setTreeSelectedKeys(new Set([nodeKey]));
                          setLastTreeClickKey(nodeKey);
                        }
                      }

                      const saRootSel = treeSelectedKeys.has('sa:root');
                      const saDestCount = localAllNames.length;
                      const rowCls = (sel: boolean) => `cursor-pointer select-none hover:bg-muted/20 ${sel ? 'bg-primary/10 text-primary' : ''}`;

                      return (
                        <>
                          {/* SA root node */}
                          <tr
                            className={rowCls(saRootSel)}
                            onClick={e => handleTreeClick('sa:root', e)}
                          >
                            <td className="px-2 py-1 border-b border-border/50 font-semibold">
                              <span className="flex items-center gap-1">
                                <ChevronDown className="h-3 w-3 shrink-0 opacity-60" />
                                <span className="truncate font-mono">{sa.alias || sa.subaccountName}</span>
                                <span className="font-normal text-[10px] text-muted-foreground shrink-0">({sa.subdomain})</span>
                              </span>
                            </td>
                            <td className="px-2 py-1 border-b border-border/50 text-right text-muted-foreground text-[10px]">
                              {saDestCount > 0 ? saDestCount : ''}
                            </td>
                          </tr>

                          {/* Space + instance rows */}
                          {visibleSpaces.map(space => {
                            const spaceNodeKey   = `space:${space.spaceId}`;
                            const isExpanded     = treeExpanded.has(space.spaceId);
                            const isSpaceSel     = treeSelectedKeys.has(spaceNodeKey);
                            const insts          = (spaceInstances.get(space.spaceId) ?? []).filter(i =>
                              !filterLc || i.instanceName.toLowerCase().includes(filterLc) || space.spaceName.toLowerCase().includes(filterLc)
                            );
                            const spaceDestCount = insts.reduce((sum, i) => sum + (instanceNames.get(i.instanceGuid)?.length ?? 0), 0);
                            return (
                              <>
                                {/* Space row */}
                                <tr
                                  key={`space-${space.spaceId}`}
                                  className={rowCls(isSpaceSel)}
                                  onClick={e => {
                                    handleTreeClick(spaceNodeKey, e);
                                    if (!e.ctrlKey && !e.metaKey && !e.shiftKey) {
                                      setTreeExpanded(prev => {
                                        const next = new Set(prev);
                                        if (next.has(space.spaceId)) next.delete(space.spaceId); else next.add(space.spaceId);
                                        return next;
                                      });
                                      if (!allInstancesLoaded) void loadAllSpaceInstances();
                                    }
                                  }}
                                >
                                  <td className="pl-5 pr-2 py-1 border-b border-border/50 font-medium">
                                    <span className="flex items-center gap-1">
                                      {isExpanded ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
                                      <span className="truncate">{space.spaceName}</span>
                                    </span>
                                  </td>
                                  <td className="px-2 py-1 border-b border-border/50 text-right text-muted-foreground text-[10px]">
                                    {spaceInstances.has(space.spaceId) && spaceDestCount > 0 ? spaceDestCount : ''}
                                  </td>
                                </tr>
                                {/* Instance rows */}
                                {isExpanded && (() => {
                                  if (!spaceInstances.has(space.spaceId)) {
                                    return <tr key={`loading-${space.spaceId}`}><td colSpan={2} className="pl-10 pr-2 py-1 text-[10px] text-muted-foreground border-b border-border/50">{allInstancesLoaded ? 'No instances' : 'Loading…'}</td></tr>;
                                  }
                                  if (insts.length === 0) {
                                    return <tr key={`empty-${space.spaceId}`}><td colSpan={2} className="pl-10 pr-2 py-1 text-[10px] text-muted-foreground border-b border-border/50">No instances</td></tr>;
                                  }
                                  return insts.map(inst => {
                                    const instNodeKey   = `inst:${inst.instanceGuid}`;
                                    const isInstSel     = treeSelectedKeys.has(instNodeKey);
                                    const instDestCount = instanceNames.get(inst.instanceGuid)?.length ?? 0;
                                    return (
                                      <tr
                                        key={inst.instanceGuid}
                                        className={rowCls(isInstSel)}
                                        onClick={e => {
                                          handleTreeClick(instNodeKey, e);
                                          void loadInstanceDestNames(inst.instanceGuid, space.spaceName);
                                        }}
                                      >
                                        <td className="pl-10 pr-2 py-1 border-b border-border/50 font-mono truncate">{inst.instanceName}</td>
                                        <td className="px-2 py-1 border-b border-border/50 text-right text-muted-foreground text-[10px]">
                                          {instanceNames.has(inst.instanceGuid) ? instDestCount : ''}
                                        </td>
                                      </tr>
                                    );
                                  });
                                })()}
                              </>
                            );
                          })}
                        </>
                      );
                    })()}
                      </tbody>
                    </table>
                  </div>
                </div>
                {/* Vertical drag divider */}
                <div
                  onMouseDown={startTreeSplitResize}
                  className="h-1.5 shrink-0 cursor-row-resize bg-border hover:bg-primary/50 transition-colors"
                />
                {/* Flat destination list (bottom pane) */}
                <div className="flex flex-col flex-1 min-h-0 overflow-hidden" style={{ height: `${100 - treeSplitPct}%` }}>
                  {/* Search row — filter + inline action buttons */}
                  <div className="px-2 py-2 border-b border-border shrink-0 flex items-center gap-1">
                    {(() => {
                      const hasSaSel   = treeSelectedKeys.has('sa:root') || treeSelectedKeys.size === 0;
                      const hasInstSel = [...treeSelectedKeys].some(k => k.startsWith('space:') || k.startsWith('inst:'));
                      let instTotal = 0; let instFiltered = 0;
                      if (hasInstSel) {
                        const seen = new Set<string>();
                        for (const nodeKey of treeSelectedKeys) {
                          const guids: string[] = [];
                          if (nodeKey.startsWith('inst:')) { guids.push(nodeKey.slice(5)); }
                          else if (nodeKey.startsWith('space:')) { for (const i of (spaceInstances.get(nodeKey.slice(6)) ?? [])) guids.push(i.instanceGuid); }
                          for (const g of guids) {
                            if (seen.has(g)) continue; seen.add(g);
                            const names = instanceNames.get(g) ?? [];
                            instTotal    += names.length;
                            if (searchQuery) {
                              instFiltered += matchedInstKeys !== null
                                ? names.filter(n => matchedInstKeys.has(`${g}/${n}`)).length
                                : names.filter(n => n.toLowerCase().includes(searchQuery.toLowerCase())).length;
                            } else {
                              instFiltered += names.length;
                            }
                          }
                        }
                      }
                      const saTotal    = hasSaSel ? localAllNames.length : 0;
                      const totalDests = saTotal + instTotal;
                      return (
                        <div className="relative flex-1 min-w-0">
                          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
                          <input
                            type="text"
                            value={searchQuery}
                            onChange={e => {
                              setSearchQuery(e.target.value);
                              if (!e.target.value.trim()) { setFilteredNames(localAllNames); setMatchedInstKeys(null); }
                            }}
                            onKeyDown={e => { if (e.key === 'Enter') void runSearch(searchQuery); }}
                            placeholder={`Search within ${totalDests} destinations`}
                            className={`w-full h-7 pl-7 text-xs border border-border rounded bg-background focus:outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50 ${searchQuery ? 'pr-6' : 'pr-2'}`}
                          />
                          {isSearching && <RefreshCw className="absolute right-6 top-1/2 -translate-y-1/2 h-3 w-3 animate-spin text-muted-foreground pointer-events-none" />}
                          {!isSearching && searchQuery && (
                            <span className="absolute right-6 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground/40 pointer-events-none">↵</span>
                          )}
                          {searchQuery && (
                            <button onClick={() => { setSearchQuery(''); setFilteredNames(localAllNames); setMatchedInstKeys(null); }} className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors p-0.5" tabIndex={-1}>
                              <X className="h-3 w-3" />
                            </button>
                          )}
                        </div>
                      );
                    })()}
                    {renderFilterToolbar({
                      onExport: async () => {
                        const saNames: string[] = [];
                        const toExport: { instanceGuid: string; spaceName: string; name: string }[] = [];
                        for (const dk of selectedDestKeys) {
                          const slashIdx = dk.indexOf('/');
                          if (slashIdx < 0) continue;
                          const prefix = dk.slice(0, slashIdx);
                          const name   = dk.slice(slashIdx + 1);
                          if (prefix === 'sa') {
                            saNames.push(name);
                          } else {
                            let sName = '';
                            for (const [sid, insts] of spaceInstances) {
                              if (insts.find(x => x.instanceGuid === prefix)) {
                                sName = (sa.org?.spaces ?? []).find(s => s.spaceId === sid)?.spaceName ?? '';
                                break;
                              }
                            }
                            toExport.push({ instanceGuid: prefix, spaceName: sName, name });
                          }
                        }
                        if (treeSelectedKeys.size === 0) { await handleExport(); return; }
                        if (saNames.length === 0 && toExport.length === 0) return;
                        const all: Record<string, unknown>[] = [];
                        for (const name of [...saNames].sort()) {
                          try {
                            const res = await fetch(`/api/destinations/${enc(sa.region)}/${enc(sa.subdomain)}/${enc(name)}/export`);
                            if (res.ok) all.push(await res.json() as Record<string, unknown>);
                          } catch { /* skip */ }
                        }
                        for (const { instanceGuid, spaceName, name } of toExport) {
                          try {
                            const res = await fetch(`/api/destinations/${enc(sa.region)}/${enc(sa.subdomain)}/spaces/${enc(spaceName)}/instances/${enc(instanceGuid)}/${enc(name)}/export`);
                            if (res.ok) all.push(await res.json() as Record<string, unknown>);
                          } catch { /* skip */ }
                        }
                        if (all.length === 0) return;
                        const blob = new Blob([JSON.stringify(all.length === 1 ? all[0] : all, null, 2)], { type: 'application/json' });
                        const href = URL.createObjectURL(blob);
                        const a = Object.assign(document.createElement('a'), { href, download: `${sa.region}_${sa.subdomain}_destinations.json` });
                        document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(href);
                      },
                      exportDisabled: selectedDestKeys.size === 0,
                      exportTitle: selectedDestKeys.size > 1 ? `Export ${selectedDestKeys.size} selected` : selectedDestKeys.size === 1 ? 'Export selected' : 'Select destinations to export',
                      compareCount: selectedDestKeys.size,
                      onCompare: () => {
                        const destsForCompare: SelectedDest[] = [];
                        for (const dk of selectedDestKeys) {
                          const slashIdx = dk.indexOf('/');
                          if (slashIdx < 0) continue;
                          const prefix = dk.slice(0, slashIdx);
                          const name   = dk.slice(slashIdx + 1);
                          if (prefix === 'sa') {
                            destsForCompare.push({ region: sa.region, subdomain: sa.subdomain, name });
                          } else {
                            let spaceName = ''; let instanceName = '';
                            for (const [sid, insts] of spaceInstances) {
                              const i = insts.find(x => x.instanceGuid === prefix);
                              if (i) { instanceName = i.instanceName; spaceName = (sa.org?.spaces ?? []).find(s => s.spaceId === sid)?.spaceName ?? ''; break; }
                            }
                            destsForCompare.push({ region: sa.region, subdomain: sa.subdomain, name, spaceName: spaceName || undefined, instanceName: instanceName || undefined, instanceGuid: prefix });
                          }
                        }
                        onOpenCompare?.(destsForCompare);
                      },
                      deleteCount: selectedDestKeys.size,
                      onDelete: () => {
                        const targets: DeleteTarget[] = [];
                        for (const dk of selectedDestKeys) {
                          const slashIdx = dk.indexOf('/');
                          if (slashIdx < 0) continue;
                          const prefix = dk.slice(0, slashIdx);
                          const name   = dk.slice(slashIdx + 1);
                          if (prefix === 'sa') {
                            targets.push({ name });
                          } else {
                            let spaceName = ''; let instanceName = '';
                            for (const [sid, insts] of spaceInstances) {
                              const i = insts.find(x => x.instanceGuid === prefix);
                              if (i) { instanceName = i.instanceName; spaceName = (sa.org?.spaces ?? []).find(s => s.spaceId === sid)?.spaceName ?? ''; break; }
                            }
                            targets.push({ name, instanceGuid: prefix, instanceName, spaceName });
                          }
                        }
                        setDeleteTargets(targets);
                        setDeleteProgress(null);
                        setDeleteSummary(null);
                        setDeleteDialogOpen(true);
                      },
                      onClearSelection: () => setSelectedDestKeys(new Set()),
                    })}
                  </div>
                  <div
                    ref={listRef}
                    className="flex-1 overflow-auto py-1"
                    onKeyDown={e => {
                      if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
                        e.preventDefault();
                        const hasSaSelected   = treeSelectedKeys.has('sa:root') || treeSelectedKeys.size === 0;
                        const hasInstSelected = [...treeSelectedKeys].some(k => k.startsWith('space:') || k.startsWith('inst:'));
                        const allDks: string[] = [];
                        if (hasSaSelected) {
                          for (const n of filteredNames) allDks.push(`sa/${n}`);
                        }
                        if (hasInstSelected) {
                          const seen = new Set<string>();
                          for (const nodeKey of treeSelectedKeys) {
                            if (nodeKey.startsWith('inst:')) {
                              const guid = nodeKey.slice(5);
                              if (!seen.has(guid)) { seen.add(guid); for (const n of (instanceNames.get(guid) ?? [])) { const ik = `${guid}/${n}`; if (!searchQuery || (matchedInstKeys !== null ? matchedInstKeys.has(ik) : n.toLowerCase().includes(searchQuery.toLowerCase()))) allDks.push(ik); } }
                            } else if (nodeKey.startsWith('space:')) {
                              const sid = nodeKey.slice(6);
                              for (const inst of (spaceInstances.get(sid) ?? [])) {
                                if (!seen.has(inst.instanceGuid)) { seen.add(inst.instanceGuid); for (const n of (instanceNames.get(inst.instanceGuid) ?? [])) { const ik = `${inst.instanceGuid}/${n}`; if (!searchQuery || (matchedInstKeys !== null ? matchedInstKeys.has(ik) : n.toLowerCase().includes(searchQuery.toLowerCase()))) allDks.push(ik); } }
                              }
                            }
                          }
                        }
                        setSelectedDestKeys(new Set(allDks));
                        if (allDks.length > 0) setLastClickDestKey(allDks[allDks.length - 1]!);
                      }
                    }}
                    tabIndex={0}
                  >
                    {(() => {
                      const hasSaSelected   = treeSelectedKeys.has('sa:root') || treeSelectedKeys.size === 0;
                      const hasInstSelected = [...treeSelectedKeys].some(k => k.startsWith('space:') || k.startsWith('inst:'));

                      const saRows = hasSaSelected ? filteredNames : [];

                      type InstRow = { instanceGuid: string; instanceName: string; spaceName: string; name: string };
                      const instRows: InstRow[] = [];
                      if (hasInstSelected) {
                        const seenInst = new Set<string>();
                        for (const nodeKey of treeSelectedKeys) {
                          if (nodeKey.startsWith('inst:')) {
                            const instGuid = nodeKey.slice(5);
                            if (seenInst.has(instGuid)) continue;
                            seenInst.add(instGuid);
                            let instName = ''; let sName = '';
                            for (const [sid, insts] of spaceInstances) {
                              const i = insts.find(x => x.instanceGuid === instGuid);
                              if (i) { instName = i.instanceName; sName = (sa.org?.spaces ?? []).find(s => s.spaceId === sid)?.spaceName ?? ''; break; }
                            }
                            for (const n of (instanceNames.get(instGuid) ?? [])) {
                              const ik = `${instGuid}/${n}`;
                              if (!searchQuery || (matchedInstKeys !== null ? matchedInstKeys.has(ik) : n.toLowerCase().includes(searchQuery.toLowerCase()))) instRows.push({ instanceGuid: instGuid, instanceName: instName, spaceName: sName, name: n });
                            }
                          } else if (nodeKey.startsWith('space:')) {
                            const spaceId = nodeKey.slice(6);
                            const space   = (sa.org?.spaces ?? []).find(s => s.spaceId === spaceId);
                            if (!space) continue;
                            for (const inst of (spaceInstances.get(spaceId) ?? [])) {
                              if (seenInst.has(inst.instanceGuid)) continue;
                              seenInst.add(inst.instanceGuid);
                              for (const n of (instanceNames.get(inst.instanceGuid) ?? [])) {
                                const ik = `${inst.instanceGuid}/${n}`;
                                if (!searchQuery || (matchedInstKeys !== null ? matchedInstKeys.has(ik) : n.toLowerCase().includes(searchQuery.toLowerCase()))) instRows.push({ instanceGuid: inst.instanceGuid, instanceName: inst.instanceName, spaceName: space.spaceName, name: n });
                              }
                            }
                          }
                        }
                      }

                      const totalRows = saRows.length + instRows.length;

                      if (totalRows === 0 && treeSelectedKeys.size > 0) {
                        return <div className="px-3 py-2 text-[10px] text-muted-foreground">{allInstancesLoaded ? 'No destinations found' : 'Loading…'}</div>;
                      }

                      const saElements = saRows.map((name, idx) => {
                        const dk        = `sa/${name}`;
                        const isPrimary  = name === selectedName && !isCreating && !activeInstScope;
                        const isSelDest  = selectedDestKeys.has(dk);
                        return (
                          <button
                            key={dk}
                            data-selected={isPrimary ? 'true' : undefined}
                            onClick={e => {
                              if (e.ctrlKey || e.metaKey) {
                                setSelectedDestKeys(prev => { const n = new Set(prev); n.has(dk) ? n.delete(dk) : n.add(dk); return n; });
                                setLastClickDestKey(dk);
                              } else if (e.shiftKey && lastClickDestKey) {
                                const allDks = filteredNames.map(n => `sa/${n}`);
                                const a = allDks.indexOf(lastClickDestKey), b = idx;
                                const [lo, hi] = a <= b ? [a, b] : [b, a];
                                setSelectedDestKeys(new Set(allDks.slice(lo, hi + 1)));
                              } else {
                                handleDestClick(name, idx, e);
                                setActiveInstScope(null);
                                setSelectedDestKeys(new Set([dk]));
                                setLastClickDestKey(dk);
                              }
                            }}
                            className={`w-full text-left px-3 py-1.5 text-xs font-mono truncate transition-colors select-none ${isPrimary ? 'bg-primary/20 text-primary font-semibold' : isSelDest ? 'bg-primary/10 text-primary' : 'text-foreground hover:bg-muted/40'}`}
                          >
                            {name}
                          </button>
                        );
                      });

                      const instElements = instRows.map((row, rowIdx) => {
                        const dk        = `${row.instanceGuid}/${row.name}`;
                        const isPrimary  = row.name === selectedName && activeInstScope?.instanceGuid === row.instanceGuid;
                        const isSelDest  = selectedDestKeys.has(dk);
                        return (
                          <button
                            key={dk}
                            data-selected={isPrimary ? 'true' : undefined}
                            onClick={e => {
                              if (e.ctrlKey || e.metaKey) {
                                setSelectedDestKeys(prev => { const n = new Set(prev); n.has(dk) ? n.delete(dk) : n.add(dk); return n; });
                                setLastClickDestKey(dk);
                              } else if (e.shiftKey && lastClickDestKey) {
                                const allDks = instRows.map(r => `${r.instanceGuid}/${r.name}`);
                                const a = allDks.indexOf(lastClickDestKey), b = rowIdx;
                                const [lo, hi] = a <= b ? [a, b] : [b, a];
                                setSelectedDestKeys(new Set(allDks.slice(lo, hi + 1)));
                              } else {
                                setSelectedDestKeys(new Set([dk]));
                                setLastClickDestKey(dk);
                                loadInstDest(row.spaceName, row.instanceGuid, row.instanceName, row.name);
                              }
                            }}
                            className={`w-full text-left px-3 py-1.5 text-xs font-mono truncate transition-colors select-none ${isPrimary ? 'bg-primary/20 text-primary font-semibold' : isSelDest ? 'bg-primary/10 text-primary' : 'text-foreground hover:bg-muted/40'}`}
                          >
                            <><span className="text-muted-foreground text-[10px]">{row.spaceName} › {row.instanceName} › </span>{row.name}</>
                          </button>
                        );
                      });

                      return [...saElements, ...instElements];
                    })()}
                  </div>
                </div>
              </div>
              {/* Horizontal drag divider */}
              <div onMouseDown={startSplitResize} className="w-1.5 shrink-0 cursor-col-resize bg-border hover:bg-primary/50 transition-colors" />
            </>
          ) : (
          <>
          <div className="border-r border-border flex flex-col shrink-0 min-w-0" style={{ width: `${splitPct}%` }}>
            {/* Search row — filter + inline action buttons */}
            <div className="px-2 py-2 border-b border-border flex items-center gap-1">
              <div className="relative flex-1 min-w-0">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={e => {
                    setSearchQuery(e.target.value);
                    if (!e.target.value.trim()) { setFilteredNames(localAllNames); setMatchedInstKeys(null); }
                  }}
                  onKeyDown={e => { if (e.key === 'Enter') void runSearch(searchQuery); }}
                  placeholder={`Search within ${localAllNames.length} destinations`}
                  className={`w-full h-7 pl-7 text-xs border border-border rounded bg-background focus:outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50 ${searchQuery ? 'pr-6' : 'pr-2'}`}
                />
                {isSearching && <RefreshCw className="absolute right-6 top-1/2 -translate-y-1/2 h-3 w-3 animate-spin text-muted-foreground pointer-events-none" />}
                {!isSearching && searchQuery && (
                  <span className="absolute right-6 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground/40 pointer-events-none">↵</span>
                )}
                {searchQuery && (
                  <button
                    onClick={() => { setSearchQuery(''); setFilteredNames(localAllNames); setMatchedInstKeys(null); }}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors p-0.5"
                    tabIndex={-1}
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </div>
              {renderFilterToolbar({
                onExport: handleExport,
                exportDisabled: selectedNames.size === 0 && !selectedName,
                exportTitle,
                compareCount: selectedNames.size,
                onCompare: () => onOpenCompare?.([...selectedNames].map(name => ({ region: sa.region, subdomain: sa.subdomain, name }))),
                deleteCount: selectedNames.size,
                onDelete: () => {
                  setDeleteTargets([...selectedNames].map(name => ({ name })));
                  setDeleteProgress(null);
                  setDeleteSummary(null);
                  setDeleteDialogOpen(true);
                },
                onClearSelection: () => { setSelectedNames(new Set()); setSelectedDestKeys(new Set()); },
              })}
            </div>
            <div
              ref={listRef}
              className="flex-1 overflow-auto py-1"
              onKeyDown={e => {
                if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
                  e.preventDefault();
                  setSelectedNames(new Set(filteredNames));
                  setSelectedDestKeys(new Set(filteredNames.map(n => `sa/${n}`)));
                  if (filteredNames.length > 0) setLastClickName(filteredNames[filteredNames.length - 1]!);
                }
              }}
              tabIndex={0}
            >
              {filteredNames.length === 0 ? (
                <div className="px-3 py-4 text-xs text-muted-foreground text-center">
                  {isSearching ? 'Searching…' : 'No destinations found'}
                </div>
              ) : filteredNames.map((name, idx) => {
                const isPrimary  = name === selectedName && !isCreating;
                const isSelected = selectedNames.has(name) && !isCreating;
                return (
                  <button
                    key={name}
                    data-selected={isPrimary ? 'true' : undefined}
                    onClick={e => handleDestClick(name, idx, e)}
                    title={isSelected && !isPrimary ? `${name} — selected for export` : name}
                    className={`w-full text-left px-3 py-1.5 text-xs font-mono truncate transition-colors select-none ${
                      isPrimary  ? 'bg-primary/20 text-primary font-semibold' :
                      isSelected ? 'bg-primary/10 text-primary' :
                                   'text-foreground hover:bg-muted/40'
                    }`}
                  >
                    {name}
                  </button>
                );
              })}
            </div>
          </div>
          {/* Horizontal drag divider */}
          <div onMouseDown={startSplitResize} className="w-1.5 shrink-0 cursor-col-resize bg-border hover:bg-primary/50 transition-colors" />
          </>
          )
        )}

        {/* Right panel */}
        <div className="flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden">

          {/* Name bar: toggle + dest name + Compare/Reset/Save */}
          <div className="flex items-center gap-2 px-2 py-2 border-b border-border shrink-0 min-h-[44px]">
            <button
              onClick={() => setShowList(v => !v)}
              className={`p-1.5 rounded transition-colors shrink-0 ${showList ? 'text-muted-foreground hover:text-foreground hover:bg-accent/50' : 'bg-accent text-foreground'}`}
              title={showList ? 'Hide destination list' : 'Show destination list'}
            >
              <PanelLeft className="h-4 w-4" />
            </button>
            <span className="text-xs font-semibold font-mono flex-1 min-w-0 flex flex-col gap-0 leading-tight">
              {isCreating ? (
                <span className="text-muted-foreground font-normal not-italic">New Destination</span>
              ) : selectedName ? (
                <>
                  <span className="flex items-center gap-1.5 min-w-0">
                    <span className="truncate shrink min-w-0">{selectedName}</span>
                  </span>
                  {activeInstScope && (
                    <span className="text-[10px] font-normal text-muted-foreground truncate">{activeInstScope.spaceName} › {activeInstScope.instanceName}</span>
                  )}
                </>
              ) : (
                <span className="text-muted-foreground font-normal">—</span>
              )}
            </span>
            {activeTab === 'properties' && !isCreating && (
              <div className="flex items-center gap-1.5 shrink-0">
                {/* Compare — always visible */}
                <button
                  onClick={() => {
                    if (!onToggleCompare) return;
                    onToggleCompare({
                      region:       sa.region,
                      subdomain:    sa.subdomain,
                      name:         selectedName,
                      spaceName:    activeInstScope?.spaceName,
                      instanceName: activeInstScope?.instanceName,
                      instanceGuid: activeInstScope?.instanceGuid,
                    });
                  }}
                  disabled={!selectedName || !onToggleCompare}
                  className={(() => {
                    const compareSelected = onToggleCompare && selectedDests?.some(
                      d => d.region === sa.region && d.subdomain === sa.subdomain && d.name === selectedName &&
                        (activeInstScope ? d.instanceGuid === activeInstScope.instanceGuid : !d.instanceGuid),
                    );
                    return compareSelected
                      ? `${btnBase} border border-primary bg-primary/10 text-primary`
                      : btnNormal;
                  })()}
                  title={onToggleCompare
                    ? (selectedDests?.some(d => d.region === sa.region && d.subdomain === sa.subdomain && d.name === selectedName && (activeInstScope ? d.instanceGuid === activeInstScope.instanceGuid : !d.instanceGuid))
                        ? 'Remove from comparison basket' : 'Add to comparison basket')
                    : 'Compare'}
                >
                  <GitCompare className="h-4 w-4" />
                </button>
                {/* Create */}
                <button
                  onClick={handleCreateClick}
                  disabled={isCreating}
                  title="Create new destination"
                  className={btnNormal}
                >
                  <Plus className="h-4 w-4" />
                </button>
                {/* Copy */}
                <button
                  onClick={handleCopyClick}
                  disabled={!selectedName || isImportRunning}
                  title="Copy destination"
                  className={btnNormal}
                >
                  <Copy className="h-4 w-4" />
                </button>
                {/* Reset */}
                <button
                  onClick={() => { setEditedProps(structuredClone(serverProps)); setSaveBanner(null); }}
                  disabled={!isDirty || isSaving || isImportRunning}
                  title="Reset changes"
                  className={btnNormal}
                >
                  <RotateCcw className="h-4 w-4" />
                </button>
                {/* Save */}
                <button
                  onClick={handleSave}
                  disabled={!selectedName || !isDirty || isSaving || isImportRunning}
                  title="Save changes"
                  className={btnNormal}
                >
                  <Save className="h-4 w-4" />
                </button>
              </div>
            )}
          </div>

          {/* Tab bar */}
          <div className="flex items-center border-b border-border shrink-0">
            <button className={tabCls(activeTab === 'properties')} onClick={() => handleTabChange('properties')}>
              {isCreating ? 'New Destination' : 'Properties'}
            </button>
            <button className={tabCls(activeTab === 'changelog')} onClick={() => { setIsCreating(false); handleTabChange('changelog'); }}>History</button>
            <button className={tabCls(activeTab === 'test')}      onClick={() => { setIsCreating(false); handleTabChange('test'); }}>Test</button>
          </div>

          {activeTab === 'properties' && isCreating && (
            <CreateTab
              name={newName}
              props={newProps}
              saving={isCreatingSave}
              error={createError}
              onNameChange={setNewName}
              onUpdate={(idx, patch) => setNewProps(prev => prev.map((p, i) => i === idx ? { ...p, ...patch } : p))}
              onDelete={idx => setNewProps(prev => prev.filter((_, i) => i !== idx))}
              onAdd={() => setNewProps(prev => [...prev, { key: '', value: '', isSensitive: false, revealed: false }])}
              onSave={handleCreateSave}
              onCancel={() => setIsCreating(false)}
            />
          )}
          {activeTab === 'properties' && !isCreating && (
            <PropertiesTab
              name={selectedName}
              props={editedProps}
              loading={isLoading}
              banner={saveBanner}
              onUpdate={(idx, patch) => setEditedProps(prev => prev.map((p, i) => i === idx ? { ...p, ...patch } : p))}
              onDelete={idx => setEditedProps(prev => prev.filter((_, i) => i !== idx))}
              onAdd={() => setEditedProps(prev => [...prev, { key: '', value: '', isSensitive: false, revealed: false }])}
              onClearBanner={() => setSaveBanner(null)}
            />
          )}
          {activeTab === 'changelog' && (
            <ChangelogTab changelog={changelog} loading={isLoadingChangelog} />
          )}
          {/* Always mounted so form + response state survives tab switches.
              key resets the component only when the selected destination changes. */}
          <div className={`flex flex-col h-full min-h-0 overflow-hidden ${activeTab !== 'test' ? 'hidden' : ''}`}>
            <TestTab
              key={`${selectedName}::${activeInstScope?.instanceGuid ?? 'sa'}`}
              org={sa} name={selectedName} instScope={activeInstScope} editedProps={editedProps}
            />
          </div>
        </div>
      </div>

      {/* Hidden file input for Import */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".json"
        className="hidden"
        onChange={handleFileChange}
      />
      <ImportDialog
        open={importDialogOpen}
        onClose={() => setImportDialogOpen(false)}
        org={sa}
        spaceInstances={spaceInstances}
        treeSelectedKeys={treeSelectedKeys}
        importItems={importItems}
        onConfirm={targets => void runImport(targets)}
        progress={importProgress}
        summary={importSummary}
      />
      <DeleteDialog
        open={deleteDialogOpen}
        onClose={() => setDeleteDialogOpen(false)}
        org={sa}
        targets={deleteTargets}
        onConfirm={() => void runDelete(deleteTargets)}
        progress={deleteProgress}
        summary={deleteSummary}
      />
    </div>
  );
}

// ─── ImportDialog ─────────────────────────────────────────────────────────────

function ImportDialog({ open, onClose, org, spaceInstances, treeSelectedKeys, importItems, onConfirm, progress, summary }: {
  open: boolean; onClose: () => void;
  org: SubaccountEntry;
  spaceInstances: Map<string, Array<{ instanceGuid: string; instanceName: string }>>;
  treeSelectedKeys: Set<string>;
  importItems: Record<string, unknown>[];
  onConfirm: (targets: ImportTarget[]) => void;
  progress: { done: number; total: number; lastDest?: string; lastAction?: 'created' | 'updated' | 'error' } | null;
  summary: { created: number; updated: number; errors: string[] } | null;
}) {
  const targets   = getImportTargets(treeSelectedKeys, spaceInstances, org);
  const isRunning = progress !== null && progress.done < progress.total;
  const isDone    = summary !== null;
  return (
    <Dialog open={open} onOpenChange={v => { if (!v && !isRunning) onClose(); }}>
      <DialogContent className="max-w-2xl w-full">
        <DialogHeader>
          <DialogTitle>Import Destinations</DialogTitle>
        </DialogHeader>

        <div className="flex gap-3 min-h-[160px] max-h-[360px]">
          <div className="flex-1 overflow-auto border rounded p-2 space-y-0.5 text-xs">
            <p className="font-medium text-muted-foreground mb-1.5">Import into ({targets.length} scope{targets.length !== 1 ? 's' : ''})</p>
            {targets.map((t, i) => (
              <div key={i} className="text-foreground truncate py-0.5">
                {t.type === 'sa'
                  ? `${org.alias ?? org.subdomain} — subaccount`
                  : `${t.spaceName} › ${t.instanceName}`}
              </div>
            ))}
          </div>
          <div className="flex-1 overflow-auto border rounded p-2 space-y-0.5 text-xs">
            <p className="font-medium text-muted-foreground mb-1.5">{importItems.length} destination{importItems.length !== 1 ? 's' : ''}</p>
            {importItems.map((item, i) => (
              <div key={i} className="font-mono text-foreground truncate py-0.5">{String(item['Name'])}</div>
            ))}
          </div>
        </div>

        {/* Status / summary banner */}
        <div className={`relative px-3 py-2 rounded border text-xs overflow-hidden ${
            isDone && summary!.errors.length > 0 && summary!.created + summary!.updated === 0
              ? 'bg-destructive/5 border-destructive/20 text-destructive'
              : isDone && summary!.errors.length > 0
              ? 'bg-amber-500/5 border-amber-500/20 text-amber-700 dark:text-amber-400'
              : isDone
              ? 'bg-green-500/5 border-green-500/20 text-green-700 dark:text-green-400'
              : isRunning
              ? 'bg-muted/30 border-border text-muted-foreground'
              : 'bg-muted/20 border-border text-muted-foreground'
          }`}>
            {isRunning && progress && (
              <div className="absolute bottom-0 left-0 h-0.5 w-full bg-primary/20">
                <div
                  className="h-full bg-primary transition-all duration-200"
                  style={{ width: `${progress.total > 0 ? Math.round(progress.done / progress.total * 100) : 0}%` }}
                />
              </div>
            )}
            {isRunning && progress && (
              <span>
                {progress.done} of {progress.total} {progress.lastAction === 'created' ? 'created' : progress.lastAction === 'updated' ? 'updated' : progress.lastAction === 'error' ? 'failed' : 'pending'}
                {progress.lastDest ? `: ${progress.lastDest}` : ''}
              </span>
            )}
            {isDone && summary!.errors.length === 0 && (
              <span>
                Success: {summary!.created + summary!.updated} destination{summary!.created + summary!.updated !== 1 ? 's' : ''} imported
                ({summary!.created} created, {summary!.updated} updated) in {targets.length} scope{targets.length !== 1 ? 's' : ''}
              </span>
            )}
            {isDone && summary!.errors.length > 0 && (
              <div className="space-y-1">
                <span className="font-medium">
                  {summary!.created + summary!.updated > 0 ? 'Warning' : 'Error'}:{' '}
                  {summary!.created + summary!.updated} of {progress?.total ?? (importItems.length * targets.length)} destinations imported
                  ({summary!.created} created, {summary!.updated} updated) in {targets.length} scope{targets.length !== 1 ? 's' : ''};
                  however the following destinations failed:
                </span>
                <ul className="mt-1 space-y-0.5 list-none">
                  {summary!.errors.map((e, i) => <li key={i} className="font-mono truncate">{e}</li>)}
                </ul>
              </div>
            )}
            {!isRunning && !isDone && (
              <span>Existing destinations with matching names will be overwritten.</span>
            )}
          </div>

        <DialogFooter>
          {!isDone && <Button variant="outline" size="sm" onClick={onClose} disabled={isRunning}>Cancel</Button>}
          {!isDone && (
            <Button size="sm" onClick={() => onConfirm(targets)} disabled={isRunning || targets.length === 0 || importItems.length === 0}>
              Import {importItems.length} destination{importItems.length !== 1 ? 's' : ''}
            </Button>
          )}
          {isDone && <Button size="sm" onClick={onClose}>Close</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── DeleteDialog ─────────────────────────────────────────────────────────────

type DeleteTarget = { name: string; instanceGuid?: string; instanceName?: string; spaceName?: string };

function DeleteDialog({ open, onClose, org, targets, onConfirm, progress, summary }: {
  open: boolean; onClose: () => void;
  org: SubaccountEntry;
  targets: DeleteTarget[];
  onConfirm: () => void;
  progress: { done: number; total: number; lastName?: string } | null;
  summary: { deleted: number; errors: string[] } | null;
}) {
  const isRunning = progress !== null && summary === null;
  const isDone    = summary !== null;
  const pct       = progress && progress.total > 0 ? Math.round(progress.done / progress.total * 100) : 0;
  const saLabel   = org.alias ?? org.subdomain;

  return (
    <Dialog open={open} onOpenChange={v => { if (!v && !isRunning) onClose(); }}>
      <DialogContent className="max-w-xl w-full">
        <DialogHeader>
          <DialogTitle>Delete Destinations</DialogTitle>
        </DialogHeader>

        <div className="border rounded overflow-auto max-h-[300px]">
          <ul className="text-xs divide-y divide-border">
            {targets.map((t, i) => (
              <li key={i} className="px-3 py-1.5 font-mono truncate text-foreground">
                {org.region} &gt; {saLabel} ({org.subdomain}){t.spaceName ? ` > ${t.spaceName} > ${t.instanceName}` : ''} &gt; <span className="font-semibold">{t.name}</span>
              </li>
            ))}
          </ul>
        </div>

        {/* Status / summary banner */}
        <div className={`relative px-3 py-2 rounded border text-xs overflow-hidden ${
          isDone && summary!.errors.length > 0 && summary!.deleted === 0
            ? 'bg-destructive/5 border-destructive/20 text-destructive'
            : isDone && summary!.errors.length > 0
            ? 'bg-amber-500/5 border-amber-500/20 text-amber-700 dark:text-amber-400'
            : isDone
            ? 'bg-green-500/5 border-green-500/20 text-green-700 dark:text-green-400'
            : isRunning
            ? 'bg-muted/30 border-border text-muted-foreground'
            : 'bg-amber-500/5 border-amber-500/20 text-amber-700 dark:text-amber-400'
        }`}>
          {isRunning && progress && (
            <div className="absolute bottom-0 left-0 h-0.5 w-full bg-primary/20">
              <div className="h-full bg-primary transition-all duration-200" style={{ width: `${pct}%` }} />
            </div>
          )}
          {!isRunning && !isDone && (
            <span>This operation is not reversible. Consider exporting destinations as a backup before proceeding.</span>
          )}
          {isRunning && progress && (
            <span>{progress.done} of {progress.total} deleted{progress.lastName ? `: ${progress.lastName}` : ''}</span>
          )}
          {isDone && summary!.errors.length === 0 && (
            <span>Success: {summary!.deleted} destination{summary!.deleted !== 1 ? 's' : ''} deleted.</span>
          )}
          {isDone && summary!.errors.length > 0 && (
            <div className="space-y-1">
              <span className="font-medium">
                {summary!.deleted > 0 ? 'Warning' : 'Error'}: {summary!.deleted} of {targets.length} destination{targets.length !== 1 ? 's' : ''} deleted; however the following failed:
              </span>
              <ul className="mt-1 space-y-0.5 list-none">
                {summary!.errors.map((e, i) => <li key={i} className="font-mono truncate">{e}</li>)}
              </ul>
            </div>
          )}
        </div>

        <DialogFooter>
          {!isDone && <Button variant="outline" size="sm" onClick={onClose} disabled={isRunning}>Cancel</Button>}
          {!isDone && (
            <Button variant="destructive" size="sm" onClick={onConfirm} disabled={isRunning || targets.length === 0}>
              Delete {targets.length} destination{targets.length !== 1 ? 's' : ''}
            </Button>
          )}
          {isDone && <Button size="sm" onClick={onClose}>Close</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
