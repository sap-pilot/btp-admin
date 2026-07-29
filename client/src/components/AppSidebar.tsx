import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { LogIn, Sun, Moon, Activity, Home, Globe, LayoutGrid, ChevronDown, RefreshCw, BookMarked, ShieldCheck } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useTheme } from '@/hooks/useTheme';
import { useSidebar } from '@/components/AppLayout';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import type { SiteConfig } from '@shared/types';

interface NavItem {
  label: string;
  href: string;
  icon: React.ReactNode;
  disabled?: boolean;
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
  { label: 'Apps', href: '/apps', icon: <LayoutGrid className="h-4 w-4 shrink-0" />, disabled: true },
  { label: 'Destinations', href: '/destinations', icon: <Globe className="h-4 w-4 shrink-0" />, disabled: true },
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

export default function AppSidebar() {
  const location = useLocation();
  const auth = useAuth();
  const { theme, toggleTheme } = useTheme();
  const { collapsed } = useSidebar();
  const [sites, setSites] = useState<SiteConfig[]>([]);
  const [appTitle, setAppTitle] = useState('BTP Admin');
  const [syncAvailable, setSyncAvailable] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [menus, setMenus] = useState<MenuGroup[]>([]);
  const [openMenus, setOpenMenus] = useState<Record<string, boolean>>({});

  useEffect(() => {
    fetch('/api/homepage')
      .then(r => r.json() as Promise<{ menus?: MenuGroup[] } | null>)
      .then(d => { setMenus(d?.menus ?? []); setOpenMenus({}); })
      .catch(() => null);
  }, [auth.loggedIn]);

  useEffect(() => {
    const p = location.pathname;
    const label = p === '/status' ? 'Status' : p === '/home' ? 'Home' : null;
    document.title = label ? `${label} - ${appTitle}` : appTitle;
  }, [location.pathname, appTitle]);

  useEffect(() => {
    fetch('/api/status/info')
      .then(r => r.json() as Promise<{ city?: string; sites?: SiteConfig[]; syncRemote?: boolean }>)
      .then(d => {
        if (d.syncRemote) setSyncAvailable(true);
        if (d.sites) {
          setSites(d.sites);
          const current = d.sites.find(s => {
            try { return new URL(s.url).origin === window.location.origin; } catch { return false; }
          });
          if (current) setAppTitle(current.name);
          else if (d.city && d.city !== 'unknown') setAppTitle(`${d.city} - BTP Admin`);
        } else if (d.city && d.city !== 'unknown') {
          setAppTitle(`${d.city} - BTP Admin`);
        }
      })
      .catch(() => null);
  }, []);

  const currentSiteUrl = sites.find(s => {
    try { return new URL(s.url).origin === window.location.origin; } catch { return false; }
  })?.url ?? '';

  function handleSiteSwitch(url: string) {
    if (url && url !== currentSiteUrl) window.location.replace(url);
  }

  const w = collapsed ? 'w-0 md:w-14' : 'w-56';
  const border = collapsed ? 'border-r-0 md:border-r' : 'border-r';

  return (
    <aside className={`${w} ${border} shrink-0 flex flex-col border-sidebar-border bg-sidebar transition-[width] duration-200 overflow-hidden`}>
      {/* Header: logo + title + site switcher + version */}
      <div className={`flex items-center border-b border-sidebar-border min-h-[52px] ${collapsed ? 'justify-center' : 'pl-2 pr-3 gap-2'}`}>
        <img src="/images/favicon-32x32.png" alt="" className="h-8 w-8 shrink-0" />
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

      {/* Navigation — flex column so theme toggle floats to bottom */}
      <nav className="flex-1 flex flex-col py-2 overflow-y-auto overflow-x-hidden">
        {/* Main nav items */}
        <div>
          {NAV_ITEMS.map(item => {
            const active = !item.disabled && location.pathname.startsWith(item.href);
            const cls = item.disabled
              ? itemBase(collapsed) + 'text-sidebar-foreground/40 cursor-not-allowed select-none'
              : active
                ? itemBase(collapsed) + 'bg-sidebar-accent text-sidebar-accent-foreground font-medium'
                : itemBase(collapsed) + 'text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground';

            const inner = (
              <>
                {item.icon}
                {!collapsed && (
                  <span className="truncate">
                    {item.label}
                    {item.disabled && <span className="ml-1 text-[10px] opacity-60">(soon)</span>}
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

        {/* Sync + Theme toggle — float to bottom of nav */}
        <div className="mt-auto pt-1">
          {syncAvailable && (!auth.enabled || auth.loggedIn) && (
            <button
              onClick={() => {
                setSyncing(true);
                fetch('/api/sync', { method: 'POST' }).finally(() => setSyncing(false));
              }}
              disabled={syncing}
              className={itemBase(collapsed) + 'text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground disabled:opacity-40 disabled:cursor-not-allowed'}
              title="Sync"
            >
              <RefreshCw className={`h-4 w-4 shrink-0 ${syncing ? 'animate-spin text-blue-400' : ''}`} />
              {!collapsed && <span className="truncate">Sync</span>}
            </button>
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
          <div className="py-2">
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
