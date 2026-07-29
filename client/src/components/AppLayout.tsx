import { createContext, useContext, useEffect, useState } from 'react';
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

export default function AppLayout() {
  const [collapsed, setCollapsed] = useState(readCookie);

  useEffect(() => {
    writeCookie(collapsed);
  }, [collapsed]);

  return (
    <SidebarContext.Provider value={{ collapsed, toggle: () => setCollapsed(c => !c) }}>
      <div className="flex h-screen overflow-hidden bg-background text-foreground">
        <AppSidebar />
        <main className="flex-1 overflow-auto min-w-0">
          <Outlet />
        </main>
      </div>
    </SidebarContext.Provider>
  );
}
