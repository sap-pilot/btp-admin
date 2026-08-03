import { useState, useRef } from 'react';
import { ChevronDown, ChevronRight, RotateCcw, Save, GripVertical, Plus, X } from 'lucide-react';

export type BannerColor = 'transparent' | 'blue' | 'green' | 'yellow' | 'red' | 'purple';

export type TabSection =
  | { type: 'subaccountGroup'; title?: string; groupId: string }
  | { type: 'banner';          message: string; backgroundColor: BannerColor }
  | { type: 'table';           title?: string;  tableContent: string[][] };

export interface TabEntry {
  tab:      string;
  sections: TabSection[];
}

interface Props {
  data:        TabEntry[];
  onChange:    (data: TabEntry[]) => void;
  isDirty:     boolean;
  isSaving:    boolean;
  onReset:     () => void;
  onSave:      () => void;
  saveStatus?: { message: string; ok: boolean } | null;
}

const BANNER_COLORS: BannerColor[] = ['transparent', 'blue', 'green', 'yellow', 'red', 'purple'];

function bannerRowBg(color: BannerColor): string {
  switch (color) {
    case 'blue':        return 'bg-blue-500/35';
    case 'green':       return 'bg-green-500/35';
    case 'yellow':      return 'bg-yellow-400/50';
    case 'red':         return 'bg-red-500/35';
    case 'purple':      return 'bg-purple-500/35';
    case 'transparent': return '';
  }
}


function matchesFilter(tab: TabEntry, q: string): { tabMatch: boolean; sections: TabSection[] } {
  if (!q) return { tabMatch: true, sections: tab.sections };
  const lower = q.toLowerCase();
  const tabMatch = tab.tab.toLowerCase().includes(lower);
  const sections = tab.sections.filter(s => {
    if (s.type === 'subaccountGroup') return s.groupId.toLowerCase().includes(lower) || (s.title ?? '').toLowerCase().includes(lower);
    if (s.type === 'banner')          return s.message.toLowerCase().includes(lower);
    if (s.type === 'table')           return (s.title ?? '').toLowerCase().includes(lower) || s.tableContent.some(r => r.some(c => c.toLowerCase().includes(lower)));
    return false;
  });
  return { tabMatch: tabMatch || sections.length > 0, sections: tabMatch ? tab.sections : sections };
}

