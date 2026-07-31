import { useState } from 'react';
import { ChevronDown, ChevronRight, RefreshCw, RotateCcw, Save, GripVertical } from 'lucide-react';

export interface OrgEntry {
  org_id:          string;
  org_name:        string;
  subdomain:       string;
  subaccount_id:   string;
  subaccount_name: string;
  alias:           string;
  directories:     string;
  pos:             number;
  includeInHomepage: boolean;
  manageDestination: boolean;
  manageApps:        boolean;
}

export interface OrgRegion {
  region: string;
  orgs:   OrgEntry[];
}

interface Props {
  data:        OrgRegion[];
  onChange:    (data: OrgRegion[]) => void;
  isDirty:     boolean;
  onRefresh:   () => void;
  isRefreshing: boolean;
  onReset:     () => void;
  isSaving:    boolean;
  onSave:      () => void;
}

function matchesFilter(org: OrgEntry, region: string, filter: string): boolean {
  if (!filter) return true;
  const q = filter.toLowerCase();
  return [
    org.org_id, org.org_name, org.subdomain,
    org.subaccount_id, org.subaccount_name,
    org.alias, org.directories, region,
  ].some(v => v.toLowerCase().includes(q));
}

export default function OrgsTable({ data, onChange, isDirty, onRefresh, isRefreshing, onReset, isSaving, onSave }: Props) {
  const [filter, setFilter]           = useState('');
  const [expandedRegions, setExpanded] = useState<Set<string>>(() => new Set(data.map(r => r.region)));
  const [dragging, setDragging]        = useState<{ ri: number; oi: number } | null>(null);
  const [dragOver, setDragOver]        = useState<{ ri: number; oi: number } | null>(null);

  const isFiltering = filter.trim().length > 0;

  function toggleRegion(region: string) {
    setExpanded(prev => {
      const next = new Set(prev);
      next.has(region) ? next.delete(region) : next.add(region);
      return next;
    });
  }

  function updateOrg(ri: number, realOi: number, patch: Partial<OrgEntry>) {
    const next = data.map((r, i) =>
      i !== ri ? r : { ...r, orgs: r.orgs.map((o, oi) => oi !== realOi ? o : { ...o, ...patch }) },
    );
    onChange(next);
  }

  function handleDragStart(ri: number, oi: number) {
    setDragging({ ri, oi });
  }

  function handleDragOver(e: React.DragEvent, ri: number, oi: number) {
    e.preventDefault();
    if (dragging && dragging.ri === ri) setDragOver({ ri, oi });
  }

  function handleDrop(e: React.DragEvent, ri: number, targetOi: number) {
    e.preventDefault();
    if (!dragging || dragging.ri !== ri) { setDragging(null); setDragOver(null); return; }
    const { oi: fromOi } = dragging;
    if (fromOi === targetOi) { setDragging(null); setDragOver(null); return; }

    const next = data.map((r, i) => {
      if (i !== ri) return r;
      const orgs = [...r.orgs];
      const [moved] = orgs.splice(fromOi, 1);
      orgs.splice(targetOi, 0, moved);
      return { ...r, orgs: orgs.map((o, idx) => ({ ...o, pos: idx })) };
    });
    onChange(next);
    setDragging(null);
    setDragOver(null);
  }

  function handleDragEnd() {
    setDragging(null);
    setDragOver(null);
  }

  const btnBase    = 'inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
  const btnOutline = `${btnBase} border border-border hover:bg-accent hover:text-accent-foreground`;
  const btnPrimary = `${btnBase} bg-primary text-primary-foreground hover:bg-primary/90`;

  const thCls    = 'px-2 py-1.5 text-left text-xs font-medium text-muted-foreground whitespace-nowrap border-b border-border';
  const rszThCls = `${thCls} overflow-hidden` ;
  const tdCls    = 'px-2 py-1 text-xs border-b border-border align-middle';
  const roTdCls = `${tdCls} text-muted-foreground font-mono overflow-hidden whitespace-nowrap text-ellipsis`;
  const inpCls  = 'w-full bg-transparent border-b border-transparent hover:border-border focus:border-primary outline-none text-xs py-0.5 placeholder:text-muted-foreground/50';

  return (
    <div className="flex flex-col h-full">
      {/* Action bar: filter + buttons */}
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
          {isSaving ? 'Saving…' : 'Save Orgs'}
        </button>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto">
        <table className="w-full border-collapse text-sm" style={{ tableLayout: 'fixed', minWidth: 900 }}>
          <thead className="sticky top-0 bg-background z-10">
            <tr>
              <th className={`${thCls} w-6`} style={{ width: 28 }} />
              <th className={rszThCls} style={{ resize: 'horizontal', width: 140, minWidth: 100 }}>Region / Org Name</th>
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
                <td colSpan={10} className="px-3 py-8 text-center text-sm text-muted-foreground">
                  No orgs loaded. Click <strong>Refresh</strong> to fetch from CF.
                </td>
              </tr>
            )}
            {data.map((region, ri) => {
              const sortedOrgs  = [...region.orgs].sort((a, b) => a.pos - b.pos);
              const visibleOrgs = sortedOrgs.filter(o => matchesFilter(o, region.region, filter));
              if (isFiltering && visibleOrgs.length === 0) return null;
              const expanded = isFiltering || expandedRegions.has(region.region);

              return [
                <tr
                  key={`region-${region.region}`}
                  className="bg-muted/40 cursor-pointer select-none hover:bg-muted/60"
                  onClick={() => !isFiltering && toggleRegion(region.region)}
                >
                  <td colSpan={10} className="px-2 py-1.5 border-b border-border">
                    <div className="flex items-center gap-1.5">
                      {isFiltering
                        ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                        : expanded
                          ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                          : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                      }
                      <span className="text-xs font-semibold">{region.region}</span>
                      <span className="text-xs text-muted-foreground ml-1">
                        ({isFiltering ? `${visibleOrgs.length} / ` : ''}{region.orgs.length} orgs)
                      </span>
                    </div>
                  </td>
                </tr>,

                ...(expanded ? visibleOrgs : []).map((org) => {
                  const realOi      = region.orgs.indexOf(org);
                  const isDragging  = dragging?.ri === ri && dragging.oi === realOi;
                  const isDropTarget = dragOver?.ri === ri && dragOver.oi === realOi;
                  return (
                    <tr
                      key={`org-${region.region}-${org.org_id}`}
                      onDragOver={e => handleDragOver(e, ri, realOi)}
                      onDrop={e => handleDrop(e, ri, realOi)}
                      className={`hover:bg-muted/20 ${isDragging ? 'opacity-40' : ''} ${isDropTarget ? 'border-t-2 border-primary' : ''}`}
                    >
                      <td
                        draggable
                        onDragStart={() => handleDragStart(ri, realOi)}
                        onDragEnd={handleDragEnd}
                        className={`${tdCls} w-6 pl-6 text-muted-foreground cursor-grab active:cursor-grabbing`}
                      >
                        <GripVertical className="h-3.5 w-3.5" />
                      </td>
                      <td className={`${tdCls} font-medium overflow-hidden whitespace-nowrap text-ellipsis`} title={org.org_name}>{org.org_name}</td>
                      <td className={roTdCls} title={org.org_id}>{org.org_id || '—'}</td>
                      <td className={roTdCls} title={org.subdomain}>{org.subdomain || '—'}</td>
                      <td className={roTdCls} title={org.subaccount_id}>{org.subaccount_id || '—'}</td>
                      <td className={tdCls}>
                        <input className={inpCls} value={org.directories} placeholder="dir1, dir2"
                          onChange={e => updateOrg(ri, realOi, { directories: e.target.value })} />
                      </td>
                      <td className={tdCls}>
                        <input className={inpCls} value={org.alias} placeholder="alias"
                          onChange={e => updateOrg(ri, realOi, { alias: e.target.value })} />
                      </td>
                      <td className={`${tdCls} text-center`}>
                        <input type="checkbox" checked={org.includeInHomepage ?? false}
                          onChange={e => updateOrg(ri, realOi, { includeInHomepage: e.target.checked })}
                          className="cursor-pointer" />
                      </td>
                      <td className={`${tdCls} text-center`}>
                        <input type="checkbox" checked={org.manageApps}
                          onChange={e => updateOrg(ri, realOi, { manageApps: e.target.checked })}
                          className="cursor-pointer" />
                      </td>
                      <td className={`${tdCls} text-center`}>
                        <input type="checkbox" checked={org.manageDestination}
                          onChange={e => updateOrg(ri, realOi, { manageDestination: e.target.checked })}
                          className="cursor-pointer" />
                      </td>
                    </tr>
                  );
                }),
              ];
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
