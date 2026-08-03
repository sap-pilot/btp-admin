import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { Outlet } from 'react-router';
import { PanelLeft } from 'lucide-react';
import AppSidebar from './AppSidebar';
import { useAuth } from '@/hooks/useAuth';
import type { SettingsData } from '@/components/config/SettingsPanel';

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

// ─── Settings context ─────────────────────────────────────────────────────────

export interface SettingsCtx {
  settings: SettingsData | null;
  refreshSettings: () => void;
}

const SettingsContext = createContext<SettingsCtx>({ settings: null, refreshSettings: () => {} });

export function useSettings(): SettingsCtx {
  return useContext(SettingsContext);
}

// ─── Layout ───────────────────────────────────────────────────────────────────

export default function AppLayout() {
  const [collapsed, setCollapsed]       = useState(readCookie);
  const [settings, setSettings]         = useState<SettingsData | null>(null);
  const [settingsKey, setSettingsKey]   = useState(0);
  const auth = useAuth();

  const gated = !auth.loading && auth.enabled && !auth.loggedIn;

  useEffect(() => { writeCookie(collapsed); }, [collapsed]);

  // Fetch settings on mount and whenever auth state changes (login → get gated data; logout → revert to public).
  // Skip while auth is still loading to avoid a redundant public-only fetch before login state is known.
  useEffect(() => {
    if (auth.loading) return;
    fetch('/api/settings')
      .then(r => r.json() as Promise<{ ok: boolean; data: SettingsData }>)
      .then(({ data }) => setSettings(data))
      .catch(() => setSettings({ homepage: { cockpit: { idp: '', host: '' }, mainSubscriptions: [] }, menus: [] }));
  }, [settingsKey, auth.loading, auth.loggedIn]);

  const refreshSettings = useCallback(() => setSettingsKey(k => k + 1), []);

  // Hold render until auth state is known to avoid flash of wrong layout
  if (auth.loading) return null;

  return (
    <SidebarContext.Provider value={{ collapsed, toggle: () => setCollapsed(c => !c) }}>
      <SettingsContext.Provider value={{ settings, refreshSettings }}>
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
      </SettingsContext.Provider>
    </SidebarContext.Provider>
  );
}
