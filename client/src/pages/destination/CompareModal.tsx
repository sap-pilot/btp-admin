import { useEffect, useRef, useState } from 'react';
import { Download, Eye, EyeOff, GitCompare, Lock, Plus, RotateCcw, Save, X } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import type { SelectedDest } from '@/components/config/tabs/DestTab';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ColData {
  data:            Record<string, string>;
  sensitiveFields: string[];
  loaded:          boolean;
  loadError?:      string;
}

type ProgressState =
  | { type: 'saving'; done: number; total: number }
  | { type: 'done';   saved: number; failed: number; errors: string[] };

// A pending new-property row: key being typed, per-column values
interface NewProp {
  id:     string; // stable react key
  key:    string;
  values: Map<string, string>; // colKey → value
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const FIELD_ORDER = ['Description', 'Type', 'URL', 'Authentication', 'User', 'Password', 'sap-client', 'ProxyType', 'ProxyHost', 'ProxyPort'];

function colKey(d: SelectedDest) {
  return d.spaceName
    ? `${d.region}/${d.subdomain}/${d.spaceName}/${d.instanceGuid}/${d.name}`
    : `${d.region}/${d.subdomain}/${d.name}`;
}

function destLoadUrl(d: SelectedDest) {
  return d.spaceName && d.instanceGuid
    ? `/api/destinations/${enc(d.region)}/${enc(d.subdomain)}/spaces/${enc(d.spaceName)}/instances/${enc(d.instanceGuid)}/${enc(d.name)}`
    : `/api/destinations/${enc(d.region)}/${enc(d.subdomain)}/${enc(d.name)}`;
}

function destSaveUrl(d: SelectedDest) {
  return d.spaceName && d.instanceGuid
    ? `/api/destinations/${enc(d.region)}/${enc(d.subdomain)}/spaces/${enc(d.spaceName)}/instances/${enc(d.instanceGuid)}/${enc(d.name)}`
    : `/api/destinations/${enc(d.region)}/${enc(d.subdomain)}/${enc(d.name)}`;
}

function destExportUrl(d: SelectedDest) {
  return d.spaceName && d.instanceGuid
    ? `/api/destinations/${enc(d.region)}/${enc(d.subdomain)}/spaces/${enc(d.spaceName)}/instances/${enc(d.instanceGuid)}/${enc(d.name)}/export`
    : `/api/destinations/${enc(d.region)}/${enc(d.subdomain)}/${enc(d.name)}/export`;
}
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

  const [colData,     setColData]     = useState<Map<string, ColData>>(new Map());
  const [colEdits,    setColEdits]    = useState<Map<string, Record<string, string>>>(new Map());
  const [colOrig,     setColOrig]     = useState<Map<string, Record<string, string>>>(new Map());
  const [colSaving,   setColSaving]   = useState<Map<string, boolean>>(new Map());
  const [revealed,    setRevealed]    = useState<Map<string, Set<string>>>(new Map());
  const [saveAllBusy,  setSaveAllBusy]  = useState(false);
  const [isExporting,  setIsExporting]  = useState(false);
  const [progress,     setProgress]     = useState<ProgressState | null>(null);
  const [newProps,    setNewProps]    = useState<NewProp[]>([]);

