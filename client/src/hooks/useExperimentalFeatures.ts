import { useCallback, useSyncExternalStore } from 'react';

const KEY = 'btp-admin:experimental';

function read(): boolean {
  try { return localStorage.getItem(KEY) === 'true'; } catch { return false; }
}

function subscribe(cb: () => void): () => void {
  window.addEventListener('storage', cb);
  return () => window.removeEventListener('storage', cb);
}

export function useExperimentalFeatures(): { experimentalFeatures: boolean; setExperimentalFeatures: (v: boolean) => void } {
  const experimentalFeatures = useSyncExternalStore(subscribe, read, () => false);

  const setExperimentalFeatures = useCallback((v: boolean) => {
    try {
      if (v) localStorage.setItem(KEY, 'true');
      else   localStorage.removeItem(KEY);
    } catch { /* ignore */ }
    // Trigger re-render in the same tab (storage event only fires in other tabs)
    window.dispatchEvent(new Event('storage'));
  }, []);

  return { experimentalFeatures, setExperimentalFeatures };
}
