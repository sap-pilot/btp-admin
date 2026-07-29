import { ChevronDown } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
  DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface HpSpace { spaceId: string; spaceName: string; destInstanceId?: string; }
export interface HpLaunchpadInstance { alias: string; name: string; }
export interface HpServiceData {
  id?: string; host?: string; url?: string; regionPostfix?: string;
  alias?: string; instances?: HpLaunchpadInstance[];
  disabled?: boolean; tooltip?: string; name?: string;
  [key: string]: unknown;
}
export interface HpSubaccount {
  id?: string; name: string; orgId?: string; subdomain?: string;
  services?: Record<string, HpServiceData>; spaces?: HpSpace[];
  usage?: string; disabled?: boolean;
}
export interface HpDirectory { name: string; short: string; region?: string; subaccounts: HpSubaccount[]; }
export interface HpGlobalAccount {
  id?: string; name: string; cockpitRegion?: string;
  directories: HpDirectory[];
  [key: string]: unknown;
}
export interface HpTemplateChild {
  name: string; url?: string; children?: HpTemplateChild[]; repeatOn?: string;
}
export interface HpTemplate { name: string; fullName?: string; url?: string; children?: HpTemplateChild[]; }
export interface HpTab { title: string; dirs: string[]; }
export interface HomepageData {
  tabs?: HpTab[];
  btp?: { globalAccounts?: HpGlobalAccount[]; title?: string; };
  templates?: Record<string, HpTemplate>;
  [key: string]: unknown;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function buildCtx(ga: HpGlobalAccount, dir: HpDirectory, sa: HpSubaccount): Record<string, string> {
  const ctx: Record<string, string> = {
    cockpitRegion: String(ga.cockpitRegion ?? ''),
    globalAccountId: String(ga.id ?? ''),
    subaccountId: String(sa.id ?? ''),
    subdomain: String(sa.subdomain ?? ''),
    orgId: String(sa.orgId ?? ''),
    region: String(dir.region ?? ''),
  };
  for (const [k, v] of Object.entries(ga)) {
    if (typeof v === 'string') ctx[k] = v;
  }
  for (const [svcKey, svcData] of Object.entries(sa.services ?? {})) {
    if (!svcData || typeof svcData !== 'object') continue;
    for (const [field, val] of Object.entries(svcData as Record<string, unknown>)) {
      if (typeof val === 'string') { ctx[field] = val; ctx[`${svcKey}-${field}`] = val; }
    }
  }
  return ctx;
}

export function resolve(tpl: string, ctx: Record<string, string>): string {
  return tpl.replace(/\{([^}]+)\}/g, (_, k: string) => ctx[k] ?? '');
}

export function findDir(short: string, gas: HpGlobalAccount[]): { dir: HpDirectory; ga: HpGlobalAccount } | null {
  for (const ga of gas) {
    const dir = ga.directories?.find(d => d.short === short);
    if (dir) return { dir, ga };
  }
  return null;
}

function collectServiceKeys(dir: HpDirectory): string[] {
  const set = new Set<string>();
  for (const sa of dir.subaccounts) for (const k of Object.keys(sa.services ?? {})) set.add(k);
  return Array.from(set).sort();
}

// ─── Recursive template children renderer ────────────────────────────────────

