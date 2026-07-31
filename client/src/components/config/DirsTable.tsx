import { useState } from 'react';
import { ChevronDown, ChevronRight, RotateCcw, Save, GripVertical, Plus, X } from 'lucide-react';

export interface DirEntry {
  alias: string;
  title: string;
  pos:   number;
}

export interface DirTab {
  tab:  string;
  dirs: DirEntry[];
}

interface Props {
  data:     DirTab[];
  onChange: (data: DirTab[]) => void;
  isDirty:  boolean;
  isSaving: boolean;
  onReset:  () => void;
  onSave:   () => void;
}

function matchesFilter(tab: DirTab, filter: string): { tabMatch: boolean; dirs: DirEntry[] } {
  if (!filter) return { tabMatch: true, dirs: tab.dirs };
  const q = filter.toLowerCase();
  const tabMatch = tab.tab.toLowerCase().includes(q);
  const dirs = tab.dirs.filter(d => d.alias.toLowerCase().includes(q) || d.title.toLowerCase().includes(q));
  return { tabMatch: tabMatch || dirs.length > 0, dirs: tabMatch ? tab.dirs : dirs };
}

export default function DirsTable({ data, onChange, isDirty, isSaving, onReset, onSave }: Props) {
  const [filter, setFilter]          = useState('');
  const [expanded, setExpanded]      = useState<Set<number>>(() => new Set(data.map((_, i) => i)));
  const [dragging, setDragging]      = useState<{ ti: number; di: number } | null>(null);
  const [dragOver, setDragOver]      = useState<{ ti: number; di: number } | null>(null);
  const [dragTab, setDragTab]        = useState<number | null>(null);
  const [dragOverTab, setDragOverTab] = useState<number | null>(null);

  const isFiltering = filter.trim().length > 0;

  function toggleTab(ti: number) {
    setExpanded(prev => {
      const next = new Set(prev);
      next.has(ti) ? next.delete(ti) : next.add(ti);
      return next;
    });
  }

  function updateTab(ti: number, patch: Partial<DirTab>) {
    onChange(data.map((t, i) => i !== ti ? t : { ...t, ...patch }));
  }

  function updateDir(ti: number, di: number, patch: Partial<DirEntry>) {
    onChange(data.map((t, i) =>
      i !== ti ? t : { ...t, dirs: t.dirs.map((d, j) => j !== di ? d : { ...d, ...patch }) },
    ));
  }

  function addTab() {
    const next = [...data, { tab: 'New Tab', dirs: [] }];
    onChange(next);
    setExpanded(prev => new Set([...prev, next.length - 1]));
  }

  function deleteTab(ti: number) {
    onChange(data.filter((_, i) => i !== ti));
    setExpanded(prev => {
      const next = new Set<number>();
      for (const v of prev) { if (v < ti) next.add(v); else if (v > ti) next.add(v - 1); }
      return next;
    });
  }

  function addDir(ti: number) {
    const dirs = [...data[ti]!.dirs, { alias: '', title: '', pos: data[ti]!.dirs.length }];
    onChange(data.map((t, i) => i !== ti ? t : { ...t, dirs }));
    setExpanded(prev => new Set([...prev, ti]));
  }

  function deleteDir(ti: number, di: number) {
    const dirs = data[ti]!.dirs.filter((_, j) => j !== di).map((d, idx) => ({ ...d, pos: idx }));
    onChange(data.map((t, i) => i !== ti ? t : { ...t, dirs }));
  }

  // Dir drag (within a tab)
  function handleDirDragStart(ti: number, di: number) { setDragging({ ti, di }); }

  function handleDirDragOver(e: React.DragEvent, ti: number, di: number) {
    e.preventDefault();
    if (dragging && dragging.ti === ti) setDragOver({ ti, di });
  }

  function handleDirDrop(e: React.DragEvent, ti: number, targetDi: number) {
    e.preventDefault();
    if (!dragging || dragging.ti !== ti) { setDragging(null); setDragOver(null); return; }
    const { di: fromDi } = dragging;
    if (fromDi === targetDi) { setDragging(null); setDragOver(null); return; }
    const dirs = [...data[ti]!.dirs];
    const [moved] = dirs.splice(fromDi, 1);
    dirs.splice(targetDi, 0, moved);
    onChange(data.map((t, i) => i !== ti ? t : { ...t, dirs: dirs.map((d, idx) => ({ ...d, pos: idx })) }));
    setDragging(null); setDragOver(null);
  }

  function handleDirDragEnd() { setDragging(null); setDragOver(null); }

  // Tab drag (reorder tabs)
  function handleTabDragStart(ti: number) { setDragTab(ti); }

  function handleTabDragOver(e: React.DragEvent, ti: number) {
    e.preventDefault();
    if (dragTab !== null && dragTab !== ti) setDragOverTab(ti);
  }

  function handleTabDrop(e: React.DragEvent, targetTi: number) {
    e.preventDefault();
    if (dragTab === null || dragTab === targetTi) { setDragTab(null); setDragOverTab(null); return; }
    const tabs = [...data];
    const [moved] = tabs.splice(dragTab, 1);
    tabs.splice(targetTi, 0, moved);
    onChange(tabs);
    // Remap expanded indices
    setExpanded(prev => {
      const arr = [...prev];
      const next = new Set<number>();
      for (const v of arr) {
        if (v === dragTab) { next.add(targetTi); continue; }
        // Shift indices for the move
        let nv = v;
        if (dragTab < targetTi) {
          if (v > dragTab && v <= targetTi) nv = v - 1;
        } else {
          if (v >= targetTi && v < dragTab) nv = v + 1;
        }
        next.add(nv);
      }
      return next;
    });
    setDragTab(null); setDragOverTab(null);
  }

  function handleTabDragEnd() { setDragTab(null); setDragOverTab(null); }

  const btnBase    = 'inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
  const btnOutline = `${btnBase} border border-border hover:bg-accent hover:text-accent-foreground`;
  const btnPrimary = `${btnBase} bg-primary text-primary-foreground hover:bg-primary/90`;
  const btnGhost   = 'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-accent transition-colors';

  const thCls    = 'px-2 py-1.5 text-left text-xs font-medium text-muted-foreground whitespace-nowrap border-b border-border';
  const rszThCls = `${thCls} overflow-hidden`;
  const tdCls  = 'px-2 py-1 text-xs border-b border-border align-middle';
  const inpCls = 'w-full bg-transparent border-b border-transparent hover:border-border focus:border-primary outline-none text-xs py-0.5 placeholder:text-muted-foreground/50';

  return (
    <div className="flex flex-col h-full">
      {/* Action bar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border shrink-0">
        <input
          type="text"
          placeholder="Filter tabs / dirs..."
          value={filter}
          onChange={e => setFilter(e.target.value)}
          className="flex-1 bg-transparent border border-border rounded px-2 py-1 text-xs outline-none focus:border-primary placeholder:text-muted-foreground/50"
        />
        {filter && (
          <button onClick={() => setFilter('')} className="text-xs text-muted-foreground hover:text-foreground shrink-0">
            Clear
          </button>
        )}
        <button
          onClick={() => setExpanded(new Set(data.map((_, i) => i)))}
          disabled={isFiltering}
          className={btnOutline}
          title="Expand all tabs"
        >
          Expand
        </button>
        <button
          onClick={() => setExpanded(new Set())}
          disabled={isFiltering}
          className={btnOutline}
          title="Collapse all tabs"
        >
          Collapse
        </button>
        <button onClick={onReset} disabled={!isDirty || isSaving} className={btnOutline} title="Restore to last saved state">
          <RotateCcw className="h-3.5 w-3.5" />
          Reset
        </button>
        <button onClick={onSave} disabled={!isDirty || isSaving} className={btnPrimary}>
          <Save className="h-3.5 w-3.5" />
          {isSaving ? 'Saving…' : 'Save'}
        </button>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto">
        <table className="w-full border-collapse text-sm min-w-[500px]">
          <thead className="sticky top-0 z-10">
            <tr className="bg-muted/40">
              <th className={`${thCls} w-6`} />
              <th className={rszThCls} style={{ resize: 'horizontal', minWidth: 120 }}>Tab / Dir Title</th>
              <th className={rszThCls} style={{ resize: 'horizontal', minWidth: 80 }}>Alias</th>
              <th className={`${thCls} w-8`} />
            </tr>
          </thead>
          <tbody>
            {data.length === 0 && !isFiltering && (
              <tr>
                <td colSpan={4} className="px-3 py-8 text-center text-sm text-muted-foreground">
                  No tabs yet. Click <strong>Add Tab</strong> below to create one.
                </td>
              </tr>
            )}
            {data.map((tab, ti) => {
              const { tabMatch, dirs: visibleDirs } = matchesFilter(tab, filter);
              if (isFiltering && !tabMatch) return null;
              const isTabDragging   = dragTab === ti;
              const isTabDropTarget = dragOverTab === ti;
              const isExpanded      = isFiltering || expanded.has(ti);

              return [
                // Tab header row
                <tr
                  key={`tab-${ti}`}
                  onDragOver={e => !isFiltering && handleTabDragOver(e, ti)}
                  onDrop={e => !isFiltering && handleTabDrop(e, ti)}
                  className={`bg-muted/20 select-none hover:bg-muted/30 ${isTabDragging ? 'opacity-40' : ''} ${isTabDropTarget ? 'border-t-2 border-primary' : ''}`}
                >
                  <td
                    draggable={!isFiltering}
                    onDragStart={() => !isFiltering && handleTabDragStart(ti)}
                    onDragEnd={handleTabDragEnd}
                    className={`${tdCls} w-6 text-muted-foreground ${!isFiltering ? 'cursor-grab active:cursor-grabbing' : ''}`}
                  >
                    {!isFiltering && <GripVertical className="h-3.5 w-3.5" />}
                  </td>
                  <td className="px-2 py-1 text-xs border-b border-border align-middle" colSpan={1}>
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={() => toggleTab(ti)}
                        className="shrink-0 text-muted-foreground hover:text-foreground"
                      >
                        {isExpanded
                          ? <ChevronDown className="h-3.5 w-3.5" />
                          : <ChevronRight className="h-3.5 w-3.5" />}
                      </button>
                      <input
                        className="font-semibold text-xs bg-transparent outline-none border-b border-transparent hover:border-border focus:border-primary py-0.5 min-w-0 flex-1"
                        value={tab.tab}
                        onChange={e => updateTab(ti, { tab: e.target.value })}
                        onClick={e => e.stopPropagation()}
                      />
                      <span className="text-xs text-muted-foreground shrink-0">({tab.dirs.length})</span>
                      <button onClick={() => addDir(ti)} className={`${btnGhost} shrink-0`} title="Add directory">
                        <Plus className="h-3 w-3" /> Add Dir
                      </button>
                    </div>
                  </td>
                  <td className={`${tdCls}`} />
                  <td className={`${tdCls} text-right`}>
                    <button onClick={() => deleteTab(ti)} className={btnGhost} title="Delete tab">
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </td>
                </tr>,

                // Dir rows
                ...(isExpanded ? visibleDirs : []).map((dir) => {
                  const realDi       = tab.dirs.indexOf(dir);
                  const isDirDragging   = dragging?.ti === ti && dragging.di === realDi;
                  const isDirDropTarget = dragOver?.ti === ti && dragOver.di === realDi;
                  return (
                    <tr
                      key={`dir-${ti}-${realDi}`}
                      onDragOver={e => handleDirDragOver(e, ti, realDi)}
                      onDrop={e => handleDirDrop(e, ti, realDi)}
                      className={`hover:bg-muted/20 ${isDirDragging ? 'opacity-40' : ''} ${isDirDropTarget ? 'border-t-2 border-primary' : ''}`}
                    >
                      <td
                        draggable
                        onDragStart={() => handleDirDragStart(ti, realDi)}
                        onDragEnd={handleDirDragEnd}
                        className={`${tdCls} w-6 pl-8 text-muted-foreground cursor-grab active:cursor-grabbing`}
                      >
                        <GripVertical className="h-3.5 w-3.5" />
                      </td>
                      <td className={`${tdCls} pl-8`}>
                        <input className={inpCls} value={dir.title} placeholder="title"
                          onChange={e => updateDir(ti, realDi, { title: e.target.value })} />
                      </td>
                      <td className={tdCls}>
                        <input className={inpCls} value={dir.alias} placeholder="alias"
                          onChange={e => updateDir(ti, realDi, { alias: e.target.value })} />
                      </td>
                      <td className={`${tdCls} text-right`}>
                        <button onClick={() => deleteDir(ti, realDi)} className={btnGhost} title="Delete dir">
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </td>
                    </tr>
                  );
                }),
              ];
            })}
          </tbody>
        </table>

        {/* Add Tab button */}
        {!isFiltering && (
          <div className="px-3 py-2">
            <button onClick={addTab} className={btnOutline}>
              <Plus className="h-3.5 w-3.5" />
              Add Tab
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
