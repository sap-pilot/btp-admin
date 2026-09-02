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
  aod?: {
    regionalEndpoints?: Record<string, string>;
    excludeApps?: string[];
  };
  sites?: Array<{ name: string; url: string; legacyUrls?: string[] }>;
  statusPage?: {
    landscapes?: Array<{ name: string; diagram: string }>;
    services?: unknown[];
  };
}

interface ConfigDefaults {
  aod:        { regionalEndpoints: Record<string, string>; excludeApps: string[] };
  sites:      Array<{ name: string; url: string }>;
  statusPage: { landscapes: Array<{ name: string; diagram: string }>; services: unknown[] };
}

export interface VarEntry {
  key: string;
  description: string;
  sensitive: boolean;
  readonly: boolean;
  custom: boolean;
  defaultValue: string;
  isEnvOverride: boolean;
  settingsOverride: string;
}

// ─── Nav items ────────────────────────────────────────────────────────────────

type NavItem = 'homepage' | 'menus' | 'sites' | 'aod' | 'statusPage' | 'variables';
const NAV_ITEMS: { id: NavItem; label: string }[] = [
  { id: 'homepage',   label: 'Homepage'                },
  { id: 'menus',      label: 'Menus'                   },
  { id: 'sites',      label: 'Sites'                   },
  { id: 'aod',        label: 'Application on Demand'   },
  { id: 'statusPage', label: 'Status Page'             },
  { id: 'variables',  label: 'Variables'               },
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
}

// ─── Shared style tokens ──────────────────────────────────────────────────────

const btnBase    = 'inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
const btnOutline = `${btnBase} border border-border hover:bg-accent hover:text-accent-foreground`;
const btnPrimary = `${btnBase} bg-primary text-primary-foreground hover:bg-primary/90 px-3 py-1.5`;
const inpCls     = 'w-full text-xs bg-transparent border border-border rounded px-2 py-1 outline-none focus:border-primary placeholder:text-muted-foreground/40';

// ─── Main component ───────────────────────────────────────────────────────────

