import { useEffect, useRef, useState } from 'react';
import { Eye, EyeOff, GripVertical, Plus, RotateCcw, Save, X } from 'lucide-react';
import MenusEditor from './MenusEditor';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MainSubscription { name: string; alias?: string; }
export interface Submenu  { text: string; url: string; public?: boolean; }
export interface MenuEntry { text: string; icon: string; submenus: Submenu[]; }
export interface SettingsData {
  homepage: {
    cockpit: { idp: string; host: string; };
    mainSubscriptions: MainSubscription[];
  };
  menus: MenuEntry[];
  variables?: Record<string, string>;
}

export interface VarEntry {
  key: string;
  description: string;
  sensitive: boolean;
  readonly: boolean;
  defaultValue: string;
  isEnvOverride: boolean;
  settingsOverride: string;
}

// ─── Nav items ────────────────────────────────────────────────────────────────

type NavItem = 'homepage' | 'menus' | 'aod' | 'variables';
const NAV_ITEMS: { id: NavItem; label: string }[] = [
  { id: 'homepage',  label: 'Homepage'                },
  { id: 'menus',     label: 'Menus'                   },
  { id: 'aod',       label: 'Application on Demand'   },
  { id: 'variables', label: 'Variables'               },
];

// ─── AOD data ─────────────────────────────────────────────────────────────────

export interface AodData { stopAppsUnusedAfterHrs?: number; excludeApps?: string[] }

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  data:            SettingsData;
  onChange:        (data: SettingsData) => void;
  isDirty:         boolean;
  isSaving:        boolean;
  onReset:         () => void;
  onSave:          () => void;
  saveStatus?:     { message: string; ok: boolean } | null;
  initialSection?: string;
  aodData?:        AodData | null;
  onAodChange?:    (d: AodData) => void;
  isAodDirty?:     boolean;
  isSavingAod?:    boolean;
  onAodReset?:     () => void;
  onAodSave?:      () => void;
  aodSaveStatus?:  { message: string; ok: boolean } | null;
}

// ─── Shared style tokens ──────────────────────────────────────────────────────

const btnBase    = 'inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
const btnOutline = `${btnBase} border border-border hover:bg-accent hover:text-accent-foreground`;
const btnPrimary = `${btnBase} bg-primary text-primary-foreground hover:bg-primary/90 px-3 py-1.5`;
const inpCls     = 'w-full text-xs bg-transparent border border-border rounded px-2 py-1 outline-none focus:border-primary placeholder:text-muted-foreground/40';

// ─── Main component ───────────────────────────────────────────────────────────

