import { useEffect, useState } from 'react';
import { Check, FlaskConical } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { useAuth } from '@/hooks/useAuth';
import { useTheme } from '@/hooks/useTheme';
import { useExperimentalFeatures } from '@/hooks/useExperimentalFeatures';
import { BASE_THEMES, ACCENT_THEMES } from '@/lib/themes';

type Section = 'account' | 'themes';

const SECTIONS: { id: Section; label: string }[] = [
  { id: 'account', label: 'User Account' },
  { id: 'themes',  label: 'Themes'       },
];

// These shadcn base themes are visually near-identical; hide them from the picker
const HIDDEN_BASE_THEMES = new Set(['stone', 'zinc', 'mauve', 'olive', 'mist', 'taupe', 'vercel']);

interface Props {
  open:             boolean;
  onClose:          () => void;
  initialSection?:  Section;
}

export default function UserSettingsModal({ open, onClose, initialSection = 'themes' }: Props) {
  const [activeSection, setActiveSection] = useState<Section>(initialSection);

  useEffect(() => {
    if (open) setActiveSection(initialSection);
  }, [open, initialSection]);

  const tabCls = (id: Section) =>
    `px-4 py-2 text-sm transition-colors border-b-2 shrink-0 ${
      activeSection === id
        ? 'border-primary text-foreground font-medium'
        : 'border-transparent text-muted-foreground hover:text-foreground'
    }`;

  return (
    <Dialog open={open} onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent className="max-w-3xl w-full p-0 gap-0 overflow-hidden flex flex-col h-[58vh] max-h-[58vh] max-[680px]:h-[100dvh] max-[680px]:max-h-[100dvh] max-[680px]:rounded-none max-[680px]:inset-0 max-[680px]:translate-x-0 max-[680px]:translate-y-0 max-[680px]:w-screen max-[680px]:max-w-none">
        <DialogTitle className="sr-only">User Settings</DialogTitle>

        {/* Tab bar — pr-10 keeps tabs clear of the X close button */}
        <div className="flex items-center border-b border-border shrink-0 px-2 pr-10">
          {SECTIONS.map(s => (
            <button key={s.id} className={tabCls(s.id)} onClick={() => setActiveSection(s.id)}>
              {s.label}
            </button>
          ))}
          {activeSection === 'themes' && (
            <span className="ml-2 text-xs text-muted-foreground">Changes apply immediately</span>
          )}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto min-h-0">
          {activeSection === 'account' && <AccountSection />}
          {activeSection === 'themes'  && <ThemesSection  />}
        </div>

      </DialogContent>
    </Dialog>
  );
}

// ─── Account section ──────────────────────────────────────────────────────────

