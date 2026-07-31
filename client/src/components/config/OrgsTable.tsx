import { useState } from 'react';
import { RefreshCw, RotateCcw, Save, GripVertical } from 'lucide-react';

export interface SpaceEntry {
  space_id:   string;
  space_name: string;
}

export interface OrgEntry {
  region:             string;
  global_account_id:  string;
  org_id:             string;
  org_name:           string;
  subdomain:          string;
  subaccount_id:      string;
  subaccount_name:    string;
  alias:              string;
  directories:        string;
  pos:                number;
  include_in_homepage: boolean;
  manage_destinations: boolean;
  manage_apps:         boolean;
  spaces:             SpaceEntry[];
}

interface Props {
  data:         OrgEntry[];
  onChange:     (data: OrgEntry[]) => void;
  isDirty:      boolean;
  onRefresh:    () => void;
  isRefreshing: boolean;
  onReset:      () => void;
  isSaving:     boolean;
  onSave:       () => void;
}

function matchesFilter(org: OrgEntry, filter: string): boolean {
  if (!filter) return true;
  const q = filter.toLowerCase();
  return [
    org.region, org.global_account_id,
    org.org_id, org.org_name, org.subdomain,
    org.subaccount_id, org.subaccount_name,
    org.alias, org.directories,
  ].some(v => v.toLowerCase().includes(q));
}

