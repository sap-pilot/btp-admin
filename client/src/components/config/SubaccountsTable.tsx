import { useRef, useState } from 'react';
import { GripVertical, RefreshCw, RotateCcw, Save } from 'lucide-react';

export interface SpaceEntry {
  spaceId:   string;
  spaceName: string;
}

export interface ServiceInstanceEntry {
  serviceOfferingName: string;
  servicePlanId:       string;
  instanceName:        string;
  url:                 string;
  spaceId:             string;
}

export interface SubaccountEntry {
  region:             string;
  globalAccountGUID:  string;
  subdomain:          string;
  subaccountId:       string;
  subaccountName:     string;
  groupIds:           string;
  alias:              string;
  pos:                number;
  inHomepage:         boolean;
  manageDestinations: boolean;
  useAOD:             boolean;
  org?: {
    orgId:   string;
    orgName: string;
    spaces:  SpaceEntry[];
  };
  subscriptions:    { displayName: string; url: string; customerDeveloped: boolean }[];
  serviceInstances: ServiceInstanceEntry[];
}

export interface RefreshProgress {
  pct:     number;
  message: string;
  error:   string | null;
}

interface Props {
  data:            SubaccountEntry[];
  onChange:        (data: SubaccountEntry[]) => void;
  isDirty:         boolean;
  onRefresh:       () => void;
  isRefreshing:    boolean;
  onReset:         () => void;
  isSaving:        boolean;
  onSave:          () => void;
  refreshProgress: RefreshProgress | null;
  onOpenDetail:    (sa: SubaccountEntry) => void;
}

function updateSa(data: SubaccountEntry[], subaccountId: string, patch: Partial<SubaccountEntry>): SubaccountEntry[] {
  return data.map(s => s.subaccountId === subaccountId ? { ...s, ...patch } : s);
}

function matchesFilter(sa: SubaccountEntry, filter: string): boolean {
  if (!filter) return true;
  const f = filter.toLowerCase();
  return (
    sa.region.toLowerCase().includes(f) ||
    sa.subdomain.toLowerCase().includes(f) ||
    sa.subaccountName.toLowerCase().includes(f) ||
    sa.subaccountId.toLowerCase().includes(f) ||
    sa.groupIds.toLowerCase().includes(f) ||
    sa.alias.toLowerCase().includes(f) ||
    (sa.org?.orgName.toLowerCase().includes(f) ?? false)
  );
}

