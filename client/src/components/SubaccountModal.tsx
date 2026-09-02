import { useState, useEffect, useRef } from 'react';
import { ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, ExternalLink, Filter, Maximize2, Minimize2, Pencil, RotateCcw, Save, ShieldBan, X } from 'lucide-react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import AppsTab from '@/components/config/tabs/AppsTab';
import DestTab, { type SelectedDest } from '@/components/config/tabs/DestTab';
import RolesTab from '@/components/config/tabs/RolesTab';
import UsersTab from '@/components/config/tabs/UsersTab';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
  DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { openSubaccountPopup } from '@/lib/openSubaccountPopup';
import type { SubaccountEntry, SpaceEntry } from './config/SubaccountsTable';
import type { CockpitMenuItem } from '@/components/home/HomepageContent';
import type { TabEntry } from './config/TabsTable';

interface Props {
  sa:                    SubaccountEntry | null;
  onClose:               () => void;
  cockpit?:              { idp: string; host: string };
  cockpitMenu?:          CockpitMenuItem | null;
  isAdmin?:              boolean;
  onSpaceSave?:          (region: string, subdomain: string, spaces: { spaceId: string; manageDest: boolean; aod: boolean }[]) => Promise<void>;
  subaccounts?:          SubaccountEntry[];
  onSelectSubaccount?:   (sa: SubaccountEntry) => void;
  tabs?:                 TabEntry[];
  initialTab?:           ModalTab;
  // Apps tab
  initialAppGuid?:       string;
  onAppDataChange?:      () => void;
  // Destinations tab
  allDestNames?:         string[];
  initialDestName?:      string;
  initialDestTab?:       'properties' | 'changelog' | 'test';
  initialDestShowList?:  boolean;
  initialDestSpaceName?: string;
  initialDestInstName?:  string;
  initialDestInstGuid?:  string;
  selectedDests?:        SelectedDest[];
  onToggleCompare?:      (d: SelectedDest) => void;
  onOpenCompare?:        (dests: SelectedDest[]) => void;
  onDestDataChange?:     () => void;
  // Roles tab
  allRcNames?:           string[];
  initialRcName?:        string;
  initialRcTab?:         'details' | 'users' | 'changelog';
  initialRcShowList?:    boolean;
  onRcDataChange?:       () => void;
  // Users tab
  initialUserEmail?:     string;
  initialUserOrigin?:    string;
  initialUserTab?:       'detail' | 'access' | 'history';
  onUserDataChange?:     () => void;
  // Popup mode
  isPopup?:              boolean;
}

export type ModalTab = 'info' | 'services' | 'apps' | 'destinations' | 'roles' | 'users';

// ─── Cockpit URL helpers ──────────────────────────────────────────────────────

function resolve(tpl: string, ctx: Record<string, string>): string {
  return tpl.replace(/\{([^}]+)\}/g, (_, k: string) => ctx[k] ?? '');
}
function cleanUrl(url: string): string {
  const hi = url.indexOf('#');
  const before = hi >= 0 ? url.slice(0, hi) : url;
  const after  = hi >= 0 ? url.slice(hi)    : '';
  const qi = before.indexOf('?');
  if (qi < 0) return url;
  const base   = before.slice(0, qi);
  const params = before.slice(qi + 1).split('&').filter(p => {
    const eq = p.indexOf('=');
    return eq < 0 || p.slice(eq + 1) !== '';
  });
  return base + (params.length ? '?' + params.join('&') : '') + after;
}
function resolveUrl(tpl: string, ctx: Record<string, string>): string {
  return cleanUrl(resolve(tpl, ctx));
}
function deriveCockpitRegion(region: string): string {
  if (region.startsWith('us')) return 'amer';
  if (region.startsWith('eu')) return region.split('-')[0];
  if (region.startsWith('ap')) return 'ap21';
  if (region.startsWith('br')) return 'br10';
  if (region.startsWith('jp')) return 'jp10';
  if (region.startsWith('ca')) return 'ca10';
  if (region.startsWith('au')) return 'ap10';
  return region;
}
function ensureHttps(host: string): string {
  return /^https?:\/\//i.test(host) ? host : `https://${host}`;
}
function stripProtocol(host: string): string {
  return host.replace(/^https?:\/\//i, '');
}

function buildCtx(sa: SubaccountEntry, cockpit: { idp: string; host: string }): Record<string, string> {
  return {
    'homepage.cockpit.host': cockpit.host ? stripProtocol(cockpit.host) : '',
    'homepage.cockpit.idp':  cockpit.idp,
    cockpitRegion:           deriveCockpitRegion(sa.region),
    globalAccountGUID:       sa.globalAccountGUID,
    subaccountId:            sa.subaccountId,
    orgId:                   sa.org?.orgId ?? '',
    subdomain:               sa.subdomain,
  };
}

const SPACE_SVC_INST_TPL = 'https://{cockpitRegion}.cockpit.btp.cloud.sap/cockpit/?idp={homepage.cockpit.idp}#/globalaccount/{globalAccountGUID}/subaccount/{subaccountId}/org/{orgId}/space/{spaceId}/service-instances';
const SA_COCKPIT_TPL     = 'https://{cockpitRegion}.cockpit.btp.cloud.sap/cockpit/?idp={homepage.cockpit.idp}#/globalaccount/{globalAccountGUID}/subaccount/{subaccountId}/overview';

function buildSpaceInstUrl(sa: SubaccountEntry, cockpit: { idp: string; host: string }, spaceId: string): string {
  return resolveUrl(SPACE_SVC_INST_TPL, { ...buildCtx(sa, cockpit), spaceId });
}

function buildInstanceDetailUrl(sa: SubaccountEntry, cockpit: { idp: string; host: string }, spaceId: string, instanceId: string): string {
  const region = deriveCockpitRegion(sa.region);
  const idp    = cockpit.idp ? `?idp=${cockpit.idp}` : '';
  const orgId  = sa.org?.orgId ?? '';
  return `https://${region}.cockpit.btp.cloud.sap/cockpit/${idp}#/globalaccount/${sa.globalAccountGUID}/subaccount/${sa.subaccountId}/org/${orgId}/space/${spaceId}/service-instances&//detail/${instanceId}/?layout=TwoColumnsMidExpanded`;
}

function renderMenuItems(items: CockpitMenuItem[], ctx: Record<string, string>, spaces: SpaceEntry[]): React.ReactNode[] {
  return items.flatMap((item, i) => {
    if (item.name === '-') return [<DropdownMenuSeparator key={`sep-${i}`} />];
    if (item.repeatOn === 'spaces') {
      return spaces.flatMap(sp => {
        const spCtx = { ...ctx, spaceId: sp.spaceId, spaceName: sp.spaceName };
        const name  = resolve(item.name, spCtx);
        const url   = item.url ? resolveUrl(item.url, spCtx) : undefined;
        if (item.submenus?.length) {
          return [(<DropdownMenuSub key={sp.spaceId}>
            <DropdownMenuSubTrigger className="text-xs">{name}</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {url && <><DropdownMenuItem className="text-xs cursor-pointer" asChild><a href={url} target="_blank" rel="noopener noreferrer">{name}</a></DropdownMenuItem><DropdownMenuSeparator /></>}
              {renderMenuItems(item.submenus, spCtx, spaces)}
            </DropdownMenuSubContent>
          </DropdownMenuSub>)];
        }
        return url ? [<DropdownMenuItem key={sp.spaceId} className="text-xs cursor-pointer" asChild><a href={url} target="_blank" rel="noopener noreferrer">{name}</a></DropdownMenuItem>] : [];
      });
    }
    const name = resolve(item.name, ctx);
    const url  = item.url ? resolveUrl(item.url, ctx) : undefined;
    if (item.submenus?.length) {
      return [(<DropdownMenuSub key={i}>
        <DropdownMenuSubTrigger className="text-xs">{name}</DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          {url && <><DropdownMenuItem className="text-xs cursor-pointer" asChild><a href={url} target="_blank" rel="noopener noreferrer">{name}</a></DropdownMenuItem><DropdownMenuSeparator /></>}
          {renderMenuItems(item.submenus, ctx, spaces)}
        </DropdownMenuSubContent>
      </DropdownMenuSub>)];
    }
    return [url
      ? <DropdownMenuItem key={i} className="text-xs cursor-pointer" asChild><a href={url} target="_blank" rel="noopener noreferrer">{name}</a></DropdownMenuItem>
      : <DropdownMenuItem key={i} className="text-xs" disabled>{name}</DropdownMenuItem>
    ];
  });
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] text-muted-foreground uppercase tracking-wide">{label}</span>
      <span className={`text-xs text-foreground break-all ${mono ? 'font-mono' : ''}`}>{value || '—'}</span>
    </div>
  );
}

