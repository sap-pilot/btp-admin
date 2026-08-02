import { useState, useRef } from 'react';
import { ChevronDown, ChevronRight, GripVertical, Plus, X } from 'lucide-react';
import type { MenuEntry, Submenu } from './SettingsPanel';

interface Props {
  data:     MenuEntry[];
  onChange: (data: MenuEntry[]) => void;
}

const inpCls = 'text-xs bg-transparent border border-border rounded px-2 py-1 outline-none focus:border-primary placeholder:text-muted-foreground/40';

export default function MenusEditor({ data, onChange }: Props) {
  const [expanded,         setExpanded]         = useState<Set<number>>(() => new Set(data.map((_, i) => i)));
  const [draggingGroup,    setDraggingGroup]    = useState<number | null>(null);
  const [dragOverGroup,    setDragOverGroup]    = useState<number | null>(null);
  const [draggingSubmenu,  setDraggingSubmenu]  = useState<{ gi: number; si: number } | null>(null);
  const [dragOverSubmenu,  setDragOverSubmenu]  = useState<{ gi: number; si: number } | null>(null);
  const groupDragRef = useRef<number | null>(null);

  // ── Group mutations ──────────────────────────────────────────────────────────

  function toggleGroup(gi: number) {
    setExpanded(prev => { const n = new Set(prev); n.has(gi) ? n.delete(gi) : n.add(gi); return n; });
  }

  function updateGroup(gi: number, field: keyof MenuEntry, val: string) {
    onChange(data.map((m, i) => i !== gi ? m : { ...m, [field]: val }));
  }

  function deleteGroup(gi: number) {
    onChange(data.filter((_, i) => i !== gi));
    setExpanded(prev => {
      const next = new Set<number>();
      prev.forEach(n => { if (n < gi) next.add(n); else if (n > gi) next.add(n - 1); });
      return next;
    });
  }

  function addGroup() {
    onChange([...data, { text: '', icon: '', submenus: [] }]);
    setExpanded(prev => new Set([...prev, data.length]));
  }

  // ── Submenu mutations ────────────────────────────────────────────────────────

  function addSubmenu(gi: number) {
    onChange(data.map((m, i) => i !== gi ? m : { ...m, submenus: [...m.submenus, { text: '', url: '' }] }));
  }

  function updateSubmenu(gi: number, si: number, field: keyof Submenu, val: string | boolean) {
    onChange(data.map((m, i) => i !== gi ? m : {
      ...m,
      submenus: m.submenus.map((s, j) => j !== si ? s : { ...s, [field]: val }),
    }));
  }

  function deleteSubmenu(gi: number, si: number) {
    onChange(data.map((m, i) => i !== gi ? m : { ...m, submenus: m.submenus.filter((_, j) => j !== si) }));
  }

  // ── Group drag handlers ──────────────────────────────────────────────────────

  function handleGroupDragStart(e: React.DragEvent, gi: number) {
    e.dataTransfer.setData('text/plain', String(gi));
    e.stopPropagation();
    groupDragRef.current = gi;
    setDraggingGroup(gi);
  }

  function handleGroupDragEnd() {
    setDraggingGroup(null);
    setDragOverGroup(null);
    groupDragRef.current = null;
  }

  function handleGroupDragOver(e: React.DragEvent, gi: number) {
    if (groupDragRef.current === null) return;
    e.preventDefault();
    setDragOverGroup(gi);
  }

  function handleGroupDrop(e: React.DragEvent, targetGi: number) {
    const from = groupDragRef.current;
    if (from === null) return;
    e.preventDefault();
    setDragOverGroup(null);
    groupDragRef.current = null;
    setDraggingGroup(null);
    if (from === targetGi) return;
    const next = [...data];
    const [item] = next.splice(from, 1);
    next.splice(targetGi, 0, item);
    onChange(next);
    setExpanded(prev => {
      const nextSet = new Set<number>();
      prev.forEach(n => {
        if (n === from) { nextSet.add(targetGi); return; }
        if (from < targetGi && n > from && n <= targetGi) { nextSet.add(n - 1); return; }
        if (from > targetGi && n >= targetGi && n < from) { nextSet.add(n + 1); return; }
        nextSet.add(n);
      });
      return nextSet;
    });
  }

  // ── Submenu drag handlers ────────────────────────────────────────────────────

  function handleSubmenuDragStart(e: React.DragEvent, gi: number, si: number) {
    e.dataTransfer.setData('text/plain', `${gi},${si}`);
    e.stopPropagation();
    setDraggingSubmenu({ gi, si });
  }

  function handleSubmenuDragEnd() {
    setDraggingSubmenu(null);
    setDragOverSubmenu(null);
  }

  function handleSubmenuDragOver(e: React.DragEvent, gi: number, si: number) {
    if (!draggingSubmenu || draggingSubmenu.gi !== gi) return;
    e.preventDefault();
    e.stopPropagation();
    setDragOverSubmenu({ gi, si });
  }

  function handleSubmenuDrop(e: React.DragEvent, targetGi: number, targetSi: number) {
    if (!draggingSubmenu || draggingSubmenu.gi !== targetGi) return;
    e.preventDefault();
    e.stopPropagation();
    const fromSi = draggingSubmenu.si;
    setDragOverSubmenu(null);
    setDraggingSubmenu(null);
    if (fromSi === targetSi) return;
    onChange(data.map((m, i) => {
      if (i !== targetGi) return m;
      const next = [...m.submenus];
      const [item] = next.splice(fromSi, 1);
      next.splice(targetSi, 0, item);
      return { ...m, submenus: next };
    }));
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-1 p-3">
      {data.map((menu, gi) => {
        const isExpanded      = expanded.has(gi);
        const isDraggingThis  = draggingGroup === gi;
        const isDragTarget    = dragOverGroup === gi && draggingGroup !== null && draggingGroup !== gi;

        return (
          <div
            key={gi}
            className={`rounded border transition-opacity ${isDraggingThis ? 'opacity-40' : ''} ${isDragTarget ? 'border-t-2 border-t-primary border-border' : 'border-border'}`}
            onDragOver={e => handleGroupDragOver(e, gi)}
            onDrop={e => handleGroupDrop(e, gi)}
          >
            {/* Group header row */}
            <div className="flex items-center gap-1 px-2 py-1.5 bg-muted/20 rounded-t">
              <div
                draggable
                onDragStart={e => handleGroupDragStart(e, gi)}
                onDragEnd={handleGroupDragEnd}
                className="shrink-0 text-muted-foreground/40 cursor-grab active:cursor-grabbing mt-px"
              >
                <GripVertical className="h-3.5 w-3.5" />
              </div>
              <button
                onClick={() => toggleGroup(gi)}
                className="shrink-0 text-muted-foreground/60 hover:text-foreground transition-colors"
                title={isExpanded ? 'Collapse' : 'Expand'}
              >
                {isExpanded
                  ? <ChevronDown className="h-3.5 w-3.5" />
                  : <ChevronRight className="h-3.5 w-3.5" />
                }
              </button>
              <input
                className={`${inpCls} flex-1 min-w-0`}
                placeholder="Menu group name"
                value={menu.text}
                onChange={e => updateGroup(gi, 'text', e.target.value)}
              />
              <input
                className={`${inpCls} w-36`}
                placeholder="e.g. book-open-text"
                value={menu.icon}
                onChange={e => updateGroup(gi, 'icon', e.target.value)}
                title="Lucide icon name (kebab-case)"
              />
              <button
                onClick={() => { addSubmenu(gi); if (!isExpanded) toggleGroup(gi); }}
                className="shrink-0 inline-flex items-center gap-0.5 text-xs text-muted-foreground hover:text-foreground transition-colors px-1 py-0.5"
                title="Add submenu item"
              >
                <Plus className="h-3 w-3" /> Add
              </button>
              <button
                onClick={() => deleteGroup(gi)}
                className="shrink-0 p-0.5 rounded text-muted-foreground/40 hover:text-destructive hover:bg-accent transition-colors"
                title="Delete group"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>

            {/* Submenu rows */}
            {isExpanded && (
              <div className="border-t border-border/40">
                {menu.submenus.length === 0 && (
                  <div className="text-xs text-muted-foreground/50 px-8 py-1.5 italic">No submenu items — click Add above</div>
                )}
                {menu.submenus.map((sub, si) => {
                  const isSubmenuDragging  = draggingSubmenu?.gi === gi && draggingSubmenu?.si === si;
                  const isSubmenuDragTarget = dragOverSubmenu?.gi === gi && dragOverSubmenu?.si === si && draggingSubmenu?.gi === gi && draggingSubmenu?.si !== si;
                  return (
                    <div
                      key={si}
                      className={`flex items-center gap-1 px-2 py-1 pl-8 border-b border-border/20 last:border-0 transition-opacity ${isSubmenuDragging ? 'opacity-40' : ''} ${isSubmenuDragTarget ? 'border-t-2 border-t-primary' : ''}`}
                      onDragOver={e => handleSubmenuDragOver(e, gi, si)}
                      onDrop={e => handleSubmenuDrop(e, gi, si)}
                    >
                      <div
                        draggable
                        onDragStart={e => handleSubmenuDragStart(e, gi, si)}
                        onDragEnd={handleSubmenuDragEnd}
                        className="shrink-0 text-muted-foreground/30 cursor-grab active:cursor-grabbing"
                      >
                        <GripVertical className="h-3 w-3" />
                      </div>
                      <input
                        className={`${inpCls} w-32`}
                        placeholder="Label"
                        value={sub.text}
                        onChange={e => updateSubmenu(gi, si, 'text', e.target.value)}
                      />
                      <input
                        className={`${inpCls} flex-1 min-w-0`}
                        placeholder="https://…"
                        value={sub.url}
                        onChange={e => updateSubmenu(gi, si, 'url', e.target.value)}
                      />
                      <label className="shrink-0 flex items-center gap-1 text-xs text-muted-foreground cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={sub.public ?? false}
                          onChange={e => updateSubmenu(gi, si, 'public', e.target.checked)}
                          className="h-3 w-3"
                        />
                        public
                      </label>
                      <button
                        onClick={() => deleteSubmenu(gi, si)}
                        className="shrink-0 p-0.5 rounded text-muted-foreground/30 hover:text-destructive hover:bg-accent transition-colors"
                        title="Delete"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}

      <button
        onClick={addGroup}
        className="mt-1 inline-flex items-center gap-1 px-2 py-1 text-xs text-muted-foreground hover:text-foreground border border-dashed border-border hover:border-muted-foreground rounded transition-colors self-start"
      >
        <Plus className="h-3.5 w-3.5" /> Add Menu Group
      </button>
    </div>
  );
}