export default function SubaccountsTable({
  data,
  onChange,
  isDirty,
  onRefresh,
  isRefreshing,
  onReset,
  isSaving,
  onSave,
  refreshProgress,
  onOpenDetail,
}: Props) {
  const [filter, setFilter] = useState('');

  // Drag-and-drop state
  const dragIndex    = useRef<number | null>(null);
  const dragOverIndex = useRef<number | null>(null);

  const sorted = [...data].sort((a, b) => {
    const aPosSet = a.pos > 0;
    const bPosSet = b.pos > 0;
    if (aPosSet !== bPosSet) return aPosSet ? -1 : 1;
    if (aPosSet) return a.pos - b.pos;
    return a.groupIds.localeCompare(b.groupIds) || a.subdomain.localeCompare(b.subdomain);
  });

  const filtered = sorted.filter(sa => matchesFilter(sa, filter));
  const isFiltered = filter.trim() !== '';

  function handleDragStart(idx: number) {
    if (isFiltered) return;
    dragIndex.current = idx;
  }

  function handleDragOver(e: React.DragEvent, idx: number) {
    e.preventDefault();
    dragOverIndex.current = idx;
  }

  function handleDrop() {
    const from = dragIndex.current;
    const to   = dragOverIndex.current;
    if (from === null || to === null || from === to) return;
    const reordered = [...sorted];
    const [moved]   = reordered.splice(from, 1);
    if (!moved) return;
    reordered.splice(to, 0, moved);
    const renumbered = reordered.map((s, i) => ({ ...s, pos: i + 1 }));
    onChange(renumbered);
    dragIndex.current     = null;
    dragOverIndex.current = null;
  }

  const btnBase    = 'inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
  const btnOutline = `${btnBase} border border-border hover:bg-accent hover:text-accent-foreground`;
  const btnPrimary = `${btnBase} bg-primary text-primary-foreground hover:bg-primary/90`;

  const thCls = 'px-2 py-1.5 text-left text-xs font-medium text-muted-foreground border-b border-border whitespace-nowrap';
  const tdCls = 'px-2 py-1 text-xs border-b border-border align-middle';

  return (
    <div className="flex flex-col h-full">
      {/* Action bar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border shrink-0 bg-muted/10">
        <input
          type="text"
          value={filter}
          onChange={e => setFilter(e.target.value)}
          placeholder="Filter subaccounts…"
          className="h-7 px-2 text-xs border border-border rounded bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring w-56"
        />
        <span className="text-xs text-muted-foreground ml-1">
          {isFiltered ? `${filtered.length} / ${data.length}` : data.length} subaccounts
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <button onClick={onRefresh} disabled={isRefreshing || isSaving} className={btnOutline}>
            <RefreshCw className={`h-3.5 w-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />
            {isRefreshing ? 'Refreshing…' : 'Refresh'}
          </button>
          <button onClick={onReset} disabled={!isDirty || isRefreshing || isSaving} className={btnOutline}>
            <RotateCcw className="h-3.5 w-3.5" />
            Reset
          </button>
          <button onClick={onSave} disabled={!isDirty || isRefreshing || isSaving} className={btnPrimary}>
            <Save className="h-3.5 w-3.5" />
            {isSaving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

      {/* Progress bar */}
      {refreshProgress !== null && (
        <div className="shrink-0 relative h-7 border-b border-border overflow-hidden">
          <div
            className={`absolute inset-y-0 left-0 transition-all duration-500 ${
              refreshProgress.error ? 'bg-destructive/50' : 'bg-green-500/50'
            }`}
            style={{ width: `${refreshProgress.pct}%` }}
          />
          <span className="absolute inset-0 flex items-center justify-center text-[11px] text-foreground font-medium px-2 truncate">
            {refreshProgress.error ?? refreshProgress.message}
          </span>
        </div>
      )}

      {/* Table */}
      <div className="flex-1 overflow-auto">
        <table className="w-full border-collapse text-xs" style={{ tableLayout: 'auto' }}>
          <thead className="sticky top-0 z-10">
            <tr className="bg-muted/30">
              <th className={`${thCls} w-6`} />
              <th className={thCls}>Region</th>
              <th className={thCls}>Subdomain</th>
              <th className={thCls}>Subaccount Name</th>
              <th className={thCls}>Group IDs</th>
              <th className={thCls}>Alias</th>
              <th className={`${thCls} text-center`}>Home</th>
              <th className={`${thCls} text-center`}>Dest</th>
              <th className={`${thCls} text-center`}>AOD</th>
              <th className={`${thCls} text-center`}>Sub</th>
              <th className={`${thCls} text-center`}>Svc</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((sa) => {
              const sortedIdx = sorted.indexOf(sa);
              return (
                <tr
                  key={sa.subaccountId}
                  className="hover:bg-muted/20"
                  draggable={!isFiltered}
                  onDragStart={() => handleDragStart(sortedIdx)}
                  onDragOver={e => handleDragOver(e, sortedIdx)}
                  onDrop={handleDrop}
                >
                  <td className={`${tdCls} text-muted-foreground/40 w-6`}>
                    {!isFiltered && <GripVertical className="h-3.5 w-3.5 cursor-grab" />}
                  </td>
                  <td className={`${tdCls} font-mono text-muted-foreground`}>{sa.region}</td>
                  <td className={`${tdCls} font-mono text-[11px] text-muted-foreground`}>{sa.subdomain}</td>
                  <td className={tdCls}>
                    <button
                      onClick={() => onOpenDetail(sa)}
                      className="text-primary hover:underline text-left font-medium truncate max-w-[220px] block"
                    >
                      {sa.subaccountName}
                    </button>
                    {sa.org && (
                      <span className="text-[10px] text-muted-foreground/60 font-mono block truncate max-w-[220px]">
                        {sa.org.orgName}
                      </span>
                    )}
                  </td>
                  <td className={tdCls}>
                    <input
                      className="w-full min-w-[80px] bg-transparent border-b border-transparent hover:border-border focus:border-primary outline-none py-0.5 font-mono text-[11px] placeholder:text-muted-foreground/30"
                      value={sa.groupIds}
                      onChange={e => onChange(updateSa(data, sa.subaccountId, { groupIds: e.target.value }))}
                      placeholder="group1,group2"
                    />
                  </td>
                  <td className={tdCls}>
                    <input
                      className="w-full min-w-[60px] bg-transparent border-b border-transparent hover:border-border focus:border-primary outline-none py-0.5 placeholder:text-muted-foreground/30"
                      value={sa.alias}
                      onChange={e => onChange(updateSa(data, sa.subaccountId, { alias: e.target.value }))}
                      placeholder="alias"
                    />
                  </td>
                  <td className={`${tdCls} text-center`}>
                    <input
                      type="checkbox"
                      checked={sa.inHomepage}
                      onChange={e => onChange(updateSa(data, sa.subaccountId, { inHomepage: e.target.checked }))}
                      className="cursor-pointer"
                    />
                  </td>
                  <td className={`${tdCls} text-center`}>
                    <input
                      type="checkbox"
                      checked={sa.manageDestinations}
                      onChange={e => onChange(updateSa(data, sa.subaccountId, { manageDestinations: e.target.checked }))}
                      className="cursor-pointer"
                    />
                  </td>
                  <td className={`${tdCls} text-center`}>
                    <input
                      type="checkbox"
                      checked={sa.useAOD}
                      onChange={e => onChange(updateSa(data, sa.subaccountId, { useAOD: e.target.checked }))}
                      className="cursor-pointer"
                    />
                  </td>
                  <td className={`${tdCls} text-center`}>
                    {sa.subscriptions.length > 0 ? (
                      <span className="inline-flex items-center justify-center rounded-full bg-primary/10 text-primary text-[10px] font-semibold px-1.5 min-w-[18px]">
                        {sa.subscriptions.length}
                      </span>
                    ) : (
                      <span className="text-muted-foreground/30">—</span>
                    )}
                  </td>
                  <td className={`${tdCls} text-center`}>
                    {sa.serviceInstances.length > 0 ? (
                      <span className="inline-flex items-center justify-center rounded-full bg-primary/10 text-primary text-[10px] font-semibold px-1.5 min-w-[18px]">
                        {sa.serviceInstances.length}
                      </span>
                    ) : (
                      <span className="text-muted-foreground/30">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={11} className="px-4 py-8 text-center text-xs text-muted-foreground">
                  {isFiltered ? 'No subaccounts match the filter.' : 'No subaccounts. Click Refresh to fetch from BTP.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