  const progressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    async function load() {
      const pairs = await Promise.all(
        selected.map(async d => {
          const k = colKey(d);
          try {
            const res  = await fetch(destLoadUrl(d));
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
      if (progressTimerRef.current) clearTimeout(progressTimerRef.current);
    };
  }, [onClose]);

  const allKeys   = sortKeys([...new Set([...colEdits.values()].flatMap(r => Object.keys(r)))]);
  const isLoading = selected.some(d => !colData.has(colKey(d)));
  const anyDirty  = selected.some(d => isDirty(d));

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

  function resetAll() {
    setColEdits(prev => {
      const next = new Map(prev);
      for (const d of selected) next.set(colKey(d), { ...(colOrig.get(colKey(d)) ?? {}) });
      return next;
    });
    setNewProps([]);
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

  // ── New-property row helpers ──────────────────────────────────────────────

  function addNewPropRow() {
    const values = new Map<string, string>();
    for (const d of selected) values.set(colKey(d), '');
    setNewProps(prev => [...prev, { id: `np-${Date.now()}`, key: '', values }]);
  }

  function updateNewPropKey(id: string, key: string) {
    setNewProps(prev => prev.map(p => p.id === id ? { ...p, key } : p));
  }

  function updateNewPropValue(id: string, ck: string, value: string) {
    setNewProps(prev => prev.map(p => {
      if (p.id !== id) return p;
      const values = new Map(p.values);
      values.set(ck, value);
      return { ...p, values };
    }));
  }

  // Commit a new-prop row: move key+values into colEdits, remove from newProps
  function commitNewProp(id: string) {
    const np = newProps.find(p => p.id === id);
    if (!np) return;
    const trimmedKey = np.key.trim();
    if (!trimmedKey || allKeys.includes(trimmedKey)) {
      // Empty key or duplicate — discard row
      setNewProps(prev => prev.filter(p => p.id !== id));
      return;
    }
    setColEdits(prev => {
      const next = new Map(prev);
      for (const d of selected) {
        const ck = colKey(d);
        const val = np.values.get(ck) ?? '';
        next.set(ck, { ...next.get(ck), [trimmedKey]: val });
      }
      return next;
    });
    setNewProps(prev => prev.filter(p => p.id !== id));
  }

  function removeNewProp(id: string) {
    setNewProps(prev => prev.filter(p => p.id !== id));
  }

  // ── Export helpers ───────────────────────────────────────────────────────

  async function exportAll() {
    setIsExporting(true);
    try {
      const all: Record<string, unknown>[] = [];
      for (const d of selected) {
        try {
          const res = await fetch(destExportUrl(d));
          if (res.ok) all.push(await res.json() as Record<string, unknown>);
        } catch { /* skip */ }
      }
      if (all.length === 0) return;
      const blob = new Blob([JSON.stringify(all.length === 1 ? all[0] : all, null, 2)], { type: 'application/json' });
      const href = URL.createObjectURL(blob);
      const a = Object.assign(document.createElement('a'), { href, download: 'compare_destinations.json' });
      document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(href);
    } finally { setIsExporting(false); }
  }

  // ── Save helpers ─────────────────────────────────────────────────────────

  async function saveCol(d: SelectedDest): Promise<boolean> {
    const k     = colKey(d);
    const edits = colEdits.get(k) ?? {};
    const data: Record<string, unknown> = { Name: d.name, ...edits };
    setColSaving(prev => new Map(prev).set(k, true));
    try {
      const res  = await fetch(destSaveUrl(d), {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ data, username }),
      });
      const json = await res.json() as { ok: boolean; error?: string };
      if (!json.ok) throw new Error(json.error ?? 'Save failed');
      setColOrig(prev => new Map(prev).set(k, { ...edits }));
      return true;
    } catch {
      return false;
    } finally {
      setColSaving(prev => { const next = new Map(prev); next.set(k, false); return next; });
    }
  }

  async function saveAll() {
    const toSave = selected.filter(d => isDirty(d));
    if (toSave.length === 0) return;
    if (progressTimerRef.current) clearTimeout(progressTimerRef.current);
    setSaveAllBusy(true);
    setProgress({ type: 'saving', done: 0, total: toSave.length });
    let saved = 0;
    const errors: string[] = [];
    for (let i = 0; i < toSave.length; i++) {
      const d = toSave[i]!;
      const label = d.spaceName
        ? `${d.region} → ${d.subdomain} → ${d.spaceName} → ${d.instanceName} → ${d.name}`
        : `${d.region} → ${d.subdomain} → ${d.name}`;
      setProgress({ type: 'saving', done: i + 1, total: toSave.length });
      const ok = await saveCol(d);
      if (ok) saved++;
      else errors.push(label);
    }
    setSaveAllBusy(false);
    setProgress({ type: 'done', saved, failed: errors.length, errors });
    if (errors.length === 0) {
      progressTimerRef.current = setTimeout(() => setProgress(null), 3000);
    }
  }

  // ── Style constants ───────────────────────────────────────────────────────

  const btnBase    = 'inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed';
  const btnOutline = `${btnBase} border border-border hover:bg-accent hover:text-accent-foreground`;
  const inputCls   = 'w-full bg-transparent outline-none border-b border-transparent hover:border-border focus:border-primary py-0.5 font-mono';

  const thCls  = 'px-3 py-2 text-xs font-medium text-left border-b border-r border-border bg-muted/30 sticky top-0 z-10';
  const tdCls  = 'px-3 py-1.5 text-xs border-b border-r border-border align-middle';
  const tdProp = `px-3 py-1.5 text-xs border-b border-r border-border align-middle sticky left-0 bg-background font-mono text-muted-foreground w-[180px] whitespace-nowrap z-[5]`;

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
          <div className="ml-auto flex items-center gap-1.5 shrink-0">
            <button
              onClick={() => void exportAll()}
              disabled={isLoading || isExporting}
              className={btnOutline}
              title="Export all compared destinations as JSON"
            >
              <Download className="h-3.5 w-3.5" />
              {isExporting ? 'Exporting…' : 'Export All'}
            </button>
            <button
              onClick={resetAll}
              disabled={!anyDirty || saveAllBusy}
              className={btnOutline}
              title="Reset all changed columns"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Reset All
            </button>
            <button
              onClick={() => void saveAll()}
              disabled={!anyDirty || saveAllBusy}
              className={`${btnBase} bg-primary text-primary-foreground hover:bg-primary/90`}
              title="Save all changed columns"
            >
              <Save className="h-3.5 w-3.5" />
              {saveAllBusy ? 'Saving…' : 'Save All'}
            </button>
            <button
              onClick={onClose}
              className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Progress bar (Save All / per-col save) */}
        {progress && (() => {
          const isDone    = progress.type === 'done';
          const hasErrors = isDone && progress.errors.length > 0;
          const pct       = isDone ? 100 : Math.round((progress.done / progress.total) * 100);
          const barColor  = hasErrors ? 'bg-amber-500' : isDone ? 'bg-green-500' : 'bg-primary';
          const bgColor   = hasErrors ? 'bg-amber-500/8' : isDone ? 'bg-green-500/8' : 'bg-muted/40';
          const textColor = hasErrors ? 'text-amber-600 dark:text-amber-400' : isDone ? 'text-green-600 dark:text-green-400' : 'text-muted-foreground';
          const msg = isDone
            ? (hasErrors
                ? `Saved ${progress.saved} of ${progress.saved + progress.errors.length} — ${progress.errors.length} failed`
                : `All ${progress.saved} destination${progress.saved !== 1 ? 's' : ''} saved successfully`)
            : `Saving ${progress.done} of ${progress.total}…`;
          return (
            <div className={`relative shrink-0 border-b border-border ${bgColor}`}>
              <div className="h-1 w-full bg-transparent">
                <div className={`h-full transition-all duration-300 ${barColor}`} style={{ width: `${pct}%` }} />
              </div>
              <div className={`px-4 py-1.5 text-xs text-center ${textColor} pr-8`}>{msg}</div>
              {hasErrors && progress.errors.map((e, i) => (
                <div key={i} className="px-4 pb-1 text-[11px] text-amber-600 dark:text-amber-400 text-center">{e}</div>
              ))}
              {isDone && (
                <button
                  onClick={() => { if (progressTimerRef.current) clearTimeout(progressTimerRef.current); setProgress(null); }}
                  className="absolute top-1 right-1 p-0.5 rounded text-muted-foreground/60 hover:text-foreground hover:bg-black/10 dark:hover:bg-white/10 transition-colors"
                  title="Dismiss"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          );
        })()}

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
                          {d.region} → {d.subdomain}{d.spaceName ? ` → ${d.spaceName} → ${d.instanceName}` : ''}
                        </span>
                        <span className="font-mono font-semibold text-foreground">{d.name}</span>
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {/* Existing property rows */}
                {allKeys.map(propKey => {
                  const diff         = isDiff(propKey);
                  const sensitiveAny = selected.some(d => colData.get(colKey(d))?.sensitiveFields.includes(propKey));
                  return (
                    <tr key={propKey} className={diff ? 'bg-amber-50/60 dark:bg-amber-950/20' : 'hover:bg-muted/10'}>
                      <td className={`${tdProp} ${diff ? 'text-amber-700 dark:text-amber-400 font-semibold' : ''}`}>
                        <div className="flex items-center gap-1.5">
                          {sensitiveAny && <Lock className="h-3 w-3 text-amber-500 shrink-0" />}
                          {propKey}
                        </div>
                      </td>
                      {selected.map(d => {
                        const k      = colKey(d);
                        const cd     = colData.get(k);
                        const isSens = cd?.sensitiveFields.includes(propKey) ?? false;
                        const isRev  = revealed.get(k)?.has(propKey) ?? false;
                        const val    = colEdits.get(k)?.[propKey] ?? '';
                        return (
                          <td key={k} className={`${tdCls} ${diff ? 'bg-amber-50/30 dark:bg-amber-950/10' : ''}`}>
                            {isSens ? (
                              <div className="flex items-center gap-1 min-w-0">
                                <input
                                  type={isRev ? 'text' : 'password'}
                                  value={val}
                                  onChange={e => updateEdit(d, propKey, e.target.value)}
                                  className={`flex-1 min-w-0 ${inputCls}`}
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
                                className={inputCls}
                              />
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}

                {/* Pending new-property rows */}
                {newProps.map(np => (
                  <tr
                    key={np.id}
                    className="bg-primary/5 hover:bg-primary/10"
                    onBlur={e => {
                      // Commit only when focus leaves the entire row (not just moves between cells)
                      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                        commitNewProp(np.id);
                      }
                    }}
                  >
                    <td className={`${tdProp} bg-primary/5`}>
                      <input
                        type="text"
                        value={np.key}
                        onChange={e => updateNewPropKey(np.id, e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') { e.preventDefault(); commitNewProp(np.id); }
                          if (e.key === 'Escape') { e.preventDefault(); removeNewProp(np.id); }
                        }}
                        placeholder="Property name…"
                        autoFocus
                        className="w-full bg-transparent outline-none border-b border-primary/50 focus:border-primary py-0.5 font-mono text-xs placeholder:text-muted-foreground/40"
                      />
                    </td>
                    {selected.map(d => {
                      const ck = colKey(d);
                      return (
                        <td key={ck} className={tdCls}>
                          <input
                            type="text"
                            value={np.values.get(ck) ?? ''}
                            onChange={e => updateNewPropValue(np.id, ck, e.target.value)}
                            onKeyDown={e => {
                              if (e.key === 'Enter') { e.preventDefault(); commitNewProp(np.id); }
                              if (e.key === 'Escape') { e.preventDefault(); removeNewProp(np.id); }
                            }}
                            className={inputCls}
                          />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="bg-muted/10">
                  <td className={`${tdProp} text-[10px] text-muted-foreground/40`}>
                    <button
                      onClick={addNewPropRow}
                      className={`${btnOutline} gap-1 text-[11px]`}
                      title="Add a new property to all destinations"
                    >
                      <Plus className="h-3 w-3" />
                      Add Property
                    </button>
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
                            disabled={!dirty || saving || saveAllBusy}
                            className={btnOutline}
                          >
                            <RotateCcw className="h-3 w-3" />
                            Reset
                          </button>
                          <button
                            onClick={() => {
                              void (async () => {
                                if (progressTimerRef.current) clearTimeout(progressTimerRef.current);
                                setProgress({ type: 'saving', done: 1, total: 1 });
                                const ok = await saveCol(d);
                                const label = d.spaceName
                                  ? `${d.region} → ${d.subdomain} → ${d.spaceName} → ${d.instanceName} → ${d.name}`
                                  : `${d.region} → ${d.subdomain} → ${d.name}`;
                                if (ok) {
                                  setProgress({ type: 'done', saved: 1, failed: 0, errors: [] });
                                  progressTimerRef.current = setTimeout(() => setProgress(null), 3000);
                                } else {
                                  setProgress({ type: 'done', saved: 0, failed: 1, errors: [label] });
                                }
                              })();
                            }}
                            disabled={!dirty || saving || saveAllBusy}
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
