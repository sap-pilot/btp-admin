import { useEffect, useState } from 'react';

type Theme = 'dark' | 'light';

const STORAGE_KEY = 'btp-status-theme';

function readStored(): Theme {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'light' || v === 'dark') return v;
  } catch { /* ignore */ }
  return 'dark';
}

// Module-level singleton — all hook instances share one theme value.
// This ensures toggleTheme() in the sidebar immediately re-renders every
// consumer (e.g. Overview's LandscapeDiagram isDark prop).
let _theme: Theme = readStored();
const _listeners = new Set<(t: Theme) => void>();

function applyTheme(t: Theme) {
  _theme = t;
  document.documentElement.classList.toggle('dark', t === 'dark');
  try { localStorage.setItem(STORAGE_KEY, t); } catch { /* ignore */ }
  _listeners.forEach(fn => fn(t));
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(_theme);

  useEffect(() => {
    _listeners.add(setTheme);
    return () => { _listeners.delete(setTheme); };
  }, []);

  const toggleTheme = () => applyTheme(_theme === 'dark' ? 'light' : 'dark');

  return { theme, toggleTheme };
}
