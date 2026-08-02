import { ChevronDown } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
  DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { TabEntry, BannerColor } from '@/components/config/TabsTable';
import type { SubaccountEntry, SpaceEntry } from '@/components/config/SubaccountsTable';
import type { MainSubscription } from '@/components/config/SettingsPanel';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CockpitMenuItem {
  name:      string;
  url?:      string;
  repeatOn?: string;
  submenus?: CockpitMenuItem[];
}

export interface HomepageData {
  tabs:              TabEntry[];
  subaccounts:       SubaccountEntry[];
  cockpit:           { idp: string; host: string };
  cockpitMenu:       CockpitMenuItem | null;
  mainSubscriptions: MainSubscription[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

function resolve(tpl: string, ctx: Record<string, string>): string {
  return tpl.replace(/\{([^}]+)\}/g, (_, k: string) => ctx[k] ?? '');
}

function csvIncludes(csv: string, val: string): boolean {
  return csv.split(',').map(s => s.trim()).some(g => g === val);
}

function bannerBg(color: BannerColor): string {
  switch (color) {
    case 'blue':   return 'bg-blue-500/35';
    case 'green':  return 'bg-green-500/35';
    case 'yellow': return 'bg-yellow-400/50';
    case 'red':    return 'bg-red-500/35';
    case 'purple': return 'bg-purple-500/35';
    default:       return '';
  }
}

// ─── Inline markdown renderer (links, images, bold, italic, <br>) ─────────────

function parseInline(text: string, li: number): React.ReactNode[] {
  // Order matters: images before links, bold before italic
  const pat = /!\[([^\]]*)\]\(([^)]+)\)|\[([^\]]*)\]\(([^)]+)\)|\*\*([^*]+)\*\*|\*([^*]+)\*/g;
  const out: React.ReactNode[] = [];
  let last = 0, ki = 0, m: RegExpExecArray | null;
  while ((m = pat.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${li}-${ki++}`;
    if      (m[2] !== undefined) out.push(<img key={k} src={m[2]} alt={m[1] ?? ''} className="max-w-full inline-block align-middle" />);
    else if (m[4] !== undefined) out.push(<a key={k} href={m[4]} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:opacity-80">{m[3]}</a>);
    else if (m[5] !== undefined) out.push(<strong key={k}>{m[5]}</strong>);
    else if (m[6] !== undefined) out.push(<em key={k}>{m[6]}</em>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function renderMd(text: string | null | undefined): React.ReactNode {
  if (!text) return null;
  return text.split(/<br\s*\/?>/i).flatMap((line, i) =>
    i === 0 ? parseInline(line, i) : [<br key={`br${i}`} />, ...parseInline(line, i)]
  );
}

function buildCtx(sa: SubaccountEntry, cockpit: { idp: string; host: string }): Record<string, string> {
  return {
    'homepage.cockpit.host': cockpit.host,
    'homepage.cockpit.idp':  cockpit.idp,
    cockpitRegion:           deriveCockpitRegion(sa.region),
    globalAccountGUID:       sa.globalAccountGUID,
    subaccountId:            sa.subaccountId,
    orgId:                   sa.org?.orgId ?? '',
    subdomain:               sa.subdomain,
  };
}

// Strip query params whose value resolved to empty string (e.g. ?idp= when IDP not set)
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

// ─── Cockpit menu renderer ────────────────────────────────────────────────────

function renderMenuItems(items: CockpitMenuItem[], ctx: Record<string, string>, spaces: SpaceEntry[]): React.ReactNode[] {
  return items.flatMap((item, i) => {
    if (item.name === '-') return [<DropdownMenuSeparator key={`sep-${i}`} />];

    if (item.repeatOn === 'spaces') {
      return spaces.flatMap(sp => {
        const spCtx = { ...ctx, spaceId: sp.spaceId, spaceName: sp.spaceName };
        const name  = resolve(item.name, spCtx);
        const url   = item.url ? resolveUrl(item.url, spCtx) : undefined;
        if (item.submenus?.length) {
          return [(
            <DropdownMenuSub key={sp.spaceId}>
              <DropdownMenuSubTrigger className="text-xs">{name}</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {url && <>
                  <DropdownMenuItem className="text-xs cursor-pointer" asChild>
                    <a href={url} target="_blank" rel="noopener noreferrer">{name}</a>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                </>}
                {renderMenuItems(item.submenus, spCtx, spaces)}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )];
        }
        return url ? [
          <DropdownMenuItem key={sp.spaceId} className="text-xs cursor-pointer" asChild>
            <a href={url} target="_blank" rel="noopener noreferrer">{name}</a>
          </DropdownMenuItem>
        ] : [];
      });
    }

    const name = resolve(item.name, ctx);
    const url  = item.url ? resolveUrl(item.url, ctx) : undefined;

    if (item.submenus?.length) {
      return [(
        <DropdownMenuSub key={i}>
          <DropdownMenuSubTrigger className="text-xs">{name}</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {url && <>
              <DropdownMenuItem className="text-xs cursor-pointer" asChild>
                <a href={url} target="_blank" rel="noopener noreferrer">{name}</a>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>}
            {renderMenuItems(item.submenus, ctx, spaces)}
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

// ─── Cockpit dropdown (in Cockpit body row) ───────────────────────────────────

function CockpitDropdown({ sa, cockpitMenu, cockpit }: {
  sa:          SubaccountEntry;
  cockpitMenu: CockpitMenuItem;
  cockpit:     { idp: string; host: string };
}) {
  const ctx    = buildCtx(sa, cockpit);
  const url    = cockpitMenu.url ? resolveUrl(cockpitMenu.url, ctx) : undefined;
  const spaces = sa.org?.spaces ?? [];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="inline-flex items-center gap-0.5 text-xs px-1.5 py-0.5 rounded hover:bg-accent/60 transition-colors text-foreground">
          {cockpitMenu.name} <ChevronDown className="h-3 w-3 shrink-0 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-[min(70vh,420px)] overflow-y-auto">
        {url && <>
          <DropdownMenuItem className="text-xs cursor-pointer" asChild>
            <a href={url} target="_blank" rel="noopener noreferrer">{cockpitMenu.name}</a>
          </DropdownMenuItem>
          {cockpitMenu.submenus?.length ? <DropdownMenuSeparator /> : null}
        </>}
        {cockpitMenu.submenus ? renderMenuItems(cockpitMenu.submenus, ctx, spaces) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ─── More dropdown (extra subscriptions not in mainSubscriptions) ─────────────

function MoreDropdown({ sa, mainNames }: { sa: SubaccountEntry; mainNames: Set<string> }) {
  const extras = sa.subscriptions
    .filter(s => !mainNames.has(s.displayName))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
  if (extras.length === 0) return <span className="text-muted-foreground/40 select-none">—</span>;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="inline-flex items-center gap-0.5 text-xs px-1.5 py-0.5 rounded hover:bg-accent/60 transition-colors text-muted-foreground">
          {extras.length} more <ChevronDown className="h-3 w-3 shrink-0 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-[min(70vh,420px)] overflow-y-auto">
        {extras.map(s => (
          <DropdownMenuItem key={s.displayName} className="text-xs cursor-pointer" asChild>
            <a href={s.url} target="_blank" rel="noopener noreferrer">{s.displayName}</a>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ─── Subaccount group section (matrix table) ──────────────────────────────────

function SubaccountGroupSection({ section, subaccounts, cockpitMenu, cockpit, mainSubscriptions }: {
  section:           { type: 'subaccountGroup'; title?: string; groupId: string };
  subaccounts:       SubaccountEntry[];
  cockpitMenu:       CockpitMenuItem | null;
  cockpit:           { idp: string; host: string };
  mainSubscriptions: MainSubscription[];
}) {
  const cols = subaccounts
    .filter(sa => sa.inHomepage && csvIncludes(sa.groupIds, section.groupId))
    .sort((a, b) => a.pos - b.pos);

  if (cols.length === 0) return null;

  const mainNames = new Set(mainSubscriptions.map(ms => ms.name));
  const hasMore   = cols.some(sa => sa.subscriptions.some(s => !mainNames.has(s.displayName)));

  return (
    <div className="mb-6">
      <div className="px-1 mb-1.5">
        {section.title && <span className="text-sm font-semibold">{section.title}</span>}
        <span className={`text-xs text-muted-foreground/60 font-mono ${section.title ? ' ml-1.5' : ''}`}>
          {section.groupId}
        </span>
      </div>
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="min-w-full text-sm border-collapse">
          <thead>
            <tr className="bg-muted/30">
              <th className="sticky left-0 z-10 bg-muted/30 text-left text-xs font-medium text-muted-foreground px-3 py-2 min-w-[110px] border-r border-border whitespace-nowrap">
                Subscriptions
              </th>
              {cols.map(sa => {
                const ctx        = buildCtx(sa, cockpit);
                const cockpitUrl = cockpitMenu?.url ? resolveUrl(cockpitMenu.url, ctx) : undefined;
                const label      = [section.groupId, sa.alias].filter(Boolean).join(' ');
                return (
                  <th key={sa.subaccountId} className="text-center text-xs font-medium px-3 py-2 min-w-[110px] border-l border-border text-muted-foreground">
                    <div className="flex flex-col items-center gap-0.5">
                      <span className="whitespace-nowrap">
                        {cockpitUrl
                          ? <a href={cockpitUrl} target="_blank" rel="noopener noreferrer" className="hover:underline">{label}</a>
                          : label
                        }
                      </span>
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
            {/* Cockpit row */}
            {cockpitMenu && (
              <tr className="border-t border-border hover:bg-muted/10 transition-colors">
                <td className="sticky left-0 z-10 bg-muted/20 px-3 py-1.5 text-xs font-medium text-muted-foreground border-r border-border whitespace-nowrap">
                  Cockpit
                </td>
                {cols.map(sa => (
                  <td key={sa.subaccountId} className="px-3 py-1.5 text-center border-l border-border">
                    <CockpitDropdown sa={sa} cockpitMenu={cockpitMenu} cockpit={cockpit} />
                  </td>
                ))}
              </tr>
            )}

            {/* Main subscription rows */}
            {mainSubscriptions.map(ms => {
              const hasAny = cols.some(sa => sa.subscriptions.some(s => s.displayName === ms.name));
              if (!hasAny) return null;
              return (
                <tr key={ms.name} className="border-t border-border hover:bg-muted/10 transition-colors">
                  <td className="sticky left-0 z-10 bg-muted/20 px-3 py-1.5 text-xs font-medium text-muted-foreground border-r border-border" title={ms.alias || undefined}>
                    {ms.name}
                  </td>
                  {cols.map(sa => {
                    const sub      = sa.subscriptions.find(s => s.displayName === ms.name);
                    const linkText = [sa.alias, ms.alias || ms.name].filter(Boolean).join(' ');
                    return (
                      <td key={sa.subaccountId} className="px-3 py-1.5 text-center border-l border-border">
                        {sub
                          ? <a href={sub.url} target="_blank" rel="noopener noreferrer" className="text-xs hover:underline">{linkText}</a>
                          : <span className="text-muted-foreground/40 select-none">—</span>
                        }
                      </td>
                    );
                  })}
                </tr>
              );
            })}

            {/* More row */}
            {hasMore && (
              <tr className="border-t border-border hover:bg-muted/10 transition-colors">
                <td className="sticky left-0 z-10 bg-muted/20 px-3 py-1.5 text-xs font-medium text-muted-foreground border-r border-border whitespace-nowrap">
                  More
                </td>
                {cols.map(sa => (
                  <td key={sa.subaccountId} className="px-3 py-1.5 text-center border-l border-border">
                    <MoreDropdown sa={sa} mainNames={mainNames} />
                  </td>
                ))}
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Table section renderer ───────────────────────────────────────────────────

function TableSection({ section }: { section: { type: 'table'; title?: string; tableContent: string[][] } }) {
  const [header, ...rows] = section.tableContent;
  return (
    <div className="mb-6">
      {section.title && (
        <div className="px-1 mb-1.5">
          <span className="text-sm font-semibold">{section.title}</span>
        </div>
      )}
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="min-w-full text-xs border-collapse">
          {header && (
            <thead>
              <tr className="bg-muted/30">
                {header.map((cell, ci) => (
                  <th key={ci} className="text-left px-3 py-2 font-medium text-muted-foreground border-b border-border whitespace-nowrap">
                    {renderMd(cell)}
                  </th>
                ))}
              </tr>
            </thead>
          )}
          <tbody>
            {rows.map((row, ri) => (
              <tr key={ri} className="border-t border-border/40 hover:bg-muted/5 transition-colors">
                {row.map((cell, ci) => (
                  <td
                    key={ci}
                    className={`px-3 py-1.5 text-xs ${
                      ci === 0
                        ? 'bg-muted/20 font-medium text-muted-foreground border-r border-border'
                        : 'border-l border-border/20'
                    }`}
                  >
                    {renderMd(cell)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Main content component ───────────────────────────────────────────────────

export default function HomepageContent({ data, activeTab, onTabChange }: {
  data:        HomepageData;
  activeTab:   string;
  onTabChange: (tab: string) => void;
}) {
  if (!data.tabs.length) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 text-muted-foreground">
        <p className="text-sm">No tabs configured.</p>
        <p className="text-xs">Add tabs in Config → Tabs.</p>
      </div>
    );
  }

  return (
    <Tabs value={activeTab} onValueChange={onTabChange} className="flex flex-col h-full">
      <div className="border-b border-border px-4 pt-2 shrink-0 overflow-x-auto">
        <TabsList className="h-8 bg-transparent p-0 gap-1">
          {data.tabs.map(tab => (
            <TabsTrigger
              key={tab.tab}
              value={tab.tab}
              className="text-xs h-7 px-3 rounded-none border-b-2 border-transparent data-[state=active]:border-foreground data-[state=active]:bg-transparent"
            >
              {tab.tab}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
      <div className="flex-1 overflow-auto">
        {data.tabs.map(tab => (
          <TabsContent key={tab.tab} value={tab.tab} className="mt-0 p-4">
            {tab.sections.map((section, si) => {
              if (section.type === 'banner') {
                const bg = bannerBg(section.backgroundColor);
                return (
                  <div key={si} className={`mb-4 px-4 py-2 rounded text-sm ${bg || 'border border-border'}`}>
                    {renderMd(section.message)}
                  </div>
                );
              }
              if (section.type === 'table') {
                return <TableSection key={si} section={section} />;
              }
              if (section.type === 'subaccountGroup') {
                return (
                  <SubaccountGroupSection
                    key={si}
                    section={section}
                    subaccounts={data.subaccounts}
                    cockpitMenu={data.cockpitMenu}
                    cockpit={data.cockpit}
                    mainSubscriptions={data.mainSubscriptions}
                  />
                );
              }
              return null;
            })}
          </TabsContent>
        ))}
      </div>
    </Tabs>
  );
}