export default function SettingsPanel({
  data, onChange, isDirty, isSaving, onReset, onSave, saveStatus,
  initialSection, aodData, onAodChange, isAodDirty, isSavingAod,
  onAodReset, onAodSave, aodSaveStatus,
}: Props) {
  const [search, setSearch]     = useState('');
  const validInitial = (['homepage', 'menus', 'aod', 'variables'] as string[]).includes(initialSection ?? '') ? initialSection as NavItem : 'homepage';
  const [activeNav, setActiveNav] = useState<NavItem>(validInitial);

  // AOD variable overrides (STOP_APPS_UNUSED_AFTER_HRS saved via /api/settings/variables)
  const [aodVarOverride, setAodVarOverride] = useState<string>('');
  const [aodVarInitial, setAodVarInitial]   = useState<string>('');
  const [stopHrsDefault, setStopHrsDefault] = useState<string>('');
  const [isSavingAodVar, setIsSavingAodVar] = useState(false);

  // Variables section state (lifted from VariablesSection)
  const [vars, setVars]               = useState<VarEntry[] | null>(null);
  const [overrides, setOverrides]     = useState<Record<string, string>>({});
  const [shown, setShown]             = useState<Set<string>>(new Set());
  const [isSavingVars, setIsSavingVars] = useState(false);
  const [varsSaveStatus, setVarsSaveStatus] = useState<{ ok: boolean; message: string } | null>(null);
  const varsSaveTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const isAodVarDirty = aodVarOverride !== aodVarInitial;

  // Single fetch shared between AOD placeholder and Variables table
  useEffect(() => {
    void fetch('/api/settings/variables')
      .then(r => r.json() as Promise<{ ok: boolean; vars: VarEntry[] }>)
      .then(({ ok, vars: v }) => {
        if (!ok) return;
        setVars(v);
        const init: Record<string, string> = {};
        for (const entry of v) {
          if (!entry.readonly) init[entry.key] = entry.settingsOverride;
        }
        setOverrides(init);
        const stopEntry = v.find(e => e.key === 'STOP_APPS_UNUSED_AFTER_HRS');
        if (stopEntry) {
          setStopHrsDefault(stopEntry.defaultValue);
          const ov = stopEntry.settingsOverride || '';
          setAodVarOverride(ov);
          setAodVarInitial(ov);
        }
      })
      .catch(() => {});
  }, []);

  async function handleAodSaveWithVar() {
    setIsSavingAodVar(true);
    try {
      await fetch('/api/settings/variables', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ variables: { STOP_APPS_UNUSED_AFTER_HRS: aodVarOverride } }),
      });
      setAodVarInitial(aodVarOverride);
    } catch { /* non-fatal */ } finally {
      setIsSavingAodVar(false);
    }
    onAodSave?.();
  }

  async function handleVarsSave() {
    if (!vars) return;
    setIsSavingVars(true);
    clearTimeout(varsSaveTimerRef.current);
    try {
      const payload: Record<string, string> = {};
      for (const entry of vars) {
        if (entry.readonly) continue;
        payload[entry.key] = overrides[entry.key] ?? '';
      }
      const res  = await fetch('/api/settings/variables', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ variables: payload }),
      });
      const json = await res.json() as { ok: boolean; error?: string };
      if (!json.ok) throw new Error(json.error ?? 'Save failed');
      setVarsSaveStatus({ ok: true, message: 'Variables saved' });
      varsSaveTimerRef.current = setTimeout(() => setVarsSaveStatus(null), 4000);
    } catch (err) {
      setVarsSaveStatus({ ok: false, message: err instanceof Error ? err.message : 'Save failed' });
    } finally {
      setIsSavingVars(false);
    }
  }

  function toggleVarShow(key: string) {
    setShown(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  const q = search.trim().toLowerCase();
  const visibleItems = NAV_ITEMS.filter(n => !q || n.label.toLowerCase().includes(q));

  const isBusy = isSavingAod || isSavingAodVar || isSavingVars;

  return (
    <div className="flex flex-col sm:flex-row h-full">
      {/* Mobile: horizontal tab bar */}
      <div className="flex sm:hidden border-b border-border shrink-0 overflow-x-auto">
        {NAV_ITEMS.map(n => (
          <button
            key={n.id}
            onClick={() => setActiveNav(n.id)}
            className={`px-4 py-2 text-sm border-b-2 whitespace-nowrap transition-colors ${
              activeNav === n.id
                ? 'border-primary text-foreground font-medium'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {n.label}
          </button>
        ))}
      </div>

      {/* Desktop: left nav panel */}
      <div className="hidden sm:flex sm:flex-col sm:w-48 sm:shrink-0 sm:border-r border-border">
        <div className="p-2 border-b border-border">
          <input
            type="text"
            placeholder="Search…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full h-7 px-2 text-xs bg-transparent border border-border rounded outline-none focus:border-primary placeholder:text-muted-foreground/50"
          />
        </div>
        <nav className="flex-1 overflow-y-auto py-1">
          {visibleItems.map(n => (
            <button
              key={n.id}
              onClick={() => setActiveNav(n.id)}
              className={`w-full text-left px-3 py-2 text-sm transition-colors rounded-none ${
                activeNav === n.id
                  ? 'bg-accent text-accent-foreground font-medium'
                  : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
              }`}
            >
              {n.label}
            </button>
          ))}
        </nav>
      </div>

      {/* Right content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Action bar */}
        <div className="flex items-center gap-2 px-4 py-2 border-b border-border shrink-0">
          <span className="text-sm font-medium flex-1">
            {activeNav === 'homepage' ? 'Homepage'
              : activeNav === 'menus' ? 'Menus'
              : activeNav === 'aod' ? 'Application on Demand'
              : 'Variables'}
          </span>
          {activeNav === 'aod' ? (
            <>
              <button onClick={onAodReset} disabled={!isAodDirty || isBusy} className={btnOutline} title="Reset">
                <RotateCcw className="h-3.5 w-3.5" /><span className="hidden sm:inline"> Reset</span>
              </button>
              <button onClick={() => void handleAodSaveWithVar()} disabled={(!isAodDirty && !isAodVarDirty) || isBusy} className={btnPrimary} title={isBusy ? 'Saving…' : 'Save'}>
                <Save className="h-3.5 w-3.5" /><span className="hidden sm:inline"> {isBusy ? 'Saving…' : 'Save'}</span>
              </button>
            </>
          ) : activeNav === 'variables' ? (
            <button onClick={() => void handleVarsSave()} disabled={isSavingVars || !vars} className={btnPrimary} title={isSavingVars ? 'Saving…' : 'Save'}>
              <Save className="h-3.5 w-3.5" /><span className="hidden sm:inline"> {isSavingVars ? 'Saving…' : 'Save'}</span>
            </button>
          ) : (
            <>
              <button onClick={onReset} disabled={!isDirty || isSaving} className={btnOutline} title="Reset">
                <RotateCcw className="h-3.5 w-3.5" /><span className="hidden sm:inline"> Reset</span>
              </button>
              <button onClick={onSave} disabled={!isDirty || isSaving} className={btnPrimary} title={isSaving ? 'Saving…' : 'Save'}>
                <Save className="h-3.5 w-3.5" /><span className="hidden sm:inline"> {isSaving ? 'Saving…' : 'Save'}</span>
              </button>
            </>
          )}
        </div>

        {/* Save status banner */}
        {(activeNav === 'aod' ? aodSaveStatus : activeNav === 'variables' ? varsSaveStatus : saveStatus) && (() => {
          const st = activeNav === 'aod' ? aodSaveStatus : activeNav === 'variables' ? varsSaveStatus : saveStatus;
          return st ? (
            <div className="shrink-0 relative h-7 border-b border-border overflow-hidden">
              <div className={`absolute inset-y-0 left-0 w-full ${st.ok ? 'bg-green-500/50' : 'bg-destructive/50'}`} />
              <span className={`absolute inset-0 flex items-center justify-center text-[11px] font-medium px-2 truncate ${st.ok ? 'text-foreground' : 'text-destructive'}`}>
                {st.message}
              </span>
            </div>
          ) : null;
        })()}

        <div className="flex-1 overflow-y-auto">
          {activeNav === 'homepage' && (
            <HomepageSection data={data} onChange={onChange} />
          )}
          {activeNav === 'menus' && (
            <MenusSection data={data} onChange={onChange} />
          )}
          {activeNav === 'aod' && (
            <AodSection
              data={aodData ?? {}}
              onChange={onAodChange ?? (() => {})}
              stopHrsOverride={aodVarOverride}
              onStopHrsOverrideChange={setAodVarOverride}
              stopHrsDefault={stopHrsDefault}
            />
          )}
          {activeNav === 'variables' && (
            <VariablesSection
              vars={vars}
              overrides={overrides}
              onOverrideChange={(key, val) => setOverrides(prev => ({ ...prev, [key]: val }))}
              shown={shown}
              onToggleShow={toggleVarShow}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Homepage section ─────────────────────────────────────────────────────────

function HomepageSection({ data, onChange }: { data: SettingsData; onChange: (d: SettingsData) => void }) {
  const [dragging, setDragging] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const dragRef = useRef<number | null>(null);

  function setCockpit(field: 'idp' | 'host', val: string) {
    onChange({ ...data, homepage: { ...data.homepage, cockpit: { ...data.homepage.cockpit, [field]: val } } });
  }

  function setSubs(subs: MainSubscription[]) {
    onChange({ ...data, homepage: { ...data.homepage, mainSubscriptions: subs } });
  }

  function addSub() {
    setSubs([...data.homepage.mainSubscriptions, { name: '', alias: '' }]);
  }

  function deleteSub(i: number) {
    setSubs(data.homepage.mainSubscriptions.filter((_, j) => j !== i));
  }

  function updateSub(i: number, field: keyof MainSubscription, val: string) {
    setSubs(data.homepage.mainSubscriptions.map((s, j) =>
      j !== i ? s : { ...s, [field]: val || undefined }
    ));
  }

  function handleDragStart(e: React.DragEvent, i: number) {
    e.dataTransfer.setData('text/plain', String(i));
    dragRef.current = i;
    setDragging(i);
  }

  function handleDragEnd() {
    setDragging(null);
    setDragOver(null);
    dragRef.current = null;
  }

  function handleDragOver(e: React.DragEvent, i: number) {
    if (dragRef.current === null) return;
    e.preventDefault();
    setDragOver(i);
  }

  function handleDrop(e: React.DragEvent, targetI: number) {
    const from = dragRef.current;
    if (from === null) return;
    e.preventDefault();
    dragRef.current = null;
    setDragging(null);
    setDragOver(null);
    if (from === targetI) return;
    const next = [...data.homepage.mainSubscriptions];
    const [item] = next.splice(from, 1);
    next.splice(targetI, 0, item);
    setSubs(next);
  }

  const subs = data.homepage.mainSubscriptions;

  return (
    <div className="px-6 py-4 flex flex-col gap-6 max-w-2xl">
      {/* Cockpit */}
      <section>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3">Cockpit</h3>
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-3">
            <label className="text-xs text-muted-foreground w-24 shrink-0">IDP</label>
            <input
              className={inpCls}
              value={data.homepage.cockpit.idp}
              placeholder="sap.default"
              onChange={e => setCockpit('idp', e.target.value)}
            />
          </div>
          <div className="flex items-center gap-3">
            <label className="text-xs text-muted-foreground w-24 shrink-0">Host</label>
            <input
              className={inpCls}
              value={data.homepage.cockpit.host}
              placeholder="amer.cockpit.btp.cloud.sap"
              onChange={e => setCockpit('host', e.target.value)}
            />
          </div>
        </div>
      </section>

      {/* Main Subscriptions */}
      <section>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">Main Subscriptions</h3>
        <p className="text-xs text-muted-foreground mb-3">
          Only items listed here appear directly on the Homepage. Other subscriptions are grouped under a <em>More</em> dropdown.
        </p>
        <table className="w-full text-xs border-collapse">
          <thead>
            <tr className="border-b border-border">
              <th className="w-5" />
              <th className="text-left py-1 pr-2 text-muted-foreground font-medium">Subscription Name</th>
              <th className="text-left py-1 pr-2 text-muted-foreground font-medium w-32">Alias</th>
              <th className="w-6" />
            </tr>
          </thead>
          <tbody>
            {subs.map((s, i) => {
              const isDragging  = dragging === i;
              const isDragTarget = dragOver === i && dragging !== null && dragging !== i;
              return (
                <tr
                  key={i}
                  className={`border-b border-border/40 transition-opacity ${isDragging ? 'opacity-40' : ''} ${isDragTarget ? 'border-t-2 border-t-primary' : ''}`}
                  onDragOver={e => handleDragOver(e, i)}
                  onDrop={e => handleDrop(e, i)}
                >
                  <td className="py-1 pr-1">
                    <div
                      draggable
                      onDragStart={e => handleDragStart(e, i)}
                      onDragEnd={handleDragEnd}
                      className="text-muted-foreground/40 cursor-grab active:cursor-grabbing"
                      title="Drag to reorder"
                    >
                      <GripVertical className="h-3.5 w-3.5" />
                    </div>
                  </td>
                  <td className="py-1 pr-2">
                    <input
                      className={inpCls}
                      value={s.name}
                      placeholder="SAP Business Application Studio"
                      onChange={e => updateSub(i, 'name', e.target.value)}
                    />
                  </td>
                  <td className="py-1 pr-2">
                    <input
                      className={inpCls}
                      value={s.alias ?? ''}
                      placeholder="BAS"
                      onChange={e => updateSub(i, 'alias', e.target.value)}
                    />
                  </td>
                  <td>
                    <button
                      onClick={() => deleteSub(i)}
                      className="p-0.5 rounded text-muted-foreground/40 hover:text-destructive hover:bg-accent transition-colors"
                      title="Delete row"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <button onClick={addSub} className={`mt-2 ${btnOutline}`}>
          <Plus className="h-3.5 w-3.5" /> Add Row
        </button>
      </section>
    </div>
  );
}

// ─── Menus section ────────────────────────────────────────────────────────────

function MenusSection({ data, onChange }: { data: SettingsData; onChange: (d: SettingsData) => void }) {
  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-2 border-b border-border/40 bg-muted/10">
        <p className="text-xs text-muted-foreground">
          <span className="font-medium">public</span> items are visible to users who are not logged in.
          {' '}Icon names can be found at{' '}
          <a href="https://lucide.dev/icons" target="_blank" rel="noopener noreferrer" className="underline hover:text-foreground">
            lucide.dev/icons
          </a>
        </p>
      </div>
      <div className="flex-1 overflow-auto">
        <MenusEditor
          data={data.menus}
          onChange={menus => onChange({ ...data, menus })}
        />
      </div>
    </div>
  );
}

// ─── AOD section ──────────────────────────────────────────────────────────────

interface AodSectionProps {
  data: AodData;
  onChange: (d: AodData) => void;
  stopHrsOverride: string;
  onStopHrsOverrideChange: (val: string) => void;
  stopHrsDefault: string;
}

function AodSection({ data, onChange, stopHrsOverride, onStopHrsOverrideChange, stopHrsDefault }: AodSectionProps) {
  const patterns = data.excludeApps ?? [];

  function updatePattern(i: number, val: string) {
    const next = patterns.map((p, j) => j === i ? val : p);
    onChange({ ...data, excludeApps: next });
  }

  function deletePattern(i: number) {
    onChange({ ...data, excludeApps: patterns.filter((_, j) => j !== i) });
  }

  function addPattern() {
    onChange({ ...data, excludeApps: [...patterns, ''] });
  }

  return (
    <div className="p-4 max-w-xl space-y-6">
      <div>
        <label className="block text-xs font-medium text-muted-foreground mb-1">
          Stop apps unused after (hours)
        </label>
        <input
          type="number"
          min={0}
          step={1}
          value={stopHrsOverride}
          onChange={e => onStopHrsOverrideChange(e.target.value)}
          placeholder={stopHrsDefault || 'e.g. 120'}
          className={inpCls}
          style={{ maxWidth: 120 }}
        />
        <p className="text-[11px] text-muted-foreground/70 mt-1">
          Apps idle for this many hours will be stopped. Leave blank to use the configured default{stopHrsDefault ? ` (${stopHrsDefault} hrs)` : ''}. Saved in Settings → Variables.
        </p>
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-medium text-muted-foreground">Exclude Apps (patterns)</span>
          <button onClick={addPattern} className={btnOutline}>
            <Plus className="h-3 w-3" /> Add Row
          </button>
        </div>
        {patterns.length === 0 ? (
          <p className="text-[11px] text-muted-foreground/50">No exclusion patterns — all eligible apps will be managed.</p>
        ) : (
          <div className="space-y-1">
            {patterns.map((pat, i) => (
              <div key={i} className="flex items-center gap-1">
                <input
                  type="text"
                  value={pat}
                  onChange={e => updatePattern(i, e.target.value)}
                  placeholder="app-name-prefix*"
                  className={`${inpCls} flex-1 font-mono`}
                />
                <button onClick={() => deletePattern(i)} className="p-1 text-muted-foreground hover:text-destructive transition-colors">
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Variables section ────────────────────────────────────────────────────────

interface VariablesSectionProps {
  vars: VarEntry[] | null;
  overrides: Record<string, string>;
  onOverrideChange: (key: string, val: string) => void;
  shown: Set<string>;
  onToggleShow: (key: string) => void;
}

function VariablesSection({ vars, overrides, onOverrideChange, shown, onToggleShow }: VariablesSectionProps) {
  if (!vars) {
    return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Loading…</div>;
  }

  return (
    <div className="p-4 flex flex-col gap-4 max-w-4xl">
      <p className="text-xs text-muted-foreground">
        Override runtime variables. Overrides are stored in <code className="font-mono bg-muted/40 px-1 rounded">settings.json</code> and take effect immediately (highest priority over env vars and config.json).
      </p>

      <div className="overflow-x-auto">
        <table className="w-full text-xs border-collapse" style={{ tableLayout: 'fixed' }}>
          <colgroup>
            <col style={{ width: '25%' }} />
            <col style={{ width: '37.5%' }} />
            <col style={{ width: '37.5%' }} />
          </colgroup>
          <thead>
            <tr className="border-b border-border">
              <th className="text-left py-2 pr-3 font-medium text-muted-foreground">Variable</th>
              <th className="text-left py-2 pr-3 font-medium text-muted-foreground">Default Value</th>
              <th className="text-left py-2 font-medium text-muted-foreground">Override</th>
            </tr>
          </thead>
          <tbody>
            {vars.map(entry => {
              const showVal = shown.has(entry.key);
              const isReadonly = entry.readonly;
              return (
                <tr key={entry.key} className="border-b border-border/30 align-top">
                  {/* Column 1: key + description */}
                  <td className="py-2 pr-3">
                    <div className="font-mono text-foreground">{entry.key}</div>
                    <div className="text-[11px] text-muted-foreground/70 mt-0.5 leading-tight">{entry.description}</div>
                  </td>
                  {/* Column 2: effective default + ENV badge */}
                  <td className="py-2 pr-3">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className={`font-mono break-all ${entry.defaultValue ? 'text-muted-foreground' : 'text-muted-foreground/40 italic'}`}>
                        {entry.defaultValue || '—'}
                      </span>
                      {entry.isEnvOverride && entry.defaultValue && (
                        <span className="shrink-0 text-[10px] px-1 py-0.5 rounded bg-amber-500/15 text-amber-600 dark:text-amber-400 font-medium border border-amber-500/25">
                          ENV
                        </span>
                      )}
                    </div>
                  </td>
                  {/* Column 3: override input */}
                  <td className="py-2">
                    {isReadonly ? (
                      <div className="space-y-1">
                        <input
                          type="text"
                          disabled
                          value=""
                          placeholder="Read-only"
                          className={`${inpCls} opacity-40 cursor-not-allowed max-w-xs`}
                        />
                        <p className="text-[10px] text-muted-foreground/60">Set via environment variable or config.json</p>
                      </div>
                    ) : entry.sensitive ? (
                      <div className="flex items-center gap-1 max-w-xs">
                        <input
                          type={showVal ? 'text' : 'password'}
                          value={overrides[entry.key] ?? ''}
                          onChange={e => onOverrideChange(entry.key, e.target.value)}
                          placeholder="Leave blank to use default"
                          className={`${inpCls} flex-1 font-mono`}
                          autoComplete="off"
                        />
                        <button
                          type="button"
                          onClick={() => onToggleShow(entry.key)}
                          className="p-1 text-muted-foreground hover:text-foreground transition-colors"
                          title={showVal ? 'Hide' : 'Show'}
                        >
                          {showVal ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                        </button>
                      </div>
                    ) : (
                      <input
                        type="text"
                        value={overrides[entry.key] ?? ''}
                        onChange={e => onOverrideChange(entry.key, e.target.value)}
                        placeholder="Leave blank to use default"
                        className={`${inpCls} max-w-xs font-mono`}
                      />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
