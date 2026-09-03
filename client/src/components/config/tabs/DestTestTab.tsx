import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Plus, Send, Trash2, X } from 'lucide-react';
import type { SubaccountEntry } from '@/components/config/SubaccountsTable';

const enc = encodeURIComponent;

// ─── Shared DestProp type (kept local to avoid circular import) ───────────────

interface DestProp {
  key:         string;
  value:       string;
  isSensitive: boolean;
  revealed:    boolean;
}

// ─── TestTab types ────────────────────────────────────────────────────────────

interface TestHeader { key: string; value: string }

interface TestResult {
  ok:          true;
  status:      number;
  statusText:  string;
  durationMs:  number;
  headers:     TestHeader[];
  body:        string;
}
interface TestError {
  ok:     false;
  error:  string;
  detail: string;
  source: 'config' | 'auth' | 'connectivity' | 'network' | 'timeout';
}
type TestOutcome = TestResult | TestError;

// ─── RFC test types ───────────────────────────────────────────────────────────
interface RfcOutcome {
  ok: true;
  durationMs: number;
  output: Record<string, unknown>;
}
interface RfcError {
  ok: false;
  error: string;
  detail: string;
  source: string;
}
type RfcTestOutcome = RfcOutcome | RfcError;

const URI_HISTORY_KEY = 'btp:dest-test-uri-history';
const URI_SUGGESTIONS = [
  '/sap/bc/ui2/start_up?sap-statistics=true',
  '/sap/opu/odata/sap/ESH_SEARCH_SRV/Diagnosis?$format=json&sap-statistics=true',
  '/sap/opu/odata/sap/UI2/USER_MENU/MenuItems?$format=json',
];

const RFC_HISTORY_KEY = 'btp:dest-test-rfc-history';
const RFC_PARAMS_KEY  = 'btp:dest-test-rfc-params';
const RFC_SUGGESTIONS = ['BAPI_USER_GET_DETAIL', 'RFC_SYSTEM_INFO', 'RFC_PING'];
const RFC_SUGGESTION_DEFAULTS: Record<string, Array<{ key: string; value: string }>> = {
  'BAPI_USER_GET_DETAIL': [{ key: 'USERNAME', value: '' }],
};

function loadRfcParamHistory(): Record<string, Array<{ key: string; value: string }>> {
  try { return JSON.parse(localStorage.getItem(RFC_PARAMS_KEY) ?? '{}') as Record<string, Array<{ key: string; value: string }>>; }
  catch { return {}; }
}
function saveRfcParamHistory(h: Record<string, Array<{ key: string; value: string }>>): void {
  try { localStorage.setItem(RFC_PARAMS_KEY, JSON.stringify(h)); } catch { /* ignore */ }
}

function loadUriHistory(): string[] {
  try { return JSON.parse(localStorage.getItem(URI_HISTORY_KEY) ?? '[]') as string[]; }
  catch { return []; }
}

function saveUriHistory(history: string[]): void {
  try { localStorage.setItem(URI_HISTORY_KEY, JSON.stringify(history)); } catch { /* ignore */ }
}

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

interface TestTabProps {
  org:         SubaccountEntry;
  name:        string;
  instScope:   { spaceName: string; instanceGuid: string; instanceName: string } | null;
  editedProps: DestProp[];
}