export default function OrgsTable({ data, onChange, isDirty, onRefresh, isRefreshing, onReset, isSaving, onSave }: Props) {
  const [filter, setFilter]     = useState('');
  const [dragging, setDragging] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);

  const isFiltering = filter.trim().length > 0;

  const anyPosSet = data.some(o => o.pos > 0);
  const sorted = [...data].sort((a, b) => {
    const aPosSet = a.pos > 0;
    const bPosSet = b.pos > 0;
    if (aPosSet !== bPosSet) return aPosSet ? -1 : 1;
    if (aPosSet) return a.pos - b.pos;
    return a.directories.localeCompare(b.directories) || a.subdomain.localeCompare(b.subdomain);
  });
  const visible = sorted
    .map((o, sortedIdx) => ({ o, sortedIdx }))
    .filter(({ o }) => matchesFilter(o, filter));

  function updateOrg(orgId: string, region: string, patch: Partial<OrgEntry>) {
    onChange(data.map(o => o.org_id === orgId && o.region === region ? { ...o, ...patch } : o));
  }

  function handleDragStart(idx: number) { setDragging(idx); }

  function handleDragOver(e: React.DragEvent, idx: number) {
    e.preventDefault();
    setDragOver(idx);
  }

  function handleDrop(e: React.DragEvent, targetIdx: number) {
    e.preventDefault();
    if (dragging === null || dragging === targetIdx) { setDragging(null); setDragOver(null); return; }
    const reordered = [...sorted];
    const [moved] = reordered.splice(dragging, 1);
    reordered.splice(targetIdx, 0, moved);
    onChange(reordered.map((o, idx) => ({ ...o, pos: idx + 1 })));
    setDragging(null);
    setDragOver(null);
  }

  function handleDragEnd() { setDragging(null); setDragOver(null); }

  const btnBase    = 'inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
  const btnOutline = `${btnBase} border border-border hover:bg-accent hover:text-accent-foreground`;
  const btnPrimary = `${btnBase} bg-primary text-primary-foreground hover:bg-primary/90`;

  const thCls    = 'px-2 py-1.5 text-left text-xs font-medium text-muted-foreground whitespace-nowrap border-b border-border';
  const rszThCls = `${thCls} overflow-hidden`;
  const tdCls    = 'px-2 py-1 text-xs border-b border-border align-middle';
  const roTdCls  = `${tdCls} text-muted-foreground font-mono overflow-hidden whitespace-nowrap text-ellipsis`;
  const inpCls   = 'w-full bg-transparent border-b border-transparent hover:border-border focus:border-primary outline-none text-xs py-0.5 placeholder:text-muted-foreground/50';

  return (
    <div className="flex flex-col h-full">
      {/* Action bar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border shrink-0">
        <input
          type="text"
          placeholder="Filter orgs..."
          value={filter}
          onChange={e => setFilter(e.target.value)}
          className="flex-1 bg-transparent border border-border rounded px-2 py-1 text-xs outline-none focus:border-primary placeholder:text-muted-foreground/50"
        />
        {filter && (
          <button onClick={() => setFilter('')} className="text-xs text-muted-foreground hover:text-foreground shrink-0">
            Clear
          </button>
        )}
        <button onClick={onRefresh} disabled={isRefreshing} className={btnOutline} title="Re-fetch orgs from CF API">
          <RefreshCw className={`h-3.5 w-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />
          {isRefreshing ? 'Refreshing…' : 'Refresh'}
        </button>
        <button onClick={onReset} disabled={!isDirty || isRefreshing || isSaving} className={btnOutline} title="Restore to last saved state">
          <RotateCcw className="h-3.5 w-3.5" />
          Reset
        </button>
        <button onClick={onSave} disabled={!isDirty || isRefreshing || isSaving} className={btnPrimary}>
          <Save className="h-3.5 w-3.5" />
          {isSaving ? 'Saving…' : 'Save'}
        </button>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto">
        <table className="w-full border-collapse text-sm" style={{ tableLayout: 'fixed', minWidth: 960 }}>
          <thead className="sticky top-0 z-10">
            <tr className="bg-muted/40">
              <th className={`${thCls} w-6`} style={{ width: 28 }} />
              <th className={thCls} style={{ width: 76 }}>Region</th>
              <th className={rszThCls} style={{ resize: 'horizontal', width: 140, minWidth: 100 }}>Org Name</th>
              <th className={rszThCls} style={{ resize: 'horizontal', width: 120, minWidth: 80 }}>Org ID</th>
              <th className={rszThCls} style={{ resize: 'horizontal', width: 110, minWidth: 80 }}>Subdomain</th>
              <th className={rszThCls} style={{ resize: 'horizontal', width: 120, minWidth: 80 }}>Subaccount ID</th>
              <th className={rszThCls} style={{ resize: 'horizontal', width: 110, minWidth: 80 }}>Directories</th>
              <th className={rszThCls} style={{ resize: 'horizontal', width: 100, minWidth: 80 }}>Alias</th>
              <th className={`${thCls} text-center`} style={{ width: 44 }}>Home</th>
              <th className={`${thCls} text-center`} style={{ width: 44 }}>Apps</th>
              <th className={`${thCls} text-center`} style={{ width: 44 }}>Dest</th>
            </tr>
          </thead>
          <tbody>
            {data.length === 0 && (
              <tr>
                <td colSpan={11} className="px-3 py-8 text-center text-sm text-muted-foreground">
                  No orgs loaded. Click <strong>Refresh</strong> to fetch from CF.
                </td>
              </tr>
            )}
            {visible.map(({ o, sortedIdx }) => {
              const isDraggingRow = dragging === sortedIdx;
              const isDropTarget  = dragOver === sortedIdx;
              return (
                <tr
                  key={`${o.region}-${o.org_id}`}
                  onDragOver={e => !isFiltering && handleDragOver(e, sortedIdx)}
                  onDrop={e => !isFiltering && handleDrop(e, sortedIdx)}
                  className={`hover:bg-muted/20 ${isDraggingRow ? 'opacity-40' : ''} ${isDropTarget ? 'border-t-2 border-primary' : ''}`}
                >
                  <td
                    draggable={!isFiltering}
                    onDragStart={() => !isFiltering && handleDragStart(sortedIdx)}
                    onDragEnd={handleDragEnd}
                    className={`${tdCls} text-muted-foreground ${isFiltering ? 'cursor-default opacity-30' : 'cursor-grab active:cursor-grabbing'}`}
                  >
                    <GripVertical className="h-3.5 w-3.5" />
                  </td>
                  <td className={`${roTdCls} text-[10px] font-semibold`} title={o.region}>{o.region}</td>
                  <td className={`${tdCls} font-medium overflow-hidden whitespace-nowrap text-ellipsis`} title={o.org_name}>{o.org_name}</td>
                  <td className={roTdCls} title={o.org_id}>{o.org_id || '—'}</td>
                  <td className={tdCls}>
                    <input className={inpCls} value={o.subdomain} placeholder="subdomain"
                      onChange={e => updateOrg(o.org_id, o.region, { subdomain: e.target.value })} />
                  </td>
                  <td className={tdCls}>
                    <input className={inpCls} value={o.subaccount_id} placeholder="subaccount ID"
                      onChange={e => updateOrg(o.org_id, o.region, { subaccount_id: e.target.value })} />
                  </td>
                  <td className={tdCls}>
                    <input className={inpCls} value={o.directories} placeholder="dir1, dir2"
                      onChange={e => updateOrg(o.org_id, o.region, { directories: e.target.value })} />
                  </td>
                  <td className={tdCls}>
                    <input className={inpCls} value={o.alias} placeholder="alias"
                      onChange={e => updateOrg(o.org_id, o.region, { alias: e.target.value })} />
                  </td>
                  <td className={`${tdCls} text-center`}>
                    <input type="checkbox" checked={o.include_in_homepage ?? false}
                      onChange={e => updateOrg(o.org_id, o.region, { include_in_homepage: e.target.checked })}
                      className="cursor-pointer" />
                  </td>
                  <td className={`${tdCls} text-center`}>
                    <input type="checkbox" checked={o.manage_apps}
                      onChange={e => updateOrg(o.org_id, o.region, { manage_apps: e.target.checked })}
                      className="cursor-pointer" />
                  </td>
                  <td className={`${tdCls} text-center`}>
                    <input type="checkbox" checked={o.manage_destinations}
                      onChange={e => updateOrg(o.org_id, o.region, { manage_destinations: e.target.checked })}
                      className="cursor-pointer" />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {!anyPosSet && data.length > 0 && (
        <div className="shrink-0 px-3 py-1.5 border-t border-border text-[10px] text-muted-foreground/60">
          Sorted by Directories then Subdomain (no positions set). Drag to reorder and Save to persist order.
        </div>
      )}
    </div>
  );
}
