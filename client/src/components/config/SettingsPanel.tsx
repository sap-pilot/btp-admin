import { useRef, useState } from 'react';
import { GripVertical, Plus, RotateCcw, Save, X } from 'lucide-react';
import MenusEditor from './MenusEditor';

// ─── Types (re-exported so AppLayout can import them) ─────────────────────────

export interface MainSubscription { name: string; alias?: string; }
export interface Submenu  { text: string; url: string; public?: boolean; }
export interface MenuEntry { text: string; icon: string; submenus: Submenu[]; }
export interface SettingsData {
  homepage: {
    cockpit: { idp: string; host: string; };
    mainSubscriptions: MainSubscription[];
  };
  menus: MenuEntry[];
}

// ─── Nav items ────────────────────────────────────────────────────────────────

type NavItem = 'homepage' | 'menus';
const NAV_ITEMS: { id: NavItem; label: string }[] = [
  { id: 'homepage', label: 'Homepage' },
  { id: 'menus',    label: 'Menus'    },
];

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  data:           SettingsData;
  onChange:       (data: SettingsData) => void;
  isDirty:        boolean;
  isSaving:       boolean;
  onReset:        () => void;
  onSave:         () => void;
  saveStatus?:    { message: string; ok: boolean } | null;
  initialSection?: string;
}

// ─── Shared style tokens ──────────────────────────────────────────────────────

const btnBase    = 'inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
const btnOutline = `${btnBase} border border-border hover:bg-accent hover:text-accent-foreground`;
const btnPrimary = `${btnBase} bg-primary text-primary-foreground hover:bg-primary/90 px-3 py-1.5`;
const inpCls     = 'w-full text-xs bg-transparent border border-border rounded px-2 py-1 outline-none focus:border-primary placeholder:text-muted-foreground/40';

// ─── Main component ───────────────────────────────────────────────────────────

export default function SettingsPanel({ data, onChange, isDirty, isSaving, onReset, onSave, saveStatus, initialSection }: Props) {
  const [search, setSearch]     = useState('');
  const validInitial = (['homepage', 'menus'] as string[]).includes(initialSection ?? '') ? initialSection as NavItem : 'homepage';
  const [activeNav, setActiveNav] = useState<NavItem>(validInitial);

  const q = search.trim().toLowerCase();
  const visibleItems = NAV_ITEMS.filter(n => !q || n.label.toLowerCase().includes(q));

  return (
    <div className="flex h-full">
      {/* Left nav */}
      <div className="w-48 shrink-0 border-r border-border flex flex-col">
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
            {activeNav === 'homepage' ? 'Homepage' : 'Menus'}
          </span>
          <button onClick={onReset} disabled={!isDirty || isSaving} className={btnOutline}>
            <RotateCcw className="h-3.5 w-3.5" /> Reset
          </button>
          <button onClick={onSave} disabled={!isDirty || isSaving} className={btnPrimary}>
            <Save className="h-3.5 w-3.5" /> {isSaving ? 'Saving…' : 'Save'}
          </button>
        </div>

        {/* Save status banner */}
        {saveStatus && (
          <div className="shrink-0 relative h-7 border-b border-border overflow-hidden">
            <div className={`absolute inset-y-0 left-0 w-full ${saveStatus.ok ? 'bg-green-500/50' : 'bg-destructive/50'}`} />
            <span className={`absolute inset-0 flex items-center justify-center text-[11px] font-medium px-2 truncate ${saveStatus.ok ? 'text-foreground' : 'text-destructive'}`}>
              {saveStatus.message}
            </span>
          </div>
        )}

        <div className="flex-1 overflow-y-auto">
          {activeNav === 'homepage' && (
            <HomepageSection data={data} onChange={onChange} />
          )}
          {activeNav === 'menus' && (
            <MenusSection data={data} onChange={onChange} />
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
