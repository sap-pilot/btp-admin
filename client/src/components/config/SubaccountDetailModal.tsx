import { useState } from 'react';
import { ChevronDown, ShieldBan, X } from 'lucide-react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
  DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { SubaccountEntry, SpaceEntry } from './SubaccountsTable';
import type { CockpitMenuItem } from '@/components/home/HomepageContent';

interface Props {
  sa:          SubaccountEntry | null;
  onClose:     () => void;
  cockpit?:    { idp: string; host: string };
  cockpitMenu?: CockpitMenuItem | null;
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

function buildCtx(sa: SubaccountEntry, cockpit: { idp: string; host: string }): Record<string, string> {
  return {
    'homepage.cockpit.host': cockpit.host ? ensureHttps(cockpit.host) : '',
    'homepage.cockpit.idp':  cockpit.idp,
    cockpitRegion:           deriveCockpitRegion(sa.region),
    globalAccountGUID:       sa.globalAccountGUID,
    subaccountId:            sa.subaccountId,
    orgId:                   sa.org?.orgId ?? '',
    subdomain:               sa.subdomain,
  };
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

export default function SubaccountDetailModal({ sa, onClose, cockpit, cockpitMenu }: Props) {
  const [activeTab, setActiveTab] = useState<ModalTab>('info');

  const tabCls = (t: ModalTab) =>
    `px-3 py-2 text-xs font-medium transition-colors border-b-2 -mb-px ${
      activeTab === t
        ? 'border-primary text-foreground'
        : 'border-transparent text-muted-foreground hover:text-foreground'
    }`;

  return (
    <DialogPrimitive.Root open={sa !== null} onOpenChange={v => { if (!v) onClose(); }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50" />
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
                {cockpit && cockpitMenu && (() => {
                  const ctx    = buildCtx(sa, cockpit);
                  const url    = cockpitMenu.url ? resolveUrl(cockpitMenu.url, ctx) : undefined;
                  const spaces = sa.org?.spaces ?? [];
                  return (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-border hover:bg-accent hover:text-foreground transition-colors shrink-0 text-muted-foreground">
                          Open Cockpit <ChevronDown className="h-3 w-3 opacity-60 shrink-0" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="max-h-[min(70vh,420px)] overflow-y-auto">
                        {url && (
                          <>
                            <DropdownMenuItem className="text-xs cursor-pointer font-semibold" asChild>
                              <a href={url} target="_blank" rel="noopener noreferrer">Open Cockpit</a>
                            </DropdownMenuItem>
                            {cockpitMenu.submenus?.length ? <DropdownMenuSeparator /> : null}
                          </>
                        )}
                        {cockpitMenu.submenus ? renderMenuItems(cockpitMenu.submenus, ctx, spaces) : null}
                      </DropdownMenuContent>
                    </DropdownMenu>
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

              {/* Tab content — fills remaining modal height */}
              <div className="flex-1 overflow-auto">

                {/* ── Subaccount & Org ── */}
                {activeTab === 'info' && (
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
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )}

                {/* ── Subscriptions ── */}
                {activeTab === 'subscriptions' && (
                  sa.subscriptions.length > 0 ? (
                    <table className="w-full border-collapse text-xs">
                      <thead className="sticky top-0 z-10">
                        <tr className="bg-muted/30">
                          <th className={thCls}>Application</th>
                          <th className={thCls}>URL</th>
                          <th className={`${thCls} text-center`}>Customer Dev</th>
                        </tr>
                      </thead>
                      <tbody>
                        {sa.subscriptions.map((sub, i) => (
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
                    <p className="text-xs text-muted-foreground px-3 py-8 text-center">No subscriptions.</p>
                  )
                )}

                {/* ── Service Instances ── */}
                {activeTab === 'services' && (
                  sa.serviceInstances.length > 0 ? (
                    <table className="w-full border-collapse text-xs">
                      <thead className="sticky top-0 z-10">
                        <tr className="bg-muted/30">
                          <th className={thCls}>Space</th>
                          <th className={thCls}>Instance Name (Service Plan)</th>
                          <th className={thCls}>Dashboard</th>
                        </tr>
                      </thead>
                      <tbody>
                        {sa.serviceInstances.map((svc, i) => {
                          const spaceName = sa.org?.spaces.find(s => s.spaceId === svc.spaceId)?.spaceName ?? '';
                          return (
                            <tr key={i} className="hover:bg-muted/20">
                              <td className={`${tdCls} text-muted-foreground whitespace-nowrap`}>{spaceName || '—'}</td>
                              <td className={tdCls}>
                                <span className="block">{svc.instanceName}</span>
                                {(svc.serviceOfferingName || svc.servicePlanId) && (
                                  <span className="block text-[10px] text-muted-foreground font-mono mt-0.5">
                                    {svc.serviceOfferingName || svc.servicePlanId}
                                  </span>
                                )}
                              </td>
                              <td className={`${tdCls} font-mono text-[11px]`}>
                                <a href={svc.url} target="_blank" rel="noreferrer" className="text-primary hover:underline break-all">
                                  {svc.url}
                                </a>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  ) : (
                    <p className="text-xs text-muted-foreground px-3 py-8 text-center">No service instances.</p>
                  )
                )}

              </div>
            </>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