export default function TestTab({ org, name, instScope, editedProps }: TestTabProps) {
  const isRfc = editedProps.some(p => p.key === 'Type' && p.value === 'RFC');

  const [method,      setMethod]      = useState<HttpMethod>('GET');
  const [url,         setUrl]         = useState('');
  const [reqHeaders,  setReqHeaders]  = useState<TestHeader[]>([{ key: '', value: '' }]);
  const [body,        setBody]        = useState('');
  const [isSending,   setIsSending]   = useState(false);
  const [result,      setResult]      = useState<TestOutcome | null>(null);
  const [formatJson,  setFormatJson]  = useState(false);
  const [uriHistory,  setUriHistory]  = useState<string[]>(loadUriHistory);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [vertSplit,   setVertSplit]   = useState(50);
  const [reqSplit,    setReqSplit]    = useState(45);
  const [respSplit,   setRespSplit]   = useState(45);

  // RFC-specific state
  const [rfcName,        setRfcName]        = useState('');
  const [rfcParams,      setRfcParams]      = useState<TestHeader[]>([{ key: '', value: '' }]);
  const [rfcResult,      setRfcResult]      = useState<RfcTestOutcome | null>(null);
  const [rfcHistory,     setRfcHistory]     = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem(RFC_HISTORY_KEY) ?? '[]') as string[]; } catch { return []; }
  });
  const [rfcParamHistory, setRfcParamHistory] = useState<Record<string, Array<{ key: string; value: string }>>>(loadRfcParamHistory);
  const [rfcHistoryOpen, setRfcHistoryOpen] = useState(false);

  const vertContainerRef  = useRef<HTMLDivElement>(null);
  const reqContainerRef   = useRef<HTMLDivElement>(null);
  const respContainerRef  = useRef<HTMLDivElement>(null);
  const uriDropdownRef    = useRef<HTMLDivElement>(null);
  const rfcDropdownRef    = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!historyOpen) return;
    function onDown(e: MouseEvent) {
      if (uriDropdownRef.current && !uriDropdownRef.current.contains(e.target as Node)) {
        setHistoryOpen(false);
      }
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [historyOpen]);

  useEffect(() => {
    if (!rfcHistoryOpen) return;
    function onDown(e: MouseEvent) {
      if (rfcDropdownRef.current && !rfcDropdownRef.current.contains(e.target as Node)) {
        setRfcHistoryOpen(false);
      }
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [rfcHistoryOpen]);

  function pickUri(u: string) { setUrl(u); setHistoryOpen(false); }
  function pickRfc(rfcN: string) {
    setRfcName(rfcN);
    setRfcHistoryOpen(false);
    const saved = rfcParamHistory[rfcN];
    if (saved !== undefined) {
      setRfcParams([...saved, { key: '', value: '' }]);
    } else if (RFC_SUGGESTION_DEFAULTS[rfcN]) {
      setRfcParams([...RFC_SUGGESTION_DEFAULTS[rfcN]!, { key: '', value: '' }]);
    } else {
      setRfcParams([{ key: '', value: '' }]);
    }
  }

  function clearHistory() {
    setUriHistory([]);
    saveUriHistory([]);
  }

  function clearRfcHistory() {
    setRfcHistory([]);
    setRfcParamHistory({});
    try {
      localStorage.setItem(RFC_HISTORY_KEY, '[]');
      localStorage.removeItem(RFC_PARAMS_KEY);
    } catch { /* ignore */ }
  }

  function addRfcParam()  { setRfcParams(p => [...p, { key: '', value: '' }]); }
  function updateRfcParam(i: number, patch: Partial<TestHeader>) {
    setRfcParams(p => p.map((r, j) => j === i ? { ...r, ...patch } : r));
  }
  function removeRfcParam(i: number) { setRfcParams(p => p.filter((_, j) => j !== i)); }

  const canFormatJson = !!(result?.ok && result.headers.some(
    h => h.key.toLowerCase() === 'content-type' && h.value.toLowerCase().includes('application/json'),
  ));

  function displayBody(): string {
    if (!result) return '';
    if (!result.ok) return `${result.error}\n\n${result.detail}\n\nSource: ${result.source}`;
    if (formatJson && canFormatJson) {
      try { return JSON.stringify(JSON.parse(result.body), null, 2); } catch { /* fall through */ }
    }
    return result.body;
  }

  function rfcDisplayBody(): string {
    if (!rfcResult) return '';
    if (!rfcResult.ok) return `${rfcResult.error}\n\n${rfcResult.detail}\n\nSource: ${rfcResult.source}`;
    try { return JSON.stringify(rfcResult.output, null, 2); } catch { return String(rfcResult.output); }
  }

  const btnBase    = 'inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
  const btnPrimary = `${btnBase} bg-primary text-primary-foreground hover:bg-primary/90`;
  const paneHdr    = 'px-3 py-1.5 text-[10px] font-semibold text-muted-foreground uppercase tracking-wide border-b border-border bg-muted/5 shrink-0 flex items-center';
  const colDrag    = 'w-1.5 bg-border hover:bg-primary/50 active:bg-primary/70 cursor-col-resize shrink-0 transition-colors select-none';
  const rowDrag    = 'h-1.5 bg-border hover:bg-primary/50 active:bg-primary/70 cursor-row-resize shrink-0 transition-colors select-none';

  function addHeader() { setReqHeaders(h => [...h, { key: '', value: '' }]); }
  function updateHeader(i: number, patch: Partial<TestHeader>) {
    setReqHeaders(h => h.map((r, j) => j === i ? { ...r, ...patch } : r));
  }
  function removeHeader(i: number) { setReqHeaders(h => h.filter((_, j) => j !== i)); }

  async function handleSend() {
    setIsSending(true);
    setResult(null);
    if (url.trim() && !URI_SUGGESTIONS.includes(url.trim())) {
      const next = [url.trim(), ...uriHistory.filter(u => u !== url.trim())].slice(0, 20);
      setUriHistory(next);
      saveUriHistory(next);
    }
    try {
      const apiUrl = instScope
        ? `/api/destinations/${enc(org.region)}/${enc(org.subdomain)}/spaces/${enc(instScope.spaceName)}/instances/${enc(instScope.instanceGuid)}/${enc(name)}/test`
        : `/api/destinations/${enc(org.region)}/${enc(org.subdomain)}/${enc(name)}/test`;
      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method, path: url, headers: reqHeaders.filter(h => h.key), body }),
      });
      setResult(await res.json() as TestOutcome);
    } catch (err) {
      setResult({ ok: false, error: 'Request failed', detail: err instanceof Error ? err.message : String(err), source: 'network' });
    } finally {
      setIsSending(false);
    }
  }

  async function handleRfcSend() {
    setIsSending(true);
    setRfcResult(null);
    const trimmedName = rfcName.trim();
    if (trimmedName) {
      if (!RFC_SUGGESTIONS.includes(trimmedName)) {
        const next = [trimmedName, ...rfcHistory.filter(u => u !== trimmedName)].slice(0, 20);
        setRfcHistory(next);
        try { localStorage.setItem(RFC_HISTORY_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      }
      const filledParams = rfcParams.filter(p => p.key);
      const nextParamHist = { ...rfcParamHistory, [trimmedName]: filledParams };
      setRfcParamHistory(nextParamHist);
      saveRfcParamHistory(nextParamHist);
    }
    try {
      const apiUrl = instScope
        ? `/api/destinations/${enc(org.region)}/${enc(org.subdomain)}/spaces/${enc(instScope.spaceName)}/instances/${enc(instScope.instanceGuid)}/${enc(name)}/test-rfc`
        : `/api/destinations/${enc(org.region)}/${enc(org.subdomain)}/${enc(name)}/test-rfc`;
      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rfcName: rfcName.trim(), importParams: rfcParams.filter(p => p.key) }),
      });
      setRfcResult(await res.json() as RfcTestOutcome);
    } catch (err) {
      setRfcResult({ ok: false, error: 'Request failed', detail: err instanceof Error ? err.message : String(err), source: 'network' });
    } finally {
      setIsSending(false);
    }
  }

  function startDrag(
    containerRef: React.RefObject<HTMLDivElement | null>,
    setSplit: React.Dispatch<React.SetStateAction<number>>,
    axis: 'x' | 'y',
  ) {
    return (e: React.MouseEvent) => {
      e.preventDefault();
      const container = containerRef.current;
      if (!container) return;
      const onMove = (ev: MouseEvent) => {
        const rect = container.getBoundingClientRect();
        const pct = axis === 'x'
          ? ((ev.clientX - rect.left)  / rect.width)  * 100
          : ((ev.clientY - rect.top)   / rect.height) * 100;
        setSplit(Math.min(78, Math.max(22, pct)));
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    };
  }

  return (
    <div className="flex flex-col h-full">
    {isRfc ? (
      <>
        {/* RFC function name bar */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border shrink-0">
          <div ref={rfcDropdownRef} className="relative flex-1">
            <div className="flex items-center h-8 border border-border rounded bg-background focus-within:ring-1 focus-within:ring-ring overflow-hidden">
              <input
                type="text"
                value={rfcName}
                onChange={e => setRfcName(e.target.value.toUpperCase())}
                onKeyDown={e => { if (e.key === 'Enter' && !isSending) void handleRfcSend(); }}
                placeholder="FUNCTION_MODULE_NAME"
                className="flex-1 h-full px-3 text-xs bg-transparent text-foreground outline-none font-mono placeholder:text-muted-foreground/50"
              />
              <button
                type="button"
                onClick={() => setRfcHistoryOpen(o => !o)}
                className="h-full px-2 text-muted-foreground/60 hover:text-foreground hover:bg-muted/30 transition-colors border-l border-border shrink-0"
                title="RFC name history"
              >
                <ChevronDown className={`h-3 w-3 transition-transform ${rfcHistoryOpen ? 'rotate-180' : ''}`} />
              </button>
            </div>
            {rfcHistoryOpen && (
              <div className="absolute left-0 right-0 top-full mt-0.5 z-50 bg-popover border border-border rounded shadow-lg overflow-hidden max-h-64 overflow-y-auto">
                {rfcHistory.length > 0 && (
                  <>
                    <div className="px-2.5 py-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-wide bg-muted/20">History</div>
                    {rfcHistory.map((u, i) => (
                      <button key={i} type="button" onClick={() => pickRfc(u)}
                        className="w-full text-left px-3 py-1.5 text-xs font-mono text-foreground hover:bg-muted/40 transition-colors truncate block" title={u}>
                        {u}
                      </button>
                    ))}
                    <div className="border-t border-border" />
                  </>
                )}
                <div className="px-2.5 py-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-wide bg-muted/20">Suggestions</div>
                {RFC_SUGGESTIONS.map((u, i) => (
                  <button key={i} type="button" onClick={() => pickRfc(u)}
                    className="w-full text-left px-3 py-1.5 text-xs font-mono text-foreground hover:bg-muted/40 transition-colors truncate block" title={u}>
                    {u}
                  </button>
                ))}
                {rfcHistory.length > 0 && (
                  <>
                    <div className="border-t border-border" />
                    <button type="button" onClick={clearRfcHistory}
                      className="w-full text-left px-3 py-1.5 text-xs text-muted-foreground hover:text-destructive hover:bg-muted/30 transition-colors flex items-center gap-1.5">
                      <Trash2 className="h-3 w-3 shrink-0" />
                      Clear history
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
          <button onClick={() => void handleRfcSend()} disabled={isSending} className={btnPrimary}>
            <Send className="h-3.5 w-3.5" />
            {isSending ? 'Sending…' : 'Send'}
          </button>
        </div>

        {/* RFC params + response */}
        <div ref={vertContainerRef} className="flex flex-col flex-1 min-h-0">
          <div style={{ height: `${vertSplit}%` }} className="flex flex-col min-h-0 overflow-hidden">
            <div className={paneHdr}>Input Parameters</div>
            <div className="flex-1 overflow-auto p-3 space-y-1.5">
              {rfcParams.map((p, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input value={p.key} onChange={e => updateRfcParam(i, { key: e.target.value.toUpperCase() })}
                    placeholder="PARAM_NAME"
                    className="w-40 h-7 px-2 text-xs border border-border rounded bg-background font-mono outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/40" />
                  <input value={p.value} onChange={e => updateRfcParam(i, { value: e.target.value })}
                    placeholder="Value"
                    className="flex-1 h-7 px-2 text-xs border border-border rounded bg-background font-mono outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/40" />
                  <button onClick={() => removeRfcParam(i)} className="text-muted-foreground/40 hover:text-destructive transition-colors shrink-0">
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
              <button onClick={addRfcParam} className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors mt-1">
                <Plus className="h-3.5 w-3.5" />
                Add parameter
              </button>
            </div>
          </div>

          <div onMouseDown={startDrag(vertContainerRef, setVertSplit, 'y')} className={rowDrag} />

          <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
            <div className={`${paneHdr} ${rfcResult && !rfcResult.ok ? 'text-destructive' : ''}`}>
              {rfcResult && !rfcResult.ok ? 'Error' : 'Response'}
              {rfcResult?.ok && (
                <span className="ml-auto text-[10px] font-mono text-muted-foreground normal-case tracking-normal font-normal">
                  {rfcResult.durationMs} ms
                </span>
              )}
            </div>
            <div className="flex-1 relative">
              {!rfcResult && !isSending && (
                <div className="flex items-center justify-center h-full text-xs text-muted-foreground/50">No response yet</div>
              )}
              {isSending && (
                <div className="flex items-center justify-center h-full text-xs text-muted-foreground">Sending…</div>
              )}
              {rfcResult && (
                <textarea readOnly value={rfcDisplayBody()}
                  className="absolute inset-0 w-full h-full p-3 text-xs font-mono bg-muted/5 outline-none resize-none text-foreground leading-relaxed" />
              )}
            </div>
          </div>
        </div>
      </>
    ) : (
      <>
        {/* URL bar */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border shrink-0">
          <select
            value={method}
            onChange={e => setMethod(e.target.value as HttpMethod)}
            className="h-8 px-2 text-xs border border-border rounded bg-background text-foreground outline-none focus:ring-1 focus:ring-ring font-mono"
          >
            {(['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] as HttpMethod[]).map(m => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>

          {/* URI input with history dropdown */}
          <div ref={uriDropdownRef} className="relative flex-1">
            <div className="flex items-center h-8 border border-border rounded bg-background focus-within:ring-1 focus-within:ring-ring overflow-hidden">
              <input
                type="text"
                value={url}
                onChange={e => setUrl(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !isSending) void handleSend(); }}
                placeholder="/api/v1/..."
                className="flex-1 h-full px-3 text-xs bg-transparent text-foreground outline-none font-mono placeholder:text-muted-foreground/50"
              />
              <button
                type="button"
                onClick={() => setHistoryOpen(o => !o)}
                className="h-full px-2 text-muted-foreground/60 hover:text-foreground hover:bg-muted/30 transition-colors border-l border-border shrink-0"
                title="URI history"
              >
                <ChevronDown className={`h-3 w-3 transition-transform ${historyOpen ? 'rotate-180' : ''}`} />
              </button>
            </div>

            {historyOpen && (
              <div className="absolute left-0 right-0 top-full mt-0.5 z-50 bg-popover border border-border rounded shadow-lg overflow-hidden max-h-64 overflow-y-auto">
                {uriHistory.length > 0 && (
                  <>
                    <div className="px-2.5 py-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-wide bg-muted/20">History</div>
                    {uriHistory.map((u, i) => (
                      <button key={i} type="button" onClick={() => pickUri(u)}
                        className="w-full text-left px-3 py-1.5 text-xs font-mono text-foreground hover:bg-muted/40 transition-colors truncate block" title={u}>
                        {u}
                      </button>
                    ))}
                    <div className="border-t border-border" />
                  </>
                )}
                <div className="px-2.5 py-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-wide bg-muted/20">Suggestions</div>
                {URI_SUGGESTIONS.map((u, i) => (
                  <button key={i} type="button" onClick={() => pickUri(u)}
                    className="w-full text-left px-3 py-1.5 text-xs font-mono text-foreground hover:bg-muted/40 transition-colors truncate block" title={u}>
                    {u}
                  </button>
                ))}
                {uriHistory.length > 0 && (
                  <>
                    <div className="border-t border-border" />
                    <button type="button" onClick={clearHistory}
                      className="w-full text-left px-3 py-1.5 text-xs text-muted-foreground hover:text-destructive hover:bg-muted/30 transition-colors flex items-center gap-1.5">
                      <Trash2 className="h-3 w-3 shrink-0" />
                      Clear history
                    </button>
                  </>
                )}
              </div>
            )}
          </div>

          <button onClick={() => void handleSend()} disabled={isSending} className={btnPrimary}>
            <Send className="h-3.5 w-3.5" />
            {isSending ? 'Sending…' : 'Send'}
          </button>
        </div>

        {/* Vertically adjustable Request / Response split */}
        <div ref={vertContainerRef} className="flex flex-col flex-1 min-h-0">

          {/* ── Request (top, vertSplit %) ── */}
          <div style={{ height: `${vertSplit}%` }} className="flex flex-col min-h-0 overflow-hidden">
            <div ref={reqContainerRef} className="flex flex-1 min-h-0">
              <div style={{ width: `${reqSplit}%` }} className="flex flex-col min-w-0">
                <div className={paneHdr}>Request Headers</div>
                <div className="flex-1 overflow-auto p-3 space-y-1.5">
                  {reqHeaders.map((h, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <input value={h.key} onChange={e => updateHeader(i, { key: e.target.value })} placeholder="Name"
                        className="w-36 h-7 px-2 text-xs border border-border rounded bg-background font-mono outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/40" />
                      <input value={h.value} onChange={e => updateHeader(i, { value: e.target.value })} placeholder="Value"
                        className="flex-1 h-7 px-2 text-xs border border-border rounded bg-background font-mono outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/40" />
                      <button onClick={() => removeHeader(i)} className="text-muted-foreground/40 hover:text-destructive transition-colors shrink-0">
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                  <button onClick={addHeader} className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors mt-1">
                    <Plus className="h-3.5 w-3.5" />
                    Add header
                  </button>
                </div>
              </div>

              <div onMouseDown={startDrag(reqContainerRef, setReqSplit, 'x')} className={colDrag} />

              <div className="flex flex-col flex-1 min-w-0">
                <div className={paneHdr}>Request Body</div>
                <textarea value={body} onChange={e => setBody(e.target.value)} placeholder='{"key": "value"}'
                  className="flex-1 p-3 text-xs font-mono bg-transparent outline-none resize-none placeholder:text-muted-foreground/40 text-foreground" />
              </div>
            </div>
          </div>

          {/* Vertical (row) drag handle between Request and Response */}
          <div onMouseDown={startDrag(vertContainerRef, setVertSplit, 'y')} className={rowDrag} />

          {/* ── Response (bottom, remaining space) ── */}
          <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
            <div ref={respContainerRef} className="flex flex-1 min-h-0">
              <div style={{ width: `${respSplit}%` }} className="flex flex-col min-w-0">
                <div className={paneHdr}>
                  Response Headers
                  {result?.ok && (
                    <div className="ml-auto flex items-center gap-2 normal-case tracking-normal font-normal">
                      <span className="text-[10px] font-mono text-muted-foreground">{result.durationMs} ms</span>
                      <span className={`text-[10px] font-mono font-semibold ${result.status < 300 ? 'text-green-600 dark:text-green-400' : result.status < 500 ? 'text-amber-600 dark:text-amber-400' : 'text-destructive'}`}>
                        [{result.status}] {result.statusText}
                      </span>
                    </div>
                  )}
                </div>
                <div className="flex-1 overflow-auto">
                  {result?.ok && (
                    <table className="w-full text-xs border-collapse">
                      <tbody>
                        {result.headers.map((h, i) => (
                          <tr key={i} className="hover:bg-muted/20">
                            <td className="px-3 py-1.5 border-b border-border font-mono text-muted-foreground whitespace-nowrap">{h.key}</td>
                            <td className="px-3 py-1.5 border-b border-border font-mono break-all">{h.value}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  {!result && !isSending && (
                    <div className="flex items-center justify-center h-full text-xs text-muted-foreground/50">No response yet</div>
                  )}
                  {isSending && (
                    <div className="flex items-center justify-center h-full text-xs text-muted-foreground">Sending…</div>
                  )}
                </div>
              </div>

              <div onMouseDown={startDrag(respContainerRef, setRespSplit, 'x')} className={colDrag} />

              <div className="flex flex-col flex-1 min-w-0">
                <div className={`${paneHdr} ${result && !result.ok ? 'text-destructive' : ''}`}>
                  {result && !result.ok ? 'Error' : 'Response Body'}
                  <label className={`ml-auto flex items-center gap-1.5 normal-case tracking-normal font-normal select-none ${canFormatJson ? 'cursor-pointer' : 'opacity-35 cursor-not-allowed'}`}>
                    <input type="checkbox" checked={formatJson} disabled={!canFormatJson}
                      onChange={e => setFormatJson(e.target.checked)} className="h-3 w-3 accent-primary" />
                    <span className="text-[10px]">Format JSON</span>
                  </label>
                </div>
                <textarea readOnly value={displayBody()} placeholder="Response will appear here"
                  className="flex-1 p-3 text-xs font-mono bg-muted/5 outline-none resize-none text-foreground leading-relaxed placeholder:text-muted-foreground/30" />
              </div>
            </div>
          </div>

        </div>
      </>
    )}
    </div>
  );
}