function renderChildren(children: HpTemplateChild[], ctx: Record<string, string>, sa: HpSubaccount): React.ReactNode[] {
  return children.flatMap((child, i) => {
    if (child.name === '-') return [<DropdownMenuSeparator key={`s${i}`} />];

    if (child.repeatOn === 'spaces') {
      return (sa.spaces ?? []).flatMap(sp => {
        const spCtx = { ...ctx, spaceId: sp.spaceId, spaceName: sp.spaceName, destInstanceId: sp.destInstanceId ?? '' };
        const name = resolve(child.name, spCtx);
        const url = child.url ? resolve(child.url, spCtx) : undefined;
        if (child.children?.length) {
          return [(
            <DropdownMenuSub key={sp.spaceId}>
              <DropdownMenuSubTrigger className="text-xs">{name}</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {url && <DropdownMenuItem className="text-xs cursor-pointer" asChild>
                  <a href={url} target="_blank" rel="noopener noreferrer">{name}</a>
                </DropdownMenuItem>}
                {url && <DropdownMenuSeparator />}
                {renderChildren(child.children, spCtx, sa)}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )];
        }
        return url ? [<DropdownMenuItem key={sp.spaceId} className="text-xs cursor-pointer" asChild>
          <a href={url} target="_blank" rel="noopener noreferrer">{name}</a>
        </DropdownMenuItem>] : [];
      });
    }

    if (child.repeatOn === 'instances') {
      const instances = (sa.services?.['launchpad']?.instances as HpLaunchpadInstance[] | undefined) ?? [];
      return instances.flatMap(inst => {
        const iCtx = { ...ctx, 'launchpad-alias': inst.alias, 'launchpad-name': inst.name };
        const name = resolve(child.name, iCtx);
        const url = child.url ? resolve(child.url, iCtx) : undefined;
        return url ? [<DropdownMenuItem key={inst.alias} className="text-xs cursor-pointer" asChild>
          <a href={url} target="_blank" rel="noopener noreferrer">{name}</a>
        </DropdownMenuItem>] : [];
      });
    }

    const name = resolve(child.name, ctx);
    const url = child.url ? resolve(child.url, ctx) : undefined;

    if (child.children?.length) {
      return [(
        <DropdownMenuSub key={i}>
          <DropdownMenuSubTrigger className="text-xs">{name}</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {url && <DropdownMenuItem className="text-xs cursor-pointer" asChild>
              <a href={url} target="_blank" rel="noopener noreferrer">{name}</a>
            </DropdownMenuItem>}
            {url && <DropdownMenuSeparator />}
            {renderChildren(child.children, ctx, sa)}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      )];
    }

    return [url
      ? <DropdownMenuItem key={i} className="text-xs cursor-pointer" asChild>
          <a href={url} target="_blank" rel="noopener noreferrer">{name}</a>
        </DropdownMenuItem>
      : <DropdownMenuItem key={i} className="text-xs" disabled>{name}</DropdownMenuItem>
    ];
  });
}

// ─── Cell components ─────────────────────────────────────────────────────────

