import { useEffect, useRef, useState } from 'react';
import {
  Check, Download, Eye, EyeOff, GitCompare, Lock, PanelLeft, Plus, RefreshCw, RotateCcw, Save, Search, Send, Trash2, Upload, X,
} from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import type { SubaccountEntry } from '@/components/config/SubaccountsTable';

export interface SelectedDest {
  region:    string;
  subdomain: string;
  name:      string;
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface DestProp {
  key:         string;
  value:       string;
  isSensitive: boolean;
  revealed:    boolean;
}

interface DestSearchResult { name: string; matchField: string; matchValue: string }
type Tab        = 'properties' | 'changelog' | 'test';
type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

export interface SubaccountDestModalProps {
  org:               SubaccountEntry;
  allNames:          string[];
  initialName?:      string;
  onClose:           () => void;
  selectedDests?:    SelectedDest[];
  onToggleCompare?:  (d: SelectedDest) => void;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const REDACTED    = '***';
const FIELD_ORDER = ['Description', 'Type', 'URL', 'Authentication', 'User', 'Password', 'sap-client', 'ProxyType', 'ProxyHost', 'ProxyPort'];

const DEFAULT_CREATE_PROPS: DestProp[] = [
  { key: 'Description',    value: '', isSensitive: false, revealed: false },
  { key: 'Type',           value: '', isSensitive: false, revealed: false },
  { key: 'URL',            value: '', isSensitive: false, revealed: false },
  { key: 'Authentication', value: '', isSensitive: false, revealed: false },
  { key: 'User',           value: '', isSensitive: false, revealed: false },
  { key: 'Password',       value: '', isSensitive: true,  revealed: false },
];

function isSensitive(key: string): boolean {
  const k = key.toLowerCase();
  return k.includes('secret') || k.includes('password') || k.includes('credential');
}

function toProps(data: Record<string, unknown>, sensitiveFields: string[]): DestProp[] {
  const sensitiveSet = new Set(sensitiveFields);
  const entries = Object.entries(data).filter(([k]) => k !== 'Name');
  const ordered: [string, unknown][] = [];
  for (const k of FIELD_ORDER) {
    const e = entries.find(([key]) => key === k);
    if (e) ordered.push(e);
  }
  for (const e of entries) {
    if (!FIELD_ORDER.includes(e[0])) ordered.push(e);
  }
  return ordered.map(([key, value]) => ({
    key,
    value:       String(value ?? ''),
    isSensitive: sensitiveSet.has(key),
    revealed:    false,
  }));
}

function fromProps(name: string, props: DestProp[]): Record<string, unknown> {
  const result: Record<string, unknown> = { Name: name };
  for (const p of props) if (p.key.trim()) result[p.key.trim()] = p.value;
  return result;
}

// ─── Shared properties table ──────────────────────────────────────────────────

interface DestPropsTableProps {
  props:    DestProp[];
  onUpdate: (idx: number, patch: Partial<DestProp>) => void;
  onDelete: (idx: number) => void;
  onAdd:    () => void;
}

function DestPropsTable({ props, onUpdate, onDelete, onAdd }: DestPropsTableProps) {
  return (
    <div className="flex-1 overflow-auto px-4">
      <table className="w-full border-collapse text-xs" style={{ tableLayout: 'fixed' }}>
        <colgroup>
          <col style={{ width: '200px' }} />
          <col />
          <col style={{ width: '36px' }} />
        </colgroup>
        <thead className="sticky top-0 z-10">
          <tr className="bg-muted/40">
            <th className="px-3 py-2 text-left font-medium text-muted-foreground border-b border-border whitespace-nowrap">Property</th>
            <th className="px-3 py-2 text-left font-medium text-muted-foreground border-b border-border">Value</th>
            <th className="border-b border-border" />
          </tr>
        </thead>
        <tbody>
          {props.map((prop, idx) => (
            <tr key={idx} className="hover:bg-muted/20 group">
              <td className="px-3 py-1.5 border-b border-border align-middle">
                <div className="flex items-center gap-1.5">
                  {prop.isSensitive && <Lock className="h-3 w-3 text-amber-500 shrink-0" />}
                  <input
                    className="w-full bg-transparent outline-none border-b border-transparent hover:border-border focus:border-primary py-0.5 font-mono placeholder:text-muted-foreground/40"
                    value={prop.key}
                    onChange={e => {
                      const k = e.target.value;
                      onUpdate(idx, { key: k, isSensitive: isSensitive(k) });
                    }}
                    placeholder="property"
                  />
                </div>
              </td>
              <td className="px-3 py-1.5 border-b border-border align-middle">
                <div className="flex items-center gap-1">
                  {prop.isSensitive ? (
                    <>
                      <input
                        type={prop.revealed ? 'text' : 'password'}
                        className="flex-1 bg-transparent outline-none border-b border-transparent hover:border-border focus:border-primary py-0.5 font-mono placeholder:text-muted-foreground/40"
                        value={prop.value}
                        onChange={e => onUpdate(idx, { value: e.target.value })}
                        placeholder={REDACTED}
                      />
                      <button
                        onClick={() => onUpdate(idx, { revealed: !prop.revealed })}
                        className="shrink-0 text-muted-foreground hover:text-foreground p-0.5"
                        title={prop.revealed ? 'Hide' : 'Reveal'}
                      >
                        {prop.revealed ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                      </button>
                    </>
                  ) : (
                    <input
                      className="w-full bg-transparent outline-none border-b border-transparent hover:border-border focus:border-primary py-0.5 font-mono placeholder:text-muted-foreground/40"
                      value={prop.value}
                      onChange={e => onUpdate(idx, { value: e.target.value })}
                      placeholder="value"
                    />
                  )}
                </div>
              </td>
              <td className="px-1 py-1.5 border-b border-border align-middle text-center">
                <button
                  onClick={() => onDelete(idx)}
                  className="text-muted-foreground/40 hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity p-0.5"
                  title="Delete property"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="py-2">
        <button onClick={onAdd} className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors">
          <Plus className="h-3.5 w-3.5" />
          Add property
        </button>
      </div>
    </div>
  );
}

// ─── PropertiesTab ────────────────────────────────────────────────────────────

interface SaveBanner { type: 'success' | 'error'; message: string }

interface PropsTabProps {
  name:             string;
  props:            DestProp[];
  dirty:            boolean;
  saving:           boolean;
  importing:        boolean;
  loading:          boolean;
  banner:           SaveBanner | null;
  compareSelected?: boolean;
  onUpdate:         (idx: number, patch: Partial<DestProp>) => void;
  onDelete:         (idx: number) => void;
  onAdd:            () => void;
  onSave:           () => void;
  onReset:          () => void;
  onClearBanner:    () => void;
  onToggleCompare?: () => void;
}

function PropertiesTab({
  name, props, dirty, saving, importing, loading, banner, compareSelected,
  onUpdate, onDelete, onAdd, onSave, onReset, onClearBanner, onToggleCompare,
}: PropsTabProps) {
  const btnBase    = 'inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
  const btnOutline = `${btnBase} border border-border hover:bg-accent hover:text-accent-foreground`;
  const btnPrimary = `${btnBase} bg-primary text-primary-foreground hover:bg-primary/90`;

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar: name | Compare | Reset | Save */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border shrink-0">
        <h2 className="text-sm font-mono font-semibold text-foreground truncate min-w-0 flex-1">
          {name || <span className="font-normal text-xs text-muted-foreground">Select or create a destination</span>}
        </h2>
        <div className="flex items-center gap-1.5 shrink-0">
          {onToggleCompare && (
            <button
              onClick={onToggleCompare}
              disabled={!name}
              className={compareSelected
                ? `${btnBase} border border-primary bg-primary/10 text-primary`
                : btnOutline}
              title={compareSelected ? 'Remove from comparison basket' : 'Add to comparison basket'}
            >
              <GitCompare className="h-3.5 w-3.5" />
              {compareSelected ? 'In Compare' : 'Select for Compare'}
            </button>
          )}
          <button onClick={onReset} disabled={!dirty || saving || importing} className={btnOutline}>
            <RotateCcw className="h-3.5 w-3.5" />
            Reset
          </button>
          <button onClick={onSave} disabled={!name || !dirty || saving || importing} className={btnPrimary}>
            <Save className="h-3.5 w-3.5" />
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

      {banner && (
        <div className={`px-4 py-1.5 text-xs flex items-center gap-2 border-b shrink-0 ${
          banner.type === 'success'
            ? 'bg-green-500/10 border-green-500/20 text-green-600 dark:text-green-400'
            : 'bg-destructive/5 border-destructive/20 text-destructive'
        }`}>
          <span className="flex-1">{banner.message}</span>
          {banner.type === 'error' && (
            <button onClick={onClearBanner} className="shrink-0 text-destructive/60 hover:text-destructive">
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      )}

      {loading && (
        <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground">Loading…</div>
      )}
      {!loading && !name && (
        <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground">
          Select a destination from the list
        </div>
      )}
      {!loading && name && (
        <DestPropsTable props={props} onUpdate={onUpdate} onDelete={onDelete} onAdd={onAdd} />
      )}
    </div>
  );
}

// ─── CreateTab ────────────────────────────────────────────────────────────────

interface CreateTabProps {
  name:         string;
  props:        DestProp[];
  saving:       boolean;
  error:        string;
  onNameChange: (name: string) => void;
  onUpdate:     (idx: number, patch: Partial<DestProp>) => void;
  onDelete:     (idx: number) => void;
  onAdd:        () => void;
  onSave:       () => void;
  onCancel:     () => void;
}

function CreateTab({ name, props, saving, error, onNameChange, onUpdate, onDelete, onAdd, onSave, onCancel }: CreateTabProps) {
  const btnBase    = 'inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
  const btnOutline = `${btnBase} border border-border hover:bg-accent hover:text-accent-foreground`;
  const btnPrimary = `${btnBase} bg-primary text-primary-foreground hover:bg-primary/90`;

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar: name input | Cancel | Create Destination */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border shrink-0">
        <input
          autoFocus
          value={name}
          onChange={e => onNameChange(e.target.value)}
          placeholder="Destination name (e.g. API_S4_HTTP_001)"
          className="flex-1 min-w-0 text-sm font-mono bg-transparent border-b border-border focus:border-primary outline-none py-0.5 placeholder:text-muted-foreground/40"
        />
        <div className="flex items-center gap-1.5 shrink-0">
          <button onClick={onCancel} disabled={saving} className={btnOutline}>Cancel</button>
          <button onClick={onSave} disabled={!name.trim() || saving} className={btnPrimary}>
            <Plus className="h-3.5 w-3.5" />
            {saving ? 'Creating…' : 'Create Destination'}
          </button>
        </div>
      </div>

      {error && (
        <div className="px-4 py-1.5 text-xs text-destructive border-b border-destructive/20 bg-destructive/5 shrink-0">
          {error}
        </div>
      )}

      <DestPropsTable props={props} onUpdate={onUpdate} onDelete={onDelete} onAdd={onAdd} />
    </div>
  );
}

// ─── ChangelogTab ─────────────────────────────────────────────────────────────

function renderDestChangelog(text: string): React.ReactNode {
  return text.split('\n').map((line, i) => {
    if (line.startsWith('## ')) {
      return <div key={i} className="font-bold mt-4 mb-1 text-foreground first:mt-0">{line.slice(3)}</div>;
    }
    if (line.startsWith('- ')) {
      const body     = line.slice(2);
      const colonIdx = body.indexOf(': ');
      if (colonIdx !== -1) {
        const key      = body.slice(0, colonIdx);
        const rest     = body.slice(colonIdx + 2);
        const arrowIdx = rest.indexOf(' → ');
        if (arrowIdx !== -1) {
          return (
            <div key={i} className="pl-1">
              <span className="text-muted-foreground">- {key}: </span>
              <span className="text-red-500 dark:text-red-400">{rest.slice(0, arrowIdx)}</span>
              <span className="text-muted-foreground"> → </span>
              <span className="text-green-600 dark:text-green-400">{rest.slice(arrowIdx + 3)}</span>
            </div>
          );
        }
      }
      return <div key={i} className="text-muted-foreground pl-1">{line}</div>;
    }
    return <div key={i} className="text-muted-foreground">{line || ' '}</div>;
  });
}

function ChangelogTab({ changelog, loading }: { changelog: string; loading: boolean }) {
  if (loading) return <div className="flex items-center justify-center h-full text-xs text-muted-foreground">Loading…</div>;
  if (!changelog) return <div className="flex items-center justify-center h-full text-xs text-muted-foreground">No change history yet.</div>;
  return (
    <div className="h-full overflow-auto p-4">
      <div className="font-mono text-xs leading-relaxed">{renderDestChangelog(changelog)}</div>
    </div>
  );
}

// ─── TestTab ──────────────────────────────────────────────────────────────────

interface TestHeader { key: string; value: string }

const MOCK_RESP_HEADERS: TestHeader[] = [
  { key: 'Content-Type',     value: 'application/json; charset=utf-8' },
  { key: 'Content-Length',   value: '842' },
  { key: 'Cache-Control',    value: 'no-cache, no-store' },
  { key: 'X-Correlation-Id', value: 'a3f8d21c-4b2e-4f9d-b3c1-9e7f2a1b0d4e' },
  { key: 'Server',           value: 'destinations-service/1.0' },
];

const MOCK_RESP_BODY = JSON.stringify(
  [{ Name: 'API_S4_HTTP_001', Type: 'HTTP', URL: 'https://s4.example.com', Authentication: 'BasicAuthentication' }],
  null, 2,
);

function TestTab() {
  const [method,     setMethod]     = useState<HttpMethod>('GET');
  const [url,        setUrl]        = useState('');
  const [reqHeaders, setReqHeaders] = useState<TestHeader[]>([{ key: '', value: '' }]);
  const [body,       setBody]       = useState('');
  const [vertSplit,  setVertSplit]  = useState(50);
  const [reqSplit,   setReqSplit]   = useState(45);
  const [respSplit,  setRespSplit]  = useState(45);

  const vertContainerRef = useRef<HTMLDivElement>(null);
  const reqContainerRef  = useRef<HTMLDivElement>(null);
  const respContainerRef = useRef<HTMLDivElement>(null);

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

      {/* URL bar (always visible) */}
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
        <input
          type="text"
          value={url}
          onChange={e => setUrl(e.target.value)}
          placeholder="https://example.com/api/..."
          className="flex-1 h-8 px-3 text-xs border border-border rounded bg-background text-foreground outline-none focus:ring-1 focus:ring-ring font-mono placeholder:text-muted-foreground/50"
        />
        <button disabled title="Not implemented yet" className={btnPrimary}>
          <Send className="h-3.5 w-3.5" />
          Send
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
                    <input
                      value={h.key}
                      onChange={e => updateHeader(i, { key: e.target.value })}
                      placeholder="Name"
                      className="w-36 h-7 px-2 text-xs border border-border rounded bg-background font-mono outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/40"
                    />
                    <input
                      value={h.value}
                      onChange={e => updateHeader(i, { value: e.target.value })}
                      placeholder="Value"
                      className="flex-1 h-7 px-2 text-xs border border-border rounded bg-background font-mono outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/40"
                    />
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
              <textarea
                value={body}
                onChange={e => setBody(e.target.value)}
                placeholder='{"key": "value"}'
                className="flex-1 p-3 text-xs font-mono bg-transparent outline-none resize-none placeholder:text-muted-foreground/40 text-foreground"
              />
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
                <div className="ml-auto flex items-center gap-2 normal-case tracking-normal font-normal">
                  <span className="text-[10px] font-mono text-muted-foreground">2910 ms</span>
                  <span className="text-[10px] font-mono font-semibold text-green-600 dark:text-green-400">[200] OK</span>
                </div>
              </div>
              <div className="flex-1 overflow-auto">
                <table className="w-full text-xs border-collapse">
                  <tbody>
                    {MOCK_RESP_HEADERS.map(h => (
                      <tr key={h.key} className="hover:bg-muted/20">
                        <td className="px-3 py-1.5 border-b border-border font-mono text-muted-foreground whitespace-nowrap">{h.key}</td>
                        <td className="px-3 py-1.5 border-b border-border font-mono break-all">{h.value}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div onMouseDown={startDrag(respContainerRef, setRespSplit, 'x')} className={colDrag} />

            <div className="flex flex-col flex-1 min-w-0">
              <div className={paneHdr}>Response Body</div>
              <textarea
                readOnly
                value={MOCK_RESP_BODY}
                className="flex-1 p-3 text-xs font-mono bg-muted/5 outline-none resize-none text-foreground leading-relaxed"
              />
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}

// ─── Main modal ───────────────────────────────────────────────────────────────

export default function SubaccountDestModal({ org, allNames, initialName, onClose, selectedDests, onToggleCompare }: SubaccountDestModalProps) {
  const auth     = useAuth();
  const username = auth.email || auth.firstName || 'admin';

  // Left panel
  const [localAllNames, setLocalAllNames] = useState<string[]>(allNames);
  const [searchQuery,   setSearchQuery]   = useState('');
  const [filteredNames, setFilteredNames] = useState<string[]>(allNames);
  const [isSearching,   setIsSearching]   = useState(false);
  const [selectedName,  setSelectedName]  = useState(initialName ?? allNames[0] ?? '');
  const [selectedNames, setSelectedNames] = useState<Set<string>>(
    () => new Set(initialName ? [initialName] : allNames[0] ? [allNames[0]] : []),
  );
  const [lastClickName, setLastClickName] = useState(initialName ?? allNames[0] ?? '');

  // Right panel
  const [activeTab, setActiveTab] = useState<Tab>('properties');

  // Properties (existing destination)
  const [serverProps, setServerProps] = useState<DestProp[]>([]);
  const [editedProps, setEditedProps] = useState<DestProp[]>([]);
  const [isLoading,   setIsLoading]   = useState(false);
  const [isSaving,    setIsSaving]    = useState(false);
  const [isImporting, setIsImporting] = useState(false);

  // Left-panel visibility toggle
  const [showList, setShowList] = useState(true);

  // Create mode (new destination from scratch)
  const [isCreating,    setIsCreating]    = useState(false);
  const [newName,       setNewName]       = useState('');
  const [newProps,      setNewProps]      = useState<DestProp[]>(() => structuredClone(DEFAULT_CREATE_PROPS));
  const [isCreatingSave, setIsCreatingSave] = useState(false);
  const [createError,   setCreateError]   = useState('');

  // Changelog
  const [changelog,          setChangelog]          = useState('');
  const [isLoadingChangelog, setIsLoadingChangelog] = useState(false);

  // Per-subaccount refresh
  type RefreshStatus = 'idle' | 'refreshing' | 'refreshed';
  const [refreshStatus, setRefreshStatus] = useState<RefreshStatus>('idle');
  const [refreshError,  setRefreshError]  = useState('');
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Save banner
  const [saveBanner,     setSaveBanner]     = useState<SaveBanner | null>(null);
  const bannerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const searchTimer  = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const listRef      = useRef<HTMLDivElement>(null);
  const isDirty      = JSON.stringify(editedProps) !== JSON.stringify(serverProps);

  // Load destination on primary selection change
  useEffect(() => {
    if (!selectedName) return;
    
    void loadDest(selectedName);
    if (activeTab === 'changelog') void loadChangelog(selectedName);
  }, [selectedName]); // eslint-disable-line react-hooks/exhaustive-deps

  // Scroll selected item into view on mount (for deep-link / search-result opens)
  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>('[data-selected="true"]');
    el?.scrollIntoView({ block: 'nearest' });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Debounced search scoped to this subdomain
  useEffect(() => {
    clearTimeout(searchTimer.current);
    const q = searchQuery.trim();
    if (!q) { setFilteredNames(localAllNames); return; }
    setIsSearching(true);
    searchTimer.current = setTimeout(async () => {
      try {
        const url = `/api/destinations/search?q=${encodeURIComponent(q)}&region=${encodeURIComponent(org.region)}&subdomain=${encodeURIComponent(org.subdomain)}`;
        const res  = await fetch(url);
        const json = await res.json() as { ok: boolean; data: DestSearchResult[] };
        if (json.ok) {
          const matched = new Set(json.data.map(r => r.name));
          setFilteredNames(localAllNames.filter(n => matched.has(n)));
        }
      } catch { /* ignore */ } finally { setIsSearching(false); }
    }, 300);
    return () => clearTimeout(searchTimer.current);
  }, [searchQuery, localAllNames, org.region, org.subdomain]);

  // Sync browser URL with selected destination
  useEffect(() => {
    if (!selectedName) return;
    history.replaceState(
      null, '',
      `/destinations/${encodeURIComponent(org.region)}/${encodeURIComponent(org.subdomain)}/${encodeURIComponent(selectedName)}`,
    );
  }, [selectedName, org.region, org.subdomain]);

  // Proactive destination load on mount — refreshes from API if data is stale
  useEffect(() => {
    void (async () => {
      setRefreshStatus('refreshing');
      try {
        const res  = await fetch(`/api/destinations/${enc(org.region)}/${enc(org.subdomain)}`);
        const json = await res.json() as { ok: boolean; names: string[]; refreshed: boolean; errors: string[] };
        if (!json.ok) {
          setRefreshError((json.errors ?? []).join('; ') || 'Failed to load destinations');
          setRefreshStatus('idle');
          return;
        }
        if (json.names.length > 0) setLocalAllNames(json.names);
        if (json.refreshed) {
          setRefreshStatus('refreshed');
          refreshTimerRef.current = setTimeout(() => setRefreshStatus('idle'), 2000);
        } else {
          setRefreshStatus('idle');
        }
      } catch (err) {
        setRefreshError(String(err));
        setRefreshStatus('idle');
      }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Close on Escape; cleanup timers on unmount
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (bannerTimerRef.current)  clearTimeout(bannerTimerRef.current);
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    };
  }, [onClose]);

  async function loadDest(name: string) {
    setIsLoading(true);
    try {
      const res  = await fetch(`/api/destinations/${enc(org.region)}/${enc(org.subdomain)}/${enc(name)}`);
      const json = await res.json() as { ok: boolean; data: Record<string, unknown>; sensitiveFields: string[] };
      if (json.ok) {
        const props = toProps(json.data, json.sensitiveFields);
        setServerProps(props);
        setEditedProps(structuredClone(props));
      }
    } catch { /* ignore */ } finally { setIsLoading(false); }
  }

  async function loadChangelog(name: string) {
    setIsLoadingChangelog(true);
    try {
      const res  = await fetch(`/api/destinations/${enc(org.region)}/${enc(org.subdomain)}/${enc(name)}/changelog`);
      const json = await res.json() as { ok: boolean; data: string };
      if (json.ok) setChangelog(json.data);
    } catch { /* ignore */ } finally { setIsLoadingChangelog(false); }
  }

  function handleTabChange(tab: Tab) {
    setActiveTab(tab);
    if (tab === 'changelog' && selectedName) void loadChangelog(selectedName);
  }

  function selectDest(name: string) {
    setSelectedName(name);
    setSelectedNames(new Set([name]));
    setLastClickName(name);
    setChangelog('');
  }

  function handleDestClick(name: string, idx: number, e: React.MouseEvent) {
    if (e.ctrlKey || e.metaKey) {
      setSelectedNames(prev => {
        const next = new Set(prev);
        if (next.has(name)) next.delete(name); else next.add(name);
        return next;
      });
      setSelectedName(name);
      setLastClickName(name);
    } else if (e.shiftKey) {
      const anchorIdx = filteredNames.indexOf(lastClickName);
      const [a, b]   = anchorIdx <= idx
        ? [anchorIdx < 0 ? 0 : anchorIdx, idx]
        : [idx, anchorIdx];
      setSelectedNames(new Set(filteredNames.slice(a, b + 1)));
      setSelectedName(name);
    } else {
      selectDest(name);
    }
    setIsCreating(false);
    
  }

  async function handleSave() {
    if (!selectedName || !isDirty) return;
    setIsSaving(true); 
    if (bannerTimerRef.current) { clearTimeout(bannerTimerRef.current); bannerTimerRef.current = null; }
    setSaveBanner(null);
    try {
      const res  = await fetch(`/api/destinations/${enc(org.region)}/${enc(org.subdomain)}/${enc(selectedName)}`, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ data: fromProps(selectedName, editedProps), username }),
      });
      const json = await res.json() as { ok: boolean; error?: string };
      if (!json.ok) throw new Error(json.error ?? 'Save failed');
      await loadDest(selectedName);
      if (activeTab === 'changelog') await loadChangelog(selectedName);
      setSaveBanner({ type: 'success', message: `${org.region} → ${org.subdomain} → ${selectedName} saved` });
      bannerTimerRef.current = setTimeout(() => setSaveBanner(null), 3000);
    } catch (err) {
      setSaveBanner({ type: 'error', message: err instanceof Error ? err.message : 'Save failed' });
    } finally { setIsSaving(false); }
  }

  async function handleExport() {
    const toExport = selectedNames.size > 0 ? [...selectedNames] : selectedName ? [selectedName] : [];
    if (toExport.length === 0) return;

    if (toExport.length === 1) {
      window.open(`/api/destinations/${enc(org.region)}/${enc(org.subdomain)}/${enc(toExport[0]!)}/export`, '_blank');
      return;
    }

    const all: Record<string, unknown>[] = [];
    for (const name of [...toExport].sort()) {
      try {
        const res = await fetch(`/api/destinations/${enc(org.region)}/${enc(org.subdomain)}/${enc(name)}/export`);
        if (res.ok) all.push(await res.json() as Record<string, unknown>);
      } catch { /* skip */ }
    }
    const blob = new Blob([JSON.stringify(all, null, 2)], { type: 'application/json' });
    const href = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement('a'), {
      href, download: `${org.region}_${org.subdomain}_multi_destinations.json`,
    });
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(href);
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    setIsImporting(true); 
    try {
      const text   = await file.text();
      const parsed = JSON.parse(text) as Record<string, unknown> | Record<string, unknown>[];
      const items  = Array.isArray(parsed) ? parsed : [parsed];
      let lastName = '';
      for (const item of items) {
        const name = String(item['Name'] ?? '').trim();
        if (!name) continue;
        const res  = await fetch(`/api/destinations/${enc(org.region)}/${enc(org.subdomain)}/${enc(name)}`, {
          method:  'PUT',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ data: item, username }),
        });
        const json = await res.json() as { ok: boolean; error?: string };
        if (!json.ok) throw new Error(`Import failed for ${name}: ${json.error ?? 'unknown error'}`);
        setLocalAllNames(prev => [...new Set([...prev, name])].sort());
        lastName = name;
      }
      if (lastName) { selectDest(lastName); setActiveTab('properties'); setIsCreating(false); }
    } catch (err) {
      setSaveBanner({ type: 'error', message: err instanceof Error ? err.message : 'Import failed' });
    } finally { setIsImporting(false); }
  }

  async function handleCreateSave() {
    const name = newName.trim();
    if (!name) { setCreateError('Destination name is required'); return; }
    setIsCreatingSave(true); setCreateError('');
    try {
      const res  = await fetch(`/api/destinations/${enc(org.region)}/${enc(org.subdomain)}/${enc(name)}`, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ data: fromProps(name, newProps), username }),
      });
      const json = await res.json() as { ok: boolean; error?: string };
      if (!json.ok) throw new Error(json.error ?? 'Create failed');
      setLocalAllNames(prev => [...new Set([...prev, name])].sort());
      selectDest(name);
      setIsCreating(false);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Create failed');
    } finally { setIsCreatingSave(false); }
  }

