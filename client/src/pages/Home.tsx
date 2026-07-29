import { useEffect } from 'react';
import { useNavigate, useParams } from 'react-router';
import { Pencil, PanelLeft } from 'lucide-react';
import { useSidebar, useHomepage } from '@/components/AppLayout';
import { useAuth } from '@/hooks/useAuth';
import HomepageContent, { type HomepageData } from '@/components/home/HomepageContent';
import EditHomePageModal from '@/components/home/EditHomePageModal';
import { useState } from 'react';

export default function Home() {
  const { toggle } = useSidebar();
  const auth = useAuth();
  const navigate = useNavigate();
  const { tab: tabParam } = useParams<{ tab?: string }>();
  const { homepage: homepageRaw, homepageLoading: loading, refreshHomepage } = useHomepage();

  const homepage = homepageRaw as HomepageData | null;
  const [editOpen, setEditOpen] = useState(false);

  // Refresh homepage when a root file (e.g. homepage.json) is updated via sync
  useEffect(() => {
    const es = new EventSource('/api/events?rootFiles=1');
    es.addEventListener('update', () => refreshHomepage());
    return () => es.close();
  }, [refreshHomepage]);

  // Ensure URL reflects a valid tab once data is available
  useEffect(() => {
    if (!homepage?.tabs?.length) return;
    const urlTab = tabParam ? decodeURIComponent(tabParam) : '';
    const valid = homepage.tabs.some(t => t.title === urlTab);
    if (!valid) {
      navigate('/home/' + encodeURIComponent(homepage.tabs[0].title), { replace: true });
    }
  }, [homepage, tabParam, navigate]);

  const urlTab = tabParam ? decodeURIComponent(tabParam) : '';
  const activeTab = homepage?.tabs?.some(t => t.title === urlTab) ? urlTab : (homepage?.tabs?.[0]?.title ?? '');

  function handleTabChange(tab: string) {
    navigate('/home/' + encodeURIComponent(tab), { replace: true });
  }

  const showEdit = !auth.enabled || auth.loggedIn;
  const canEdit = !auth.enabled || auth.isAdmin;
  const editTooltip = canEdit ? 'Edit Homepage' : 'Only BTP_Admin can edit Homepage';

  return (
    <div className="flex flex-col h-full bg-background text-foreground">
      {/* Topbar */}
      <div className="flex items-center gap-2 border-b border-border px-3 min-h-[52px] shrink-0">
        <button onClick={toggle} className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors" title="Toggle sidebar">
          <PanelLeft className="h-4 w-4" />
        </button>
        <span className="text-sm font-medium">{homepage?.btp?.title ?? 'Home'}</span>
        {showEdit && (
          <span className="ml-auto" title={editTooltip}>
            <button
              onClick={() => setEditOpen(true)}
              disabled={!canEdit}
              className={`p-1.5 rounded-md transition-colors${canEdit ? ' text-muted-foreground hover:text-foreground hover:bg-accent/50' : ' text-muted-foreground/30 cursor-not-allowed pointer-events-none'}`}
              aria-label={editTooltip}
            >
              <Pencil className="h-4 w-4" />
            </button>
          </span>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        {loading && (
          <div className="flex items-center justify-center h-full text-sm text-muted-foreground">Loading…</div>
        )}
        {!loading && !homepage && (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-muted-foreground">
            <p className="text-sm">Homepage not configured.</p>
            <p className="text-xs">Add <code className="bg-muted px-1 rounded">homepage.json</code> to your response directory or set <code className="bg-muted px-1 rounded">HOMEPAGE_JSON</code>.</p>
          </div>
        )}
        {!loading && homepage && (
          <HomepageContent data={homepage} activeTab={activeTab} onTabChange={handleTabChange} />
        )}
      </div>

      <EditHomePageModal
        open={editOpen}
        onClose={() => setEditOpen(false)}
        onSaved={refreshHomepage}
      />
    </div>
  );
}