export default function TabsTable({ data, onChange, isDirty, isSaving, onReset, onSave, saveStatus }: Props) {
  const [filter, setFilter]           = useState('');
  const [expanded, setExpanded]       = useState<Set<number>>(() => new Set(data.map((_, i) => i)));
  const [dragging, setDragging]       = useState<{ ti: number; si: number } | null>(null);
  const [dragOver, setDragOver]       = useState<{ ti: number; si: number } | null>(null);
  const [dragTab, setDragTab]         = useState<number | null>(null);
  const [dragOverTab, setDragOverTab] = useState<number | null>(null);
  const dragTabRef                    = useRef<number | null>(null);

  const isFiltering    = filter.trim().length > 0;
  const totalTabs      = data.length;
  const totalSections  = data.reduce((n, t) => n + t.sections.length, 0);
  const filteredTabCount = isFiltering ? data.filter(t => matchesFilter(t, filter).tabMatch).length : totalTabs;
  const filteredSectionCount = isFiltering
    ? data.reduce((n, t) => { const { tabMatch, sections } = matchesFilter(t, filter); return n + (tabMatch ? t.sections.length : sections.length); }, 0)
    : totalSections;

  // ── Tab mutations ──────────────────────────────────────────────────────────

  function toggleTab(ti: number) {
    setExpanded(prev => { const next = new Set(prev); next.has(ti) ? next.delete(ti) : next.add(ti); return next; });
  }

  function updateTabName(ti: number, name: string) {
    onChange(data.map((t, i) => i !== ti ? t : { ...t, tab: name }));
  }

  function addTab() {
    const next = [...data, { tab: 'New Tab', sections: [] }];
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

  // ── Section mutations ──────────────────────────────────────────────────────

  function updateSectionAt(ti: number, si: number, updater: (s: TabSection) => TabSection) {
    onChange(data.map((t, i) => i !== ti ? t : {
      ...t,
      sections: t.sections.map((s, j) => j !== si ? s : updater(s)),
    }));
  }

  function addSection(ti: number, type: TabSection['type']) {
    let section: TabSection;
    if (type === 'subaccountGroup') section = { type, groupId: '' };
    else if (type === 'banner')     section = { type, message: '', backgroundColor: 'transparent' };
    else                            section = { type, tableContent: [['', '', ''], ['', '', ''], ['', '', '']] };
    const sections = [...data[ti]!.sections, section];
    onChange(data.map((t, i) => i !== ti ? t : { ...t, sections }));
    setExpanded(prev => new Set([...prev, ti]));
  }

  function deleteSection(ti: number, si: number) {
    const sections = data[ti]!.sections.filter((_, j) => j !== si);
    onChange(data.map((t, i) => i !== ti ? t : { ...t, sections }));
  }

  // ── Table cell mutations ───────────────────────────────────────────────────

  function updateTableCell(ti: number, si: number, row: number, col: number, value: string) {
    updateSectionAt(ti, si, s => {
      if (s.type !== 'table') return s;
      return { ...s, tableContent: s.tableContent.map((r, ri) => ri !== row ? r : r.map((c, ci) => ci !== col ? c : value)) };
    });
  }

  function addTableRow(ti: number, si: number) {
    updateSectionAt(ti, si, s => {
      if (s.type !== 'table') return s;
      const cols = s.tableContent[0]?.length ?? 2;
      return { ...s, tableContent: [...s.tableContent, Array<string>(cols).fill('')] };
    });
  }

  function addTableCol(ti: number, si: number) {
    updateSectionAt(ti, si, s => {
      if (s.type !== 'table') return s;
      return { ...s, tableContent: s.tableContent.map(r => [...r, '']) };
    });
  }

  function deleteTableRow(ti: number, si: number, row: number) {
    updateSectionAt(ti, si, s => {
      if (s.type !== 'table') return s;
      const next = s.tableContent.filter((_, ri) => ri !== row);
      return { ...s, tableContent: next.length ? next : [['']] };
    });
  }

  function deleteTableCol(ti: number, si: number, col: number) {
    updateSectionAt(ti, si, s => {
      if (s.type !== 'table') return s;
      const next = s.tableContent.map(r => r.filter((_, ci) => ci !== col));
      return { ...s, tableContent: next[0]?.length ? next : next.map(() => ['']) };
    });
  }

  // ── Section drag-and-drop ─────────────────────────────────────────────────

  function handleSectionDragStart(ti: number, si: number) { setDragging({ ti, si }); }

  function handleSectionDragOver(e: React.DragEvent, ti: number, si: number) {
    e.preventDefault();
    if (dragging && dragging.ti === ti) setDragOver({ ti, si });
  }

  function handleSectionDrop(e: React.DragEvent, ti: number, targetSi: number) {
    e.preventDefault();
    if (!dragging || dragging.ti !== ti) { setDragging(null); setDragOver(null); return; }
    const { si: fromSi } = dragging;
    if (fromSi === targetSi) { setDragging(null); setDragOver(null); return; }
    const sections = [...data[ti]!.sections];
    const [moved] = sections.splice(fromSi, 1);
    sections.splice(targetSi, 0, moved);
    onChange(data.map((t, i) => i !== ti ? t : { ...t, sections }));
    setDragging(null); setDragOver(null);
  }

  function handleSectionDragEnd() { setDragging(null); setDragOver(null); }

  // ── Tab drag-and-drop ─────────────────────────────────────────────────────

  function handleTabDragStart(ti: number) { dragTabRef.current = ti; setDragTab(ti); }

  function handleTabDragOver(e: React.DragEvent, ti: number) {
    e.preventDefault();
    if (dragTabRef.current !== null && dragTabRef.current !== ti) setDragOverTab(ti);
  }

  function handleTabDrop(e: React.DragEvent, targetTi: number) {
    e.preventDefault();
    const fromTi = dragTabRef.current;
    if (fromTi === null || fromTi === targetTi) { dragTabRef.current = null; setDragTab(null); setDragOverTab(null); return; }
    const tabs = [...data];
    const [moved] = tabs.splice(fromTi, 1);
    tabs.splice(targetTi, 0, moved);
    onChange(tabs);
    const finalTi = fromTi < targetTi ? Math.min(targetTi, data.length - 1) : targetTi;
    setExpanded(prev => {
      const next = new Set<number>();
      for (const v of [...prev]) {
        if (v === fromTi) { next.add(finalTi); continue; }
        let nv = v;
        if (fromTi < targetTi) { if (v > fromTi && v <= targetTi) nv = v - 1; }
        else                   { if (v >= targetTi && v < fromTi)  nv = v + 1; }
        next.add(nv);
      }
      return next;
    });
    dragTabRef.current = null; setDragTab(null); setDragOverTab(null);
  }

  function handleTabDragEnd() { dragTabRef.current = null; setDragTab(null); setDragOverTab(null); }

  // ── Styles ────────────────────────────────────────────────────────────────

  const btnBase    = 'inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
  const btnOutline = `${btnBase} border border-border hover:bg-accent hover:text-accent-foreground`;
  const btnPrimary = `${btnBase} bg-primary text-primary-foreground hover:bg-primary/90 gap-1.5 px-3 py-1.5`;
  const btnGhost   = 'inline-flex items-center gap-1 px-1 py-0.5 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-accent transition-colors';
  const inpCls     = 'bg-transparent border-b border-transparent hover:border-border focus:border-primary outline-none text-xs py-0.5 placeholder:text-muted-foreground/40';

  function badge(label: string, color: string) {
    return <span className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded font-medium uppercase tracking-wide ${color}`}>{label}</span>;
  }

  // ── Section renderers ─────────────────────────────────────────────────────

  function renderSection(ti: number, si: number, sec: TabSection, isVisible: boolean) {
    if (!isVisible) return null;
    const isSecDragging   = dragging?.ti === ti && dragging.si === si;
    const isSecDropTarget = dragOver?.ti === ti && dragOver.si === si;

    const wrapCls = `flex items-start gap-2 px-2 py-1.5 border-b border-border hover:bg-muted/10 pl-10 ${isSecDragging ? 'opacity-40' : ''} ${isSecDropTarget ? 'border-t-2 border-primary' : ''}`;

    const gripEl = (
      <div
        draggable
        onDragStart={() => handleSectionDragStart(ti, si)}
        onDragEnd={handleSectionDragEnd}
        onDragOver={e => handleSectionDragOver(e, ti, si)}
        onDrop={e => handleSectionDrop(e, ti, si)}
        className="shrink-0 text-muted-foreground/40 cursor-grab active:cursor-grabbing mt-0.5"
      >
        <GripVertical className="h-3.5 w-3.5" />
      </div>
    );

    if (sec.type === 'subaccountGroup') {
      return (
        <div key={`sec-${ti}-${si}`} className={wrapCls}
          onDragOver={e => handleSectionDragOver(e, ti, si)}
          onDrop={e => handleSectionDrop(e, ti, si)}
        >
          {gripEl}
          {badge('Group', 'bg-blue-500/10 text-blue-600 dark:text-blue-400')}
          <input
            className={`${inpCls} flex-1 min-w-0`}
            value={sec.title ?? ''}
            placeholder="Title"
            onChange={e => updateSectionAt(ti, si, s => ({ ...s, title: e.target.value || undefined } as TabSection))}
          />
          <input
            className={`${inpCls} font-mono w-36 shrink-0`}
            value={sec.groupId}
            placeholder="group-id"
            onChange={e => updateSectionAt(ti, si, s => ({ ...s, groupId: e.target.value } as TabSection))}
          />
          <button onClick={() => deleteSection(ti, si)} className={`${btnGhost} shrink-0`} title="Delete section"><X className="h-3.5 w-3.5" /></button>
        </div>
      );
    }

    if (sec.type === 'banner') {
      const rowBg    = bannerRowBg(sec.backgroundColor);
      const bannerWrapCls = `flex items-start gap-2 px-2 py-1.5 border-b border-border pl-10 transition-colors ${rowBg || 'hover:bg-muted/10'} ${isSecDragging ? 'opacity-40' : ''} ${isSecDropTarget ? 'border-t-2 border-primary' : ''}`;
      return (
        <div key={`sec-${ti}-${si}`} className={bannerWrapCls}
          onDragOver={e => handleSectionDragOver(e, ti, si)}
          onDrop={e => handleSectionDrop(e, ti, si)}
        >
          {gripEl}
          {badge('Banner', 'bg-amber-500/10 text-amber-600 dark:text-amber-400')}
          <div className="flex-1 min-w-0">
            <textarea
              className={`${inpCls} w-full resize-y leading-snug`}
              rows={2}
              value={sec.message}
              placeholder="Message (markdown supported)"
              onChange={e => updateSectionAt(ti, si, s => ({ ...s, message: e.target.value } as TabSection))}
            />
          </div>
          <select
            value={sec.backgroundColor}
            onChange={e => updateSectionAt(ti, si, s => ({ ...s, backgroundColor: e.target.value as BannerColor } as TabSection))}
            className="shrink-0 w-36 text-xs bg-background border border-border rounded px-1.5 py-0.5 outline-none focus:border-primary text-foreground"
          >
            {BANNER_COLORS.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <button onClick={() => deleteSection(ti, si)} className={`${btnGhost} shrink-0`} title="Delete section"><X className="h-3.5 w-3.5" /></button>
        </div>
      );
    }

    // table
    const colCount = sec.tableContent[0]?.length ?? 0;
    return (
      <div key={`sec-${ti}-${si}`} className={`border-b border-border ${isSecDragging ? 'opacity-40' : ''} ${isSecDropTarget ? 'border-t-2 border-primary' : ''}`}
        onDragOver={e => handleSectionDragOver(e, ti, si)}
        onDrop={e => handleSectionDrop(e, ti, si)}
      >
        {/* Table section header */}
        <div className="flex items-center gap-2 px-2 py-1.5 pl-10 hover:bg-muted/10">
          {gripEl}
          {badge('Table', 'bg-violet-500/10 text-violet-600 dark:text-violet-400')}
          <input
            className={`${inpCls} flex-1 min-w-0`}
            value={sec.title ?? ''}
            placeholder="Table title"
            onChange={e => updateSectionAt(ti, si, s => ({ ...s, title: e.target.value || undefined } as TabSection))}
          />
          <button onClick={() => addTableRow(ti, si)} className={btnGhost} title="Add row"><Plus className="h-3 w-3" /> Add Row</button>
          <button onClick={() => addTableCol(ti, si)} className={btnGhost} title="Add column"><Plus className="h-3 w-3" /> Add Column</button>
          <button onClick={() => deleteSection(ti, si)} className={`${btnGhost} ml-1`} title="Delete section"><X className="h-3.5 w-3.5" /></button>
        </div>
        {/* Table editor */}
        <div className="pl-14 pr-3 pb-2 overflow-x-auto">
          <table className="border-collapse text-xs w-full">
            <thead>
              <tr>
                <th className="w-5" /> {/* corner */}
                {Array.from({ length: colCount }, (_, ci) => (
                  <th key={ci} className={`px-1 pb-0.5 text-center ${ci === 0 ? 'w-28' : ''}`}>
                    <button
                      onClick={() => deleteTableCol(ti, si, ci)}
                      className="text-muted-foreground/50 hover:text-destructive transition-colors"
                      title="Delete column"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sec.tableContent.map((row, ri) => (
                <tr key={ri}>
                  <td className="pr-1 align-middle">
                    <button
                      onClick={() => deleteTableRow(ti, si, ri)}
                      className="text-muted-foreground/50 hover:text-destructive transition-colors"
                      title="Delete row"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </td>
                  {row.map((cell, ci) => {
                    const isHeadRow = ri === 0;
                    const isLeadCol = ci === 0;
                    const tdCls = [
                      'border border-border/40 px-0.5 py-0.5',
                      isHeadRow ? 'bg-muted/50' : isLeadCol ? 'bg-muted/25' : '',
                      isLeadCol ? 'w-28' : '',
                    ].join(' ');
                    return (
                      <td key={ci} className={tdCls}>
                        <input
                          className={`w-full min-w-[60px] bg-transparent outline-none text-xs px-1 py-0.5 placeholder:text-muted-foreground/30 ${isHeadRow || isLeadCol ? 'font-medium' : ''}`}
                          value={cell}
                          placeholder={isHeadRow || isLeadCol ? '' : 'markdown syntax supported eg: [text](url)'}
                          onChange={e => updateTableCell(ti, si, ri, ci, e.target.value)}
                        />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full">
      {/* Action bar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border shrink-0">
        <div className="relative flex-1 min-w-0">
          <input
            type="text"
            placeholder="Filter tabs / sections…"
            value={filter}
            onChange={e => setFilter(e.target.value)}
            className="w-full h-7 px-2 pr-44 text-xs bg-transparent border border-border rounded outline-none focus:border-primary placeholder:text-muted-foreground/50"
          />
          <span className={`absolute top-1/2 -translate-y-1/2 text-xs text-muted-foreground/50 pointer-events-none select-none whitespace-nowrap ${isFiltering ? 'right-6' : 'right-2'}`}>
            {isFiltering
              ? `${filteredTabCount}/${totalTabs} tabs & ${filteredSectionCount}/${totalSections} sections`
              : `${totalTabs} tabs & ${totalSections} sections`}
          </span>
          {filter && (
            <button onClick={() => setFilter('')} className="absolute right-1 top-1/2 -translate-y-1/2 p-0.5 rounded text-muted-foreground hover:text-foreground transition-colors" aria-label="Clear filter">
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
        <button onClick={() => setExpanded(new Set(data.map((_, i) => i)))} disabled={isFiltering} className={btnOutline}>Expand</button>
        <button onClick={() => setExpanded(new Set())} disabled={isFiltering} className={btnOutline}>Collapse</button>
        <button onClick={onReset} disabled={!isDirty || isSaving} className={btnOutline}><RotateCcw className="h-3.5 w-3.5" /> Reset</button>
        <button onClick={onSave}  disabled={!isDirty || isSaving} className={btnPrimary}><Save className="h-3.5 w-3.5" />{isSaving ? 'Saving…' : 'Save'}</button>
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

      {/* Content */}
      <div className="flex-1 overflow-auto">
        {data.length === 0 && !isFiltering && (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            No tabs yet. Click <strong>Add Tab</strong> below to create one.
          </div>
        )}

        {data.map((tab, ti) => {
          const { tabMatch, sections: visibleSections } = matchesFilter(tab, filter);
          if (isFiltering && !tabMatch) return null;
          const isTabDragging   = dragTab === ti;
          const isTabDropTarget = dragOverTab === ti;
          const isExpanded      = isFiltering || expanded.has(ti);

          return (
            <div
              key={`tab-${ti}`}
              onDragOver={e => !isFiltering && handleTabDragOver(e, ti)}
              onDrop={e => !isFiltering && handleTabDrop(e, ti)}
              className={isTabDropTarget ? 'border-t-2 border-primary' : ''}
            >
              {/* Tab header */}
              <div className={`flex items-center gap-1.5 px-2 py-1.5 border-b border-border bg-muted/20 hover:bg-muted/30 select-none ${isTabDragging ? 'opacity-40' : ''}`}>
                <div
                  draggable={!isFiltering}
                  onDragStart={() => !isFiltering && handleTabDragStart(ti)}
                  onDragEnd={handleTabDragEnd}
                  className={`shrink-0 text-muted-foreground/50 ${!isFiltering ? 'cursor-grab active:cursor-grabbing' : ''}`}
                >
                  {!isFiltering && <GripVertical className="h-3.5 w-3.5" />}
                </div>
                <button onClick={() => toggleTab(ti)} className="shrink-0 text-muted-foreground hover:text-foreground">
                  {isExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                </button>
                <input
                  className="font-semibold text-xs bg-transparent outline-none border-b border-transparent hover:border-border focus:border-primary py-0.5 min-w-0 flex-1"
                  value={tab.tab}
                  onChange={e => updateTabName(ti, e.target.value)}
                  onClick={e => e.stopPropagation()}
                />
                <span className="text-xs text-muted-foreground shrink-0">({tab.sections.length})</span>
                <button onClick={() => addSection(ti, 'subaccountGroup')} className={`${btnGhost} shrink-0`}>
                  <Plus className="h-3 w-3" /> Add Subaccount Group
                </button>
                <button onClick={() => addSection(ti, 'banner')} className={`${btnGhost} shrink-0`}>
                  <Plus className="h-3 w-3" /> Add Banner
                </button>
                <button onClick={() => addSection(ti, 'table')} className={`${btnGhost} shrink-0`}>
                  <Plus className="h-3 w-3" /> Add Table
                </button>
                <button onClick={() => deleteTab(ti)} className={`${btnGhost} shrink-0 ml-1`} title="Delete tab">
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>

              {/* Sections */}
              {isExpanded && (
                <>
                  {tab.sections.map((sec, si) => {
                    const isVisible = !isFiltering || visibleSections.includes(sec);
                    return renderSection(ti, si, sec, isVisible);
                  })}

                  {/* Sentinel: drop-at-end for sections */}
                  {!isFiltering && dragging?.ti === ti && (
                    <div
                      onDragOver={e => { e.preventDefault(); setDragOver({ ti, si: tab.sections.length }); }}
                      onDrop={e => handleSectionDrop(e, ti, tab.sections.length)}
                      className={`h-3 ${dragOver?.ti === ti && dragOver.si === tab.sections.length ? 'border-t-2 border-primary' : ''}`}
                    />
                  )}
                </>
              )}
            </div>
          );
        })}

        {/* Sentinel: drop-at-end for tabs */}
        {dragTab !== null && !isFiltering && (
          <div
            onDragOver={e => { e.preventDefault(); setDragOverTab(data.length); }}
            onDrop={e => handleTabDrop(e, data.length)}
            className={`h-3 ${dragOverTab === data.length ? 'border-t-2 border-primary' : ''}`}
          />
        )}

        {!isFiltering && (
          <div className="px-3 py-2">
            <button onClick={addTab} className={btnOutline}>
              <Plus className="h-3.5 w-3.5" /> Add Tab
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
