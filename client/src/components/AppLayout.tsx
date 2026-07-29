import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { Outlet } from 'react-router';
import { PanelLeft } from 'lucide-react';
import AppSidebar from './AppSidebar';
import { useAuth } from '@/hooks/useAuth';

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
  const auth = useAuth();

  const gated = !auth.loading && auth.enabled && !auth.loggedIn;

  useEffect(() => {
    writeCookie(collapsed);
  }, [collapsed]);

  useEffect(() => {
    if (auth.loading || gated) { setHomepageLoading(false); return; }
    setHomepageLoading(true);
    fetch('/api/homepage')
      .then(r => r.json() as Promise<Record<string, unknown> | null>)
      .then(d => setHomepage(d))
      .catch(() => null)
      .finally(() => setHomepageLoading(false));
  }, [homepageKey, auth.loading, gated]);

  const refreshHomepage = useCallback(() => setHomepageKey(k => k + 1), []);

  // Hold render until auth state is known to avoid flash of wrong layout
  if (auth.loading) return null;

  return (
    <SidebarContext.Provider value={{ collapsed, toggle: () => setCollapsed(c => !c) }}>
      <HomepageContext.Provider value={{ homepage, homepageLoading, refreshHomepage }}>
        <div className="flex h-screen overflow-hidden bg-background text-foreground">
          <AppSidebar />
          <main className="flex-1 overflow-auto min-w-0">
            {gated ? (
              <div className="flex flex-col h-full">
                <div className="flex items-center gap-2 border-b border-border px-4 min-h-[52px] shrink-0">
                  <button
                    onClick={() => setCollapsed(c => !c)}
                    className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors shrink-0"
                    title="Toggle sidebar"
                  >
                    <PanelLeft className="h-4 w-4" />
                  </button>
                </div>
                <div className="flex-1 flex flex-col items-center justify-center gap-3">
                  <button
                    onClick={auth.login}
                    className="rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground shadow-sm hover:bg-primary/90 transition-colors"
                  >
                    Welcome, click here to login
                  </button>
                  <a
                    href="https://github.com/sap-pilot/btp-admin/issues"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                  >
                    Report an issue
                  </a>
                </div>
              </div>
            ) : (
              <Outlet />
            )}
          </main>
        </div>
      </HomepageContext.Provider>
    </SidebarContext.Provider>
  );
}
