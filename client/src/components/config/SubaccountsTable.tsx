import { useRef, useState } from 'react';
import { GripVertical, RefreshCw, RotateCcw, Save, ShieldBan, X } from 'lucide-react';

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
  /** Runtime-only flag set by server when org ID or subaccount ID is in RESTRICTED_ORG_IDS. */
  restricted?:        boolean;
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
  data:              SubaccountEntry[];
  onChange:          (data: SubaccountEntry[]) => void;
  isDirty:           boolean;
  onRefresh:         () => void;
  isRefreshing:      boolean;
  onReset:           () => void;
  isSaving:          boolean;
  onSave:            () => void;
  refreshProgress:   RefreshProgress | null;
  onDismissProgress: () => void;
  onOpenDetail:      (sa: SubaccountEntry) => void;
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
    sa.globalAccountGUID.toLowerCase().includes(f) ||
    sa.globalAccountSubdomain.toLowerCase().includes(f) ||
    sa.groupIds.toLowerCase().includes(f) ||
    sa.alias.toLowerCase().includes(f) ||
    (sa.org?.orgId.toLowerCase().includes(f) ?? false) ||
    (sa.org?.orgName.toLowerCase().includes(f) ?? false) ||
    (sa.org?.spaces.some(sp => sp.spaceId.toLowerCase().includes(f) || sp.spaceName.toLowerCase().includes(f)) ?? false)
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
  onDismissProgress,
  onOpenDetail,
}: Props) {
  const [filter, setFilter]       = useState('');
  const [colWidths, setColWidths] = useState<number[]>(INIT_WIDTHS);

  const resizingRef        = useRef<{ colIdx: number; startX: number; startWidth: number } | null>(null);
  const dragIndex          = useRef<number | null>(null);
  const dragOverRef        = useRef<number | null>(null);
  const [dropIndicator, setDropIndicator] = useState<number | null>(null);

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

  function handleDragStart(e: React.DragEvent, idx: number) {
    if (isFiltered) return;
    dragIndex.current = idx;
    const row = (e.currentTarget as HTMLElement).closest('tr');
    if (row) {
      const rect = row.getBoundingClientRect();
      e.dataTransfer.setDragImage(row, e.clientX - rect.left, e.clientY - rect.top);
    }
  }

  function handleDragOver(e: React.DragEvent, idx: number) {
    e.preventDefault();
    if (dragOverRef.current !== idx) {
      dragOverRef.current = idx;
      setDropIndicator(idx);
    }
  }

  function clearDragState() {
    dragIndex.current   = null;
    dragOverRef.current = null;
    setDropIndicator(null);
  }

  function handleDrop() {
    const from = dragIndex.current;
    const to   = dragOverRef.current;
    clearDragState();
    if (from === null || to === null || from === to) return;
    const reordered = [...sorted];
    const [moved]   = reordered.splice(from, 1);
    if (!moved) return;
    reordered.splice(to, 0, moved);
    onChange(reordered.map((s, i) => ({ ...s, pos: i + 1 })));
  }

  const btnBase    = 'inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
  const btnOutline = `${btnBase} border border-border hover:bg-accent hover:text-accent-foreground`;
  const btnPrimary = `${btnBase} bg-primary text-primary-foreground hover:bg-primary/90`;

  const thCls  = 'relative px-2 py-1.5 text-left text-xs font-medium text-muted-foreground border-b border-border whitespace-nowrap overflow-hidden select-none';
  const tdCls  = 'px-2 py-1 text-xs border-b border-border align-middle overflow-hidden';
  const rszHdl = 'absolute right-0 top-0 h-full w-[3px] cursor-col-resize hover:bg-primary/40 z-10';

  const totalW = colWidths.reduce((a, b) => a + b, 0);

  const barFill = refreshProgress?.error
    ? 'bg-destructive'
    : refreshProgress?.warning
      ? 'bg-yellow-500'
      : refreshProgress && refreshProgress.pct >= 100
        ? 'bg-green-500'
        : 'bg-primary';

  const barBg = refreshProgress?.error
    ? 'bg-destructive/8'
    : refreshProgress?.warning
      ? 'bg-yellow-500/8'
      : refreshProgress && refreshProgress.pct >= 100
        ? 'bg-green-500/8'
        : 'bg-muted/40';

  const barTextColor = refreshProgress?.error
    ? 'text-destructive'
    : refreshProgress?.warning
      ? 'text-yellow-700 dark:text-yellow-300'
      : refreshProgress && refreshProgress.pct >= 100
        ? 'text-green-600 dark:text-green-400'
        : 'text-foreground';

  return (
    <div className="flex flex-col h-full">
      {/* Action bar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border shrink-0 bg-muted/10">
        <div className="relative flex-1 min-w-0">
          <input
            type="text"
            value={filter}
            onChange={e => setFilter(e.target.value)}
            placeholder="Filter subaccounts…"
            className="w-full h-7 px-2 pr-32 text-xs border border-border rounded bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
          <span className={`absolute top-1/2 -translate-y-1/2 text-xs text-muted-foreground/50 pointer-events-none select-none whitespace-nowrap ${filter ? 'right-6' : 'right-2'}`}>
            {isFiltered ? `${filtered.length} / ${data.length}` : data.length} subaccounts
          </span>
          {filter && (
            <button
              onClick={() => setFilter('')}
              className="absolute right-1 top-1/2 -translate-y-1/2 p-0.5 rounded text-muted-foreground hover:text-foreground transition-colors"
              aria-label="Clear filter"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button onClick={onRefresh} disabled={isSaving} className={btnOutline} title={isRefreshing ? 'Refreshing… — click to force another refresh' : 'Refresh'}>
            <RefreshCw className={`h-3.5 w-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />
            <span className="hidden sm:inline">{isRefreshing ? 'Refreshing…' : 'Refresh'}</span>
          </button>
          <button onClick={onReset} disabled={!isDirty || isRefreshing || isSaving} className={btnOutline} title="Reset">
            <RotateCcw className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Reset</span>
          </button>
          <button onClick={onSave} disabled={!isDirty || isRefreshing || isSaving} className={btnPrimary} title={isSaving ? 'Saving…' : 'Save'}>
            <Save className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">{isSaving ? 'Saving…' : 'Save'}</span>
          </button>
        </div>
      </div>

      {/* Progress bar */}
      {refreshProgress !== null && (
        <div className={`relative shrink-0 border-b border-border ${barBg}`}>
          <div className="h-1 w-full bg-transparent">
            <div className={`h-full transition-all duration-300 ${barFill}`} style={{ width: `${refreshProgress.pct}%` }} />
          </div>
          <div className={`px-4 py-1.5 text-xs text-center pr-8 ${barTextColor}`}>
            {refreshProgress.error ?? refreshProgress.message}
          </div>
          <button
            onClick={onDismissProgress}
            className="absolute top-1 right-1 p-0.5 rounded text-muted-foreground/60 hover:text-foreground hover:bg-black/10 dark:hover:bg-white/10 transition-colors"
            title="Dismiss"
          >
            <X className="h-3.5 w-3.5" />
          </button>
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
                  style={dropIndicator === sortedIdx && sortedIdx !== dragIndex.current
                    ? { boxShadow: '0 -2px 0 0 hsl(var(--primary))' }
                    : undefined}
                  onDragOver={e => handleDragOver(e, sortedIdx)}
                  onDrop={handleDrop}
                >
                  <td
                    className={`${tdCls} text-muted-foreground/40${sa.restricted ? ' relative' : ''}`}
                    draggable={!isFiltered}
                    onDragStart={e => handleDragStart(e, sortedIdx)}
                    onDragEnd={clearDragState}
                  >
                    {sa.restricted && (
                      <>
                        <span className="absolute top-0 left-0 border-t-[22px] border-t-red-500 dark:border-t-red-400 border-r-[22px] border-r-transparent pointer-events-none select-none z-10" />
                        <ShieldBan className="absolute top-[2px] left-[1.5px] h-[9px] w-[9px] text-white pointer-events-none select-none z-10" />
                      </>
                    )}
                    {!isFiltered && <GripVertical className="h-3.5 w-3.5 cursor-grab" />}
                  </td>
                  <td className={`${tdCls} font-mono text-muted-foreground truncate`}>{sa.region}</td>
                  <td className={`${tdCls} font-mono text-[11px] truncate`}>
                    <button
                      onClick={() => onOpenDetail(sa)}
                      className="text-primary hover:underline text-left block w-full truncate"
                    >
                      {sa.subdomain}
                    </button>
                  </td>
                  <td className={tdCls}>
                    <span className="block text-[11px] truncate">{sa.globalAccountName || '—'}</span>
                    <span className="block font-mono text-[10px] text-muted-foreground/60 truncate mt-0.5" title={sa.globalAccountGUID}>{sa.globalAccountGUID}</span>
                  </td>
                  <td className={tdCls}>
                    <span className="font-medium block text-[11px] truncate">{sa.subaccountName}</span>
                    <span className="block font-mono text-[10px] text-muted-foreground/70 truncate mt-0.5">{sa.subaccountId}</span>
                  </td>
                  <td className={tdCls}>
                    <span className="block font-mono text-[11px] text-muted-foreground truncate">{sa.org?.orgName || '—'}</span>
                    {sa.org?.orgId && (
                      <span className="block font-mono text-[10px] text-muted-foreground/60 truncate mt-0.5">{sa.org.orgId}</span>
                    )}
                  </td>
                  <td className={tdCls} onDragStart={e => e.stopPropagation()}>
                    <input
                      className={`w-full bg-transparent border-b outline-none py-0.5 font-mono text-[11px] placeholder:text-muted-foreground/30 focus:border-primary ${
                        sa.groupIds ? 'border-transparent hover:border-border' : 'border-amber-500/60 hover:border-amber-500'
                      }`}
                      value={sa.groupIds}
                      onChange={e => onChange(updateSa(data, sa.subaccountId, { groupIds: e.target.value }))}
                      placeholder="group1,group2"
                    />
                  </td>
                  <td className={tdCls} onDragStart={e => e.stopPropagation()}>
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
                      className={sa.restricted ? 'cursor-not-allowed opacity-40' : 'cursor-pointer'}
                      disabled={sa.restricted}
                      title={sa.restricted ? 'Disabled — subaccount is restricted' : undefined} />
                  </td>
                  <td className={`${tdCls} text-center`}>
                    <input type="checkbox" checked={sa.useAOD}
                      onChange={e => onChange(updateSa(data, sa.subaccountId, { useAOD: e.target.checked }))}
                      className={sa.restricted ? 'cursor-not-allowed opacity-40' : 'cursor-pointer'}
                      disabled={sa.restricted}
                      title={sa.restricted ? 'Disabled — subaccount is restricted' : undefined} />
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
