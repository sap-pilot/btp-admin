import { useState, useEffect } from 'react';
import SubaccountModal, { type ModalTab } from '@/components/SubaccountModal';
import type { SubaccountEntry } from '@/components/config/SubaccountsTable';
import type { CockpitMenuItem } from '@/components/home/HomepageContent';
import type { TabEntry } from '@/components/config/TabsTable';
import type { SettingsData } from '@/components/config/SettingsPanel';

const VALID_TABS = new Set<ModalTab>(['info', 'services', 'apps', 'destinations', 'roles', 'users']);

function boolParam(params: URLSearchParams, key: string): boolean | undefined {
  return params.has(key) ? params.get(key) === 'true' : undefined;
}
function strParam(params: URLSearchParams, key: string): string | undefined {
  return params.get(key) ?? undefined;
}

export default function SubaccountPopup() {
  // Read URL params once at mount; store in state so tab-driven URL changes
  // (history.replaceState in handleTabSwitch) don't corrupt them on re-render.
  const [region, setRegion]       = useState(() => new URLSearchParams(window.location.search).get('region') ?? '');
  const [subdomain, setSubdomain] = useState(() => new URLSearchParams(window.location.search).get('subdomain') ?? '');

  const initialParams = new URLSearchParams(window.location.search);
  const tabParam  = initialParams.get('tab') ?? '';
  const initialTab: ModalTab = VALID_TABS.has(tabParam as ModalTab) ? (tabParam as ModalTab) : 'info';

  // Entity-specific hints forwarded from the originating click
  const initialAppGuid      = strParam(initialParams, 'appGuid');
  const initialDestName     = strParam(initialParams, 'destName');
  const initialDestShowList = boolParam(initialParams, 'destShowList');
  const initialDestSpaceName = strParam(initialParams, 'destSpaceName');
  const initialDestInstName  = strParam(initialParams, 'destInstName');
  const initialDestInstGuid  = strParam(initialParams, 'destInstGuid');
  const initialRcName       = strParam(initialParams, 'rcName');
  const initialRcShowList   = boolParam(initialParams, 'rcShowList');
  const initialUserEmail    = strParam(initialParams, 'userEmail');
  const initialUserOrigin   = strParam(initialParams, 'userOrigin');

  const [sa, setSa]               = useState<SubaccountEntry | null>(null);
  const [sas, setSas]             = useState<SubaccountEntry[]>([]);
  const [cockpit, setCockpit]     = useState<{ idp: string; host: string } | undefined>();
  const [cockpitMenu, setCockpitMenu] = useState<CockpitMenuItem | null>(null);
  const [tabs, setTabs]           = useState<TabEntry[]>([]);
  const [isAdmin, setIsAdmin]     = useState(false);
  const [error, setError]         = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      fetch('/api/config/subaccounts').then(r => r.json() as Promise<{ ok: boolean; data: SubaccountEntry[] }>),
      fetch('/api/settings').then(r => r.json() as Promise<{ ok: boolean; data: SettingsData }>),
      fetch('/api/config/cockpit-menu').then(r => r.json() as Promise<CockpitMenuItem | null>),
      fetch('/api/config/tabs').then(r => r.json() as Promise<{ ok: boolean; data: TabEntry[] }>),
      fetch('/api/me').then(r => r.json() as Promise<{ isAdmin?: boolean }>),
    ]).then(([sasRes, settingsRes, menuRes, tabsRes, meRes]) => {
      const list = sasRes.data ?? [];
      setSas(list);
      const found = list.find(s => s.region === region && s.subdomain === subdomain);
      if (!found) { setError(`Subaccount not found: ${region}/${subdomain}`); return; }
      setSa(found);
      setCockpit(settingsRes.data?.homepage?.cockpit);
      setCockpitMenu(menuRes);
      setTabs(tabsRes.data ?? []);
      setIsAdmin(meRes.isAdmin ?? false);
    }).catch(() => setError('Failed to load subaccount data'));
  }, [region, subdomain]);

  if (error) {
    return (
      <div className="flex h-screen items-center justify-center bg-background text-foreground">
        <p className="text-sm text-destructive">{error}</p>
      </div>
    );
  }

  return (
    <div className="bg-background text-foreground min-h-screen">
      <SubaccountModal
        sa={sa}
        onClose={() => window.close()}
        cockpit={cockpit}
        cockpitMenu={cockpitMenu}
        isAdmin={isAdmin}
        subaccounts={sas}
        onSelectSubaccount={next => {
          setSa(next);
          setRegion(next.region);
          setSubdomain(next.subdomain);
          const r = encodeURIComponent(next.region);
          const s = encodeURIComponent(next.subdomain);
          history.replaceState(null, '', `/popup.html?region=${r}&subdomain=${s}&tab=info`);
        }}
        tabs={tabs}
        initialTab={initialTab}
        initialAppGuid={initialAppGuid}
        initialDestName={initialDestName}
        initialDestShowList={initialDestShowList}
        initialDestSpaceName={initialDestSpaceName}
        initialDestInstName={initialDestInstName}
        initialDestInstGuid={initialDestInstGuid}
        initialRcName={initialRcName}
        initialRcShowList={initialRcShowList}
        initialUserEmail={initialUserEmail}
        initialUserOrigin={initialUserOrigin}
        isPopup
      />
    </div>
  );
}
