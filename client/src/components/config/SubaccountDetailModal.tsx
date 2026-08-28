import { useState, useEffect } from 'react';
import { ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, Filter, RotateCcw, Save, ShieldBan, X } from 'lucide-react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
  DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { SubaccountEntry, SpaceEntry } from './SubaccountsTable';
import type { CockpitMenuItem } from '@/components/home/HomepageContent';

interface Props {
  sa:           SubaccountEntry | null;
  onClose:      () => void;
  cockpit?:     { idp: string; host: string };
  cockpitMenu?: CockpitMenuItem | null;
  isAdmin?:     boolean;
  onSpaceSave?: (region: string, subdomain: string, spaces: { spaceId: string; manageDest: boolean; aod: boolean }[]) => Promise<void>;
}

type ModalTab = 'info' | 'subscriptions' | 'services';

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

export default function SubaccountDetailModal({ sa, onClose, cockpit, cockpitMenu, isAdmin, onSpaceSave }: Props) {
  const [activeTab, setActiveTab]           = useState<ModalTab>('info');
  const [svcFilter, setSvcFilter]           = useState('');
  const [subFilter, setSubFilter]           = useState('');
  const [svcExpanded, setSvcExpanded]       = useState<Set<string>>(new Set());
  const [spaceDests, setSpaceDests]         = useState<Map<string, boolean>>(new Map());
  const [spaceDestsOrig, setSpaceDestsOrig] = useState<Map<string, boolean>>(new Map());
  const [spaceAods, setSpaceAods]           = useState<Map<string, boolean>>(new Map());
  const [spaceAodsOrig, setSpaceAodsOrig]   = useState<Map<string, boolean>>(new Map());
  const [spaceSaving, setSpaceSaving]       = useState(false);

  const canManageSpaces = isAdmin || window.location.hostname === 'localhost';

  useEffect(() => {
    if (!sa) return;
    setSvcFilter('');
    setSubFilter('');
    setSvcExpanded(new Set(sa.serviceInstances.map(svc => svc.spaceId ?? '')));
    const m  = new Map((sa.org?.spaces ?? []).map(s => [s.spaceId, s.manageDest ?? false]));
    const ma = new Map((sa.org?.spaces ?? []).map(s => [s.spaceId, s.aod ?? false]));
    setSpaceDests(new Map(m));
    setSpaceDestsOrig(new Map(m));
    setSpaceAods(new Map(ma));
    setSpaceAodsOrig(new Map(ma));
  }, [sa]);

  const tabCls = (t: ModalTab) =>
    `px-3 py-2 text-xs font-medium transition-colors border-b-2 -mb-px ${
      activeTab === t
        ? 'border-primary text-foreground'
        : 'border-transparent text-muted-foreground hover:text-foreground'
    }`;

  const spaceDestsDirty = [...spaceDests.entries()].some(([id, v]) => spaceDestsOrig.get(id) !== v)
    || [...spaceAods.entries()].some(([id, v]) => spaceAodsOrig.get(id) !== v);

  async function handleSpaceSave() {
    if (!sa || !onSpaceSave) return;
    setSpaceSaving(true);
    try {
      await onSpaceSave(sa.region, sa.subdomain, [...spaceDests.entries()].map(([spaceId, manageDest]) => ({
        spaceId, manageDest, aod: spaceAods.get(spaceId) ?? false,
      })));
      setSpaceDestsOrig(new Map(spaceDests));
      setSpaceAodsOrig(new Map(spaceAods));
    } finally {
      setSpaceSaving(false);
    }
  }

  const btnOutline = 'inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-medium border border-border hover:bg-accent hover:text-accent-foreground transition-colors disabled:opacity-50 disabled:cursor-not-allowed';

  return (
    <DialogPrimitive.Root open={sa !== null} onOpenChange={v => { if (!v) onClose(); }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm" />
        <DialogPrimitive.Content
          className="fixed inset-4 z-50 flex flex-col bg-background rounded-lg shadow-xl outline-none overflow-hidden max-w-[62.4rem] mx-auto"
          onInteractOutside={onClose}
          onEscapeKeyDown={onClose}
          aria-describedby={undefined}
        >
          {!sa ? null : (
            <>
              {/* Header */}
              <div className="flex items-center gap-2 px-4 py-3 border-b border-border shrink-0">
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  <DialogPrimitive.Title className="text-sm font-semibold min-w-0 truncate">
                    {sa.subaccountName}
                  </DialogPrimitive.Title>
                  {sa.subdomain && (
                    <span className="text-xs font-normal font-mono text-muted-foreground bg-muted px-1.5 py-0.5 rounded shrink-0">
                      {sa.subdomain}
                    </span>
                  )}
                  {sa.restricted && (
                    <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-red-500 bg-red-500/10 border border-red-500/30 px-1.5 py-0.5 rounded shrink-0">
                      <ShieldBan className="h-3 w-3" /> Restricted
                    </span>
                  )}
                </div>
                {canManageSpaces && sa.org && sa.org.spaces.length > 0 && (
                  <>
                    <button
                      className={btnOutline}
                      disabled={!spaceDestsDirty}
                      onClick={() => { setSpaceDests(new Map(spaceDestsOrig)); setSpaceAods(new Map(spaceAodsOrig)); }}
                    >
                      <RotateCcw className="h-3 w-3" /> Reset
                    </button>
                    <button
                      className={btnOutline}
                      disabled={!spaceDestsDirty || spaceSaving || !onSpaceSave}
                      onClick={() => void handleSpaceSave()}
                    >
                      <Save className="h-3 w-3" /> {spaceSaving ? 'Saving…' : 'Save'}
                    </button>
                  </>
                )}
                {cockpit && cockpitMenu && (() => {
                  const ctx     = buildCtx(sa, cockpit);
                  const url     = cockpitMenu.url ? resolveUrl(cockpitMenu.url, ctx) : undefined;
                  const spaces  = sa.org?.spaces ?? [];
                  const hasSubs = cockpitMenu.submenus && cockpitMenu.submenus.length > 0;
                  const btnBase = 'flex items-center text-xs py-1 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors';
                  return (
                    <div className="inline-flex rounded border border-border shrink-0 overflow-hidden">
                      {url
                        ? <a href={url} target="_blank" rel="noopener noreferrer" className={`${btnBase} px-2 ${hasSubs ? 'border-r border-border' : ''}`}>Open Cockpit</a>
                        : hasSubs ? <span className={`${btnBase} px-2 border-r border-border`}>Cockpit</span> : null
                      }
                      {hasSubs && (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <button className={`${btnBase} px-1.5`}>
                              <ChevronDown className="h-3 w-3 opacity-60" />
                            </button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="max-h-[min(70vh,420px)] overflow-y-auto">
                            {renderMenuItems(cockpitMenu.submenus!, ctx, spaces)}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                    </div>
                  );
                })()}
                <button
                  onClick={onClose}
                  className="p-1.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors shrink-0"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              {/* Tab bar */}
              <div className="flex border-b border-border shrink-0 px-2 bg-muted/5">
                <button className={tabCls('info')} onClick={() => setActiveTab('info')}>
                  Subaccount &amp; Org
                </button>
                <button className={tabCls('subscriptions')} onClick={() => setActiveTab('subscriptions')}>
                  Subscriptions ({sa.subscriptions.length})
                </button>
                <button className={tabCls('services')} onClick={() => setActiveTab('services')}>
                  Service Instances ({sa.serviceInstances.length})
                </button>
              </div>

              {/* Tab content */}
              <div className="flex-1 min-h-0 flex flex-col">

                {/* ── Subaccount & Org ── */}
                {activeTab === 'info' && (
                  <div className="flex-1 overflow-auto">
                    <div className="p-4 space-y-4">
                      {/* Identity grid */}
                      <div className="grid grid-cols-2 gap-3">
                        <Field label="Subaccount ID"       value={sa.subaccountId}                mono />
                        <Field label="Global Account GUID" value={sa.globalAccountGUID}           mono />
                        <Field label="Global Account Name"      value={sa.globalAccountName}                />
                        <Field label="Global Account Subdomain" value={sa.globalAccountSubdomain} mono />
                        <Field label="Region"              value={sa.region}                      mono />
                        <Field label="Subdomain"           value={sa.subdomain}                   mono />
                        <Field label="Org Name"            value={sa.org?.orgName ?? ''}               />
                        <Field label="Org ID"              value={sa.org?.orgId   ?? ''}          mono />
                        <Field label="Group IDs"           value={sa.groupIds}                         />
                        <Field label="Alias"               value={sa.alias}                            />
                      </div>

                      {/* Flags */}
                      <div className="flex gap-4">
                        {([
                          { label: 'In Homepage',         val: sa.inHomepage },
                          { label: 'Manage Destinations', val: sa.manageDestinations },
                          { label: 'Use AOD',             val: sa.useAOD },
                        ] as const).map(({ label, val }) => (
                          <div key={label} className="flex items-center gap-1.5">
                            <span className={`w-2 h-2 rounded-full ${val ? 'bg-green-500' : 'bg-muted-foreground/30'}`} />
                            <span className="text-xs text-muted-foreground">{label}</span>
                          </div>
                        ))}
                      </div>

                      {/* CF Spaces — full width */}
                      {sa.org && sa.org.spaces.length > 0 && (
                        <div>
                          <h3 className="text-xs font-semibold text-foreground border-b border-border pb-1 mb-2">
                            CF Spaces
                          </h3>
                          <table className="w-full border-collapse text-xs">
                            <thead>
                              <tr className="bg-muted/30">
                                <th className={thCls}>Space Name</th>
                                <th className={`${thCls} font-mono`}>Space ID</th>
                                {canManageSpaces && <th className={`${thCls} text-center`}>Manage Dest</th>}
                                {canManageSpaces && <th className={`${thCls} text-center`}>AOD</th>}
                              </tr>
                            </thead>
                            <tbody>
                              {sa.org.spaces.map(s => {
                                const spaceUrl = cockpit?.host
                                  ? `${ensureHttps(cockpit.host)}/#/globalaccount/${sa.globalAccountGUID}/subaccount/${sa.subaccountId}/space/${s.spaceId}`
                                  : undefined;
                                return (
                                  <tr key={s.spaceId} className="hover:bg-muted/20">
                                    <td className={tdCls}>
                                      {spaceUrl
                                        ? <a href={spaceUrl} target="_blank" rel="noopener noreferrer" className="hover:underline hover:text-primary transition-colors">{s.spaceName}</a>
                                        : s.spaceName
                                      }
                                    </td>
                                    <td className={`${tdCls} font-mono text-muted-foreground`}>{s.spaceId}</td>
                                    {canManageSpaces && (
                                      <td className={`${tdCls} text-center`}>
                                        <input
                                          type="checkbox"
                                          checked={spaceDests.get(s.spaceId) ?? false}
                                          onChange={e => {
                                            const checked = e.target.checked;
                                            setSpaceDests(prev => new Map(prev).set(s.spaceId, checked));
                                            if (!checked) setSpaceAods(prev => new Map(prev).set(s.spaceId, false));
                                          }}
                                          className="cursor-pointer"
                                        />
                                      </td>
                                    )}
                                    {canManageSpaces && (
                                      <td className={`${tdCls} text-center`}>
                                        <input
                                          type="checkbox"
                                          checked={spaceAods.get(s.spaceId) ?? false}
                                          disabled={!(spaceDests.get(s.spaceId) ?? false)}
                                          onChange={e => setSpaceAods(prev => new Map(prev).set(s.spaceId, e.target.checked))}
                                          className={spaceDests.get(s.spaceId) ? 'cursor-pointer' : 'cursor-not-allowed opacity-40'}
                                          title={spaceDests.get(s.spaceId) ? undefined : 'Enable Manage Dest first'}
                                        />
                                      </td>
                                    )}
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* ── Subscriptions ── */}
                {activeTab === 'subscriptions' && (() => {
                  const q        = subFilter.toLowerCase().trim();
                  const filtered = sa.subscriptions.filter(sub =>
                    !q ||
                    sub.displayName.toLowerCase().includes(q) ||
                    sub.url.toLowerCase().includes(q)
                  );
                  return (
                    <>
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
                        {filtered.length > 0 ? (
                          <table className="w-full border-collapse text-xs">
                            <thead className="sticky top-0 z-10">
                              <tr className="bg-muted/30">
                                <th className={thCls}>Application</th>
                                <th className={thCls}>URL</th>
                                <th className={`${thCls} text-center`}>Customer Dev</th>
                              </tr>
                            </thead>
                            <tbody>
                              {filtered.map((sub, i) => (
                                <tr key={i} className="hover:bg-muted/20">
                                  <td className={tdCls}>{sub.displayName}</td>
                                  <td className={`${tdCls} font-mono text-[11px]`}>
                                    <a href={sub.url} target="_blank" rel="noreferrer" className="text-primary hover:underline break-all">
                                      {sub.url}
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
                    </>
                  );
                })()}

                {/* ── Service Instances ── */}
                {activeTab === 'services' && (() => {
                  const q           = svcFilter.toLowerCase().trim();
                  const isFiltering = q.length > 0;

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
                      if (!q) return { spaceId, spaceName, instances };
                      const spaceMatch = spaceName.toLowerCase().includes(q);
                      if (spaceMatch) return { spaceId, spaceName, instances };
                      const matched = instances.filter(svc =>
                        svc.instanceName.toLowerCase().includes(q) ||
                        (svc.serviceOfferingName ?? '').toLowerCase().includes(q) ||
                        (svc.servicePlanId ?? '').toLowerCase().includes(q)
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
                    <>
                      {/* Toolbar */}
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
                        <button
                          onClick={() => setSvcExpanded(new Set(allSpaceIds))}
                          disabled={isFiltering}
                          className={btnOutline}
                          title="Expand all"
                        >
                          <ChevronsUpDown className="h-3.5 w-3.5" />
                          <span className="hidden sm:inline">Expand</span>
                        </button>
                        <button
                          onClick={() => setSvcExpanded(new Set())}
                          disabled={isFiltering}
                          className={btnOutline}
                          title="Collapse all"
                        >
                          <ChevronsDownUp className="h-3.5 w-3.5" />
                          <span className="hidden sm:inline">Collapse</span>
                        </button>
                      </div>

                      {/* Tree table */}
                      <div className="flex-1 overflow-auto">
                        {filteredGroups.length > 0 ? (
                          <table className="w-full border-collapse text-xs">
                            <thead className="sticky top-0 z-10">
                              <tr className="bg-muted/30">
                                <th className={thCls}>Space / Instance</th>
                                <th className={thCls}>Service</th>
                                <th className={thCls}>Dashboard</th>
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
                                    <td colSpan={3} className="px-2 py-1.5 border-b border-border">
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
                                            ? <span className="font-mono text-[10px] text-muted-foreground">{svc.serviceOfferingName || svc.servicePlanId}</span>
                                            : <span className="text-muted-foreground/40">—</span>
                                          }
                                        </td>
                                        <td className={`${tdCls} font-mono text-[11px]`}>
                                          <a href={svc.url} target="_blank" rel="noreferrer" className="text-primary hover:underline break-all">{svc.url}</a>
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
                    </>
                  );
                })()}

              </div>
            </>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
