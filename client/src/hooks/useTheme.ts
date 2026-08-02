import { useEffect, useState } from 'react';
import { BASE_THEMES, ACCENT_THEMES, themeVarName } from '@/lib/themes';

type DarkLight = 'dark' | 'light';

const STORAGE_DARK   = 'btp-status-theme';
const STORAGE_BASE   = 'btp-status-theme-base';
const STORAGE_ACCENT = 'btp-status-theme-accent';

// Build the set of all CSS var names used by any theme so clearThemeVars is precise
const ALL_THEME_KEYS = new Set<string>();
for (const t of [...BASE_THEMES, ...ACCENT_THEMES]) {
  for (const k of Object.keys(t.cssVars.light)) ALL_THEME_KEYS.add(k);
  for (const k of Object.keys(t.cssVars.dark))  ALL_THEME_KEYS.add(k);
}

function applyVars(vars: Record<string, string>) {
  const el = document.documentElement;
  for (const [k, v] of Object.entries(vars)) el.style.setProperty(themeVarName(k), v);
}

function clearThemeVars() {
  const el = document.documentElement;
  for (const k of ALL_THEME_KEYS) el.style.removeProperty(themeVarName(k));
}

function readStorage(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

function writeStorage(key: string, value: string | null) {
  try {
    if (value) localStorage.setItem(key, value);
    else       localStorage.removeItem(key);
  } catch { /* ignore */ }
}

// ── Module-level singleton ────────────────────────────────────────────────────

let _dark:   DarkLight   = (readStorage(STORAGE_DARK) as DarkLight | null) === 'light' ? 'light' : 'dark';
let _base:   string | null = readStorage(STORAGE_BASE);
let _accent: string | null = readStorage(STORAGE_ACCENT);

const _darkListeners   = new Set<(t: DarkLight) => void>();
const _baseListeners   = new Set<(b: string | null) => void>();
const _accentListeners = new Set<(a: string | null) => void>();

function applyDark(t: DarkLight) {
  _dark = t;
  document.documentElement.classList.toggle('dark', t === 'dark');
  writeStorage(STORAGE_DARK, t);
  _darkListeners.forEach(fn => fn(t));
}

function applyPreset(base: string | null, accent: string | null) {
  _base   = base;
  _accent = accent;
  clearThemeVars();

  if (base) {
    const t = BASE_THEMES.find(th => th.name === base);
    if (t) applyVars(_dark === 'dark' ? t.cssVars.dark : t.cssVars.light);
  }
  if (accent) {
    const t = ACCENT_THEMES.find(th => th.name === accent);
    if (t) applyVars(_dark === 'dark' ? t.cssVars.dark : t.cssVars.light);
  }

  writeStorage(STORAGE_BASE,   base);
  writeStorage(STORAGE_ACCENT, accent);
  _baseListeners.forEach(fn => fn(base));
  _accentListeners.forEach(fn => fn(accent));
}

// Apply immediately on module load (before React renders) to prevent flash
applyDark(_dark);
if (_base || _accent) applyPreset(_base, _accent);

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useTheme() {
  const [dark,   setDark]   = useState<DarkLight>(_dark);
  const [base,   setBase]   = useState<string | null>(_base);
  const [accent, setAccent] = useState<string | null>(_accent);

  useEffect(() => {
    _darkListeners.add(setDark);
    _baseListeners.add(setBase);
    _accentListeners.add(setAccent);
    return () => {
      _darkListeners.delete(setDark);
      _baseListeners.delete(setBase);
      _accentListeners.delete(setAccent);
    };
  }, []);

  const toggleTheme = () => {
    const next = _dark === 'dark' ? 'light' : 'dark';
    applyDark(next);
    if (_base || _accent) applyPreset(_base, _accent);
  };

  const setThemePreset = (newBase: string | null, newAccent: string | null) => {
    applyPreset(newBase, newAccent);
  };

  // Expose as `theme` for backwards-compat with existing consumers
  return { theme: dark, toggleTheme, baseTheme: base, accentTheme: accent, setThemePreset };
}
