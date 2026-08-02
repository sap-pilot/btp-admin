import { useState } from 'react';
import HomepageContent, { type HomepageData, type CockpitMenuItem } from '@/components/home/HomepageContent';
import type { TabEntry } from '@/components/config/TabsTable';
import type { SubaccountEntry } from '@/components/config/SubaccountsTable';
import type { SettingsData } from '@/components/config/SettingsPanel';

interface Props {
  tabs:        TabEntry[];
  subaccounts: SubaccountEntry[];
  settings:    SettingsData | null;
  cockpitMenu: CockpitMenuItem | null;
}

export default function HomePreviewPanel({ tabs, subaccounts, settings, cockpitMenu }: Props) {
  const [activeTab, setActiveTab] = useState('');

  const cockpit           = settings?.homepage.cockpit ?? { idp: '', host: '' };
  const mainSubscriptions = settings?.homepage.mainSubscriptions ?? [];
  const data: HomepageData = { tabs, subaccounts, cockpit, cockpitMenu, mainSubscriptions };
  const resolvedTab = tabs.some(t => t.tab === activeTab) ? activeTab : (tabs[0]?.tab ?? '');

  return (
    <div className="flex flex-col h-full border-l border-border overflow-hidden bg-background">
      {/* Header — py-2 text-sm matches the tab-bar button sizing on the left */}
      <div className="shrink-0 px-3 border-b border-border bg-muted/20 flex items-center gap-2">
        <span className="py-[9px] text-sm font-medium">Preview</span>
        <span className="text-[10px] text-muted-foreground">· live, unsaved changes</span>
      </div>
      <div className="flex-1 overflow-hidden">
        <HomepageContent data={data} activeTab={resolvedTab} onTabChange={setActiveTab} />
      </div>
    </div>
  );
}