  function handleCreateClick() {
    setIsCreating(true);
    setNewName('');
    setNewProps(structuredClone(DEFAULT_CREATE_PROPS));
    setCreateError('');
    setActiveTab('properties');
  }

  async function handleRefresh() {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    setRefreshStatus('refreshing');
    setRefreshError('');
    try {
      const res  = await fetch(`/api/destinations/${enc(org.region)}/${enc(org.subdomain)}?force=1`);
      const json = await res.json() as { ok: boolean; names: string[]; refreshed: boolean; errors: string[] };
      if (!res.ok || !json.ok) {
        setRefreshError((json.errors ?? []).join('; ') || `HTTP ${res.status}`);
        setRefreshStatus('idle');
        return;
      }
      if (json.names.length > 0) setLocalAllNames(json.names);
      if (selectedName) await loadDest(selectedName);
      if (activeTab === 'changelog' && selectedName) await loadChangelog(selectedName);
      setRefreshStatus('refreshed');
      refreshTimerRef.current = setTimeout(() => setRefreshStatus('idle'), 2000);
    } catch (err) {
      setRefreshError(String(err));
      setRefreshStatus('idle');
    }
  }

  const tabCls = (active: boolean) =>
    `px-4 py-2 text-xs transition-colors border-b-2 shrink-0 font-medium ${
      active ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'
    }`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-background border border-border rounded-lg shadow-xl flex flex-col w-full h-full max-w-[1800px] max-h-[calc(100vh-1.5rem)]">
        {/* Modal header */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border shrink-0">
          <span className="text-sm font-semibold min-w-0 flex items-center gap-1 truncate">
            <span className="text-muted-foreground font-normal">{org.region}</span>
            <span className="text-muted-foreground font-normal">›</span>
            <span>{org.alias || org.subaccountName}</span>
            <span className="text-muted-foreground font-normal text-xs font-mono">({org.subdomain})</span>
            {selectedName && !isCreating && (
              <>
                <span className="text-muted-foreground font-normal">›</span>
                <span>{selectedName}</span>
              </>
            )}
          </span>
          <div className="ml-auto flex items-center gap-1.5 shrink-0">
            {(() => {
              const btnBase    = 'inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
              const btnOutline = `${btnBase} border border-border hover:bg-accent hover:text-accent-foreground`;
              const exportCount = selectedNames.size;
              const exportLabel = exportCount > 1 ? `Export (${exportCount})` : 'Export';
              const exportTitle = exportCount > 1
                ? `Download ${exportCount} selected destinations as {region}_{subdomain}_multi_destinations.json`
                : 'Download destination JSON — Ctrl/⌘+click or Shift+click to select multiple for bulk export';
              return (
                <>
                  <button
                    onClick={handleCreateClick}
                    disabled={isSaving || isImporting}
                    className={btnOutline}
                    title="Create a new destination from scratch"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Create
                  </button>
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    disabled={isImporting || isSaving}
                    className={btnOutline}
                    title="Import single or multiple destinations into this subaccount. New destinations will be created, existing destinations will be updated."
                  >
                    <Upload className="h-3.5 w-3.5" />
                    {isImporting ? 'Importing…' : 'Import'}
                  </button>
                  <button
                    onClick={handleExport}
                    disabled={exportCount === 0 && !selectedName}
                    className={btnOutline}
                    title={exportTitle}
                  >
                    <Download className="h-3.5 w-3.5" />
                    {exportLabel}
                  </button>
                  <button
                    onClick={() => void handleRefresh()}
                    disabled={refreshStatus === 'refreshing' || isSaving || isImporting}
                    className={refreshStatus === 'refreshed'
                      ? `${btnBase} bg-green-500/10 border border-green-500/30 text-green-600 dark:text-green-400`
                      : btnOutline}
                    title="Force-refresh destinations from the Destination API"
                  >
                    {refreshStatus === 'refreshed'
                      ? <><Check className="h-3.5 w-3.5" /> Refreshed</>
                      : <><RefreshCw className={`h-3.5 w-3.5 ${refreshStatus === 'refreshing' ? 'animate-spin' : ''}`} /> {refreshStatus === 'refreshing' ? 'Refreshing…' : 'Refresh'}</>
                    }
                  </button>
                  <div className="w-px h-4 bg-border mx-0.5" />
                </>
              );
            })()}
            <button onClick={onClose} className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors">
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Refresh error banner */}
        {refreshError && (
          <div className="px-4 py-2 bg-destructive/5 border-b border-destructive/20 text-destructive text-xs flex items-center gap-2 shrink-0">
            <span className="flex-1">{refreshError}</span>
            <button onClick={() => setRefreshError('')} className="shrink-0 p-0.5 rounded hover:bg-destructive/10 transition-colors">
              <X className="h-3 w-3" />
            </button>
          </div>
        )}