function AccountSection() {
  const auth = useAuth();
  const { experimentalFeatures, setExperimentalFeatures } = useExperimentalFeatures();

  return (
    <div className="px-6 py-6 flex flex-col gap-6 max-w-md">

      {/* User identity block — only when auth is enabled and user is logged in */}
      {auth.enabled && auth.loggedIn && (
        <>
          <div className="flex items-center gap-4">
            <div className="h-12 w-12 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-lg font-bold select-none shrink-0">
              {auth.initials || auth.firstName.slice(0, 1).toUpperCase()}
            </div>
            <div className="flex flex-col gap-0.5 min-w-0">
              <span className="text-sm font-semibold truncate">{auth.firstName}</span>
              {auth.email && <span className="text-xs text-muted-foreground truncate">{auth.email}</span>}
              {auth.isAdmin && (
                <span className="text-[10px] font-medium text-primary mt-0.5">Administrator</span>
              )}
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-3 py-2 border-b border-border/50">
              <span className="text-xs text-muted-foreground w-24 shrink-0">Name</span>
              <span className="text-sm">{auth.firstName}</span>
            </div>
            {auth.email && (
              <div className="flex items-center gap-3 py-2 border-b border-border/50">
                <span className="text-xs text-muted-foreground w-24 shrink-0">Email</span>
                <span className="text-sm truncate">{auth.email}</span>
              </div>
            )}
            <div className="flex items-center gap-3 py-2 border-b border-border/50">
              <span className="text-xs text-muted-foreground w-24 shrink-0">Role</span>
              <span className="text-sm">{auth.isAdmin ? 'Administrator' : 'Viewer'}</span>
            </div>
          </div>
        </>
      )}

      {auth.enabled && !auth.loggedIn && (
        <p className="text-sm text-muted-foreground">You are not logged in.</p>
      )}

      {!auth.enabled && (
        <p className="text-sm text-muted-foreground">Authentication is not enabled on this instance.</p>
      )}

      {/* Experimental features — browser-local, always visible */}
      <div className="flex flex-col gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Features</h3>
        <label className="flex items-center justify-between gap-4 py-2 border-b border-border/50 cursor-pointer group">
          <div className="flex items-center gap-2 min-w-0">
            <FlaskConical className="h-4 w-4 shrink-0 text-muted-foreground group-hover:text-foreground transition-colors" />
            <div className="flex flex-col gap-0.5 min-w-0">
              <span className="text-sm">Experimental Features</span>
              <span className="text-[11px] text-muted-foreground leading-tight">
                Show Destinations, Role Collections and Users in the sidebar. Stored in your browser.
              </span>
            </div>
          </div>
          <button
            role="switch"
            aria-checked={experimentalFeatures}
            onClick={() => setExperimentalFeatures(!experimentalFeatures)}
            className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${
              experimentalFeatures ? 'bg-primary' : 'bg-input'
            }`}
          >
            <span className={`pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform ${
              experimentalFeatures ? 'translate-x-4' : 'translate-x-0'
            }`} />
          </button>
        </label>
      </div>

    </div>
  );
}

// ─── Themes section ───────────────────────────────────────────────────────────

const visibleBaseThemes = BASE_THEMES.filter(t => !HIDDEN_BASE_THEMES.has(t.name));

function ThemesSection() {
  const { theme: darkMode, toggleTheme, baseTheme, accentTheme, setThemePreset } = useTheme();

  return (
    <div className="px-6 py-4 flex flex-col gap-6">

      {/* Light / Dark */}
      <div className="flex items-center gap-3">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Appearance</span>
        <div className="inline-flex rounded border border-border text-xs overflow-hidden">
          <button
            onClick={() => darkMode !== 'light' && toggleTheme()}
            className={`px-3 py-1 transition-colors ${
              darkMode === 'light'
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground'
            }`}
          >
            Light
          </button>
          <button
            onClick={() => darkMode !== 'dark' && toggleTheme()}
            className={`px-3 py-1 border-l border-border transition-colors ${
              darkMode === 'dark'
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground'
            }`}
          >
            Dark
          </button>
        </div>
      </div>

      {/* Base themes */}
      <section>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3">Base Theme</h3>
        <div className="grid grid-cols-4 gap-2.5">
          {visibleBaseThemes.map(theme => {
            const vars       = darkMode === 'dark' ? theme.cssVars.dark : theme.cssVars.light;
            const isSelected = baseTheme === theme.name;
            return (
              <button
                key={theme.name}
                onClick={() => setThemePreset(isSelected ? null : theme.name, accentTheme)}
                style={{ background: vars['background'] ?? undefined }}
                className={`relative rounded-lg border-2 p-3 text-left transition-all hover:shadow-md ${
                  isSelected ? 'border-primary' : 'border-border hover:border-muted-foreground/30'
                }`}
              >
                <div className="flex items-center gap-1 mb-2">
                  {(['primary', 'secondary', 'muted', 'accent'] as const).map(k => (
                    <div key={k} style={{ background: vars[k] ?? undefined }} className="h-2.5 w-2.5 rounded-full shrink-0" />
                  ))}
                </div>
                <div className="flex flex-col gap-1 mb-2">
                  <div style={{ background: vars['foreground'] ?? undefined }} className="h-1 rounded-sm w-4/5 opacity-60" />
                  <div style={{ background: vars['muted-foreground'] ?? undefined }} className="h-1 rounded-sm w-3/5 opacity-40" />
                </div>
                <span style={{ color: vars['foreground'] ?? undefined }} className="text-[10px] font-medium leading-tight">{theme.label}</span>
                {isSelected && (
                  <span
                    style={{ background: vars['primary'] ?? undefined, color: vars['primary-foreground'] ?? undefined }}
                    className="absolute top-1.5 right-1.5 h-[16px] w-[16px] rounded-full flex items-center justify-center"
                  >
                    <Check className="h-2.5 w-2.5" />
                  </span>
                )}
              </button>
            );
          })}
        </div>
        {baseTheme && !HIDDEN_BASE_THEMES.has(baseTheme) && (
          <button
            onClick={() => setThemePreset(null, accentTheme)}
            className="mt-2 text-xs text-muted-foreground underline-offset-2 hover:underline hover:text-foreground transition-colors"
          >
            Reset to default
          </button>
        )}
      </section>

      {/* Accent colors */}
      <section>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3">Accent Color</h3>
        <div className="flex flex-wrap gap-3">
          {ACCENT_THEMES.map(theme => {
            const vars         = darkMode === 'dark' ? theme.cssVars.dark : theme.cssVars.light;
            const isSelected   = accentTheme === theme.name;
            const primaryColor = vars['primary'] ?? 'currentColor';
            const primaryFg    = vars['primary-foreground'] ?? '#fff';
            return (
              <div key={theme.name} className="flex flex-col items-center gap-1">
                <button
                  onClick={() => setThemePreset(baseTheme, isSelected ? null : theme.name)}
                  title={theme.label}
                  style={{
                    background:    primaryColor,
                    outlineColor:  primaryColor,
                    outlineOffset: '2px',
                    outlineStyle:  isSelected ? 'solid' : 'none',
                    outlineWidth:  '2px',
                  }}
                  className="h-8 w-8 rounded-full flex items-center justify-center hover:scale-110 transition-transform"
                >
                  {isSelected && <Check style={{ color: primaryFg }} className="h-4 w-4" />}
                </button>
                <span className="text-[10px] text-muted-foreground">{theme.label}</span>
              </div>
            );
          })}
        </div>
        {accentTheme && (
          <button
            onClick={() => setThemePreset(baseTheme, null)}
            className="mt-2 text-xs text-muted-foreground underline-offset-2 hover:underline hover:text-foreground transition-colors"
          >
            Remove accent
          </button>
        )}
      </section>

    </div>
  );
}