function CellDropdown({ label, url, tpl, ctx, sa }: {
  label: string; url?: string;
  tpl: HpTemplate; ctx: Record<string, string>; sa: HpSubaccount;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="inline-flex items-center gap-0.5 text-xs px-1.5 py-0.5 rounded hover:bg-accent/60 transition-colors text-foreground">
          {label}<ChevronDown className="h-3 w-3 shrink-0 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-[min(70vh,420px)] overflow-y-auto">
        {url && <DropdownMenuItem className="text-xs cursor-pointer" asChild>
          <a href={url} target="_blank" rel="noopener noreferrer">{tpl.name}</a>
        </DropdownMenuItem>}
        {url && tpl.children?.length ? <DropdownMenuSeparator /> : null}
        {tpl.children ? renderChildren(tpl.children, ctx, sa) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ServiceCell({ ga, dir, sa, serviceKey, templates }: {
  ga: HpGlobalAccount; dir: HpDirectory; sa: HpSubaccount;
  serviceKey: string; templates: Record<string, HpTemplate>;
}) {
  const svcData = sa.services?.[serviceKey];
  const tpl = templates[serviceKey];

  if (!svcData || !tpl) {
    return <span className="text-muted-foreground/40 select-none">—</span>;
  }
  if (svcData.disabled) {
    return <span className="text-muted-foreground/40 cursor-help line-through text-xs" title={String(svcData.tooltip ?? 'Disabled')}>{tpl.name}</span>;
  }

  const ctx = buildCtx(ga, dir, sa);
  const url: string | undefined = typeof svcData.url === 'string' ? svcData.url
    : tpl.url ? resolve(tpl.url, ctx) : undefined;

  if (tpl.children?.length) {
    return <CellDropdown label={tpl.name} url={url} tpl={tpl} ctx={ctx} sa={sa} />;
  }
  if (url) {
    return (
      <a href={url} target="_blank" rel="noopener noreferrer"
        className="inline-flex items-center gap-0.5 text-xs text-foreground hover:underline">
        {tpl.name}
      </a>
    );
  }
  return <span className="text-muted-foreground/40 select-none">—</span>;
}

// ─── Dir table ───────────────────────────────────────────────────────────────

function DirTable({ ga, dir, templates }: {
  ga: HpGlobalAccount; dir: HpDirectory; templates: Record<string, HpTemplate>;
}) {
  const cockpitTpl = templates['cockpit'];
  const serviceKeys = collectServiceKeys(dir).filter(k => k !== 'cockpit');

  return (
    <div className="mb-6">
      <div className="px-1 mb-1.5 flex items-baseline gap-2">
        <span className="text-sm font-semibold">{dir.name}</span>
        {dir.region && <span className="text-xs text-muted-foreground">{dir.region}</span>}
        <span className="text-xs text-muted-foreground">· {ga.name}</span>
      </div>
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="min-w-full text-sm border-collapse">
          <thead>
            <tr className="bg-muted/30">
              <th className="sticky left-0 z-10 bg-muted/30 text-left text-xs font-medium text-muted-foreground px-3 py-2 min-w-[120px] border-r border-border whitespace-nowrap">
                Services \ Orgs
              </th>
              {dir.subaccounts.map(sa => {
                const ctx = buildCtx(ga, dir, sa);
                const cockpitUrl = cockpitTpl?.url ? resolve(cockpitTpl.url, ctx) : undefined;
                return (
                  <th key={sa.name} className={`text-center text-xs font-medium px-3 py-2 min-w-[110px] border-l border-border${sa.usage === 'prod' ? ' text-amber-500' : ' text-muted-foreground'}`}>
                    <div className="flex flex-col items-center gap-0.5">
                      <div className="flex items-center gap-1 whitespace-nowrap">
                        {cockpitUrl
                          ? <a href={cockpitUrl} target="_blank" rel="noopener noreferrer" className="hover:underline">{sa.name}</a>
                          : <span>{sa.name}</span>
                        }
                        {cockpitTpl?.children?.length ? (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <button className="opacity-60 hover:opacity-100 transition-opacity" title="Cockpit">
                                <ChevronDown className="h-3 w-3" />
                              </button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="start" className="max-h-[min(70vh,420px)] overflow-y-auto">
                              {cockpitUrl && <DropdownMenuItem className="text-xs cursor-pointer" asChild>
                                <a href={cockpitUrl} target="_blank" rel="noopener noreferrer">{cockpitTpl.name}</a>
                              </DropdownMenuItem>}
                              {cockpitUrl ? <DropdownMenuSeparator /> : null}
                              {renderChildren(cockpitTpl.children, ctx, sa)}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        ) : null}
                        {sa.usage === 'prod' && <span className="text-[9px] opacity-70">PROD</span>}
                      </div>
                      {sa.subdomain && (
                        <span className="text-[10px] font-normal font-mono text-muted-foreground/60 leading-tight">
                          {sa.subdomain}
                        </span>
                      )}
                    </div>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {serviceKeys.map(svcKey => {
              const tpl = templates[svcKey];
              if (!tpl) return null;
              const hasAny = dir.subaccounts.some(sa => sa.services?.[svcKey]);
              if (!hasAny) return null;
              return (
                <tr key={svcKey} className="border-t border-border hover:bg-muted/10 transition-colors">
                  <td className="sticky left-0 z-10 bg-background px-3 py-1.5 text-xs font-medium border-r border-border whitespace-nowrap" title={tpl.fullName}>
                    {tpl.name}
                  </td>
                  {dir.subaccounts.map(sa => (
                    <td key={sa.name} className={`px-3 py-1.5 text-center border-l border-border${sa.disabled ? ' opacity-40' : ''}`}>
                      <ServiceCell ga={ga} dir={dir} sa={sa} serviceKey={svcKey} templates={templates} />
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Main content component ───────────────────────────────────────────────────

export default function HomepageContent({ data, activeTab, onTabChange }: {
  data: HomepageData | null;
  activeTab: string;
  onTabChange: (tab: string) => void;
}) {
  if (!data?.tabs?.length) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 text-muted-foreground">
        <p className="text-sm">No homepage data.</p>
      </div>
    );
  }

  const templates = data.templates ?? {};
  const globalAccounts = data.btp?.globalAccounts ?? [];

  return (
    <Tabs value={activeTab} onValueChange={onTabChange} className="flex flex-col h-full">
      <div className="border-b border-border px-4 pt-2 shrink-0 overflow-x-auto">
        <TabsList className="h-8 bg-transparent p-0 gap-1">
          {data.tabs.map(tab => (
            <TabsTrigger key={tab.title} value={tab.title} className="text-xs h-7 px-3 rounded-none border-b-2 border-transparent data-[state=active]:border-foreground data-[state=active]:bg-transparent">
              {tab.title}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
      <div className="flex-1 overflow-auto">
        {data.tabs.map(tab => (
          <TabsContent key={tab.title} value={tab.title} className="mt-0 p-4">
            {tab.dirs.map(dirShort => {
              const found = findDir(dirShort, globalAccounts);
              if (!found) return null;
              return <DirTable key={dirShort} ga={found.ga} dir={found.dir} templates={templates} />;
            })}
          </TabsContent>
        ))}
      </div>
    </Tabs>
  );
}