export default function SettingsPanel({
  data, onChange, isDirty, isSaving, onReset, onSave, saveStatus,
  initialSection,
}: Props) {
  const [search, setSearch]     = useState('');
  const validInitial = (['homepage', 'menus', 'sites', 'aod', 'statusPage', 'variables'] as string[]).includes(initialSection ?? '') ? initialSection as NavItem : 'homepage';
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

  // Fetch config-level defaults for AOD, Sites, Status Page
  const [configDefaults, setConfigDefaults] = useState<ConfigDefaults | null>(null);
  useEffect(() => {
    void fetch('/api/settings/defaults')
      .then(r => r.json() as Promise<{ ok: boolean; defaults: ConfigDefaults }>)
      .then(({ ok, defaults }) => { if (ok) setConfigDefaults(defaults); })
      .catch(() => {});
  }, []);

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
    // also save settings data (includes data.aod regional endpoints / exclude apps)
    onSave();
  }

  async function handleVarsSave() {
    if (!vars) return;
    setIsSavingVars(true);
    clearTimeout(varsSaveTimerRef.current);
    try {
      // Iterate overrides (not vars) so deleted custom vars with '' are included
      const readonlyKeys = new Set(vars.filter(e => e.readonly).map(e => e.key));
      const payload: Record<string, string> = {};
      for (const [key, val] of Object.entries(overrides)) {
        if (readonlyKeys.has(key)) continue;
        payload[key] = val;
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

  function handleDeleteVar(key: string) {
    setVars(prev => prev?.filter(e => e.key !== key) ?? prev);
    setOverrides(prev => ({ ...prev, [key]: '' }));
  }

  function handleAddVar(key: string, val: string) {
    const entry: VarEntry = { key, description: '', sensitive: false, readonly: false, custom: true, defaultValue: '', isEnvOverride: false, settingsOverride: val };
    setVars(prev => [...(prev ?? []), entry]);
    setOverrides(prev => ({ ...prev, [key]: val }));
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

  const isBusy = isSavingAodVar || isSavingVars;

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
              : activeNav === 'sites' ? 'Sites'
              : activeNav === 'aod' ? 'Application on Demand'
              : activeNav === 'statusPage' ? 'Status Page'
              : 'Variables'}
          </span>
          {activeNav === 'aod' ? (
            <>
              <button onClick={onReset} disabled={(!isAodVarDirty && !isDirty) || isBusy} className={btnOutline} title="Reset">
                <RotateCcw className="h-3.5 w-3.5" /><span className="hidden sm:inline"> Reset</span>
              </button>
              <button onClick={() => void handleAodSaveWithVar()} disabled={(!isAodVarDirty && !isDirty) || isBusy} className={btnPrimary} title={isBusy ? 'Saving…' : 'Save'}>
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
        {(activeNav === 'variables' ? varsSaveStatus : saveStatus) && (() => {
          const st = activeNav === 'variables' ? varsSaveStatus : saveStatus;
          return st ? (
            <div className="shrink-0 relative h-7 border-b border-border overflow-hidden">
              <div className={`absolute inset-y-0 left-0 w-full ${st.ok ? 'bg-green-500/50' : 'bg-destructive/50'}`} />
              <span className={`absolute inset-0 flex items-center justify-center text-[11px] font-medium px-2 truncate ${st.ok ? 'text-foreground' : 'text-destructive'}`}>
                {st.message}
              </span>
            </div>
          ) : null;
        })()}

        <div className="flex-1 overflow-hidden flex flex-col">
          {activeNav === 'homepage' && (
            <div className="overflow-y-auto flex-1">
              <HomepageSection data={data} onChange={onChange} />
            </div>
          )}
          {activeNav === 'menus' && (
            <MenusSection data={data} onChange={onChange} />
          )}
          {activeNav === 'sites' && (
            <SitesSection
              sitesDefault={configDefaults?.sites ?? []}
              sitesOverride={data.sites}
              onChange={v => onChange({ ...data, sites: v })}
            />
          )}
          {activeNav === 'aod' && (
            <div className="overflow-y-auto flex-1">
              <AodSection
                stopHrsOverride={aodVarOverride}
                onStopHrsOverrideChange={setAodVarOverride}
                stopHrsDefault={stopHrsDefault}
                aodOverride={data.aod}
                onAodOverrideChange={v => onChange({ ...data, aod: v })}
                aodDefaults={configDefaults?.aod ?? { regionalEndpoints: {}, excludeApps: [] }}
              />
            </div>
          )}
          {activeNav === 'statusPage' && (
            <StatusPageSection
              statusPageOverride={data.statusPage}
              onStatusPageChange={v => onChange({ ...data, statusPage: v })}
              statusPageDefaults={configDefaults?.statusPage ?? { landscapes: [], services: [] }}
            />
          )}
          {activeNav === 'variables' && (
            <div className="overflow-y-auto flex-1">
              <VariablesSection
                vars={vars}
                overrides={overrides}
                onOverrideChange={(key, val) => setOverrides(prev => ({ ...prev, [key]: val }))}
                shown={shown}
                onToggleShow={toggleVarShow}
                onDeleteVar={handleDeleteVar}
                onAddVar={handleAddVar}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Shared 2-pane JSON editor ────────────────────────────────────────────────

const preCls      = 'text-[11px] font-mono bg-muted/30 border border-border rounded p-2 overflow-auto whitespace-pre-wrap break-all';
const textareaCls = 'w-full text-[11px] font-mono bg-transparent border border-border rounded p-2 outline-none focus:border-primary placeholder:text-muted-foreground/40';

interface TwoPaneProps {
  label:        string;
  tip?:         React.ReactNode;
  defaultValue: unknown;
  value:        string;
  onChange:     (v: string) => void;
  placeholder?: string;
  error?:       string;
  /** When true the panes grow to fill the parent's remaining height (parent must be a flex column with overflow hidden). */
  stretch?:     boolean;
}

function TwoPane({ label, tip, defaultValue, value, onChange, placeholder, error, stretch }: TwoPaneProps) {
  const pretty = defaultValue != null && (Array.isArray(defaultValue) ? defaultValue.length > 0 : Object.keys(defaultValue as object).length > 0)
    ? JSON.stringify(defaultValue, null, 2)
    : '';
  const preH      = stretch ? 'h-full' : 'max-h-48';
  const textareaH = stretch ? 'h-full resize-none' : 'resize-y min-h-[80px] max-h-48';
  return (
    <div className={`space-y-1.5${stretch ? ' flex flex-col flex-1 min-h-0' : ''}`}>
      <div className="text-xs font-medium text-foreground shrink-0">{label}</div>
      {tip && <p className="text-[11px] text-muted-foreground/70 leading-snug shrink-0">{tip}</p>}
      <div className={`grid grid-cols-2 gap-3${stretch ? ' flex-1 min-h-0' : ''}`}>
        <div className={stretch ? 'flex flex-col min-h-0' : ''}>
          <div className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1 shrink-0">Default</div>
          <pre className={`${preCls} ${preH}`}>{pretty || '—'}</pre>
        </div>
        <div className={stretch ? 'flex flex-col min-h-0' : ''}>
          <div className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1 shrink-0">Override</div>
          <textarea
            value={value}
            onChange={e => onChange(e.target.value)}
            placeholder={placeholder ?? 'Leave blank to use default'}
            className={`${textareaCls} ${textareaH} ${error ? 'border-destructive' : 'border-border'}`}
            spellCheck={false}
          />
          {error && <p className="text-[10px] text-destructive mt-0.5 shrink-0">{error}</p>}
        </div>
      </div>
    </div>
  );
}

function tryParseJson<T>(s: string): T | undefined {
  if (!s.trim()) return undefined;
  try { return JSON.parse(s) as T; } catch { return undefined; }
}

// ─── Homepage section ─────────────────────────────────────────────────────────

function HomepageSection({ data, onChange }: {
  data: SettingsData;
  onChange: (d: SettingsData) => void;
}) {
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

// ─── Sites section ────────────────────────────────────────────────────────────

function SitesSection({ sitesDefault, sitesOverride, onChange }: {
  sitesDefault:  Array<{ name: string; url: string }>;
  sitesOverride?: Array<{ name: string; url: string; legacyUrls?: string[] }>;
  onChange: (v: SettingsData['sites']) => void;
}) {
  const [str, setStr] = useState(() =>
    sitesOverride && sitesOverride.length > 0 ? JSON.stringify(sitesOverride, null, 2) : '',
  );
  const [err, setErr] = useState('');

  function handleChange(v: string) {
    setStr(v);
    if (!v.trim()) { setErr(''); onChange(undefined); return; }
    const parsed = tryParseJson<Array<{ name: string; url: string }>>(v);
    if (!parsed || !Array.isArray(parsed)) { setErr('Invalid JSON array'); return; }
    setErr('');
    onChange(parsed);
  }

  return (
    <div className="flex flex-col h-full p-4">
      <p className="text-xs text-muted-foreground mb-4 shrink-0">
        Override the site switcher entries shown in the header. The app uses this list first; falls back to <code className="font-mono bg-muted/40 px-0.5 rounded">config.json→sites</code> when absent.
      </p>
      <TwoPane
        label="Site Switcher"
        tip={<>Array of <code className="font-mono bg-muted/40 px-0.5 rounded">{"{ name, url }"}</code> objects (optionally with <code className="font-mono bg-muted/40 px-0.5 rounded">legacyUrls</code>).</>}
        defaultValue={sitesDefault}
        value={str}
        onChange={handleChange}
        placeholder={'[\n  { "name": "Prod", "url": "https://..." }\n]'}
        error={err}
        stretch
      />
    </div>
  );
}

// ─── AOD section ──────────────────────────────────────────────────────────────

interface AodSectionProps {
  stopHrsOverride:      string;
  onStopHrsOverrideChange: (val: string) => void;
  stopHrsDefault:       string;
  aodOverride:          SettingsData['aod'];
  onAodOverrideChange:  (v: SettingsData['aod']) => void;
  aodDefaults:          { regionalEndpoints: Record<string, string>; excludeApps: string[] };
}

function AodSection({
  stopHrsOverride, onStopHrsOverrideChange, stopHrsDefault,
  aodOverride, onAodOverrideChange, aodDefaults,
}: AodSectionProps) {
  const [endpointsStr, setEndpointsStr] = useState(() =>
    aodOverride?.regionalEndpoints && Object.keys(aodOverride.regionalEndpoints).length > 0
      ? JSON.stringify(aodOverride.regionalEndpoints, null, 2) : '',
  );
  const [endpointsErr, setEndpointsErr] = useState('');

  const [excludeStr, setExcludeStr] = useState(() =>
    aodOverride?.excludeApps && aodOverride.excludeApps.length > 0
      ? JSON.stringify(aodOverride.excludeApps, null, 2) : '',
  );
  const [excludeErr, setExcludeErr] = useState('');

  function handleEndpointsChange(v: string) {
    setEndpointsStr(v);
    if (!v.trim()) {
      setEndpointsErr('');
      onAodOverrideChange({ ...aodOverride, regionalEndpoints: undefined });
      return;
    }
    const parsed = tryParseJson<Record<string, string>>(v);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      setEndpointsErr('Invalid JSON object');
      return;
    }
    setEndpointsErr('');
    onAodOverrideChange({ ...aodOverride, regionalEndpoints: parsed });
  }

  function handleExcludeChange(v: string) {
    setExcludeStr(v);
    if (!v.trim()) {
      setExcludeErr('');
      onAodOverrideChange({ ...aodOverride, excludeApps: undefined });
      return;
    }
    const parsed = tryParseJson<string[]>(v);
    if (!parsed || !Array.isArray(parsed)) { setExcludeErr('Invalid JSON array'); return; }
    setExcludeErr('');
    onAodOverrideChange({ ...aodOverride, excludeApps: parsed });
  }

  return (
    <div className="flex flex-col h-full p-4">
      {/* Stop hours (variable override) */}
      <div className="shrink-0 mb-6">
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

      {/* Regional Proxy Endpoint */}
      <div className="shrink-0 mb-6">
        <TwoPane
          label="Regional Proxy Endpoint"
          tip="Map of CF region → proxy URL used to start AOD apps. Override here to change routing without restarting."
          defaultValue={aodDefaults.regionalEndpoints}
          value={endpointsStr}
          onChange={handleEndpointsChange}
          placeholder={'{\n  "us10": "https://...",\n  "eu10": "https://..."\n}'}
          error={endpointsErr}
        />
      </div>

      {/* Exclude Apps — stretches to fill remaining height */}
      <TwoPane
        label="Exclude Apps (patterns)"
        tip={<>Array of app-name patterns excluded from auto-stop. Wildcards are supported — e.g. <code className="font-mono bg-muted/40 px-0.5 rounded">my-job-scheduler-app*</code> excludes all apps with that prefix. Override here to change exclusions without restarting.</>}
        defaultValue={aodDefaults.excludeApps}
        value={excludeStr}
        onChange={handleExcludeChange}
        placeholder={'[\n  "my-job-scheduler-app*",\n  "another-app"\n]'}
        error={excludeErr}
        stretch
      />
    </div>
  );
}

// ─── Status Page section ──────────────────────────────────────────────────────

interface StatusPageSectionProps {
  statusPageOverride?: SettingsData['statusPage'];
  onStatusPageChange: (v: SettingsData['statusPage']) => void;
  statusPageDefaults: { landscapes: Array<{ name: string; diagram: string }>; services: unknown[] };
}

function StatusPageSection({ statusPageOverride, onStatusPageChange, statusPageDefaults }: StatusPageSectionProps) {
  const [landscapesStr, setLandscapesStr] = useState(() =>
    statusPageOverride?.landscapes && statusPageOverride.landscapes.length > 0
      ? JSON.stringify(statusPageOverride.landscapes, null, 2) : '',
  );
  const [landscapesErr, setLandscapesErr] = useState('');

  const [servicesStr, setServicesStr] = useState(() =>
    statusPageOverride?.services && statusPageOverride.services.length > 0
      ? JSON.stringify(statusPageOverride.services, null, 2) : '',
  );
  const [servicesErr, setServicesErr] = useState('');

  function handleLandscapesChange(v: string) {
    setLandscapesStr(v);
    if (!v.trim()) {
      setLandscapesErr('');
      onStatusPageChange({ ...statusPageOverride, landscapes: undefined });
      return;
    }
    const parsed = tryParseJson<Array<{ name: string; diagram: string }>>(v);
    if (!parsed || !Array.isArray(parsed)) { setLandscapesErr('Invalid JSON array'); return; }
    setLandscapesErr('');
    onStatusPageChange({ ...statusPageOverride, landscapes: parsed });
  }

  function handleServicesChange(v: string) {
    setServicesStr(v);
    if (!v.trim()) {
      setServicesErr('');
      onStatusPageChange({ ...statusPageOverride, services: undefined });
      return;
    }
    const parsed = tryParseJson<unknown[]>(v);
    if (!parsed || !Array.isArray(parsed)) { setServicesErr('Invalid JSON array'); return; }
    setServicesErr('');
    onStatusPageChange({ ...statusPageOverride, services: parsed });
  }

  return (
    <div className="flex flex-col h-full p-4">
      <p className="text-xs text-muted-foreground mb-4 shrink-0">
        Override the landscapes and service definitions used on the Status page. Changes take effect immediately for display; the probe scheduler restarts automatically when service definitions change.
      </p>

      {/* Landscapes — fixed height, both panes equal */}
      <div className="mb-6 shrink-0">
        <TwoPane
          label="Landscapes"
          tip={<>Array of <code className="font-mono bg-muted/40 px-0.5 rounded">{"{ name, diagram }"}</code> objects. Draft and preview Mermaid diagrams at <a href="https://mermaid.live/edit" target="_blank" rel="noopener noreferrer" className="underline hover:text-foreground">mermaid.live/edit</a>.</>}
          defaultValue={statusPageDefaults.landscapes}
          value={landscapesStr}
          onChange={handleLandscapesChange}
          placeholder={'[\n  { "name": "US", "diagram": "graph LR..." }\n]'}
          error={landscapesErr}
        />
      </div>

      {/* Services — stretches to fill remaining height */}
      <TwoPane
        label="Services"
        tip={<>Array of service probe definitions. See the <a href="https://github.com/sap-pilot/btp-admin#status-page-configuration" target="_blank" rel="noopener noreferrer" className="underline hover:text-foreground">status page configuration docs</a> for the schema.</>}
        defaultValue={statusPageDefaults.services}
        value={servicesStr}
        onChange={handleServicesChange}
        placeholder={'[\n  { "group": "...", "name": "...", "endpoints": [...] }\n]'}
        error={servicesErr}
        stretch
      />
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
  onDeleteVar: (key: string) => void;
  onAddVar: (key: string, val: string) => void;
}

function VariablesSection({ vars, overrides, onOverrideChange, shown, onToggleShow, onDeleteVar, onAddVar }: VariablesSectionProps) {
  const [newKey, setNewKey] = useState('');
  const [newVal, setNewVal] = useState('');
  const [newKeyErr, setNewKeyErr] = useState('');

  function submitAdd() {
    const k = newKey.trim();
    if (!k) { setNewKeyErr('Key is required'); return; }
    if (!/^[A-Z0-9_]+$/.test(k)) { setNewKeyErr('Use uppercase letters, digits, and underscores only'); return; }
    if (vars?.some(e => e.key === k)) { setNewKeyErr('Key already exists'); return; }
    setNewKeyErr('');
    onAddVar(k, newVal);
    setNewKey('');
    setNewVal('');
  }

  if (!vars) {
    return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Loading…</div>;
  }

  return (
    <div className="p-4 flex flex-col gap-4 max-w-4xl">
      <p className="text-xs text-muted-foreground">
        Override runtime variables. Overrides are stored in <code className="font-mono bg-muted/40 px-1 rounded">settings.json</code> and take effect immediately (highest priority over env vars and config.json). Custom variables (not in the predefined list) can be added and deleted.
      </p>

      <div className="overflow-x-auto">
        <table className="w-full text-xs border-collapse" style={{ tableLayout: 'fixed' }}>
          <colgroup>
            <col style={{ width: '25%' }} />
            <col style={{ width: '35%' }} />
            <col style={{ width: '40%' }} />
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
                    {entry.description && (
                      <div className="text-[11px] text-muted-foreground/70 mt-0.5 leading-tight">{entry.description}</div>
                    )}
                    {entry.custom && (
                      <span className="text-[10px] px-1 py-0.5 rounded bg-muted/60 text-muted-foreground font-medium">custom</span>
                    )}
                  </td>
                  {/* Column 2: effective default + ENV badge */}
                  <td className="py-2 pr-3">
                    {entry.custom ? (
                      <span className="text-muted-foreground/40 italic text-[11px]">—</span>
                    ) : (
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
                    )}
                  </td>
                  {/* Column 3: override input + optional delete */}
                  <td className="py-2">
                    <div className="flex items-center gap-1">
                      {isReadonly ? (
                        <div className="space-y-1 flex-1">
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
                        <div className="flex items-center gap-1 flex-1 max-w-xs">
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
                          className={`${inpCls} flex-1 max-w-xs font-mono`}
                        />
                      )}
                      {entry.custom && (
                        <button
                          type="button"
                          onClick={() => onDeleteVar(entry.key)}
                          className="p-1 text-muted-foreground hover:text-destructive transition-colors shrink-0"
                          title="Delete custom variable"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
            {/* Add new custom variable row */}
            <tr className="align-top">
              <td className="pt-3 pr-3">
                <input
                  type="text"
                  value={newKey}
                  onChange={e => { setNewKey(e.target.value.toUpperCase()); setNewKeyErr(''); }}
                  onKeyDown={e => { if (e.key === 'Enter') submitAdd(); }}
                  placeholder="NEW_VAR_KEY"
                  className={`${inpCls} font-mono ${newKeyErr ? 'border-destructive' : ''}`}
                />
                {newKeyErr && <p className="text-[10px] text-destructive mt-0.5">{newKeyErr}</p>}
              </td>
              <td className="pt-3 pr-3">
                <span className="text-[11px] text-muted-foreground/50 italic">custom</span>
              </td>
              <td className="pt-3">
                <div className="flex items-center gap-1 max-w-xs">
                  <input
                    type="text"
                    value={newVal}
                    onChange={e => setNewVal(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') submitAdd(); }}
                    placeholder="value"
                    className={`${inpCls} flex-1 font-mono`}
                  />
                  <button
                    type="button"
                    onClick={submitAdd}
                    className={`${btnOutline} shrink-0`}
                    title="Add variable"
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
