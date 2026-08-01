import { useState } from 'react';
import { ChevronDown, ChevronRight, RotateCcw, Save, GripVertical, Plus, X } from 'lucide-react';

export interface TabGroup {
  groupId:    string;
  groupTitle: string;
}

export interface TabEntry {
  tab:    string;
  groups: TabGroup[];
}

interface Props {
  data:       TabEntry[];
  onChange:   (data: TabEntry[]) => void;
  isDirty:    boolean;
  isSaving:   boolean;
  onReset:    () => void;
  onSave:     () => void;
  saveStatus?: { message: string; ok: boolean } | null;
}

function matchesFilter(tab: TabEntry, filter: string): { tabMatch: boolean; groups: TabGroup[] } {
  if (!filter) return { tabMatch: true, groups: tab.groups };
  const q = filter.toLowerCase();
  const tabMatch = tab.tab.toLowerCase().includes(q);
  const groups = tab.groups.filter(g => g.groupId.toLowerCase().includes(q) || g.groupTitle.toLowerCase().includes(q));
  return { tabMatch: tabMatch || groups.length > 0, groups: tabMatch ? tab.groups : groups };
}

export default function TabsTable({ data, onChange, isDirty, isSaving, onReset, onSave, saveStatus }: Props) {
  const [filter, setFilter]           = useState('');
  const [expanded, setExpanded]       = useState<Set<number>>(() => new Set(data.map((_, i) => i)));
  const [dragging, setDragging]       = useState<{ ti: number; gi: number } | null>(null);
  const [dragOver, setDragOver]       = useState<{ ti: number; gi: number } | null>(null);
  const [dragTab, setDragTab]         = useState<number | null>(null);
  const [dragOverTab, setDragOverTab] = useState<number | null>(null);

  const isFiltering = filter.trim().length > 0;

  function toggleTab(ti: number) {
    setExpanded(prev => {
      const next = new Set(prev);
      next.has(ti) ? next.delete(ti) : next.add(ti);
      return next;
    });
  }

  function updateTab(ti: number, patch: Partial<TabEntry>) {
    onChange(data.map((t, i) => i !== ti ? t : { ...t, ...patch }));
  }

  function updateGroup(ti: number, gi: number, patch: Partial<TabGroup>) {
    onChange(data.map((t, i) =>
      i !== ti ? t : { ...t, groups: t.groups.map((g, j) => j !== gi ? g : { ...g, ...patch }) },
    ));
  }

  function addTab() {
    const next = [...data, { tab: 'New Tab', groups: [] }];
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

  function addGroup(ti: number) {
    const groups = [...data[ti]!.groups, { groupId: '', groupTitle: '' }];
    onChange(data.map((t, i) => i !== ti ? t : { ...t, groups }));
    setExpanded(prev => new Set([...prev, ti]));
  }

  function deleteGroup(ti: number, gi: number) {
    const groups = data[ti]!.groups.filter((_, j) => j !== gi);
    onChange(data.map((t, i) => i !== ti ? t : { ...t, groups }));
  }

  // Group drag (within a tab only)
  function handleGroupDragStart(ti: number, gi: number) { setDragging({ ti, gi }); }

  function handleGroupDragOver(e: React.DragEvent, ti: number, gi: number) {
    e.preventDefault();
    if (dragging && dragging.ti === ti) setDragOver({ ti, gi });
  }

  function handleGroupDrop(e: React.DragEvent, ti: number, targetGi: number) {
    e.preventDefault();
    if (!dragging || dragging.ti !== ti) { setDragging(null); setDragOver(null); return; }
    const { gi: fromGi } = dragging;
    if (fromGi === targetGi) { setDragging(null); setDragOver(null); return; }
    const groups = [...data[ti]!.groups];
    const [moved] = groups.splice(fromGi, 1);
    groups.splice(targetGi, 0, moved);
    onChange(data.map((t, i) => i !== ti ? t : { ...t, groups }));
    setDragging(null); setDragOver(null);
  }

  function handleGroupDragEnd() { setDragging(null); setDragOver(null); }

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
    // splice past end appends, so actual final index is capped at data.length-1
    const finalTi = dragTab < targetTi ? Math.min(targetTi, data.length - 1) : targetTi;
    setExpanded(prev => {
      const next = new Set<number>();
      for (const v of [...prev]) {
        if (v === dragTab) { next.add(finalTi); continue; }
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

  const thCls  = 'px-2 py-1.5 text-left text-xs font-medium text-muted-foreground whitespace-nowrap border-b border-border';
  const tdCls  = 'px-2 py-1 text-xs border-b border-border align-middle';
  const inpCls = 'w-full bg-transparent border-b border-transparent hover:border-border focus:border-primary outline-none text-xs py-0.5 placeholder:text-muted-foreground/50';

  return (
    <div className="flex flex-col h-full">
      {/* Action bar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border shrink-0">
        <input
          type="text"
          placeholder="Filter tabs / groups…"
          value={filter}
          onChange={e => setFilter(e.target.value)}
          className="flex-1 bg-transparent border border-border rounded px-2 py-1 text-xs outline-none focus:border-primary placeholder:text-muted-foreground/50"
        />
        {filter && (
          <button onClick={() => setFilter('')} className="text-xs text-muted-foreground hover:text-foreground shrink-0">
            Clear
          </button>
        )}
        <button onClick={() => setExpanded(new Set(data.map((_, i) => i)))} disabled={isFiltering} className={btnOutline}>
          Expand
        </button>
        <button onClick={() => setExpanded(new Set())} disabled={isFiltering} className={btnOutline}>
          Collapse
        </button>
        <button onClick={onReset} disabled={!isDirty || isSaving} className={btnOutline}>
          <RotateCcw className="h-3.5 w-3.5" />
          Reset
        </button>
        <button onClick={onSave} disabled={!isDirty || isSaving} className={btnPrimary}>
          <Save className="h-3.5 w-3.5" />
          {isSaving ? 'Saving…' : 'Save'}
        </button>
      </div>

      {/* Save status banner — matches SubaccountsTable progress bar style */}
      {saveStatus && (
        <div className="shrink-0 relative h-7 border-b border-border overflow-hidden">
          <div className={`absolute inset-y-0 left-0 w-full ${saveStatus.ok ? 'bg-green-500/50' : 'bg-destructive/50'}`} />
          <span className={`absolute inset-0 flex items-center justify-center text-[11px] font-medium px-2 truncate ${saveStatus.ok ? 'text-foreground' : 'text-destructive'}`}>
            {saveStatus.message}
          </span>
        </div>
      )}

      {/* Table */}
      <div className="flex-1 overflow-auto">
        <table className="w-full border-collapse text-sm min-w-[500px]">
          <thead className="sticky top-0 z-10">
            <tr className="bg-muted/40">
              <th className={`${thCls} w-6`} />
              <th className={thCls} style={{ minWidth: 120 }}>Group Title</th>
              <th className={thCls} style={{ minWidth: 80 }}>Group ID</th>
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
              const { tabMatch, groups: visibleGroups } = matchesFilter(tab, filter);
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
                  <td className="px-2 py-1 text-xs border-b border-border align-middle" colSpan={2}>
                    <div className="flex items-center gap-1.5">
                      <button onClick={() => toggleTab(ti)} className="shrink-0 text-muted-foreground hover:text-foreground">
                        {isExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                      </button>
                      <input
                        className="font-semibold text-xs bg-transparent outline-none border-b border-transparent hover:border-border focus:border-primary py-0.5 min-w-0 flex-1"
                        value={tab.tab}
                        onChange={e => updateTab(ti, { tab: e.target.value })}
                        onClick={e => e.stopPropagation()}
                      />
                      <span className="text-xs text-muted-foreground shrink-0">({tab.groups.length})</span>
                      <button onClick={() => addGroup(ti)} className={`${btnGhost} shrink-0`} title="Add group">
                        <Plus className="h-3 w-3" /> Add Group
                      </button>
                    </div>
                  </td>
                  <td className={`${tdCls} text-right`}>
                    <button onClick={() => deleteTab(ti)} className={btnGhost} title="Delete tab">
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </td>
                </tr>,

                // Group rows
                ...(isExpanded ? visibleGroups : []).map((grp) => {
                  const realGi      = tab.groups.indexOf(grp);
                  const isGrpDragging   = dragging?.ti === ti && dragging.gi === realGi;
                  const isGrpDropTarget = dragOver?.ti === ti && dragOver.gi === realGi;
                  return (
                    <tr
                      key={`grp-${ti}-${realGi}`}
                      onDragOver={e => handleGroupDragOver(e, ti, realGi)}
                      onDrop={e => handleGroupDrop(e, ti, realGi)}
                      className={`hover:bg-muted/20 ${isGrpDragging ? 'opacity-40' : ''} ${isGrpDropTarget ? 'border-t-2 border-primary' : ''}`}
                    >
                      <td
                        draggable
                        onDragStart={() => handleGroupDragStart(ti, realGi)}
                        onDragEnd={handleGroupDragEnd}
                        className={`${tdCls} w-6 pl-8 text-muted-foreground cursor-grab active:cursor-grabbing`}
                      >
                        <GripVertical className="h-3.5 w-3.5" />
                      </td>
                      <td className={`${tdCls} pl-8`}>
                        <input
                          className={inpCls}
                          value={grp.groupTitle}
                          placeholder="Group title"
                          onChange={e => updateGroup(ti, realGi, { groupTitle: e.target.value })}
                        />
                      </td>
                      <td className={tdCls}>
                        <input
                          className={`${inpCls} font-mono`}
                          value={grp.groupId}
                          placeholder="group-id"
                          onChange={e => updateGroup(ti, realGi, { groupId: e.target.value })}
                        />
                      </td>
                      <td className={`${tdCls} text-right`}>
                        <button onClick={() => deleteGroup(ti, realGi)} className={btnGhost} title="Delete group">
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </td>
                    </tr>
                  );
                }),

                // Sentinel: drop-at-end target for groups within this tab
                ...(isExpanded && !isFiltering && dragging?.ti === ti ? [
                  <tr
                    key={`grp-sentinel-${ti}`}
                    onDragOver={e => { e.preventDefault(); setDragOver({ ti, gi: tab.groups.length }); }}
                    onDrop={e => handleGroupDrop(e, ti, tab.groups.length)}
                    className={dragOver?.ti === ti && dragOver.gi === tab.groups.length ? 'border-t-2 border-primary' : ''}
                  >
                    <td colSpan={4} className="h-3" />
                  </tr>,
                ] : []),
              ];
            })}

            {/* Sentinel: drop-at-end target for tabs */}
            {dragTab !== null && !isFiltering && (
              <tr
                onDragOver={e => { e.preventDefault(); setDragOverTab(data.length); }}
                onDrop={e => handleTabDrop(e, data.length)}
                className={dragOverTab === data.length ? 'border-t-2 border-primary' : ''}
              >
                <td colSpan={4} className="h-3" />
              </tr>
            )}
          </tbody>
        </table>

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
