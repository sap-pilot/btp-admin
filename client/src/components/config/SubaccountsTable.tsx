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
  region:                 string;
  globalAccountGUID:      string;
  globalAccountName:      string;
  globalAccountSubdomain: string;
  subdomain:              string;
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
  pct:      number;
  message:  string;
  error:    string | null;
  warning?: boolean;
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

// col idx:        0    1    2    3    4    5    6    7   8   9   10  11  12
//                grip  rgn  sub  ga   sa   org  grp  al  hm  dt  aod sub svc
const INIT_WIDTHS = [28,  65,  95, 160, 195, 145, 110, 85, 42, 42,  42, 44, 44];
const MIN_WIDTHS  = [28,  40,  55,  90, 110,  80,  55, 45, 32, 32,  32, 32, 32];

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
    sa.globalAccountName.toLowerCase().includes(f) ||
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
  const [filter, setFilter]       = useState('');
  const [colWidths, setColWidths] = useState<number[]>(INIT_WIDTHS);

  const resizingRef   = useRef<{ colIdx: number; startX: number; startWidth: number } | null>(null);
  const dragIndex     = useRef<number | null>(null);
  const dragOverIndex = useRef<number | null>(null);

  const sorted = [...data].sort((a, b) => {
    const aPosSet = a.pos > 0;
    const bPosSet = b.pos > 0;
    if (aPosSet !== bPosSet) return aPosSet ? -1 : 1;
    if (aPosSet) return a.pos - b.pos;
    return a.groupIds.localeCompare(b.groupIds) || a.subdomain.localeCompare(b.subdomain);
  });

  const filtered   = sorted.filter(sa => matchesFilter(sa, filter));
  const isFiltered = filter.trim() !== '';

  function startResize(e: React.MouseEvent, colIdx: number) {
    e.preventDefault();
    e.stopPropagation();
    resizingRef.current = { colIdx, startX: e.clientX, startWidth: colWidths[colIdx] ?? 60 };

    const onMove = (ev: MouseEvent) => {
      if (!resizingRef.current) return;
      const { colIdx: ci, startX, startWidth } = resizingRef.current;
      const newW = Math.max(MIN_WIDTHS[ci] ?? 30, startWidth + ev.clientX - startX);
      setColWidths(prev => { const w = [...prev]; w[ci] = newW; return w; });
    };

    const onUp = () => {
      resizingRef.current = null;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

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

  const thCls  = 'relative px-2 py-1.5 text-left text-xs font-medium text-muted-foreground border-b border-border whitespace-nowrap overflow-hidden select-none';
  const tdCls  = 'px-2 py-1 text-xs border-b border-border align-middle overflow-hidden';
  const rszHdl = 'absolute right-0 top-0 h-full w-[3px] cursor-col-resize hover:bg-primary/40 z-10';

  const totalW = colWidths.reduce((a, b) => a + b, 0);

  const barColor = refreshProgress?.error
    ? 'bg-destructive/50'
    : refreshProgress?.warning
      ? 'bg-yellow-500/40'
      : 'bg-green-500/50';

  const barTextColor = refreshProgress?.error
    ? 'text-destructive'
    : refreshProgress?.warning
      ? 'text-yellow-700 dark:text-yellow-300'
      : 'text-foreground';

  return (
    <div className="flex flex-col h-full">
      {/* Action bar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border shrink-0 bg-muted/10">
        <input
          type="text"
          value={filter}
          onChange={e => setFilter(e.target.value)}
          placeholder="Filter subaccounts…"
          className="flex-1 min-w-0 h-7 px-2 text-xs border border-border rounded bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        />
        <span className="shrink-0 text-xs text-muted-foreground">
          {isFiltered ? `${filtered.length} / ${data.length}` : data.length} subaccounts
        </span>
        <div className="flex items-center gap-1.5 shrink-0">
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
            className={`absolute inset-y-0 left-0 transition-all duration-500 ${barColor}`}
            style={{ width: `${refreshProgress.pct}%` }}
          />
          <span className={`absolute inset-0 flex items-center justify-center text-[11px] font-medium px-2 truncate ${barTextColor}`}>
            {refreshProgress.error ?? refreshProgress.message}
          </span>
        </div>
      )}

      {/* Table */}
      <div className="flex-1 overflow-auto">
        <table
          className="border-collapse text-xs"
          style={{ tableLayout: 'fixed', width: totalW, minWidth: '100%' }}
        >
          <colgroup>
            {colWidths.map((w, i) => <col key={i} style={{ width: w }} />)}
          </colgroup>
          <thead className="sticky top-0 z-10">
            <tr className="bg-muted/30">
              {/* grip — fixed, not resizable */}
              <th className={thCls} />

              <th className={thCls}>
                Region
                <div className={rszHdl} onMouseDown={e => startResize(e, 1)} />
              </th>
              <th className={thCls}>
                Subdomain
                <div className={rszHdl} onMouseDown={e => startResize(e, 2)} />
              </th>
              <th className={thCls}>
                Global Account
                <div className={rszHdl} onMouseDown={e => startResize(e, 3)} />
              </th>
              <th className={thCls}>
                Subaccount Name
                <div className={rszHdl} onMouseDown={e => startResize(e, 4)} />
              </th>
              <th className={thCls}>
                Org Name
                <div className={rszHdl} onMouseDown={e => startResize(e, 5)} />
              </th>
              <th className={thCls}>
                Group IDs
                <div className={rszHdl} onMouseDown={e => startResize(e, 6)} />
              </th>
              <th className={thCls}>
                Alias
                <div className={rszHdl} onMouseDown={e => startResize(e, 7)} />
              </th>
              <th className={`${thCls} text-center`}>
                Home
                <div className={rszHdl} onMouseDown={e => startResize(e, 8)} />
              </th>
              <th className={`${thCls} text-center`}>
                Dest
                <div className={rszHdl} onMouseDown={e => startResize(e, 9)} />
              </th>
              <th className={`${thCls} text-center`}>
                AOD
                <div className={rszHdl} onMouseDown={e => startResize(e, 10)} />
              </th>
              <th className={`${thCls} text-center`}>
                Sub
                <div className={rszHdl} onMouseDown={e => startResize(e, 11)} />
              </th>
              <th className={`${thCls} text-center`}>
                Svc
                <div className={rszHdl} onMouseDown={e => startResize(e, 12)} />
              </th>
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
                  <td className={`${tdCls} text-muted-foreground/40`}>
                    {!isFiltered && <GripVertical className="h-3.5 w-3.5 cursor-grab" />}
                  </td>
                  <td className={`${tdCls} font-mono text-muted-foreground truncate`}>{sa.region}</td>
                  <td className={`${tdCls} font-mono text-[11px] text-muted-foreground truncate`}>{sa.subdomain}</td>
                  <td className={tdCls}>
                    <span className="block text-[11px] truncate">{sa.globalAccountName || '—'}</span>
                    <span className="block font-mono text-[10px] text-muted-foreground/60 truncate mt-0.5" title={sa.globalAccountGUID}>{sa.globalAccountGUID}</span>
                  </td>
                  <td className={tdCls}>
                    <button
                      onClick={() => onOpenDetail(sa)}
                      className="text-primary hover:underline text-left font-medium block w-full truncate"
                    >
                      {sa.subaccountName}
                    </button>
                    <span className="block font-mono text-[10px] text-muted-foreground/70 truncate mt-0.5">{sa.subaccountId}</span>
                  </td>
                  <td className={tdCls}>
                    <span className="block font-mono text-[11px] text-muted-foreground truncate">{sa.org?.orgName || '—'}</span>
                    {sa.org?.orgId && (
                      <span className="block font-mono text-[10px] text-muted-foreground/60 truncate mt-0.5">{sa.org.orgId}</span>
                    )}
                  </td>
                  <td className={tdCls}>
                    <input
                      className={`w-full bg-transparent border-b outline-none py-0.5 font-mono text-[11px] placeholder:text-muted-foreground/30 focus:border-primary ${
                        sa.groupIds ? 'border-transparent hover:border-border' : 'border-amber-500/60 hover:border-amber-500'
                      }`}
                      value={sa.groupIds}
                      onChange={e => onChange(updateSa(data, sa.subaccountId, { groupIds: e.target.value }))}
                      placeholder="group1,group2"
                    />
                  </td>
                  <td className={tdCls}>
                    <input
                      className={`w-full bg-transparent border-b outline-none py-0.5 placeholder:text-muted-foreground/30 focus:border-primary ${
                        sa.alias ? 'border-transparent hover:border-border' : 'border-amber-500/60 hover:border-amber-500'
                      }`}
                      value={sa.alias}
                      onChange={e => onChange(updateSa(data, sa.subaccountId, { alias: e.target.value }))}
                      placeholder="alias"
                    />
                  </td>
                  <td className={`${tdCls} text-center`}>
                    <input type="checkbox" checked={sa.inHomepage}
                      onChange={e => onChange(updateSa(data, sa.subaccountId, { inHomepage: e.target.checked }))}
                      className="cursor-pointer" />
                  </td>
                  <td className={`${tdCls} text-center`}>
                    <input type="checkbox" checked={sa.manageDestinations}
                      onChange={e => onChange(updateSa(data, sa.subaccountId, { manageDestinations: e.target.checked }))}
                      className="cursor-pointer" />
                  </td>
                  <td className={`${tdCls} text-center`}>
                    <input type="checkbox" checked={sa.useAOD}
                      onChange={e => onChange(updateSa(data, sa.subaccountId, { useAOD: e.target.checked }))}
                      className="cursor-pointer" />
                  </td>
                  <td className={`${tdCls} text-center`}>
                    {sa.subscriptions.length > 0
                      ? <span className="inline-flex items-center justify-center rounded-full bg-primary/10 text-primary text-[10px] font-semibold px-1.5 min-w-[18px]">{sa.subscriptions.length}</span>
                      : <span className="text-muted-foreground/30">—</span>}
                  </td>
                  <td className={`${tdCls} text-center`}>
                    {sa.serviceInstances.length > 0
                      ? <span className="inline-flex items-center justify-center rounded-full bg-primary/10 text-primary text-[10px] font-semibold px-1.5 min-w-[18px]">{sa.serviceInstances.length}</span>
                      : <span className="text-muted-foreground/30">—</span>}
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={13} className="px-4 py-8 text-center text-xs text-muted-foreground">
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
