import { useEffect, useRef, useState } from 'react';
import { Eye, EyeOff, GitCompare, Lock, RotateCcw, Save, X } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import type { SelectedDest } from './SubaccountDestModal';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ColData {
  data:            Record<string, string>;
  sensitiveFields: string[];
  loaded:          boolean;
  loadError?:      string;
}

interface Banner {
  id:      string;
  type:    'success' | 'error';
  message: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const FIELD_ORDER = ['Description', 'Type', 'URL', 'Authentication', 'User', 'Password', 'sap-client', 'ProxyType', 'ProxyHost', 'ProxyPort'];

function colKey(d: SelectedDest) { return `${d.region}/${d.subdomain}/${d.name}`; }
function enc(s: string) { return encodeURIComponent(s); }

function sortKeys(keys: string[]): string[] {
  const ordered: string[] = [];
  for (const k of FIELD_ORDER) { if (keys.includes(k)) ordered.push(k); }
  for (const k of [...keys].sort()) { if (!FIELD_ORDER.includes(k)) ordered.push(k); }
  return ordered;
}

// ─── Component ────────────────────────────────────────────────────────────────

interface Props {
  selected: SelectedDest[];
  onClose:  () => void;
}

export default function CompareModal({ selected, onClose }: Props) {
  const auth     = useAuth();
  const username = auth.email || auth.firstName || 'admin';

  const [colData,   setColData]   = useState<Map<string, ColData>>(new Map());
  const [colEdits,  setColEdits]  = useState<Map<string, Record<string, string>>>(new Map());
  const [colOrig,   setColOrig]   = useState<Map<string, Record<string, string>>>(new Map());
  const [colSaving, setColSaving] = useState<Map<string, boolean>>(new Map());
  const [revealed,  setRevealed]  = useState<Map<string, Set<string>>>(new Map());
  const [banners,   setBanners]   = useState<Banner[]>([]);

  const bannerTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    async function load() {
      const pairs = await Promise.all(
        selected.map(async d => {
          const k = colKey(d);
          try {
            const res  = await fetch(`/api/destinations/${enc(d.region)}/${enc(d.subdomain)}/${enc(d.name)}`);
            const json = await res.json() as { ok: boolean; data: Record<string, unknown>; sensitiveFields: string[] };
            if (!json.ok) return { k, cd: { data: {}, sensitiveFields: [], loaded: false, loadError: 'Load failed' } as ColData };
            const data: Record<string, string> = {};
            for (const [key, val] of Object.entries(json.data)) {
              if (key !== 'Name') data[key] = String(val ?? '');
            }
            return { k, cd: { data, sensitiveFields: json.sensitiveFields, loaded: true } as ColData };
          } catch {
            return { k, cd: { data: {}, sensitiveFields: [], loaded: false, loadError: 'Network error' } as ColData };
          }
        }),
      );
      const newData  = new Map<string, ColData>();
      const newEdits = new Map<string, Record<string, string>>();
      const newOrig  = new Map<string, Record<string, string>>();
      for (const { k, cd } of pairs) {
        newData.set(k, cd);
        newEdits.set(k, { ...cd.data });
        newOrig.set(k, { ...cd.data });
      }
      setColData(newData);
      setColEdits(newEdits);
      setColOrig(newOrig);
    }
    void load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      for (const t of bannerTimers.current.values()) clearTimeout(t);
    };
  }, [onClose]);

  const allKeys = sortKeys([...new Set([...colData.values()].flatMap(cd => Object.keys(cd.data)))]);
  const isLoading = selected.some(d => !colData.has(colKey(d)));

  function isDiff(propKey: string): boolean {
    const vals = selected.map(d => colEdits.get(colKey(d))?.[propKey] ?? '');
    return new Set(vals).size > 1;
  }

  function isDirty(d: SelectedDest): boolean {
    const k = colKey(d);
    return JSON.stringify(colEdits.get(k)) !== JSON.stringify(colOrig.get(k));
  }

  function updateEdit(d: SelectedDest, propKey: string, value: string) {
    const k = colKey(d);
    setColEdits(prev => { const next = new Map(prev); next.set(k, { ...next.get(k), [propKey]: value }); return next; });
  }

  function resetCol(d: SelectedDest) {
    const k = colKey(d);
    setColEdits(prev => { const next = new Map(prev); next.set(k, { ...(colOrig.get(k) ?? {}) }); return next; });
  }

  function toggleReveal(d: SelectedDest, propKey: string) {
    const k = colKey(d);
    setRevealed(prev => {
      const next = new Map(prev);
      const curr = new Set(next.get(k) ?? []);
      if (curr.has(propKey)) curr.delete(propKey); else curr.add(propKey);
      next.set(k, curr);
      return next;
    });
  }

  function addBanner(type: 'success' | 'error', message: string) {
    const id = `${Date.now()}-${Math.random()}`;
    setBanners(prev => [...prev, { id, type, message }]);
    if (type === 'success') {
      const t = setTimeout(() => setBanners(prev => prev.filter(b => b.id !== id)), 3000);
      bannerTimers.current.set(id, t);
    }
  }

  function removeBanner(id: string) {
    clearTimeout(bannerTimers.current.get(id));
    bannerTimers.current.delete(id);
    setBanners(prev => prev.filter(b => b.id !== id));
  }

  async function saveCol(d: SelectedDest) {
    const k     = colKey(d);
    const edits = colEdits.get(k) ?? {};
    const data: Record<string, unknown> = { Name: d.name, ...edits };
    setColSaving(prev => new Map(prev).set(k, true));
    try {
      const res  = await fetch(`/api/destinations/${enc(d.region)}/${enc(d.subdomain)}/${enc(d.name)}`, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ data, username }),
      });
      const json = await res.json() as { ok: boolean; error?: string };
      if (!json.ok) throw new Error(json.error ?? 'Save failed');
      setColOrig(prev => new Map(prev).set(k, { ...edits }));
      addBanner('success', `${d.region} → ${d.subdomain} → ${d.name} saved`);
    } catch (err) {
      addBanner('error', `${d.region} → ${d.subdomain} → ${d.name}: ${err instanceof Error ? err.message : 'Save failed'}`);
    } finally {
      setColSaving(prev => { const next = new Map(prev); next.set(k, false); return next; });
    }
  }

  const thCls  = 'px-3 py-2 text-xs font-medium text-left border-b border-r border-border bg-muted/30 sticky top-0 z-10';
  const tdCls  = 'px-3 py-1.5 text-xs border-b border-r border-border align-middle';
  const tdProp = `px-3 py-1.5 text-xs border-b border-r border-border align-middle sticky left-0 bg-background font-mono text-muted-foreground w-[180px] whitespace-nowrap z-[5]`;
  const btnBase = 'inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed';

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-3"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-background border border-border rounded-lg shadow-xl flex flex-col w-full h-full max-w-[min(95vw,1600px)] max-h-[calc(100vh-1.5rem)]">

        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border shrink-0">
          <GitCompare className="h-4 w-4 text-muted-foreground shrink-0" />
          <span className="text-sm font-semibold">Compare Destinations</span>
          <span className="text-xs text-muted-foreground">({selected.length})</span>
          <button
            onClick={onClose}
            className="ml-auto p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors shrink-0"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Banners */}
        {banners.map(b => (
          <div
            key={b.id}
            className={`px-4 py-1.5 text-xs flex items-center gap-2 border-b shrink-0 ${
              b.type === 'success'
                ? 'bg-green-500/10 border-green-500/20 text-green-600 dark:text-green-400'
                : 'bg-destructive/5 border-destructive/20 text-destructive'
            }`}
          >
            <span className="flex-1">{b.message}</span>
            {b.type === 'error' && (
              <button onClick={() => removeBanner(b.id)} className="shrink-0 text-destructive/60 hover:text-destructive">
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
        ))}

        {/* Loading */}
        {isLoading && (
          <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
            Loading destinations…
          </div>
        )}

        {/* Table */}
        {!isLoading && (
          <div className="flex-1 overflow-auto min-h-0">
            <table className="w-full border-collapse text-xs" style={{ tableLayout: 'fixed' }}>
              <colgroup>
                <col style={{ width: '180px' }} />
                {selected.map(d => <col key={colKey(d)} />)}
              </colgroup>
              <thead>
                <tr>
                  <th className={`${thCls} sticky left-0 z-20`}>Property</th>
                  {selected.map(d => (
                    <th key={colKey(d)} className={thCls}>
                      <div className="flex flex-col gap-0.5">
                        <span className="font-mono text-[10px] text-muted-foreground/70 font-normal">
                          {d.region} → {d.subdomain}
                        </span>
                        <span className="font-mono font-semibold text-foreground">{d.name}</span>
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {allKeys.map(propKey => {
                  const diff          = isDiff(propKey);
                  const sensitiveAny  = selected.some(d => colData.get(colKey(d))?.sensitiveFields.includes(propKey));
                  return (
                    <tr key={propKey} className={diff ? 'bg-amber-50/60 dark:bg-amber-950/20' : 'hover:bg-muted/10'}>
                      <td className={`${tdProp} ${diff ? 'text-amber-700 dark:text-amber-400 font-semibold' : ''}`}>
                        <div className="flex items-center gap-1.5">
                          {sensitiveAny && <Lock className="h-3 w-3 text-amber-500 shrink-0" />}
                          {propKey}
                        </div>
                      </td>
                      {selected.map(d => {
                        const k       = colKey(d);
                        const cd      = colData.get(k);
                        const isSens  = cd?.sensitiveFields.includes(propKey) ?? false;
                        const isRev   = revealed.get(k)?.has(propKey) ?? false;
                        const val     = colEdits.get(k)?.[propKey] ?? '';
                        return (
                          <td key={k} className={`${tdCls} ${diff ? 'bg-amber-50/30 dark:bg-amber-950/10' : ''}`}>
                            {isSens ? (
                              <div className="flex items-center gap-1 min-w-0">
                                <input
                                  type={isRev ? 'text' : 'password'}
                                  value={val}
                                  onChange={e => updateEdit(d, propKey, e.target.value)}
                                  className="flex-1 min-w-0 bg-transparent outline-none border-b border-transparent hover:border-border focus:border-primary py-0.5 font-mono"
                                />
                                <button
                                  onClick={() => toggleReveal(d, propKey)}
                                  className="shrink-0 text-muted-foreground hover:text-foreground p-0.5"
                                  title={isRev ? 'Hide' : 'Reveal'}
                                >
                                  {isRev ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                                </button>
                              </div>
                            ) : (
                              <input
                                type="text"
                                value={val}
                                onChange={e => updateEdit(d, propKey, e.target.value)}
                                className="w-full bg-transparent outline-none border-b border-transparent hover:border-border focus:border-primary py-0.5 font-mono"
                              />
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="bg-muted/10">
                  <td className={`${tdProp} text-[10px] text-muted-foreground/40`}>
                    {allKeys.length} properties
                  </td>
                  {selected.map(d => {
                    const k      = colKey(d);
                    const dirty  = isDirty(d);
                    const saving = colSaving.get(k) ?? false;
                    return (
                      <td key={k} className={tdCls}>
                        <div className="flex items-center gap-1.5 py-0.5">
                          <button
                            onClick={() => resetCol(d)}
                            disabled={!dirty || saving}
                            className={`${btnBase} border border-border hover:bg-accent hover:text-accent-foreground`}
                          >
                            <RotateCcw className="h-3 w-3" />
                            Reset
                          </button>
                          <button
                            onClick={() => void saveCol(d)}
                            disabled={!dirty || saving}
                            className={`${btnBase} bg-primary text-primary-foreground hover:bg-primary/90`}
                          >
                            <Save className="h-3 w-3" />
                            {saving ? 'Saving…' : 'Save'}
                          </button>
                        </div>
                      </td>
                    );
                  })}
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
