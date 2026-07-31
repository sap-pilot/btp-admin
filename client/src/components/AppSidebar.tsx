import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { LogIn, Sun, Moon, Activity, Home, Globe, LayoutGrid, Network, ChevronDown, RefreshCw, BookMarked, ShieldCheck, Settings } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useTheme } from '@/hooks/useTheme';
import { useSidebar, useHomepage } from '@/components/AppLayout';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import type { SiteConfig } from '@shared/types';

interface NavChild {
  label: string;
  href: string;
  disabled?: boolean;
  soon?: boolean;
}

interface NavItem {
  label: string;
  href: string;
  icon: React.ReactNode;
  disabled?: boolean;
  soon?: boolean;
  wip?: boolean;
  restricted?: boolean;
  children?: NavChild[];
}

interface MenuItem {
  title: string;
  url: string;
  target?: string;
}

interface MenuGroup {
  title: string;
  children: MenuItem[];
}

const NAV_ITEMS: NavItem[] = [
  { label: 'Home', href: '/home', icon: <Home className="h-4 w-4 shrink-0" /> },
  { label: 'Status', href: '/status', icon: <Activity className="h-4 w-4 shrink-0" /> },
  { label: 'Apps', href: '/apps', icon: <LayoutGrid className="h-4 w-4 shrink-0" />, soon: true, restricted: true },
  { label: 'Destinations', href: '/destinations', icon: <Globe className="h-4 w-4 shrink-0" />, wip: true, restricted: true },
  {
    label: 'Integration', href: '/int', icon: <Network className="h-4 w-4 shrink-0" />, soon: true, restricted: true,
    children: [
      { label: 'Dynamic Routing', href: '/int/dynamic-routing', soon: true },
    ],
  },
];

const itemBase = (collapsed: boolean) =>
  collapsed
    ? 'flex items-center justify-center py-2 mx-1 rounded-md text-sm transition-colors '
    : 'flex items-center gap-3 px-3 py-2 mx-1 rounded-md text-sm transition-colors ';

function menuIcon(title: string) {
  switch (title) {
    case 'Security': return <ShieldCheck className="h-4 w-4 shrink-0" />;
    case 'Resources': return <BookMarked className="h-4 w-4 shrink-0" />;
    default: return <BookMarked className="h-4 w-4 shrink-0" />;
  }
}

function matchesOrigin(s: SiteConfig): boolean {
  try {
    const o = window.location.origin;
    if (new URL(s.url).origin === o) return true;
    return (s.legacyUrls ?? []).some(u => new URL(u).origin === o);
  } catch { return false; }
}