        {/* Body */}
        <div className="flex flex-1 min-h-0">
          {/* Left panel: destination list */}
          {showList && <div className="w-60 border-r border-border flex flex-col shrink-0">
            <div className="px-2 py-2 border-b border-border">
              <div className="relative">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  placeholder="Search destinations…"
                  className="w-full h-7 pl-7 pr-2 text-xs border border-border rounded bg-background focus:outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                />
              </div>
            </div>
            <div ref={listRef} className="flex-1 overflow-auto py-1">
              {filteredNames.length === 0 ? (
                <div className="px-3 py-4 text-xs text-muted-foreground text-center">
                  {isSearching ? 'Searching…' : 'No destinations found'}
                </div>
              ) : filteredNames.map((name, idx) => {
                const isPrimary  = name === selectedName && !isCreating;
                const isSelected = selectedNames.has(name) && !isCreating;
                return (
                  <button
                    key={name}
                    data-selected={isPrimary ? 'true' : undefined}
                    onClick={e => handleDestClick(name, idx, e)}
                    title={isSelected && !isPrimary ? `${name} — selected for export` : name}
                    className={`w-full text-left px-3 py-1.5 text-xs font-mono truncate transition-colors select-none ${
                      isPrimary  ? 'bg-primary/20 text-primary font-semibold' :
                      isSelected ? 'bg-primary/10 text-primary' :
                                   'text-foreground hover:bg-muted/40'
                    }`}
                  >
                    {name}
                  </button>
                );
              })}
            </div>
            {!isCreating && selectedNames.size > 1 && (
              <div className="px-3 py-1.5 border-t border-border text-[10px] text-muted-foreground shrink-0">
                {selectedNames.size} selected · Ctrl/Shift+click to select
              </div>
            )}
          </div>}

