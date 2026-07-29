import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { Outlet } from 'react-router';
import AppSidebar from './AppSidebar';

const COOKIE = 'sidebar-collapsed';
const MAX_AGE = 365 * 24 * 60 * 60; // 1 year

function readCookie(): boolean {
  const m = document.cookie.match(/(?:^|;\s*)sidebar-collapsed=([^;]*)/);
  return m?.[1] === '1';
}

function writeCookie(value: boolean) {
  document.cookie = `${COOKIE}=${value ? '1' : '0'}; max-age=${MAX_AGE}; path=/; SameSite=Strict`;
}

interface SidebarCtx {
  collapsed: boolean;
  toggle: () => void;
}

const SidebarContext = createContext<SidebarCtx>({ collapsed: false, toggle: () => {} });

export function useSidebar(): SidebarCtx {
  return useContext(SidebarContext);
}

// ─── Homepage context ─────────────────────────────────────────────────────────

export interface HomepageCtx {
  homepage: Record<string, unknown> | null;
  homepageLoading: boolean;
  refreshHomepage: () => void;
}

const HomepageContext = createContext<HomepageCtx>({
  homepage: null,
  homepageLoading: true,
  refreshHomepage: () => {},
});

export function useHomepage(): HomepageCtx {
  return useContext(HomepageContext);
}

// ─── Layout ───────────────────────────────────────────────────────────────────

export default function AppLayout() {
  const [collapsed, setCollapsed] = useState(readCookie);
  const [homepage, setHomepage] = useState<Record<string, unknown> | null>(null);
  const [homepageLoading, setHomepageLoading] = useState(true);
  const [homepageKey, setHomepageKey] = useState(0);

  useEffect(() => {
    writeCookie(collapsed);
  }, [collapsed]);

  useEffect(() => {
    setHomepageLoading(true);
    fetch('/api/homepage')
      .then(r => r.json() as Promise<Record<string, unknown> | null>)
      .then(d => setHomepage(d))
      .catch(() => null)
      .finally(() => setHomepageLoading(false));
  }, [homepageKey]);

  const refreshHomepage = useCallback(() => setHomepageKey(k => k + 1), []);

  return (
    <SidebarContext.Provider value={{ collapsed, toggle: () => setCollapsed(c => !c) }}>
      <HomepageContext.Provider value={{ homepage, homepageLoading, refreshHomepage }}>
        <div className="flex h-screen overflow-hidden bg-background text-foreground">
          <AppSidebar />
          <main className="flex-1 overflow-auto min-w-0">
            <Outlet />
          </main>
        </div>
      </HomepageContext.Provider>
    </SidebarContext.Provider>
  );
}