export default function AppSidebar() {
  const location = useLocation();
  const auth = useAuth();
  const { theme, toggleTheme } = useTheme();
  const { collapsed } = useSidebar();
  const { homepage, refreshHomepage } = useHomepage();
  const [sites, setSites] = useState<SiteConfig[]>([]);
  const [appTitle, setAppTitle] = useState('BTP Admin');
  const [syncAvailable, setSyncAvailable] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncBusy, setSyncBusy] = useState(false);
  const [openMenus, setOpenMenus] = useState<Record<string, boolean>>({});

  const menus = (homepage?.menus as MenuGroup[] | undefined) ?? [];

  // On auth change: reset open menus; refresh homepage so restricted items show/hide.
  // Skip on the very first render — AppLayout's initial fetch already covers it.
  const firstAuthRender = useRef(true);
  useEffect(() => {
    setOpenMenus({});
    if (firstAuthRender.current) { firstAuthRender.current = false; return; }
    refreshHomepage();
  }, [auth.loggedIn, refreshHomepage]);

  useEffect(() => {
    const p = location.pathname;
    const label = p === '/status' ? 'Status' : p === '/home' ? 'Home' : null;
    document.title = label ? `${label} - ${appTitle}` : appTitle;
  }, [location.pathname, appTitle]);

  useEffect(() => {
    fetch('/api/info')
      .then(r => r.json() as Promise<{ city?: string; sites?: SiteConfig[]; syncRemote?: boolean }>)
      .then(d => {
        if (d.syncRemote) setSyncAvailable(true);
        if (d.sites) {
          setSites(d.sites);
          const current = d.sites.find(matchesOrigin);
          if (current) setAppTitle(current.name);
          else if (d.city && d.city !== 'unknown') setAppTitle(`${d.city} - BTP Admin`);
        } else if (d.city && d.city !== 'unknown') {
          setAppTitle(`${d.city} - BTP Admin`);
        }
      })
      .catch(() => null);
  }, []);

  const currentSiteUrl = sites.find(matchesOrigin)?.url ?? '';

  function handleSiteSwitch(url: string) {
    if (!url || url === currentSiteUrl) return;
    try {
      const { pathname, search, hash } = window.location;
      window.location.replace(new URL(pathname + search + hash, url).href);
    } catch {
      window.location.replace(url);
    }
  }

  const w = collapsed ? 'w-0 md:w-14' : 'w-56';
  const border = collapsed ? 'border-r-0 md:border-r' : 'border-r';

  return (
    <aside className={`${w} ${border} shrink-0 flex flex-col border-sidebar-border bg-sidebar transition-[width] duration-200 overflow-hidden`}>
      {/* Header: logo + title + site switcher + version */}
      <div className={`flex items-center border-b border-sidebar-border min-h-[52px] ${collapsed ? 'justify-center' : 'pl-2 pr-3 gap-2'}`}>
        <img src="/images/favicon-32x32.png?lastModified=20260729" alt="" className="h-8 w-8 shrink-0" />
        {!collapsed && (
          <div className="flex flex-col min-w-0 flex-1">
            <div className="flex items-center gap-1">
              <span className="text-sm font-semibold truncate text-sidebar-foreground">{appTitle}</span>
              {sites.length >= 2 && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button className="text-sidebar-foreground/50 hover:text-sidebar-foreground transition-colors shrink-0" title="Switch site">
                      <ChevronDown className="h-3.5 w-3.5" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    {sites.map(s => (
                      <DropdownMenuItem
                        key={s.url}
                        className={`text-xs cursor-pointer${s.url === currentSiteUrl ? ' font-semibold' : ''}`}
                        onSelect={() => handleSiteSwitch(s.url)}
                      >
                        {s.name}
                        {s.url === currentSiteUrl && (
                          <span className="text-muted-foreground text-xs ml-auto pl-3">current</span>
                        )}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
            <a
              href="https://github.com/sap-pilot/btp-admin/blob/main/CHANGELOG.md"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[10px] text-sidebar-foreground/50 leading-tight truncate hover:text-sidebar-foreground transition-colors"
              title={`v${__APP_VERSION__}-${__COMMIT_HASH__} — built ${new Date(__BUILD_DATE__).toLocaleString()}`}
            >
              v{__APP_VERSION__}-{__COMMIT_HASH__}
            </a>
          </div>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 flex flex-col py-2 overflow-y-auto overflow-x-hidden">
        {/* Main nav items and menu groups — hidden when auth gating is active */}
        {(!auth.enabled || auth.loggedIn) && <>
        <div>
          {NAV_ITEMS.filter(item => !item.restricted || !auth.enabled || auth.loggedIn).map(item => {
            const active = !item.disabled && !item.soon && location.pathname.startsWith(item.href);
            const disabledCls = itemBase(collapsed) + 'text-sidebar-foreground/40 cursor-not-allowed select-none';
            const cls = item.disabled
              ? disabledCls
              : active
                ? itemBase(collapsed) + 'bg-sidebar-accent text-sidebar-accent-foreground font-medium'
                : itemBase(collapsed) + 'text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground';

            // Item with children — collapsible submenu (expanded) or icon-only (collapsed)
            if (item.children) {
              const isOpen = !!openMenus[item.href];
              const childrenPanel = isOpen && (
                <div className="ml-6 mr-1 border-l border-sidebar-border py-0.5 flex flex-col gap-0.5">
                  {item.children.map(c => {
                    const childCls = 'flex h-7 min-w-0 items-center rounded-md pl-5 pr-3 text-sm';
                    if (c.disabled) {
                      return (
                        <div key={c.href} className={childCls + ' text-sidebar-foreground/40 cursor-not-allowed select-none'}>
                          <span className="truncate">{c.label}<span className="ml-1 text-[10px] opacity-60">(soon)</span></span>
                        </div>
                      );
                    }
                    return (
                      <Link
                        key={c.href}
                        to={c.href}
                        className={childCls + ' text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground transition-colors'}
                      >
                        <span className="truncate">
                          {c.label}
                          {c.soon && <span className="ml-1 text-[10px] opacity-60">(soon)</span>}
                        </span>
                      </Link>
                    );
                  })}
                </div>
              );
              if (collapsed) {
                if (item.disabled) {
                  return (
                    <div key={item.href} className={disabledCls} title={item.label}>
                      {item.icon}
                    </div>
                  );
                }
                return (
                  <Link key={item.href} to={item.href} className={cls} title={item.label}>
                    {item.icon}
                  </Link>
                );
              }
              if (item.disabled) {
                return (
                  <div key={item.href} className="flex flex-col">
                    <button
                      className={cls}
                      onClick={() => setOpenMenus(o => ({ ...o, [item.href]: !o[item.href] }))}
                    >
                      {item.icon}
                      <span className="truncate flex-1 text-left">
                        {item.label}
                        <span className="ml-1 text-[10px] opacity-60">(soon)</span>
                      </span>
                      <ChevronDown className={`h-3.5 w-3.5 shrink-0 transition-transform${isOpen ? ' rotate-180' : ''}`} />
                    </button>
                    {childrenPanel}
                  </div>
                );
              }
              // soon or active — split row: Link navigates, chevron toggles submenu
              const rowCls = `flex items-center rounded-md text-sm transition-colors mx-1 ${
                active
                  ? 'bg-sidebar-accent text-sidebar-accent-foreground font-medium'
                  : 'text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
              }`;
              return (
                <div key={item.href} className="flex flex-col">
                  <div className={rowCls}>
                    <Link to={item.href} className="flex items-center gap-3 flex-1 min-w-0 pl-3 py-2">
                      {item.icon}
                      <span className="truncate flex-1 text-left">
                        {item.label}
                        {item.soon && <span className="ml-1 text-[10px] opacity-60">(soon)</span>}
                      </span>
                    </Link>
                    <button
                      className="pr-3 py-2 shrink-0"
                      onClick={() => setOpenMenus(o => ({ ...o, [item.href]: !o[item.href] }))}
                    >
                      <ChevronDown className={`h-3.5 w-3.5 shrink-0 transition-transform${isOpen ? ' rotate-180' : ''}`} />
                    </button>
                  </div>
                  {childrenPanel}
                </div>
              );
            }

            const inner = (
              <>
                {item.icon}
                {!collapsed && (
                  <span className="truncate">
                    {item.label}
                    {(item.disabled || item.soon) && <span className="ml-1 text-[10px] opacity-60" title="coming soon">(soon)</span>}
                    {item.wip && <span className="ml-1 text-[10px] opacity-60" title="work in progress">(wip)</span>}
                  </span>
                )}
              </>
            );

            if (item.disabled) {
              return <div key={item.href} className={cls} title={collapsed ? item.label : undefined}>{inner}</div>;
            }
            return (
              <Link key={item.href} to={item.href} className={cls} title={collapsed ? item.label : undefined}>
                {inner}
              </Link>
            );
          })}
        </div>

        {/* Dynamic menu groups from homepage.json */}
        {menus.map(menu => {
          if (collapsed) {
            return (
              <DropdownMenu key={menu.title}>
                <DropdownMenuTrigger asChild>
                  <button
                    className={itemBase(true) + 'text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'}
                    title={menu.title}
                  >
                    {menuIcon(menu.title)}
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent side="right" align="end">
                  {menu.children.map(c => (
                    <DropdownMenuItem key={c.url} className="text-sm cursor-pointer" asChild>
                      <a href={c.url} target={c.target ?? '_blank'} rel="noopener noreferrer">{c.title}</a>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            );
          }
          return (
            <div key={menu.title} className="flex flex-col">
              <button
                onClick={() => setOpenMenus(o => ({ ...o, [menu.title]: !o[menu.title] }))}
                className={itemBase(false) + 'text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'}
              >
                {menuIcon(menu.title)}
                <span className="truncate flex-1 text-left">{menu.title}</span>
                <ChevronDown className={`h-3.5 w-3.5 shrink-0 transition-transform${openMenus[menu.title] ? ' rotate-180' : ''}`} />
              </button>
              {openMenus[menu.title] && (
                <div className="ml-6 mr-1 border-l border-sidebar-border py-0.5 flex flex-col gap-0.5">
                  {menu.children.map(c => (
                    <a
                      key={c.url}
                      href={c.url}
                      target={c.target ?? '_blank'}
                      rel="noopener noreferrer"
                      className="flex h-7 min-w-0 items-center rounded-md pl-5 pr-3 text-sm text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground transition-colors"
                    >
                      <span className="truncate">{c.title}</span>
                    </a>
                  ))}
                </div>
              )}
            </div>
          );
        })}
        </>}

        {/* Sync + Configuration + Theme toggle — float to bottom; theme toggle visible even before login */}
        <div className="mt-auto pt-1 flex flex-col">
          {(!auth.enabled || auth.isAdmin) && (
            <Link
              to="/config/orgs"
              className={itemBase(collapsed) + (location.pathname.startsWith('/config')
                ? 'bg-sidebar-accent text-sidebar-accent-foreground font-medium'
                : 'text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground')}
              title="configure subaccounts/orgs, tabs/directories and menu items"
            >
              <Settings className="h-4 w-4 shrink-0" />
              {!collapsed && <span className="truncate">Config</span>}
            </Link>
          )}
          {syncAvailable && (!auth.enabled || auth.loggedIn) && (
            <>
              <button
                onClick={async () => {
                  setSyncing(true);
                  setSyncBusy(false);
                  try {
                    const res = await fetch('/api/sync', { method: 'POST' });
                    const data = await res.json() as { busy?: boolean };
                    if (data.busy) {
                      setSyncBusy(true);
                      setTimeout(() => setSyncBusy(false), 6000);
                    }
                  } finally {
                    setSyncing(false);
                  }
                }}
                disabled={syncing}
                className={itemBase(collapsed) + 'text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground disabled:opacity-40 disabled:cursor-not-allowed'}
                title="Sync"
              >
                <RefreshCw className={`h-4 w-4 shrink-0 ${syncing ? 'animate-spin text-blue-400' : ''}`} />
                {!collapsed && <span className="truncate">Sync</span>}
              </button>
              {syncBusy && !collapsed && (
                <div className="mx-3 mb-1 text-[11px] text-muted-foreground leading-tight">
                  Sync already running.
                  {auth.isAdmin && (
                    <> <button
                      className="text-primary underline-offset-2 hover:underline"
                      onClick={async () => {
                        setSyncBusy(false);
                        setSyncing(true);
                        try {
                          await fetch('/api/sync', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ force: true }),
                          });
                        } finally {
                          setSyncing(false);
                        }
                      }}
                    >Force sync?</button></>
                  )}
                </div>
              )}
            </>
          )}
          <button
            onClick={toggleTheme}
            className={itemBase(collapsed) + 'text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'}
            title="Toggle Theme"
          >
            {theme === 'dark' ? <Moon className="h-4 w-4 shrink-0" /> : <Sun className="h-4 w-4 shrink-0" />}
            {!collapsed && <span className="truncate">Toggle Theme</span>}
          </button>
        </div>
      </nav>

      {/* Bottom: auth */}
      <div className="border-t border-sidebar-border">
        {auth.enabled ? (
          <div className="py-2 flex flex-col">
            {!auth.loggedIn ? (
              <button
                onClick={auth.login}
                className={itemBase(collapsed) + 'text-sidebar-foreground/70 hover:text-sidebar-accent-foreground hover:bg-sidebar-accent'}
                title="Log in"
              >
                <LogIn className="h-4 w-4 shrink-0" />
                {!collapsed && <span>Log in</span>}
              </button>
            ) : (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    className={itemBase(collapsed) + 'text-sidebar-foreground/70 hover:text-sidebar-accent-foreground hover:bg-sidebar-accent'}
                    title={collapsed ? auth.firstName : undefined}
                  >
                    <div className="h-4 w-4 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-[9px] font-bold leading-none select-none shrink-0">
                      {auth.initials || auth.firstName.slice(0, 1).toUpperCase()}
                    </div>
                    {!collapsed && (
                      <span className="truncate text-sm">{auth.firstName}</span>
                    )}
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent side="top" align="start" className="w-52">
                  <div className="px-2 py-1.5 border-b border-border mb-1">
                    <p className="text-xs font-medium">{auth.firstName}</p>
                    {auth.email && <p className="text-[10px] text-muted-foreground">{auth.email}</p>}
                  </div>
                  <DropdownMenuItem className="text-xs cursor-pointer" onSelect={auth.logout}>
                    Log out
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        ) : null}
      </div>
    </aside>
  );
}