          {/* Right panel */}
          <div className="flex-1 flex flex-col min-w-0">
            <div className="flex items-center border-b border-border shrink-0 px-2">
              <button
                onClick={() => setShowList(v => !v)}
                className={`p-1.5 mr-1 rounded transition-colors ${showList ? 'text-muted-foreground hover:text-foreground hover:bg-accent' : 'bg-accent text-foreground'}`}
                title={showList ? 'Hide destination list' : 'Show destination list'}
              >
                <PanelLeft className="h-3.5 w-3.5" />
              </button>
              <button className={tabCls(activeTab === 'properties')} onClick={() => handleTabChange('properties')}>
                {isCreating ? 'New Destination' : 'Properties'}
              </button>
              <button className={tabCls(activeTab === 'changelog')} onClick={() => { setIsCreating(false); handleTabChange('changelog'); }}>Change History</button>
              <button className={tabCls(activeTab === 'test')}      onClick={() => { setIsCreating(false); handleTabChange('test'); }}>Test Destination</button>
            </div>

            <div className="flex-1 min-h-0 overflow-hidden">
              {activeTab === 'properties' && isCreating && (
                <CreateTab
                  name={newName}
                  props={newProps}
                  saving={isCreatingSave}
                  error={createError}
                  onNameChange={setNewName}
                  onUpdate={(idx, patch) => setNewProps(prev => prev.map((p, i) => i === idx ? { ...p, ...patch } : p))}
                  onDelete={idx => setNewProps(prev => prev.filter((_, i) => i !== idx))}
                  onAdd={() => setNewProps(prev => [...prev, { key: '', value: '', isSensitive: false, revealed: false }])}
                  onSave={handleCreateSave}
                  onCancel={() => setIsCreating(false)}
                />
              )}
              {activeTab === 'properties' && !isCreating && (
                <PropertiesTab
                  name={selectedName}
                  props={editedProps}
                  dirty={isDirty}
                  saving={isSaving}
                  importing={isImporting}
                  loading={isLoading}
                  banner={saveBanner}
                  compareSelected={selectedDests?.some(
                    d => d.region === org.region && d.subdomain === org.subdomain && d.name === selectedName,
                  )}
                  onUpdate={(idx, patch) => setEditedProps(prev => prev.map((p, i) => i === idx ? { ...p, ...patch } : p))}
                  onDelete={idx => setEditedProps(prev => prev.filter((_, i) => i !== idx))}
                  onAdd={() => setEditedProps(prev => [...prev, { key: '', value: '', isSensitive: false, revealed: false }])}
                  onSave={handleSave}
                  onReset={() => { setEditedProps(structuredClone(serverProps)); setSaveBanner(null); }}
                  onClearBanner={() => setSaveBanner(null)}
                  onToggleCompare={onToggleCompare
                    ? () => onToggleCompare({ region: org.region, subdomain: org.subdomain, name: selectedName })
                    : undefined}
                />
              )}
              {activeTab === 'changelog' && (
                <ChangelogTab changelog={changelog} loading={isLoadingChangelog} />
              )}
              {activeTab === 'test' && <TestTab />}
            </div>
          </div>
        </div>

        {/* Hidden file input for Import */}
        <input
          ref={fileInputRef}
          type="file"
          accept=".json"
          className="hidden"
          onChange={handleFileChange}
        />
      </div>
    </div>
  );
}

function enc(s: string) { return encodeURIComponent(s); }