const thCls = 'text-left px-2 py-1.5 text-[10px] font-medium text-muted-foreground border-b border-border';
const tdCls = 'px-2 py-1.5 border-b border-border text-xs';

const TAB_LABEL: Record<ModalTab, string> = {
  info: 'Overview', services: 'Services', apps: 'Apps',
  destinations: 'Destinations', roles: 'Roles', users: 'Users',
};

export default function SubaccountModal({ sa, onClose, cockpit, cockpitMenu, isAdmin, onSpaceSave, subaccounts, onSelectSubaccount, tabs, initialTab, initialAppGuid, onAppDataChange, allDestNames, initialDestName, initialDestTab, initialDestShowList, initialDestSpaceName, initialDestInstName, initialDestInstGuid, selectedDests, onToggleCompare, onOpenCompare, onDestDataChange, allRcNames, initialRcName, initialRcTab, initialRcShowList, onRcDataChange, initialUserEmail, initialUserOrigin, initialUserTab, onUserDataChange, isPopup }: Props) {
  const [activeTab, setActiveTab]           = useState<ModalTab>(initialTab ?? 'info');
  const [mountedTabs, setMountedTabs]       = useState<Set<ModalTab>>(new Set);
  const [maximized, setMaximized]           = useState(false);
  const [svcFilter, setSvcFilter]           = useState('');
  const [subFilter, setSubFilter]           = useState('');
  const [saFilter, setSaFilter]             = useState('');
  const [svcExpanded, setSvcExpanded]       = useState<Set<string>>(new Set());
  const [spaceDests, setSpaceDests]         = useState<Map<string, boolean>>(new Map());
  const [spaceDestsOrig, setSpaceDestsOrig] = useState<Map<string, boolean>>(new Map());
  const [spaceAods, setSpaceAods]           = useState<Map<string, boolean>>(new Map());
  const [spaceAodsOrig, setSpaceAodsOrig]   = useState<Map<string, boolean>>(new Map());
  const [spaceSaving, setSpaceSaving]       = useState(false);
  const [spaceEditing, setSpaceEditing]     = useState(false);
  const [aodRefreshPending, setAodRefreshPending] = useState(false);
  const [destAutoRefresh, setDestAutoRefresh]     = useState(0);
  const [overviewSplit, setOverviewSplit]   = useState(40);
  const [servicesSplit, setServicesSplit]   = useState(40);

  const overviewRef  = useRef<HTMLDivElement>(null);
  const servicesRef  = useRef<HTMLDivElement>(null);
  const dragging     = useRef<{ set: (v: number) => void; left: number; width: number } | null>(null);
  const prevSaKeyRef = useRef('');

  const saKey = sa ? `${sa.region}/${sa.subdomain}` : '';

  // Lazy-mount admin tabs: add on first visit; reset to empty when SA switches.
  useEffect(() => {
    const isNewSa = saKey !== prevSaKeyRef.current;
    prevSaKeyRef.current = saKey;
    setMountedTabs(prev => {
      if (isNewSa) return saKey ? new Set([activeTab]) : new Set();
      if (prev.has(activeTab)) return prev;
      const next = new Set(prev);
      next.add(activeTab);
      return next;
    });
  }, [activeTab, saKey]);

  const canManageSpaces = isAdmin || window.location.hostname === 'localhost';
  const isAdminMode     = isAdmin || window.location.hostname === 'localhost';

  useEffect(() => {
    if (!sa) return;
    setSvcFilter('');
    setSubFilter('');
    setSpaceEditing(false);
    setSvcExpanded(new Set(sa.serviceInstances.map(svc => svc.spaceId ?? '')));
    const m  = new Map((sa.org?.spaces ?? []).map(s => [s.spaceId, s.manageDest ?? false]));
    const ma = new Map((sa.org?.spaces ?? []).map(s => [s.spaceId, s.aod ?? false]));
    setSpaceDests(new Map(m));
    setSpaceDestsOrig(new Map(m));
    setSpaceAods(new Map(ma));
    setSpaceAodsOrig(new Map(ma));
    // Reset activeTab if the new SA doesn't support the current tab
    setActiveTab(prev => {
      if (prev === 'destinations' && !sa.manageDestinations) return 'info';
      if ((prev === 'roles' || prev === 'users') && !sa.manageRoles) return 'info';
      return prev;
    });
  }, [sa]);

  useEffect(() => {
    if (!isPopup || !sa) return;
    const label = sa.alias || sa.subaccountName;
    document.title = `${label} › ${TAB_LABEL[activeTab] ?? activeTab}`;
  }, [isPopup, sa, activeTab]);

  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (!dragging.current) return;
      const { set, left, width } = dragging.current;
      set(Math.min(75, Math.max(25, ((e.clientX - left) / width) * 100)));
    }
    function onUp() { dragging.current = null; }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
  }, []);

  function startDrag(e: React.MouseEvent, set: (v: number) => void, container: HTMLDivElement | null) {
    if (!container) return;
    const rect = container.getBoundingClientRect();
    e.preventDefault();
    dragging.current = { set, left: rect.left, width: rect.width };
  }

  const tabCls = (t: ModalTab) =>
    `px-3 py-2 text-xs font-medium transition-colors border-b-2 -mb-px ${
      activeTab === t
        ? 'border-primary text-foreground'
        : 'border-transparent text-muted-foreground hover:text-foreground'
    }`;

  function handleTabSwitch(tab: ModalTab) {
    setActiveTab(tab);
    if (!sa) return;
    const r = encodeURIComponent(sa.region);
    const s = encodeURIComponent(sa.subdomain);
    const tabUrls: Record<ModalTab, string> = {
      info:         `/subaccount/${r}/${s}`,
      services:     `/services/${r}/${s}`,
      apps:         `/apps/${r}/${s}`,
      destinations: `/destinations/${r}/${s}`,
      roles:        `/role-collections/${r}/${s}`,
      users:        `/users/${r}/${s}`,
    };
    history.replaceState(null, '', tabUrls[tab]);
  }

  function openInPopup() {
    if (!sa) return;
    openSubaccountPopup(sa.region, sa.subdomain, activeTab);
    onClose();
  }

  const spaceDestsDirty = [...spaceDests.entries()].some(([id, v]) => spaceDestsOrig.get(id) !== v)
    || [...spaceAods.entries()].some(([id, v]) => spaceAodsOrig.get(id) !== v);

  async function handleSpaceSave() {
    if (!sa || !onSpaceSave) return;
    const aodChanged = [...spaceAods.entries()].some(([id, v]) => spaceAodsOrig.get(id) !== v);
    setSpaceSaving(true);
    try {
      await onSpaceSave(sa.region, sa.subdomain, [...spaceDests.entries()].map(([spaceId, manageDest]) => ({
        spaceId, manageDest, aod: spaceAods.get(spaceId) ?? false,
      })));
      setSpaceDestsOrig(new Map(spaceDests));
      setSpaceAodsOrig(new Map(spaceAods));
      setSpaceEditing(false);
      if (aodChanged) setAodRefreshPending(true);
    } finally {
      setSpaceSaving(false);
    }
  }

  function handleAodRefreshConfirm() {
    setAodRefreshPending(false);
    setMountedTabs(prev => { const next = new Set(prev); next.add('destinations'); return next; });
    setActiveTab('destinations');
    setDestAutoRefresh(prev => prev + 1);
  }

  const btnOutline = 'inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-medium border border-border hover:bg-accent hover:text-accent-foreground transition-colors disabled:opacity-50 disabled:cursor-not-allowed';

  // ── Subaccount switcher dropdown ──────────────────────────────────────────
  const switcherList = subaccounts ?? [];
  const showSwitcher = switcherList.length > 1 && !!onSelectSubaccount;

  function renderSwitcherContent() {
    if (!sa) return null;
    const q = saFilter.toLowerCase().trim();

    function saMatches(s: SubaccountEntry): boolean {
      if (!q) return true;
      return (s.alias || s.subaccountName).toLowerCase().includes(q) ||
        s.subdomain.toLowerCase().includes(q) ||
        s.region.toLowerCase().includes(q) ||
        s.groupIds.toLowerCase().includes(q);
    }

    function csvIncludes(csv: string, val: string): boolean {
      return csv.split(',').map(v => v.trim()).includes(val);
    }

    type GroupNode = { groupId: string; title?: string; items: SubaccountEntry[] };
    type TabNode   = { tabName: string; groups: GroupNode[] };

    const placed = new Set<string>();

    const tabNodes: TabNode[] = (tabs ?? []).flatMap(tab => {
      const groups: GroupNode[] = tab.sections
        .filter(sec => sec.type === 'subaccountGroup')
        .flatMap(sec => {
          if (sec.type !== 'subaccountGroup') return [];
          const items = switcherList
            .filter(s => csvIncludes(s.groupIds, sec.groupId) && saMatches(s))
            .sort((a, b) => a.pos - b.pos);
          if (items.length === 0) return [];
          items.forEach(s => placed.add(s.subaccountId));
          return [{ groupId: sec.groupId, title: sec.title, items }];
        });
      if (groups.length === 0) return [];
      return [{ tabName: tab.tab, groups }];
    });

    const ungrouped = switcherList
      .filter(s => !placed.has(s.subaccountId) && saMatches(s))
      .sort((a, b) => a.pos - b.pos);

    const hasAnyResults = tabNodes.some(t => t.groups.length > 0) || ungrouped.length > 0;

    function SaItem({ s }: { s: SubaccountEntry }) {
      const isCurrent = s.subaccountId === sa!.subaccountId;
      return (
        <DropdownMenuItem
          key={s.subaccountId}
          className={`text-xs cursor-pointer py-1.5 px-3 overflow-hidden ${isCurrent ? 'font-medium bg-accent/40' : ''}`}
          onSelect={() => onSelectSubaccount!(s)}
        >
          <span className="truncate">
            {s.alias || s.subaccountName}
            <span className="text-muted-foreground font-mono text-[10px] ml-1">({s.region}.{s.subdomain})</span>
          </span>
        </DropdownMenuItem>
      );
    }

    return (
      <DropdownMenuContent align="start" className="w-[28rem] p-0 flex flex-col max-h-[min(80vh,600px)] overflow-hidden">
        <div className="shrink-0 p-2 border-b border-border">
          <div className="relative">
            <Filter className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground/50 pointer-events-none" />
            <input
              type="text"
              placeholder="Filter subaccounts…"
              value={saFilter}
              onChange={e => setSaFilter(e.target.value)}
              onKeyDown={e => { if (e.key !== 'Escape') e.stopPropagation(); }}
              autoFocus
              className="w-full h-7 pl-7 pr-2 text-xs bg-transparent border border-border rounded outline-none focus:border-primary placeholder:text-muted-foreground/50"
            />
          </div>
        </div>
        <div className="overflow-y-auto overflow-x-hidden flex-1">
          {!hasAnyResults ? (
            <p className="text-xs text-muted-foreground px-3 py-4 text-center">No results.</p>
          ) : (
            <>
              {tabNodes.map(tab => (
                <div key={tab.tabName}>
                  <div className="px-2 py-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider bg-muted/30 sticky top-0 z-10">
                    {tab.tabName}
                  </div>
                  {tab.groups.map(group => (
                    <div key={group.groupId}>
                      <div className="px-3 py-0.5 text-[10px] text-muted-foreground/70 font-medium italic">
                        {group.title || group.groupId}
                      </div>
                      {group.items.map(s => <SaItem key={s.subaccountId} s={s} />)}
                    </div>
                  ))}
                </div>
              ))}
              {ungrouped.length > 0 && (
                <div>
                  {tabNodes.length > 0 && <DropdownMenuSeparator />}
                  <div className="px-2 py-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider bg-muted/30 sticky top-0 z-10">
                    Other
                  </div>
                  {ungrouped.map(s => <SaItem key={s.subaccountId} s={s} />)}
                </div>
              )}
            </>
          )}
        </div>
      </DropdownMenuContent>
    );
  }

  const tabLabel = TAB_LABEL[activeTab] ?? 'Overview';

  return (
    <DialogPrimitive.Root open={sa !== null} onOpenChange={v => { if (!v) onClose(); }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm" />
        <DialogPrimitive.Content
          className={`fixed z-50 flex flex-col bg-background shadow-xl outline-none overflow-hidden mx-auto transition-none ${
            isPopup || maximized ? 'inset-0 rounded-none' : 'inset-4 rounded-lg max-w-[1150px]'
          }`}
          onInteractOutside={e => e.preventDefault()}
          onEscapeKeyDown={onClose}
          aria-describedby={undefined}
        >
          {!sa ? null : (
            <>
              {/* Header */}
              <div className="flex items-center gap-2 px-4 py-3 border-b border-border shrink-0">
                {/* Breadcrumb title */}
                <DialogPrimitive.Title className="flex items-center gap-1.5 min-w-0 flex-1 overflow-hidden text-sm font-semibold">
                  {showSwitcher ? (
                    <DropdownMenu onOpenChange={open => { if (!open) setSaFilter(''); }}>
                      <DropdownMenuTrigger asChild>
                        <button className="flex items-center gap-1 rounded px-1 -mx-1 hover:bg-accent transition-colors min-w-0 max-w-[50%]">
                          <span className="truncate text-sm font-semibold">{sa.alias || sa.subaccountName}</span>
                          <span className="text-xs font-normal font-mono text-muted-foreground shrink-0">({sa.region}.{sa.subdomain})</span>
                          <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0 opacity-60" />
                        </button>
                      </DropdownMenuTrigger>
                      {renderSwitcherContent()}
                    </DropdownMenu>
                  ) : (
                    <span className="flex items-center gap-1 min-w-0">
                      <span className="truncate text-sm font-semibold">{sa.alias || sa.subaccountName}</span>
                      <span className="text-xs font-normal font-mono text-muted-foreground shrink-0">({sa.region}.{sa.subdomain})</span>
                    </span>
                  )}
                  {sa.restricted && (
                    <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-red-500 bg-red-500/10 border border-red-500/30 px-1.5 py-0.5 rounded shrink-0">
                      <ShieldBan className="h-3 w-3" /> Restricted
                    </span>
                  )}
                  <span className="text-muted-foreground shrink-0 text-xs font-normal">›</span>
                  <span className="text-xs text-muted-foreground shrink-0 font-medium">{tabLabel}</span>
                </DialogPrimitive.Title>

                {cockpit && (() => {
                  const ctx     = buildCtx(sa, cockpit);
                  const saUrl   = resolveUrl(SA_COCKPIT_TPL, ctx);
                  const spaces  = sa.org?.spaces ?? [];
                  const hasSubs = !!(cockpitMenu?.submenus && cockpitMenu.submenus.length > 0);
                  const btnBase = 'flex items-center text-xs py-1 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors';
                  return (
                    <div className="inline-flex rounded border border-border shrink-0 overflow-hidden">
                      <a href={saUrl} target="_blank" rel="noopener noreferrer" className={`${btnBase} px-2 ${hasSubs ? 'border-r border-border' : ''}`}>Open Cockpit</a>
                      {hasSubs && (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <button className={`${btnBase} px-1.5`}>
                              <ChevronDown className="h-3 w-3 opacity-60" />
                            </button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="max-h-[min(70vh,420px)] overflow-y-auto">
                            {renderMenuItems(cockpitMenu!.submenus!, ctx, spaces)}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                    </div>
                  );
                })()}
                {!isPopup && (
                  <button
                    onClick={openInPopup}
                    className="p-1.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors shrink-0"
                    title={"Open this modal in a new window.\nCtrl-click a subaccount link to open directly in a popup.\nShift-click a subaccount link to open in a new tab."}
                  >
                    <ExternalLink className="h-4 w-4" />
                  </button>
                )}
                {!isPopup && (
                  <button
                    onClick={() => setMaximized(v => !v)}
                    className="p-1.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors shrink-0"
                    title={maximized ? 'Restore' : 'Maximize'}
                  >
                    {maximized ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
                  </button>
                )}
                <button
                  onClick={onClose}
                  className="p-1.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors shrink-0"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              {/* Tab bar */}
              <div className="flex border-b border-border shrink-0 px-2 bg-muted/5">
                <button className={tabCls('info')} onClick={() => handleTabSwitch('info')}>Overview</button>
                <button className={tabCls('services')} onClick={() => handleTabSwitch('services')}>Services</button>
                {isAdminMode && (
                  <>
                    <button className={tabCls('apps')} onClick={() => handleTabSwitch('apps')}>Apps</button>
                    {sa.manageDestinations && (
                      <button className={tabCls('destinations')} onClick={() => handleTabSwitch('destinations')}>Destinations</button>
                    )}
                    {sa.manageRoles && (
                      <>
                        <button className={tabCls('roles')} onClick={() => handleTabSwitch('roles')}>Roles</button>
                        <button className={tabCls('users')} onClick={() => handleTabSwitch('users')}>Users</button>
                      </>
                    )}
                  </>
                )}
              </div>

              {/* Tab content */}
              <div className="flex-1 min-h-0 flex flex-col">

                {/* ── Overview ── */}
                {activeTab === 'info' && (
                  <div ref={overviewRef} className="flex-1 flex min-h-0 overflow-hidden">

                    {/* Left pane — subaccount properties */}
                    <div style={{ width: `${overviewSplit}%` }} className="overflow-auto shrink-0">
                      <div className="p-4 flex flex-col gap-3">
                        <Field label="Subaccount ID"            value={sa.subaccountId}                mono />
                        <Field label="Global Account GUID"      value={sa.globalAccountGUID}           mono />
                        <Field label="Global Account Name"      value={sa.globalAccountName}                />
                        <Field label="Global Account Subdomain" value={sa.globalAccountSubdomain}      mono />
                        <Field label="Region"                   value={sa.region}                      mono />
                        <Field label="Subdomain"                value={sa.subdomain}                   mono />
                        <Field label="Org Name"                 value={sa.org?.orgName ?? ''}               />
                        <Field label="Org ID"                   value={sa.org?.orgId   ?? ''}          mono />
                        <Field label="Group IDs"                value={sa.groupIds}                         />
                        <Field label="Alias"                    value={sa.alias}                            />
                        <div className="flex flex-wrap gap-4 pt-1">
                          {([
                            { label: 'In Homepage',         val: sa.inHomepage },
                            { label: 'Manage Destinations', val: sa.manageDestinations },
                            { label: 'Manage Roles',        val: sa.manageRoles },
                          ] as const).map(({ label, val }) => (
                            <div key={label} className="flex items-center gap-1.5">
                              <span className={`w-2 h-2 rounded-full ${val ? 'bg-green-500' : 'bg-muted-foreground/30'}`} />
                              <span className="text-xs text-muted-foreground">{label}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>

                    {/* Drag handle */}
                    <div
                      className="w-1 shrink-0 cursor-col-resize bg-border hover:bg-primary/40 active:bg-primary/60 transition-colors"
                      onMouseDown={e => startDrag(e, setOverviewSplit, overviewRef.current)}
                    />

                    {/* Right pane — Spaces */}
                    <div className="flex-1 min-w-0 flex flex-col min-h-0">
                      <div className="flex items-center gap-2 px-3 py-2 border-b border-border shrink-0">
                        <span className="text-xs font-semibold flex-1">Spaces</span>
                        {canManageSpaces && sa.org && sa.org.spaces.length > 0 && (
                          spaceEditing ? (
                            <>
                              <button
                                className={btnOutline}
                                disabled={!spaceDestsDirty || spaceSaving || !onSpaceSave}
                                onClick={() => void handleSpaceSave()}
                              >
                                <Save className="h-3 w-3" /> {spaceSaving ? 'Saving…' : 'Save'}
                              </button>
                              <button
                                className={btnOutline}
                                onClick={() => {
                                  setSpaceDests(new Map(spaceDestsOrig));
                                  setSpaceAods(new Map(spaceAodsOrig));
                                  setSpaceEditing(false);
                                }}
                              >
                                <RotateCcw className="h-3 w-3" /> Cancel
                              </button>
                            </>
                          ) : (
                            <button className={btnOutline} onClick={() => setSpaceEditing(true)}>
                              <Pencil className="h-3 w-3" /> Edit
                            </button>
                          )
                        )}
                      </div>
                      <div className="flex-1 overflow-auto">
                        {sa.org && sa.org.spaces.length > 0 ? (
                          <table className="w-full border-collapse text-xs">
                            <thead>
                              <tr className="bg-muted/30">
                                <th className={thCls}>Space</th>
                                {canManageSpaces && <th className={thCls}>Dest</th>}
                                {canManageSpaces && <th className={thCls}>AOD</th>}
                              </tr>
                            </thead>
                            <tbody>
                              {sa.org.spaces.map(s => {
                                const spaceUrl = cockpit?.host
                                  ? `${ensureHttps(cockpit.host)}/#/globalaccount/${sa.globalAccountGUID}/subaccount/${sa.subaccountId}/space/${s.spaceId}`
                                  : undefined;
                                const destChecked = spaceDests.get(s.spaceId) ?? false;
                                const aodChecked  = spaceAods.get(s.spaceId) ?? false;
                                return (
                                  <tr key={s.spaceId} className="hover:bg-muted/20">
                                    <td className={tdCls}>
                                      <div className="flex flex-col">
                                        <span>
                                          {spaceUrl
                                            ? <a href={spaceUrl} target="_blank" rel="noopener noreferrer" className="hover:underline hover:text-primary transition-colors">{s.spaceName}</a>
                                            : s.spaceName
                                          }
                                        </span>
                                        <span className="text-[10px] text-muted-foreground font-mono">{s.spaceId}</span>
                                      </div>
                                    </td>
                                    {canManageSpaces && (
                                      <td className={tdCls}>
                                        {spaceEditing ? (
                                          <input
                                            type="checkbox"
                                            checked={destChecked}
                                            onChange={e => {
                                              const checked = e.target.checked;
                                              setSpaceDests(prev => new Map(prev).set(s.spaceId, checked));
                                              if (!checked) setSpaceAods(prev => new Map(prev).set(s.spaceId, false));
                                            }}
                                            className="cursor-pointer"
                                          />
                                        ) : destChecked ? (
                                          <span className="inline-flex items-center gap-1 text-[10px] text-green-600 dark:text-green-400 font-medium">
                                            <span className="w-1.5 h-1.5 rounded-full bg-green-500 shrink-0" />Managed
                                          </span>
                                        ) : null}
                                      </td>
                                    )}
                                    {canManageSpaces && (
                                      <td className={tdCls}>
                                        {spaceEditing ? (
                                          <input
                                            type="checkbox"
                                            checked={aodChecked}
                                            disabled={!destChecked}
                                            onChange={e => setSpaceAods(prev => new Map(prev).set(s.spaceId, e.target.checked))}
                                            className={destChecked ? 'cursor-pointer' : 'cursor-not-allowed opacity-40'}
                                            title={!destChecked ? 'Enable Dest first' : undefined}
                                          />
                                        ) : aodChecked ? (
                                          <span className="inline-flex items-center gap-1 text-[10px] text-green-600 dark:text-green-400 font-medium">
                                            <span className="w-1.5 h-1.5 rounded-full bg-green-500 shrink-0" />In Use
                                          </span>
                                        ) : null}
                                      </td>
                                    )}
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        ) : (
                          <p className="text-xs text-muted-foreground px-3 py-8 text-center">No CF spaces.</p>
                        )}
                      </div>
                    </div>
                  </div>
                )}

                {/* ── Services (subscriptions + service instances) ── */}
                {activeTab === 'services' && (() => {
                  const subQ        = subFilter.toLowerCase().trim();
                  const filteredSubs = sa.subscriptions.filter(sub =>
                    !subQ ||
                    sub.displayName.toLowerCase().includes(subQ) ||
                    sub.url.toLowerCase().includes(subQ)
                  );

                  const svcQ        = svcFilter.toLowerCase().trim();
                  const isFiltering = svcQ.length > 0;

                  const allGroups = Object.entries(
                    sa.serviceInstances.reduce<Record<string, typeof sa.serviceInstances>>((acc, svc) => {
                      (acc[svc.spaceId ?? ''] ??= []).push(svc);
                      return acc;
                    }, {})
                  ).sort(([a], [b]) => {
                    const nameA = (sa.org?.spaces.find(s => s.spaceId === a)?.spaceName ?? a) || '';
                    const nameB = (sa.org?.spaces.find(s => s.spaceId === b)?.spaceName ?? b) || '';
                    return nameA.localeCompare(nameB);
                  });

                  type Group = { spaceId: string; spaceName: string; instances: typeof sa.serviceInstances };
                  const filteredGroups: Group[] = allGroups
                    .map(([spaceId, instances]) => {
                      const spaceName = (sa.org?.spaces.find(s => s.spaceId === spaceId)?.spaceName ?? spaceId) || 'Unknown Space';
                      if (!svcQ) return { spaceId, spaceName, instances };
                      const spaceMatch = spaceName.toLowerCase().includes(svcQ);
                      if (spaceMatch) return { spaceId, spaceName, instances };
                      const matched = instances.filter(svc =>
                        svc.instanceName.toLowerCase().includes(svcQ) ||
                        (svc.serviceOfferingName ?? '').toLowerCase().includes(svcQ) ||
                        (svc.servicePlanId ?? '').toLowerCase().includes(svcQ)
                      );
                      return matched.length > 0 ? { spaceId, spaceName, instances: matched } : null;
                    })
                    .filter((g): g is Group => g !== null);

                  const allSpaceIds = allGroups.map(([id]) => id);

                  function toggleSvc(spaceId: string) {
                    setSvcExpanded(prev => {
                      const next = new Set(prev);
                      next.has(spaceId) ? next.delete(spaceId) : next.add(spaceId);
                      return next;
                    });
                  }

                  return (
                    <div ref={servicesRef} className="flex-1 flex min-h-0 overflow-hidden">

                      {/* Left pane — subscriptions */}
                      <div style={{ width: `${servicesSplit}%` }} className="flex flex-col min-h-0 shrink-0 border-r border-border">
                        <div className="shrink-0 flex items-center gap-2 px-2 py-2 border-b border-border">
                          <div className="relative flex-1 min-w-0">
                            <Filter className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground/50 pointer-events-none" />
                            <input
                              type="text"
                              placeholder="Filter subscriptions…"
                              value={subFilter}
                              onChange={e => setSubFilter(e.target.value)}
                              className="w-full h-7 pl-7 pr-7 text-xs bg-transparent border border-border rounded outline-none focus:border-primary placeholder:text-muted-foreground/50"
                            />
                            {subFilter && (
                              <button onClick={() => setSubFilter('')} className="absolute right-1 top-1/2 -translate-y-1/2 p-0.5 rounded text-muted-foreground hover:text-foreground transition-colors" aria-label="Clear filter">
                                <X className="h-3 w-3" />
                              </button>
                            )}
                          </div>
                        </div>
                        <div className="flex-1 overflow-auto">
                          {filteredSubs.length > 0 ? (
                            <table className="w-full border-collapse text-xs">
                              <thead className="sticky top-0 z-10">
                                <tr className="bg-muted/30">
                                  <th className={thCls}>Subscription</th>
                                  <th className={`${thCls} text-center`}>Custom</th>
                                </tr>
                              </thead>
                              <tbody>
                                {filteredSubs.map((sub, i) => (
                                  <tr key={i} className="hover:bg-muted/20">
                                    <td className={tdCls}>
                                      <a href={sub.url} target="_blank" rel="noreferrer" className="hover:underline hover:text-primary transition-colors">
                                        {sub.displayName}
                                      </a>
                                    </td>
                                    <td className={`${tdCls} text-center`}>
                                      {sub.customerDeveloped
                                        ? <span className="text-green-600 dark:text-green-400 font-medium">Yes</span>
                                        : <span className="text-muted-foreground/40">—</span>}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          ) : (
                            <p className="text-xs text-muted-foreground px-3 py-8 text-center">
                              {sa.subscriptions.length === 0 ? 'No subscriptions.' : 'No subscriptions match the filter.'}
                            </p>
                          )}
                        </div>
                      </div>

                      {/* Drag handle */}
                      <div
                        className="w-1 shrink-0 cursor-col-resize bg-border hover:bg-primary/40 active:bg-primary/60 transition-colors"
                        onMouseDown={e => startDrag(e, setServicesSplit, servicesRef.current)}
                      />

                      {/* Right pane — service instances */}
                      <div className="flex-1 min-w-0 flex flex-col min-h-0">
                        <div className="shrink-0 flex items-center gap-2 px-2 py-2 border-b border-border">
                          <div className="relative flex-1 min-w-0">
                            <Filter className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground/50 pointer-events-none" />
                            <input
                              type="text"
                              placeholder="Filter spaces / instances…"
                              value={svcFilter}
                              onChange={e => setSvcFilter(e.target.value)}
                              className="w-full h-7 pl-7 pr-7 text-xs bg-transparent border border-border rounded outline-none focus:border-primary placeholder:text-muted-foreground/50"
                            />
                            {svcFilter && (
                              <button onClick={() => setSvcFilter('')} className="absolute right-1 top-1/2 -translate-y-1/2 p-0.5 rounded text-muted-foreground hover:text-foreground transition-colors" aria-label="Clear filter">
                                <X className="h-3 w-3" />
                              </button>
                            )}
                          </div>
                          {(() => {
                            const allSvcExpanded = !isFiltering && allSpaceIds.length > 0 && allSpaceIds.every(id => svcExpanded.has(id));
                            return (
                              <button
                                onClick={() => setSvcExpanded(allSvcExpanded ? new Set() : new Set(allSpaceIds))}
                                disabled={isFiltering}
                                className="inline-flex items-center gap-1.5 px-2 py-1.5 rounded text-xs font-medium hover:bg-accent hover:text-accent-foreground transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                                title={allSvcExpanded ? 'Collapse all' : 'Expand all'}
                              >
                                {allSvcExpanded ? <ChevronsDownUp className="h-4 w-4" /> : <ChevronsUpDown className="h-4 w-4" />}
                              </button>
                            );
                          })()}
                        </div>
                        <div className="flex-1 overflow-auto">
                          {filteredGroups.length > 0 ? (
                            <table className="w-full border-collapse text-xs">
                              <thead className="sticky top-0 z-10">
                                <tr className="bg-muted/30">
                                  <th className={thCls}>Space / Instance</th>
                                  <th className={thCls}>Service</th>
                                </tr>
                              </thead>
                              <tbody>
                                {filteredGroups.flatMap(({ spaceId, spaceName, instances }) => {
                                  const isExpanded = isFiltering || svcExpanded.has(spaceId);
                                  const spaceUrl = cockpit && sa.org && spaceId
                                    ? buildSpaceInstUrl(sa, cockpit, spaceId)
                                    : undefined;
                                  return [
                                    <tr
                                      key={`sp-${spaceId}`}
                                      className="bg-muted/20 hover:bg-muted/30 cursor-pointer select-none"
                                      onClick={() => { if (!isFiltering) toggleSvc(spaceId); }}
                                    >
                                      <td colSpan={2} className="px-2 py-1.5 border-b border-border">
                                        <div className="flex items-center gap-1.5">
                                          <span className="shrink-0 text-muted-foreground">
                                            {isExpanded
                                              ? <ChevronDown className="h-3.5 w-3.5" />
                                              : <ChevronRight className="h-3.5 w-3.5" />
                                            }
                                          </span>
                                          <span className="font-medium text-foreground">
                                            {spaceUrl
                                              ? <a href={spaceUrl} target="_blank" rel="noopener noreferrer" className="hover:underline hover:text-primary transition-colors" onClick={e => e.stopPropagation()}>{spaceName}</a>
                                              : spaceName
                                            }
                                          </span>
                                          <span className="text-[10px] text-muted-foreground shrink-0">({instances.length})</span>
                                        </div>
                                      </td>
                                    </tr>,
                                    ...(isExpanded ? instances.map((svc, i) => {
                                      const instUrl = cockpit && sa.org && spaceId && svc.id
                                        ? buildInstanceDetailUrl(sa, cockpit, spaceId, svc.id)
                                        : undefined;
                                      return (
                                        <tr key={`${spaceId}-${i}`} className="hover:bg-muted/20">
                                          <td className={`${tdCls} pl-7`}>
                                            {instUrl
                                              ? <a href={instUrl} target="_blank" rel="noopener noreferrer" className="hover:underline hover:text-primary transition-colors">{svc.instanceName}</a>
                                              : svc.instanceName
                                            }
                                          </td>
                                          <td className={tdCls}>
                                            {(svc.serviceOfferingName || svc.servicePlanId)
                                              ? (svc.url
                                                  ? <a href={svc.url} target="_blank" rel="noreferrer" className="font-mono text-[10px] text-muted-foreground hover:underline hover:text-primary transition-colors">{svc.serviceOfferingName || svc.servicePlanId}</a>
                                                  : <span className="font-mono text-[10px] text-muted-foreground">{svc.serviceOfferingName || svc.servicePlanId}</span>
                                                )
                                              : <span className="text-muted-foreground/40">—</span>
                                            }
                                          </td>
                                        </tr>
                                      );
                                    }) : []),
                                  ];
                                })}
                              </tbody>
                            </table>
                          ) : (
                            <p className="text-xs text-muted-foreground px-3 py-8 text-center">
                              {sa.serviceInstances.length === 0
                                ? 'No service instances.'
                                : 'No service instances match the filter.'
                              }
                            </p>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })()}

                {/* ── Apps / Destinations / Roles / Users ──
                    Lazy-mount on first visit; stay mounted (hidden) on tab switch
                    so intra-tab selections are preserved. Reset when SA changes. */}
                {mountedTabs.has('apps') && isAdminMode && sa && (
                  <div className={activeTab === 'apps' ? 'flex-1 min-h-0 flex flex-col' : 'hidden'}>
                    <AppsTab
                      sa={sa}
                      initialGuid={initialAppGuid}
                      onAppDataChange={onAppDataChange}
                    />
                  </div>
                )}

                {mountedTabs.has('destinations') && isAdminMode && sa && (
                  <div className={activeTab === 'destinations' ? 'flex-1 min-h-0 flex flex-col' : 'hidden'}>
                    <DestTab
                      sa={sa}
                      allNames={allDestNames}
                      initialName={initialDestName}
                      initialTab={initialDestTab}
                      initialShowList={initialDestShowList}
                      initialSpaceName={initialDestSpaceName}
                      initialInstName={initialDestInstName}
                      initialInstGuid={initialDestInstGuid}
                      selectedDests={selectedDests}
                      onToggleCompare={onToggleCompare}
                      onOpenCompare={onOpenCompare}
                      onDestDataChange={onDestDataChange}
                      autoRefreshTrigger={destAutoRefresh}
                    />
                  </div>
                )}

                {mountedTabs.has('roles') && isAdminMode && sa && (
                  <div className={activeTab === 'roles' ? 'flex-1 min-h-0 flex flex-col' : 'hidden'}>
                    <RolesTab
                      sa={sa}
                      allNames={allRcNames}
                      initialName={initialRcName}
                      initialTab={initialRcTab}
                      initialShowList={initialRcShowList}
                      onRcDataChange={onRcDataChange}
                    />
                  </div>
                )}

                {mountedTabs.has('users') && isAdminMode && sa && (
                  <div className={activeTab === 'users' ? 'flex-1 min-h-0 flex flex-col' : 'hidden'}>
                    <UsersTab
                      sa={sa}
                      initialUserEmail={initialUserEmail}
                      initialUserOrigin={initialUserOrigin}
                      initialTab={initialUserTab}
                      onUserDataChange={onUserDataChange}
                    />
                  </div>
                )}

              </div>

              {/* AOD refresh confirmation dialog */}
              {aodRefreshPending && (
                <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/80 backdrop-blur-sm rounded-lg">
                  <div className="bg-background border border-border rounded-lg p-6 max-w-sm w-full shadow-xl mx-4">
                    <h3 className="text-sm font-semibold mb-2">Refresh Destinations?</h3>
                    <p className="text-xs text-muted-foreground mb-5">
                      AOD option has been changed. In order to install/uninstall the AOD proxy, the subaccount and instance destinations need to be refreshed. Proceed?
                    </p>
                    <div className="flex justify-end gap-2">
                      <button
                        onClick={() => setAodRefreshPending(false)}
                        className="inline-flex items-center px-3 py-1.5 rounded text-xs font-medium border border-border hover:bg-accent hover:text-accent-foreground transition-colors"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={handleAodRefreshConfirm}
                        className="inline-flex items-center px-3 py-1.5 rounded text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
                      >
                        Refresh Destinations
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
