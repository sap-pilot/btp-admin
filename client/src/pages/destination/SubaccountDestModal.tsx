import { useEffect, useRef, useState } from 'react';
import {
  ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, CheckSquare, Download, Eye, EyeOff, GitCompare, Lock, Maximize2, Minimize2, PanelLeft, Plus, RefreshCw, RotateCcw, Save, Search, Send, Square, Trash2, Upload, X,
} from 'lucide-react';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
  DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/useAuth';
import { useSettings } from '@/components/AppLayout';
import type { SubaccountEntry, SpaceEntry } from '@/components/config/SubaccountsTable';
import type { CockpitMenuItem } from '@/components/home/HomepageContent';

export interface SelectedDest {
  region:        string;
  subdomain:     string;
  name:          string;
  spaceName?:    string;
  instanceName?: string;
  instanceGuid?: string;
}

// ─── Cockpit URL helpers ──────────────────────────────────────────────────────

function deriveCockpitRegion(region: string): string {
  if (region.startsWith('us')) return 'amer';
  if (region.startsWith('eu')) return region.split('-')[0]!;
  if (region.startsWith('ap')) return 'ap21';
  if (region.startsWith('br')) return 'br10';
  if (region.startsWith('jp')) return 'jp10';
  if (region.startsWith('ca')) return 'ca10';
  if (region.startsWith('au')) return 'ap10';
  return region;
}
function stripProtocol(h: string): string { return h.replace(/^https?:\/\//i, ''); }
function resolve(tpl: string, ctx: Record<string, string>): string {
  return tpl.replace(/\{([^}]+)\}/g, (_, k: string) => ctx[k] ?? '');
}
function cleanUrl(url: string): string {
  const hi = url.indexOf('#');
  const before = hi >= 0 ? url.slice(0, hi) : url;
  const after  = hi >= 0 ? url.slice(hi) : '';
  const qi = before.indexOf('?');
  if (qi < 0) return url;
  const base   = before.slice(0, qi);
  const params = before.slice(qi + 1).split('&').filter(p => { const eq = p.indexOf('='); return eq < 0 || p.slice(eq + 1) !== ''; });
  return base + (params.length ? '?' + params.join('&') : '') + after;
}
function resolveUrl(tpl: string, ctx: Record<string, string>): string { return cleanUrl(resolve(tpl, ctx)); }
function buildCockpitCtx(sa: SubaccountEntry, cockpit: { idp: string; host: string }): Record<string, string> {
  return {
    'homepage.cockpit.host': cockpit.host ? stripProtocol(cockpit.host) : '',
    'homepage.cockpit.idp':  cockpit.idp,
    cockpitRegion:           deriveCockpitRegion(sa.region),
    globalAccountGUID:       sa.globalAccountGUID,
    subaccountId:            sa.subaccountId,
    orgId:                   sa.org?.orgId ?? '',
    subdomain:               sa.subdomain,
  };
}
function renderMenuItems(items: CockpitMenuItem[], ctx: Record<string, string>, spaces: SpaceEntry[]): React.ReactNode[] {
  return items.flatMap((item, i) => {
    if (item.name === '-') return [<DropdownMenuSeparator key={`sep-${i}`} />];
    if (item.repeatOn === 'spaces') {
      return spaces.flatMap(sp => {
        const spCtx = { ...ctx, spaceId: sp.spaceId, spaceName: sp.spaceName };
        const name  = resolve(item.name, spCtx);
        const url   = item.url ? resolveUrl(item.url, spCtx) : undefined;
        if (item.submenus?.length) {
          return [(<DropdownMenuSub key={sp.spaceId}>
            <DropdownMenuSubTrigger className="text-xs">{name}</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {url && <><DropdownMenuItem className="text-xs cursor-pointer" asChild><a href={url} target="_blank" rel="noopener noreferrer">{name}</a></DropdownMenuItem><DropdownMenuSeparator /></>}
              {renderMenuItems(item.submenus, spCtx, spaces)}
            </DropdownMenuSubContent>
          </DropdownMenuSub>)];
        }
        return url ? [<DropdownMenuItem key={sp.spaceId} className="text-xs cursor-pointer" asChild><a href={url} target="_blank" rel="noopener noreferrer">{name}</a></DropdownMenuItem>] : [];
      });
    }
    const name = resolve(item.name, ctx);
    const url  = item.url ? resolveUrl(item.url, ctx) : undefined;
    if (item.submenus?.length) {
      return [(<DropdownMenuSub key={i}>
        <DropdownMenuSubTrigger className="text-xs">{name}</DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          {url && <><DropdownMenuItem className="text-xs cursor-pointer" asChild><a href={url} target="_blank" rel="noopener noreferrer">{name}</a></DropdownMenuItem><DropdownMenuSeparator /></>}
          {renderMenuItems(item.submenus, ctx, spaces)}
        </DropdownMenuSubContent>
      </DropdownMenuSub>)];
    }
    return [url
      ? <DropdownMenuItem key={i} className="text-xs cursor-pointer" asChild><a href={url} target="_blank" rel="noopener noreferrer">{name}</a></DropdownMenuItem>
      : <DropdownMenuItem key={i} className="text-xs" disabled>{name}</DropdownMenuItem>
    ];
  });
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface DestProp {
  key:         string;
  value:       string;
  isSensitive: boolean;
  revealed:    boolean;
}

interface DestSearchResult { name: string; matchField: string; matchValue: string; spaceName?: string; instanceName?: string; instanceGuid?: string }
type Tab        = 'properties' | 'changelog' | 'test';
type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
type ImportTarget = { type: 'sa' } | { type: 'inst'; spaceName: string; instanceGuid: string; instanceName: string };

export interface SubaccountDestModalProps {
  org:                   SubaccountEntry;
  allNames:              string[];
  initialName?:          string;
  initialTab?:           Tab;
  initialShowList?:      boolean;
  initialSpaceName?:     string;
  initialInstanceName?:  string;
  initialInstanceGuid?:  string;
  onClose:               () => void;
  selectedDests?:        SelectedDest[];
  onToggleCompare?:      (d: SelectedDest) => void;
  onOpenCompare?:        (dests: SelectedDest[]) => void;
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
  return k.includes('secret') || k.includes('password') || k.includes('passwd') || k.includes('credential');
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
  name:          string;
  props:         DestProp[];
  loading:       boolean;
  banner:        SaveBanner | null;
  onUpdate:      (idx: number, patch: Partial<DestProp>) => void;
  onDelete:      (idx: number) => void;
  onAdd:         () => void;
  onClearBanner: () => void;
}

function PropertiesTab({
  name, props, loading, banner,
  onUpdate, onDelete, onAdd, onClearBanner,
}: PropsTabProps) {
  return (
    <div className="flex flex-col h-full">
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

function getImportTargets(
  treeSelectedKeys: Set<string>,
  spaceInstances: Map<string, Array<{ instanceGuid: string; instanceName: string }>>,
  org: SubaccountEntry,
): ImportTarget[] {
  const result: ImportTarget[] = [];
  const hasSa   = treeSelectedKeys.size === 0 || treeSelectedKeys.has('sa:root');
  const hasInst = [...treeSelectedKeys].some(k => k.startsWith('space:') || k.startsWith('inst:'));
  if (hasSa || !hasInst) result.push({ type: 'sa' });
  const seenGuids = new Set<string>();
  for (const key of treeSelectedKeys) {
    if (key.startsWith('inst:')) {
      const guid = key.slice(5);
      if (seenGuids.has(guid)) continue; seenGuids.add(guid);
      let spaceName = ''; let instanceName = '';
      for (const [sid, insts] of spaceInstances) {
        const i = insts.find(x => x.instanceGuid === guid);
        if (i) { spaceName = (org.org?.spaces ?? []).find(s => s.spaceId === sid)?.spaceName ?? ''; instanceName = i.instanceName; break; }
      }
      result.push({ type: 'inst', spaceName, instanceGuid: guid, instanceName });
    } else if (key.startsWith('space:')) {
      const sid = key.slice(6);
      const spaceName = (org.org?.spaces ?? []).find(s => s.spaceId === sid)?.spaceName ?? '';
      for (const inst of spaceInstances.get(sid) ?? []) {
        if (seenGuids.has(inst.instanceGuid)) continue; seenGuids.add(inst.instanceGuid);
        result.push({ type: 'inst', spaceName, instanceGuid: inst.instanceGuid, instanceName: inst.instanceName });
      }
    }
  }
  return result;
}

// ─── Main modal ───────────────────────────────────────────────────────────────

export default function SubaccountDestModal({ org, allNames, initialName, initialTab, initialShowList, initialSpaceName, initialInstanceName, initialInstanceGuid, onClose, selectedDests, onToggleCompare, onOpenCompare }: SubaccountDestModalProps) {
  const auth                        = useAuth();
  const { settings, cockpitMenu }   = useSettings();
  const cockpit                     = settings?.homepage.cockpit ?? { idp: '', host: '' };
  const username = auth.email || auth.firstName || 'admin';

  // Left panel
  const [localAllNames,    setLocalAllNames]    = useState<string[]>(allNames);
  const [searchQuery,      setSearchQuery]      = useState('');
  const [filteredNames,    setFilteredNames]    = useState<string[]>(allNames);
  const [matchedInstKeys,  setMatchedInstKeys]  = useState<Set<string> | null>(null); // "{guid}/{name}" — non-null after a search
  const [isSearching,      setIsSearching]      = useState(false);
  const [selectedName,  setSelectedName]  = useState(initialName ?? allNames[0] ?? '');
  const [selectedNames, setSelectedNames] = useState<Set<string>>(
    () => new Set(initialName ? [initialName] : allNames[0] ? [allNames[0]] : []),
  );
  const [lastClickName, setLastClickName] = useState(initialName ?? allNames[0] ?? '');

  // Right panel
  const [activeTab, setActiveTab] = useState<Tab>(initialTab ?? 'properties');

  // Properties (existing destination)
  const [serverProps, setServerProps] = useState<DestProp[]>([]);
  const [editedProps, setEditedProps] = useState<DestProp[]>([]);
  const [isLoading,   setIsLoading]   = useState(false);
  const [isSaving,    setIsSaving]    = useState(false);

  // Import dialog state
  const [importItems,      setImportItems]      = useState<Record<string, unknown>[]>([]);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [importProgress,   setImportProgress]   = useState<{ done: number; total: number; lastDest?: string; lastAction?: 'created' | 'updated' | 'error' } | null>(null);
  const [importSummary,    setImportSummary]     = useState<{ created: number; updated: number; errors: string[] } | null>(null);
  const isImportRunning = importProgress !== null && importSummary === null;

  // Left-panel visibility toggle
  const [showList,   setShowList]   = useState(initialShowList ?? true);
  const [maximized,  setMaximized]  = useState(false);

  // Space destination tree
  const hasSpaceDests = (org.org?.spaces ?? []).some(s => s.manageDest);
  // Tree node keys: `sa:root` | `space:{spaceId}` | `inst:{instanceGuid}`
  const [treeSelectedKeys,  setTreeSelectedKeys]  = useState<Set<string>>(new Set());
  const [lastTreeClickKey,  setLastTreeClickKey]  = useState<string>('');
  // Ordered flat list of all tree node keys (spaces then their instances, in render order) for shift-click
  const [treeExpanded,      setTreeExpanded]      = useState<Set<string>>(new Set(['__sa__'])); // SA root always expanded
  const [treeFilter,        setTreeFilter]        = useState('');
  const [instanceNames,     setInstanceNames]     = useState<Map<string, string[]>>(new Map()); // key=instanceGuid → dest names
  // key=spaceId → instances from local store (loaded once from GET .../spaces)
  const [spaceInstances,    setSpaceInstances]    = useState<Map<string, Array<{ instanceGuid: string; instanceName: string }>>>(new Map());
  const [allInstancesLoaded, setAllInstancesLoaded] = useState(false);
  // Multi-select for instance/space dest list; key = `{instanceGuid}/{name}` or `sa/{name}`
  const [selectedDestKeys,  setSelectedDestKeys]  = useState<Set<string>>(new Set());
  const [lastClickDestKey,  setLastClickDestKey]  = useState<string>('');

  // Horizontal split (left panel width as % of total)
  const [splitPct,  setSplitPct]  = useState(50);
  // Vertical split within left panel (tree height as % of left panel)
  const [treeSplitPct, setTreeSplitPct] = useState(40);
  const bodyRef              = useRef<HTMLDivElement>(null);
  const splitResizeRef       = useRef<{ startX: number; startPct: number; containerW: number } | null>(null);
  const treeSplitResizeRef   = useRef<{ startY: number; startPct: number; containerH: number } | null>(null);

  function startSplitResize(e: React.MouseEvent) {
    e.preventDefault();
    if (!bodyRef.current) return;
    splitResizeRef.current = { startX: e.clientX, startPct: splitPct, containerW: bodyRef.current.offsetWidth };
    function onMove(ev: MouseEvent) {
      if (!splitResizeRef.current) return;
      const { startX, startPct, containerW } = splitResizeRef.current;
      const deltaPct = ((ev.clientX - startX) / containerW) * 100;
      setSplitPct(Math.min(75, Math.max(20, startPct + deltaPct)));
    }
    function onUp() {
      splitResizeRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  function startTreeSplitResize(e: React.MouseEvent) {
    e.preventDefault();
    const container = (e.target as HTMLElement).closest('.tree-split-container') as HTMLElement | null;
    if (!container) return;
    treeSplitResizeRef.current = { startY: e.clientY, startPct: treeSplitPct, containerH: container.offsetHeight };
    function onMove(ev: MouseEvent) {
      if (!treeSplitResizeRef.current) return;
      const { startY, startPct, containerH } = treeSplitResizeRef.current;
      const deltaPct = ((ev.clientY - startY) / containerH) * 100;
      setTreeSplitPct(Math.min(70, Math.max(15, startPct + deltaPct)));
    }
    function onUp() {
      treeSplitResizeRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  // Load all space instances from local store in one shot (keyed by spaceId from org.spaces)
  async function loadAllSpaceInstances() {
    if (allInstancesLoaded) return;
    try {
      const res  = await fetch(`/api/destinations/${enc(org.region)}/${enc(org.subdomain)}/spaces`);
      const json = await res.json() as { ok: boolean; data: Array<{ spaceName: string; instanceGuid: string; instanceName: string }> };
      if (!json.ok) return;
      // Build spaceId → instances map using org.spaces to resolve spaceId from spaceName
      const nameToId = new Map((org.org?.spaces ?? []).map(s => [s.spaceName, s.spaceId]));
      const bySpace = new Map<string, Array<{ instanceGuid: string; instanceName: string }>>();
      for (const item of (json.data ?? [])) {
        const spaceId = nameToId.get(item.spaceName);
        if (!spaceId) continue;
        const arr = bySpace.get(spaceId) ?? [];
        arr.push({ instanceGuid: item.instanceGuid, instanceName: item.instanceName });
        bySpace.set(spaceId, arr);
      }
      setSpaceInstances(bySpace);
      setAllInstancesLoaded(true);
      // Eagerly load dest names for all instances so counts are populated immediately
      for (const item of (json.data ?? [])) {
        void loadInstanceDestNames(item.instanceGuid, item.spaceName);
      }
    } catch { /* ignore */ }
  }

  async function loadInstanceDestNames(instanceGuid: string, spaceName: string) {
    if (instanceNames.has(instanceGuid)) return;
    try {
      const res  = await fetch(`/api/destinations/${enc(org.region)}/${enc(org.subdomain)}/spaces/${enc(spaceName)}/instances/${enc(instanceGuid)}`);
      const json = await res.json() as { ok: boolean; names: string[] };
      if (json.ok) setInstanceNames(prev => new Map(prev).set(instanceGuid, json.names ?? []));
    } catch { /* ignore */ }
  }

  // activeInstScope tracks the single dest being viewed in the right panel (for save/breadcrumb)
  const [activeInstScope, setActiveInstScope] = useState<{ spaceName: string; instanceGuid: string; instanceName: string } | null>(
    initialInstanceGuid && initialSpaceName && initialInstanceName
      ? { spaceName: initialSpaceName, instanceGuid: initialInstanceGuid, instanceName: initialInstanceName }
      : null,
  );

  function loadInstDest(spaceName: string, instanceGuid: string, instanceName: string, name: string) {
    setActiveInstScope({ spaceName, instanceGuid, instanceName });
    setSelectedName(name);
    setSelectedNames(new Set([name]));
    setIsCreating(false);
    void loadInstDestData(spaceName, instanceGuid, name);
  }

  async function loadInstDestData(spaceName: string, instanceGuid: string, name: string) {
    setIsLoading(true);
    try {
      const res  = await fetch(`/api/destinations/${enc(org.region)}/${enc(org.subdomain)}/spaces/${enc(spaceName)}/instances/${enc(instanceGuid)}/${enc(name)}`);
      const json = await res.json() as { ok: boolean; data: Record<string, unknown>; sensitiveFields: string[] };
      if (json.ok) {
        const props = toProps(json.data, json.sensitiveFields);
        setServerProps(props);
        setEditedProps(structuredClone(props));
      }
    } catch { /* ignore */ } finally { setIsLoading(false); }
  }

  // Create mode (new destination from scratch)
  const [isCreating,    setIsCreating]    = useState(false);
  const [newName,       setNewName]       = useState('');
  const [newProps,      setNewProps]      = useState<DestProp[]>(() => structuredClone(DEFAULT_CREATE_PROPS));
  const [isCreatingSave, setIsCreatingSave] = useState(false);
  const [createError,   setCreateError]   = useState('');

  // Changelog
  const [changelog,          setChangelog]          = useState('');
  const [isLoadingChangelog, setIsLoadingChangelog] = useState(false);

  // Per-subaccount refresh progress
  type SubProgress = { type: 'refreshing' | 'done' | 'error'; created?: number; updated?: number; deleted?: number; received?: number; errors?: string[] };
  const [subProgress, setSubProgress] = useState<SubProgress | null>(null);
  const subProgressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Save banner
  const [saveBanner,     setSaveBanner]     = useState<SaveBanner | null>(null);
  const bannerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  // Enter-triggered full-text search scoped to this subdomain
  async function runSearch(q: string) {
    if (!q.trim()) { setFilteredNames(localAllNames); setMatchedInstKeys(null); return; }
    setIsSearching(true);
    try {
      const url = `/api/destinations/search?q=${encodeURIComponent(q.trim())}&region=${encodeURIComponent(org.region)}&subdomain=${encodeURIComponent(org.subdomain)}`;
      const res  = await fetch(url);
      const json = await res.json() as { ok: boolean; data: DestSearchResult[] };
      if (json.ok) {
        const saMatched   = new Set(json.data.filter(r => !r.spaceName).map(r => r.name));
        const instMatched = new Set(json.data.filter(r => r.spaceName && r.instanceGuid).map(r => `${r.instanceGuid}/${r.name}`));
        setFilteredNames(localAllNames.filter(n => saMatched.has(n)));
        setMatchedInstKeys(instMatched);
      }
    } catch { /* ignore */ } finally { setIsSearching(false); }
  }

  // Sync browser URL with selected destination and active tab
  useEffect(() => {
    if (!selectedName) return;
    const tabSuffix = activeTab === 'changelog' ? '/history' : activeTab === 'test' ? '/test' : '';
    const base = `/destinations/${encodeURIComponent(org.region)}/${encodeURIComponent(org.subdomain)}`;
    const path = activeInstScope
      ? `${base}/${encodeURIComponent(activeInstScope.spaceName)}/${encodeURIComponent(activeInstScope.instanceName)}/${encodeURIComponent(activeInstScope.instanceGuid)}/${encodeURIComponent(selectedName)}${tabSuffix}`
      : `${base}/${encodeURIComponent(selectedName)}${tabSuffix}`;
    history.replaceState(null, '', path);
  }, [selectedName, activeTab, activeInstScope, org.region, org.subdomain]);

  // Proactive destination load on mount — silently loads local data; only shows
  // progress banner if an actual API refresh ran (stale data) or an error occurred.
  useEffect(() => {
    void (async () => {
      try {
        const res  = await fetch(`/api/destinations/${enc(org.region)}/${enc(org.subdomain)}`);
        const json = await res.json() as { ok: boolean; names: string[]; refreshed: boolean; errors: string[]; created?: number; updated?: number; deleted?: number; received?: number };
        if (!json.ok) {
          setSubProgress({ type: 'error', errors: json.errors?.length ? json.errors : ['Failed to load destinations'] });
          return;
        }
        if (json.names.length > 0) setLocalAllNames(json.names);
        if (json.refreshed) {
          if (json.errors?.length) {
            setSubProgress({ type: 'error', errors: json.errors });
          } else {
            setSubProgress({ type: 'done', created: json.created ?? 0, updated: json.updated ?? 0, deleted: json.deleted ?? 0, received: json.received });
            subProgressTimerRef.current = setTimeout(() => setSubProgress(null), 3000);
          }
        }
      } catch (err) {
        setSubProgress({ type: 'error', errors: [String(err)] });
      }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Load all space instances from local store as soon as the modal opens (if this SA has manageDest spaces)
  useEffect(() => {
    if (hasSpaceDests) void loadAllSpaceInstances();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // When opened with an initial instance dest (from deep-link or global search click):
  // once spaceInstances are loaded, select the instance node in the tree + load the dest content.
  useEffect(() => {
    if (!initialInstanceGuid || !initialSpaceName || !initialName) return;
    if (!allInstancesLoaded) return; // wait until instances are fetched
    // Select the instance node in the tree
    setTreeSelectedKeys(new Set([`inst:${initialInstanceGuid}`]));
    setLastTreeClickKey(`inst:${initialInstanceGuid}`);
    // Expand the space that contains this instance
    const space = (org.org?.spaces ?? []).find(s => s.spaceName === initialSpaceName);
    if (space) setTreeExpanded(prev => new Set([...prev, space.spaceId]));
    // Load the dest content
    void loadInstDestData(initialSpaceName, initialInstanceGuid, initialName);
  }, [allInstancesLoaded]); // eslint-disable-line react-hooks/exhaustive-deps


  useEffect(() => {
    for (const key of treeSelectedKeys) {
      if (!key.startsWith('inst:')) continue;
      const instanceGuid = key.slice(5);
      if (instanceNames.has(instanceGuid)) continue;
      // Find the spaceName for this instance
      for (const [spaceId, insts] of spaceInstances) {
        const inst = insts.find(i => i.instanceGuid === instanceGuid);
        if (inst) {
          const space = (org.org?.spaces ?? []).find(s => s.spaceId === spaceId);
          if (space) void loadInstanceDestNames(instanceGuid, space.spaceName);
          break;
        }
      }
    }
    // Also load all instances under selected spaces
    for (const key of treeSelectedKeys) {
      if (!key.startsWith('space:')) continue;
      const spaceId = key.slice(6);
      const insts = spaceInstances.get(spaceId) ?? [];
      const space = (org.org?.spaces ?? []).find(s => s.spaceId === spaceId);
      if (!space) continue;
      for (const inst of insts) {
        if (!instanceNames.has(inst.instanceGuid)) void loadInstanceDestNames(inst.instanceGuid, space.spaceName);
      }
    }
  }, [treeSelectedKeys, spaceInstances]); // eslint-disable-line react-hooks/exhaustive-deps

  // Close on Escape; cleanup timers on unmount
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (bannerTimerRef.current)      clearTimeout(bannerTimerRef.current);
      if (subProgressTimerRef.current) clearTimeout(subProgressTimerRef.current);
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
      const url = activeInstScope
        ? `/api/destinations/${enc(org.region)}/${enc(org.subdomain)}/spaces/${enc(activeInstScope.spaceName)}/instances/${enc(activeInstScope.instanceGuid)}/${enc(selectedName)}`
        : `/api/destinations/${enc(org.region)}/${enc(org.subdomain)}/${enc(selectedName)}`;
      const res  = await fetch(url, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ data: fromProps(selectedName, editedProps), username }),
      });
      const json = await res.json() as { ok: boolean; error?: string };
      if (!json.ok) throw new Error(json.error ?? 'Save failed');
      if (activeInstScope) {
        await loadInstDestData(activeInstScope.spaceName, activeInstScope.instanceGuid, selectedName);
      } else {
        await loadDest(selectedName);
        if (activeTab === 'changelog') await loadChangelog(selectedName);
      }
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
    try {
      const text   = await file.text();
      const parsed = JSON.parse(text) as Record<string, unknown> | Record<string, unknown>[];
      const items  = (Array.isArray(parsed) ? parsed : [parsed]).filter(i => typeof i['Name'] === 'string' && (i['Name'] as string).trim());
      if (items.length === 0) { setSaveBanner({ type: 'error', message: 'No valid destinations in file' }); return; }
      setImportItems(items);
      setImportProgress(null);
      setImportSummary(null);
      setImportDialogOpen(true);
    } catch {
      setSaveBanner({ type: 'error', message: 'Invalid JSON file' });
    }
  }

  async function runImport(targets: ImportTarget[]) {
    const total = importItems.length * targets.length;
    setImportProgress({ done: 0, total });
    setImportSummary(null);
    let done = 0; let created = 0; let updated = 0;
    const errors: string[]  = [];
    const changes: Array<{ region: string; subdomain: string; name: string; action: 'created' | 'updated'; spaceName?: string; instanceGuid?: string; instanceName?: string }> = [];

    for (const item of importItems) {
      const name = String(item['Name']).trim();
      for (const target of targets) {
        let lastAction: 'created' | 'updated' | 'error' = 'updated';
        try {
          const url = target.type === 'sa'
            ? `/api/destinations/${enc(org.region)}/${enc(org.subdomain)}/${enc(name)}`
            : `/api/destinations/${enc(org.region)}/${enc(org.subdomain)}/spaces/${enc(target.spaceName)}/instances/${enc(target.instanceGuid)}/${enc(name)}`;
          const isNew = target.type === 'sa'
            ? !localAllNames.includes(name)
            : !(instanceNames.get(target.instanceGuid) ?? []).includes(name);
          const res  = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: item, username, action: 'import' }) });
          const json = await res.json() as { ok: boolean; error?: string };
          if (!json.ok) throw new Error(json.error ?? 'PUT failed');
          lastAction = isNew ? 'created' : 'updated';
          if (isNew) { created++; } else { updated++; }
          changes.push({ region: org.region, subdomain: org.subdomain, name, action: isNew ? 'created' : 'updated', ...(target.type === 'inst' ? { spaceName: target.spaceName, instanceGuid: target.instanceGuid, instanceName: target.instanceName } : {}) });
          if (target.type === 'sa') setLocalAllNames(prev => [...new Set([...prev, name])].sort());
          else setInstanceNames(prev => { const m = new Map(prev); m.set(target.instanceGuid, [...new Set([...(m.get(target.instanceGuid) ?? []), name])].sort()); return m; });
        } catch (err) {
          lastAction = 'error';
          errors.push(`${name}${target.type === 'inst' ? ` (${target.instanceName})` : ''}: ${err instanceof Error ? err.message : 'error'}`);
        }
        done++;
        setImportProgress({ done, total, lastDest: name, lastAction });
      }
    }

    // Write one grouped global changelog entry
    if (changes.length > 0) {
      try {
        await fetch('/api/destinations/batch-changelog', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ changes }),
        });
      } catch { /* non-fatal */ }
    }

    setImportSummary({ created, updated, errors });
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
    if (subProgressTimerRef.current) clearTimeout(subProgressTimerRef.current);
    setSubProgress({ type: 'refreshing' });
    try {
      const res  = await fetch(`/api/destinations/${enc(org.region)}/${enc(org.subdomain)}?force=1`);
      const json = await res.json() as { ok: boolean; names: string[]; refreshed: boolean; errors: string[]; created?: number; updated?: number; deleted?: number; received?: number };
      if (!res.ok || !json.ok) {
        setSubProgress({ type: 'error', errors: json.errors?.length ? json.errors : [`HTTP ${res.status}`] });
        return;
      }
      if (json.names.length > 0) setLocalAllNames(json.names);
      if (json.errors?.length) {
        setSubProgress({ type: 'error', errors: json.errors });
        return;
      }
      if (selectedName) await loadDest(selectedName);
      if (activeTab === 'changelog' && selectedName) await loadChangelog(selectedName);
      setSubProgress({ type: 'done', created: json.created ?? 0, updated: json.updated ?? 0, deleted: json.deleted ?? 0, received: json.received });
      subProgressTimerRef.current = setTimeout(() => setSubProgress(null), 3000);
    } catch (err) {
      setSubProgress({ type: 'error', errors: [String(err)] });
    }
  }

  const tabCls = (active: boolean) =>
    `px-4 py-2 text-xs transition-colors border-b-2 shrink-0 font-medium ${
      active ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'
    }`;

  const btnBase    = 'inline-flex items-center gap-1.5 px-2 sm:px-3 py-1.5 rounded text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
  const btnOutline = `${btnBase} border border-border hover:bg-accent hover:text-accent-foreground`;
  const exportCount = selectedNames.size;
  const exportTitle = exportCount > 1
    ? `Download ${exportCount} selected destinations as ${org.region}_${org.subdomain}_multi_destinations.json`
    : 'Download destination JSON — Ctrl/⌘+click or Shift+click to select multiple for bulk export';

  // Inline filter-row toolbar helper (New, Import, Export, Compare)
  function renderFilterToolbar(opts: {
    onExport: () => void;
    exportDisabled: boolean;
    exportTitle: string;
    exportCount: number;
    compareCount: number;
    onCompare: () => void;
    isCreatingMode: boolean;
  }) {
    const { onExport, exportDisabled, compareCount, onCompare, isCreatingMode } = opts;
    return (
      <>
        <button
          onClick={handleCreateClick}
          disabled={isCreatingMode}
          className={btnOutline}
          title="Create new destination"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={isImportRunning}
          className={btnOutline}
          title="Import destination(s) from JSON"
        >
          <Upload className="h-3.5 w-3.5" />
          {maximized && <span className="ml-1 max-[680px]:hidden">Import</span>}
        </button>
        <button
          onClick={onExport}
          disabled={exportDisabled}
          className={btnOutline}
          title={opts.exportTitle}
        >
          <Download className="h-3.5 w-3.5" />
          {maximized
            ? <span className="ml-1 max-[680px]:hidden">Export{opts.exportCount > 0 ? ` (${opts.exportCount})` : ''}</span>
            : opts.exportCount > 0 ? <span className="text-[10px]">{opts.exportCount}</span> : null
          }
        </button>
        <button
          onClick={onCompare}
          disabled={compareCount < 2}
          className={btnOutline}
          title={compareCount >= 2 ? `Compare ${compareCount} selected destinations` : 'Select 2+ destinations to compare'}
        >
          <GitCompare className="h-3.5 w-3.5" />
          {maximized
            ? <span className="ml-1 max-[680px]:hidden">Compare{compareCount > 0 ? ` (${compareCount})` : ''}</span>
            : compareCount > 0 ? <span className="text-[10px]">{compareCount}</span> : null
          }
        </button>
      </>
    );
  }

  return (
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm ${maximized ? 'p-0' : 'p-4'}`}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className={`bg-background border border-border shadow-2xl flex flex-col ${
        maximized ? 'w-full h-full rounded-none' : 'w-full max-w-5xl h-[90vh] rounded-xl'
      }`}>

        {/* Modal header: breadcrumb + Maximize + X */}
        <div className="flex items-center gap-2 px-4 border-b border-border shrink-0 min-h-[44px]">
          <div className="text-sm font-semibold min-w-0 flex items-center gap-1 flex-1 overflow-hidden">
            <span className="text-muted-foreground font-normal shrink-0">{org.region} ›</span>
            {cockpitMenu
              ? (() => {
                  const ctx    = buildCockpitCtx(org, cockpit);
                  const url    = cockpitMenu.url ? resolveUrl(cockpitMenu.url, ctx) : undefined;
                  const spaces = org.org?.spaces ?? [];
                  const hasSubs = (cockpitMenu.submenus?.length ?? 0) > 0;
                  return (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button className="inline-flex items-center gap-0.5 hover:bg-accent/60 hover:text-foreground px-1 py-0.5 rounded transition-colors min-w-0 shrink truncate">
                          <span className="truncate">{org.alias || org.subaccountName}</span>
                          <span className="font-normal text-xs font-mono text-muted-foreground shrink-0">({org.subdomain})</span>
                          <ChevronDown className="h-3 w-3 shrink-0 opacity-60 ml-0.5" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start" className="max-h-[min(70vh,420px)] overflow-y-auto">
                        {url && <>
                          <DropdownMenuItem className="text-xs cursor-pointer" asChild>
                            <a href={url} target="_blank" rel="noopener noreferrer">{cockpitMenu.name}</a>
                          </DropdownMenuItem>
                          {hasSubs && <DropdownMenuSeparator />}
                        </>}
                        {hasSubs && renderMenuItems(cockpitMenu.submenus!, ctx, spaces)}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  );
                })()
              : <span className="truncate">{org.alias || org.subaccountName} <span className="font-normal text-xs font-mono text-muted-foreground">({org.subdomain})</span></span>
            }
            <span className="text-muted-foreground font-normal shrink-0">
              {(() => {
                if (!hasSpaceDests || treeSelectedKeys.size === 0) return '› Subaccount Destinations';
                const hasSa   = treeSelectedKeys.has('sa:root');
                const hasInst = [...treeSelectedKeys].some(k => k.startsWith('space:') || k.startsWith('inst:'));
                if (hasSa && hasInst) return '› Subaccount & Instance Destinations';
                if (hasSa)           return '› Subaccount Destinations';
                return '› Instance Destinations';
              })()}
            </span>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={() => void handleRefresh()}
              className={`inline-flex items-center gap-1.5 p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors text-xs font-medium`}
              title="Refresh subaccount destinations"
            >
              <RefreshCw className="h-4 w-4" />
              {maximized && <span className="max-[680px]:hidden">Refresh</span>}
            </button>
            <button
              onClick={() => setMaximized(v => !v)}
              className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
              title={maximized ? 'Restore' : 'Maximize'}
            >
              {maximized ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
            </button>
            <button onClick={onClose} className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors">
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Sub-refresh progress banner */}
        {subProgress && (
          <div className={`relative px-4 py-2 border-b text-xs flex items-center justify-center gap-2 shrink-0 overflow-hidden ${
            subProgress.type === 'error' ? 'bg-amber-500/5 border-amber-500/20 text-amber-700 dark:text-amber-400'
            : subProgress.type === 'done' ? 'bg-green-500/5 border-green-500/20 text-green-700 dark:text-green-400'
            : 'bg-muted/30 border-border text-muted-foreground'
          }`}>
            {subProgress.type === 'refreshing' && (
              <div className="absolute bottom-0 left-0 h-0.5 bg-primary/40 animate-pulse w-full" />
            )}
            <span className="text-center">
              {subProgress.type === 'refreshing' && 'Refreshing subaccount destinations…'}
              {subProgress.type === 'done' && (
                (subProgress.created ?? 0) === 0 && (subProgress.updated ?? 0) === 0 && (subProgress.deleted ?? 0) === 0
                  ? 'Refreshed — no change'
                  : `Refreshed — created ${subProgress.created ?? 0}, updated ${subProgress.updated ?? 0}, deleted ${subProgress.deleted ?? 0} destinations since last check`
              )}
              {subProgress.type === 'error' && (subProgress.errors ?? []).join('; ')}
            </span>
            {subProgress.type !== 'refreshing' && (
              <button
                onClick={() => { if (subProgressTimerRef.current) clearTimeout(subProgressTimerRef.current); setSubProgress(null); }}
                className="absolute right-2 shrink-0 p-0.5 rounded hover:opacity-70 transition-opacity"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
        )}

        {/* Body */}
        <div ref={bodyRef} className="flex flex-1 min-h-0">
          {/* Left panel: destination list (or tree + list when hasSpaceDests) */}
          {showList && (
            hasSpaceDests ? (
              <>
                <div
                  className="tree-split-container border-r border-border flex flex-col shrink-0 min-w-0"
                  style={{ width: `${splitPct}%` }}
                >
                  {/* Tree (top pane) */}
                  <div className="flex flex-col overflow-hidden" style={{ height: `${treeSplitPct}%` }}>
                    {/* Tree title bar */}
                    <div className="flex items-center gap-1 px-2 border-b border-border shrink-0 min-h-[44px]">
                      {/* Filter input */}
                      <div className="relative flex-1 min-w-0">
                        <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
                        <input
                          type="text"
                          value={treeFilter}
                          onChange={e => setTreeFilter(e.target.value)}
                          placeholder="Filter spaces / instances…"
                          className={`w-full h-7 pl-7 text-xs border border-border rounded bg-background focus:outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50 ${treeFilter ? 'pr-6' : 'pr-2'}`}
                        />
                        {treeFilter && (
                          <button onClick={() => setTreeFilter('')} className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors p-0.5" tabIndex={-1}>
                            <X className="h-3 w-3" />
                          </button>
                        )}
                      </div>
                      {/* Toolbar: Expand · Collapse · Select All · Unselect All */}
                      <div className="flex items-center gap-0.5 shrink-0">
                        <button
                          onClick={() => {
                            const allSpaceIds = (org.org?.spaces ?? []).filter(s => s.manageDest).map(s => s.spaceId);
                            setTreeExpanded(new Set(['__sa__', ...allSpaceIds]));
                            if (!allInstancesLoaded) void loadAllSpaceInstances();
                          }}
                          className={btnOutline}
                          title="Expand all spaces"
                        >
                          <ChevronsUpDown className="h-3.5 w-3.5" />
                          {maximized && <span className="ml-1 max-[680px]:hidden">Expand</span>}
                        </button>
                        <button
                          onClick={() => setTreeExpanded(new Set(['__sa__']))}
                          className={btnOutline}
                          title="Collapse to space level"
                        >
                          <ChevronsDownUp className="h-3.5 w-3.5" />
                          {maximized && <span className="ml-1 max-[680px]:hidden">Collapse</span>}
                        </button>
                        <div className="w-px h-3 bg-border mx-0.5" />
                        <button
                          onClick={() => {
                            const keys: string[] = ['sa:root'];
                            for (const sp of (org.org?.spaces ?? []).filter(s => s.manageDest)) {
                              keys.push(`space:${sp.spaceId}`);
                              for (const i of (spaceInstances.get(sp.spaceId) ?? [])) keys.push(`inst:${i.instanceGuid}`);
                            }
                            setTreeSelectedKeys(new Set(keys));
                            setLastTreeClickKey(keys[keys.length - 1] ?? '');
                          }}
                          className={btnOutline}
                          title="Select all"
                        >
                          <CheckSquare className="h-3.5 w-3.5" />
                          {maximized && <span className="ml-1 max-[680px]:hidden">All</span>}
                        </button>
                        <button
                          onClick={() => { setTreeSelectedKeys(new Set()); setLastTreeClickKey(''); }}
                          className={btnOutline}
                          title="Unselect all"
                        >
                          <Square className="h-3.5 w-3.5" />
                          {maximized && <span className="ml-1 max-[680px]:hidden">None</span>}
                        </button>
                      </div>
                    </div>
                    {/* Tree table */}
                    <div
                      className="flex-1 overflow-auto"
                      tabIndex={0}
                      onKeyDown={e => {
                        if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
                          e.preventDefault();
                          const keys: string[] = ['sa:root'];
                          for (const sp of (org.org?.spaces ?? []).filter(s => s.manageDest)) {
                            keys.push(`space:${sp.spaceId}`);
                            for (const i of (spaceInstances.get(sp.spaceId) ?? [])) keys.push(`inst:${i.instanceGuid}`);
                          }
                          setTreeSelectedKeys(new Set(keys));
                          setLastTreeClickKey(keys[keys.length - 1] ?? '');
                        }
                      }}
                    >
                      <table className="w-full border-collapse text-xs" style={{ tableLayout: 'fixed' }}>
                        <colgroup>
                          <col />
                          <col style={{ width: '52px' }} />
                        </colgroup>
                        <thead className="sticky top-0 z-10">
                          <tr className="bg-muted/40">
                            <th className="px-2 py-1 text-left text-[10px] font-medium text-muted-foreground border-b border-border">Subaccount › Spaces › Destination Instances</th>
                            <th className="px-2 py-1 text-right text-[10px] font-medium text-muted-foreground border-b border-border">Dests</th>
                          </tr>
                        </thead>
                        <tbody>
                      {(() => {
                        const filterLc = treeFilter.toLowerCase();
                        // Build ordered flat list of all visible tree nodes once (for shift-click range)
                        const orderedKeys: string[] = ['sa:root'];
                        const visibleSpaces = (org.org?.spaces ?? []).filter(s => s.manageDest && (
                          !filterLc || s.spaceName.toLowerCase().includes(filterLc) ||
                          (spaceInstances.get(s.spaceId) ?? []).some(i => i.instanceName.toLowerCase().includes(filterLc))
                        ));
                        for (const sp of visibleSpaces) {
                          orderedKeys.push(`space:${sp.spaceId}`);
                          if (treeExpanded.has(sp.spaceId)) {
                            for (const i of (spaceInstances.get(sp.spaceId) ?? [])) {
                              if (!filterLc || i.instanceName.toLowerCase().includes(filterLc) || sp.spaceName.toLowerCase().includes(filterLc)) {
                                orderedKeys.push(`inst:${i.instanceGuid}`);
                              }
                            }
                          }
                        }

                        function handleTreeClick(nodeKey: string, e: React.MouseEvent) {
                          if (e.ctrlKey || e.metaKey) {
                            setTreeSelectedKeys(prev => {
                              const next = new Set(prev);
                              if (next.has(nodeKey)) next.delete(nodeKey); else next.add(nodeKey);
                              return next;
                            });
                            setLastTreeClickKey(nodeKey);
                          } else if (e.shiftKey && lastTreeClickKey) {
                            const a = orderedKeys.indexOf(lastTreeClickKey);
                            const b = orderedKeys.indexOf(nodeKey);
                            if (a >= 0 && b >= 0) {
                              const [lo, hi] = a <= b ? [a, b] : [b, a];
                              setTreeSelectedKeys(new Set(orderedKeys.slice(lo, hi + 1)));
                            }
                            setLastTreeClickKey(nodeKey);
                          } else {
                            setTreeSelectedKeys(new Set([nodeKey]));
                            setLastTreeClickKey(nodeKey);
                          }
                        }

                        const saRootSel = treeSelectedKeys.has('sa:root');
                        const saDestCount = localAllNames.length;
                        const rowCls = (sel: boolean) => `cursor-pointer select-none hover:bg-muted/20 ${sel ? 'bg-primary/10 text-primary' : ''}`;

                        return (
                          <>
                            {/* SA root node */}
                            <tr
                              className={rowCls(saRootSel)}
                              onClick={e => handleTreeClick('sa:root', e)}
                            >
                              <td className="px-2 py-1 border-b border-border/50 font-semibold">
                                <span className="flex items-center gap-1">
                                  <ChevronDown className="h-3 w-3 shrink-0 opacity-60" />
                                  <span className="truncate font-mono">{org.alias || org.subaccountName}</span>
                                  <span className="font-normal text-[10px] text-muted-foreground shrink-0">({org.subdomain})</span>
                                </span>
                              </td>
                              <td className="px-2 py-1 border-b border-border/50 text-right text-muted-foreground text-[10px]">
                                {saDestCount > 0 ? saDestCount : ''}
                              </td>
                            </tr>

                            {/* Space + instance rows */}
                            {visibleSpaces.map(space => {
                              const spaceNodeKey   = `space:${space.spaceId}`;
                              const isExpanded     = treeExpanded.has(space.spaceId);
                              const isSpaceSel     = treeSelectedKeys.has(spaceNodeKey);
                              const insts          = (spaceInstances.get(space.spaceId) ?? []).filter(i =>
                                !filterLc || i.instanceName.toLowerCase().includes(filterLc) || space.spaceName.toLowerCase().includes(filterLc)
                              );
                              const spaceDestCount = insts.reduce((sum, i) => sum + (instanceNames.get(i.instanceGuid)?.length ?? 0), 0);
                              return (
                                <>
                                  {/* Space row */}
                                  <tr
                                    key={`space-${space.spaceId}`}
                                    className={rowCls(isSpaceSel)}
                                    onClick={e => {
                                      handleTreeClick(spaceNodeKey, e);
                                      if (!e.ctrlKey && !e.metaKey && !e.shiftKey) {
                                        setTreeExpanded(prev => {
                                          const next = new Set(prev);
                                          if (next.has(space.spaceId)) next.delete(space.spaceId); else next.add(space.spaceId);
                                          return next;
                                        });
                                        if (!allInstancesLoaded) void loadAllSpaceInstances();
                                      }
                                    }}
                                  >
                                    <td className="pl-5 pr-2 py-1 border-b border-border/50 font-medium">
                                      <span className="flex items-center gap-1">
                                        {isExpanded ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
                                        <span className="truncate">{space.spaceName}</span>
                                      </span>
                                    </td>
                                    <td className="px-2 py-1 border-b border-border/50 text-right text-muted-foreground text-[10px]">
                                      {spaceInstances.has(space.spaceId) && spaceDestCount > 0 ? spaceDestCount : ''}
                                    </td>
                                  </tr>
                                  {/* Instance rows */}
                                  {isExpanded && (() => {
                                    if (!spaceInstances.has(space.spaceId)) {
                                      return <tr key={`loading-${space.spaceId}`}><td colSpan={2} className="pl-10 pr-2 py-1 text-[10px] text-muted-foreground border-b border-border/50">{allInstancesLoaded ? 'No instances' : 'Loading…'}</td></tr>;
                                    }
                                    if (insts.length === 0) {
                                      return <tr key={`empty-${space.spaceId}`}><td colSpan={2} className="pl-10 pr-2 py-1 text-[10px] text-muted-foreground border-b border-border/50">No instances</td></tr>;
                                    }
                                    return insts.map(inst => {
                                      const instNodeKey   = `inst:${inst.instanceGuid}`;
                                      const isInstSel     = treeSelectedKeys.has(instNodeKey);
                                      const instDestCount = instanceNames.get(inst.instanceGuid)?.length ?? 0;
                                      return (
                                        <tr
                                          key={inst.instanceGuid}
                                          className={rowCls(isInstSel)}
                                          onClick={e => {
                                            handleTreeClick(instNodeKey, e);
                                            void loadInstanceDestNames(inst.instanceGuid, space.spaceName);
                                          }}
                                        >
                                          <td className="pl-10 pr-2 py-1 border-b border-border/50 font-mono truncate">{inst.instanceName}</td>
                                          <td className="px-2 py-1 border-b border-border/50 text-right text-muted-foreground text-[10px]">
                                            {instanceNames.has(inst.instanceGuid) ? instDestCount : ''}
                                          </td>
                                        </tr>
                                      );
                                    });
                                  })()}
                                </>
                              );
                            })}
                          </>
                        );
                      })()}
                        </tbody>
                      </table>
                    </div>
                  </div>
                  {/* Vertical drag divider */}
                  <div
                    onMouseDown={startTreeSplitResize}
                    className="h-1.5 shrink-0 cursor-row-resize bg-border hover:bg-primary/50 transition-colors"
                  />
                  {/* Flat destination list (bottom pane) */}
                  <div className="flex flex-col flex-1 min-h-0 overflow-hidden" style={{ height: `${100 - treeSplitPct}%` }}>
                    {/* Search row — filter + inline action buttons */}
                    <div className="px-2 py-2 border-b border-border shrink-0 flex items-center gap-1">
                      {(() => {
                        const hasSaSel   = treeSelectedKeys.has('sa:root') || treeSelectedKeys.size === 0;
                        const hasInstSel = [...treeSelectedKeys].some(k => k.startsWith('space:') || k.startsWith('inst:'));
                        let instTotal = 0; let instFiltered = 0;
                        if (hasInstSel) {
                          const seen = new Set<string>();
                          for (const nodeKey of treeSelectedKeys) {
                            const guids: string[] = [];
                            if (nodeKey.startsWith('inst:')) { guids.push(nodeKey.slice(5)); }
                            else if (nodeKey.startsWith('space:')) { for (const i of (spaceInstances.get(nodeKey.slice(6)) ?? [])) guids.push(i.instanceGuid); }
                            for (const g of guids) {
                              if (seen.has(g)) continue; seen.add(g);
                              const names = instanceNames.get(g) ?? [];
                              instTotal    += names.length;
                              if (searchQuery) {
                                instFiltered += matchedInstKeys !== null
                                  ? names.filter(n => matchedInstKeys.has(`${g}/${n}`)).length
                                  : names.filter(n => n.toLowerCase().includes(searchQuery.toLowerCase())).length;
                              } else {
                                instFiltered += names.length;
                              }
                            }
                          }
                        }
                        const saTotal       = hasSaSel ? localAllNames.length : 0;
                        const saFiltered    = hasSaSel ? filteredNames.length  : 0;
                        const totalDests    = saTotal    + instTotal;
                        const filteredDests = saFiltered + instFiltered;
                        const matchLabel    = searchQuery && filteredDests !== totalDests ? `${filteredDests} of ${totalDests} matched` : null;
                        const hasMatchLabel = matchLabel !== null;
                        return (
                          <div className="relative flex-1 min-w-0">
                            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
                            <input
                              type="text"
                              value={searchQuery}
                              onChange={e => {
                                setSearchQuery(e.target.value);
                                if (!e.target.value.trim()) { setFilteredNames(localAllNames); setMatchedInstKeys(null); }
                              }}
                              onKeyDown={e => { if (e.key === 'Enter') void runSearch(searchQuery); }}
                              placeholder={`Search within ${totalDests} destinations`}
                              className={`w-full h-7 pl-7 text-xs border border-border rounded bg-background focus:outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50 ${searchQuery ? (hasMatchLabel ? 'pr-28' : 'pr-6') : 'pr-2'}`}
                            />
                            {isSearching && <RefreshCw className="absolute right-6 top-1/2 -translate-y-1/2 h-3 w-3 animate-spin text-muted-foreground pointer-events-none" />}
                            {!isSearching && hasMatchLabel && (
                              <span className="absolute right-6 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground/60 pointer-events-none whitespace-nowrap">{matchLabel}</span>
                            )}
                            {!isSearching && searchQuery && !hasMatchLabel && (
                              <span className="absolute right-6 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground/40 pointer-events-none">↵</span>
                            )}
                            {searchQuery && (
                              <button onClick={() => { setSearchQuery(''); setFilteredNames(localAllNames); setMatchedInstKeys(null); }} className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors p-0.5" tabIndex={-1}>
                                <X className="h-3 w-3" />
                              </button>
                            )}
                          </div>
                        );
                      })()}
                      {renderFilterToolbar({
                        onExport: async () => {
                          const toExport: { instanceGuid: string; spaceName: string; name: string }[] = [];
                          for (const dk of selectedDestKeys) {
                            const slashIdx = dk.indexOf('/');
                            if (slashIdx < 0) continue;
                            const prefix = dk.slice(0, slashIdx);
                            const name   = dk.slice(slashIdx + 1);
                            if (prefix !== 'sa') {
                              let sName = '';
                              for (const [sid, insts] of spaceInstances) {
                                if (insts.find(x => x.instanceGuid === prefix)) {
                                  sName = (org.org?.spaces ?? []).find(s => s.spaceId === sid)?.spaceName ?? '';
                                  break;
                                }
                              }
                              toExport.push({ instanceGuid: prefix, spaceName: sName, name });
                            }
                          }
                          if (treeSelectedKeys.size === 0) { await handleExport(); return; }
                          if (toExport.length === 0) return;
                          const all: Record<string, unknown>[] = [];
                          for (const { instanceGuid, spaceName, name } of toExport) {
                            try {
                              const res = await fetch(`/api/destinations/${enc(org.region)}/${enc(org.subdomain)}/spaces/${enc(spaceName)}/instances/${enc(instanceGuid)}/${enc(name)}/export`);
                              if (res.ok) all.push(await res.json() as Record<string, unknown>);
                            } catch { /* skip */ }
                          }
                          if (all.length === 0) return;
                          const blob = new Blob([JSON.stringify(all.length === 1 ? all[0] : all, null, 2)], { type: 'application/json' });
                          const href = URL.createObjectURL(blob);
                          const a = Object.assign(document.createElement('a'), { href, download: `${org.region}_${org.subdomain}_instance_destinations.json` });
                          document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(href);
                        },
                        exportDisabled: selectedDestKeys.size === 0,
                        exportTitle: selectedDestKeys.size > 1 ? `Export ${selectedDestKeys.size} selected` : selectedDestKeys.size === 1 ? 'Export selected' : 'Select destinations to export',
                        exportCount: selectedDestKeys.size,
                        compareCount: selectedDestKeys.size,
                        onCompare: () => {
                          const destsForCompare: SelectedDest[] = [];
                          for (const dk of selectedDestKeys) {
                            const slashIdx = dk.indexOf('/');
                            if (slashIdx < 0) continue;
                            const prefix = dk.slice(0, slashIdx);
                            const name   = dk.slice(slashIdx + 1);
                            if (prefix === 'sa') {
                              destsForCompare.push({ region: org.region, subdomain: org.subdomain, name });
                            } else {
                              let spaceName = ''; let instanceName = '';
                              for (const [sid, insts] of spaceInstances) {
                                const i = insts.find(x => x.instanceGuid === prefix);
                                if (i) { instanceName = i.instanceName; spaceName = (org.org?.spaces ?? []).find(s => s.spaceId === sid)?.spaceName ?? ''; break; }
                              }
                              destsForCompare.push({ region: org.region, subdomain: org.subdomain, name, spaceName: spaceName || undefined, instanceName: instanceName || undefined, instanceGuid: prefix });
                            }
                          }
                          onOpenCompare?.(destsForCompare);
                        },
                        isCreatingMode: isCreating,
                      })}
                    </div>
                    <div
                      ref={listRef}
                      className="flex-1 overflow-auto py-1"
                      onKeyDown={e => {
                        if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
                          e.preventDefault();
                          const hasSaSelected   = treeSelectedKeys.has('sa:root') || treeSelectedKeys.size === 0;
                          const hasInstSelected = [...treeSelectedKeys].some(k => k.startsWith('space:') || k.startsWith('inst:'));
                          const allDks: string[] = [];
                          if (hasSaSelected) {
                            for (const n of filteredNames) allDks.push(`sa/${n}`);
                          }
                          if (hasInstSelected) {
                            const seen = new Set<string>();
                            for (const nodeKey of treeSelectedKeys) {
                              if (nodeKey.startsWith('inst:')) {
                                const guid = nodeKey.slice(5);
                                if (!seen.has(guid)) { seen.add(guid); for (const n of (instanceNames.get(guid) ?? [])) { const ik = `${guid}/${n}`; if (!searchQuery || (matchedInstKeys !== null ? matchedInstKeys.has(ik) : n.toLowerCase().includes(searchQuery.toLowerCase()))) allDks.push(ik); } }
                              } else if (nodeKey.startsWith('space:')) {
                                const sid = nodeKey.slice(6);
                                for (const inst of (spaceInstances.get(sid) ?? [])) {
                                  if (!seen.has(inst.instanceGuid)) { seen.add(inst.instanceGuid); for (const n of (instanceNames.get(inst.instanceGuid) ?? [])) { const ik = `${inst.instanceGuid}/${n}`; if (!searchQuery || (matchedInstKeys !== null ? matchedInstKeys.has(ik) : n.toLowerCase().includes(searchQuery.toLowerCase()))) allDks.push(ik); } }
                                }
                              }
                            }
                          }
                          setSelectedDestKeys(new Set(allDks));
                          if (allDks.length > 0) setLastClickDestKey(allDks[allDks.length - 1]!);
                        }
                      }}
                      tabIndex={0}
                    >
                      {(() => {
                        // Collect rows from all selected tree nodes; if nothing selected show subaccount dests
                        const hasSaSelected   = treeSelectedKeys.has('sa:root') || treeSelectedKeys.size === 0;
                        const hasInstSelected = [...treeSelectedKeys].some(k => k.startsWith('space:') || k.startsWith('inst:'));

                        // Collect SA-level dests if SA root selected or nothing selected
                        const saRows = hasSaSelected ? filteredNames : [];

                        // Collect instance dests if space/inst nodes selected
                        type InstRow = { instanceGuid: string; instanceName: string; spaceName: string; name: string };
                        const instRows: InstRow[] = [];
                        if (hasInstSelected) {
                          const seenInst = new Set<string>();
                          for (const nodeKey of treeSelectedKeys) {
                            if (nodeKey.startsWith('inst:')) {
                              const instGuid = nodeKey.slice(5);
                              if (seenInst.has(instGuid)) continue;
                              seenInst.add(instGuid);
                              let instName = ''; let sName = '';
                              for (const [sid, insts] of spaceInstances) {
                                const i = insts.find(x => x.instanceGuid === instGuid);
                                if (i) { instName = i.instanceName; sName = (org.org?.spaces ?? []).find(s => s.spaceId === sid)?.spaceName ?? ''; break; }
                              }
                              for (const n of (instanceNames.get(instGuid) ?? [])) {
                                const ik = `${instGuid}/${n}`;
                                if (!searchQuery || (matchedInstKeys !== null ? matchedInstKeys.has(ik) : n.toLowerCase().includes(searchQuery.toLowerCase()))) instRows.push({ instanceGuid: instGuid, instanceName: instName, spaceName: sName, name: n });
                              }
                            } else if (nodeKey.startsWith('space:')) {
                              const spaceId = nodeKey.slice(6);
                              const space   = (org.org?.spaces ?? []).find(s => s.spaceId === spaceId);
                              if (!space) continue;
                              for (const inst of (spaceInstances.get(spaceId) ?? [])) {
                                if (seenInst.has(inst.instanceGuid)) continue;
                                seenInst.add(inst.instanceGuid);
                                for (const n of (instanceNames.get(inst.instanceGuid) ?? [])) {
                                  const ik = `${inst.instanceGuid}/${n}`;
                                  if (!searchQuery || (matchedInstKeys !== null ? matchedInstKeys.has(ik) : n.toLowerCase().includes(searchQuery.toLowerCase()))) instRows.push({ instanceGuid: inst.instanceGuid, instanceName: inst.instanceName, spaceName: space.spaceName, name: n });
                                }
                              }
                            }
                          }
                        }

                        const totalRows = saRows.length + instRows.length;

                        if (totalRows === 0 && treeSelectedKeys.size > 0) {
                          return <div className="px-3 py-2 text-[10px] text-muted-foreground">{allInstancesLoaded ? 'No destinations found' : 'Loading…'}</div>;
                        }

                        // Render SA dest rows
                        const saElements = saRows.map((name, idx) => {
                          const dk        = `sa/${name}`;
                          const isPrimary  = name === selectedName && !isCreating && !activeInstScope;
                          const isSelDest  = selectedDestKeys.has(dk);
                          return (
                            <button
                              key={dk}
                              data-selected={isPrimary ? 'true' : undefined}
                              onClick={e => {
                                if (e.ctrlKey || e.metaKey) {
                                  setSelectedDestKeys(prev => { const n = new Set(prev); n.has(dk) ? n.delete(dk) : n.add(dk); return n; });
                                  setLastClickDestKey(dk);
                                } else if (e.shiftKey && lastClickDestKey) {
                                  const allDks = filteredNames.map(n => `sa/${n}`);
                                  const a = allDks.indexOf(lastClickDestKey), b = idx;
                                  const [lo, hi] = a <= b ? [a, b] : [b, a];
                                  setSelectedDestKeys(new Set(allDks.slice(lo, hi + 1)));
                                } else {
                                  handleDestClick(name, idx, e);
                                  setActiveInstScope(null);
                                  setSelectedDestKeys(new Set([dk]));
                                  setLastClickDestKey(dk);
                                }
                              }}
                              className={`w-full text-left px-3 py-1.5 text-xs font-mono truncate transition-colors select-none ${isPrimary ? 'bg-primary/20 text-primary font-semibold' : isSelDest ? 'bg-primary/10 text-primary' : 'text-foreground hover:bg-muted/40'}`}
                            >
                              {name}
                            </button>
                          );
                        });

                        // Render instance dest rows
                        const instElements = instRows.map((row, rowIdx) => {
                          const dk        = `${row.instanceGuid}/${row.name}`;
                          const isPrimary  = row.name === selectedName && activeInstScope?.instanceGuid === row.instanceGuid;
                          const isSelDest  = selectedDestKeys.has(dk);
                          return (
                            <button
                              key={dk}
                              data-selected={isPrimary ? 'true' : undefined}
                              onClick={e => {
                                if (e.ctrlKey || e.metaKey) {
                                  setSelectedDestKeys(prev => { const n = new Set(prev); n.has(dk) ? n.delete(dk) : n.add(dk); return n; });
                                  setLastClickDestKey(dk);
                                } else if (e.shiftKey && lastClickDestKey) {
                                  const allDks = instRows.map(r => `${r.instanceGuid}/${r.name}`);
                                  const a = allDks.indexOf(lastClickDestKey), b = rowIdx;
                                  const [lo, hi] = a <= b ? [a, b] : [b, a];
                                  setSelectedDestKeys(new Set(allDks.slice(lo, hi + 1)));
                                } else {
                                  setSelectedDestKeys(new Set([dk]));
                                  setLastClickDestKey(dk);
                                  loadInstDest(row.spaceName, row.instanceGuid, row.instanceName, row.name);
                                }
                              }}
                              className={`w-full text-left px-3 py-1.5 text-xs font-mono truncate transition-colors select-none ${isPrimary ? 'bg-primary/20 text-primary font-semibold' : isSelDest ? 'bg-primary/10 text-primary' : 'text-foreground hover:bg-muted/40'}`}
                            >
                              <><span className="text-muted-foreground text-[10px]">{row.spaceName} › {row.instanceName} › </span>{row.name}</>
                            </button>
                          );
                        });

                        return [...saElements, ...instElements];
                      })()}
                    </div>
                  </div>
                </div>
                {/* Horizontal drag divider */}
                <div onMouseDown={startSplitResize} className="w-1.5 shrink-0 cursor-col-resize bg-border hover:bg-primary/50 transition-colors" />
              </>
            ) : (
            <>
            <div className="border-r border-border flex flex-col shrink-0 min-w-0" style={{ width: `${splitPct}%` }}>
              {/* Search row — filter + inline action buttons */}
              <div className="px-2 py-2 border-b border-border flex items-center gap-1">
                <div className="relative flex-1 min-w-0">
                  <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={e => {
                      setSearchQuery(e.target.value);
                      if (!e.target.value.trim()) { setFilteredNames(localAllNames); setMatchedInstKeys(null); }
                    }}
                    onKeyDown={e => { if (e.key === 'Enter') void runSearch(searchQuery); }}
                    placeholder={`Search within ${localAllNames.length} destinations`}
                    className={`w-full h-7 pl-7 text-xs border border-border rounded bg-background focus:outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50 ${searchQuery ? (filteredNames.length !== localAllNames.length ? 'pr-28' : 'pr-6') : 'pr-2'}`}
                  />
                  {isSearching && <RefreshCw className="absolute right-6 top-1/2 -translate-y-1/2 h-3 w-3 animate-spin text-muted-foreground pointer-events-none" />}
                  {!isSearching && searchQuery && filteredNames.length !== localAllNames.length && (
                    <span className="absolute right-6 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground/60 pointer-events-none whitespace-nowrap">{filteredNames.length} of {localAllNames.length} matched</span>
                  )}
                  {!isSearching && searchQuery && filteredNames.length === localAllNames.length && (
                    <span className="absolute right-6 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground/40 pointer-events-none">↵</span>
                  )}
                  {searchQuery && (
                    <button
                      onClick={() => { setSearchQuery(''); setFilteredNames(localAllNames); setMatchedInstKeys(null); }}
                      className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors p-0.5"
                      tabIndex={-1}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </div>
                {renderFilterToolbar({
                  onExport: handleExport,
                  exportDisabled: selectedNames.size === 0 && !selectedName,
                  exportTitle,
                  exportCount: selectedNames.size,
                  compareCount: selectedNames.size,
                  onCompare: () => onOpenCompare?.([...selectedNames].map(name => ({ region: org.region, subdomain: org.subdomain, name }))),
                  isCreatingMode: isCreating,
                })}
              </div>
              <div
                ref={listRef}
                className="flex-1 overflow-auto py-1"
                onKeyDown={e => {
                  if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
                    e.preventDefault();
                    setSelectedNames(new Set(filteredNames));
                    setSelectedDestKeys(new Set(filteredNames.map(n => `sa/${n}`)));
                    if (filteredNames.length > 0) setLastClickName(filteredNames[filteredNames.length - 1]!);
                  }
                }}
                tabIndex={0}
              >
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
            </div>
            {/* Horizontal drag divider */}
            <div onMouseDown={startSplitResize} className="w-1.5 shrink-0 cursor-col-resize bg-border hover:bg-primary/50 transition-colors" />
            </>
            )
          )}

          {/* Right panel */}
          <div className="flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden">

            {/* Name bar: toggle + dest name + Compare/Reset/Save (matches left filter bar height) */}
            <div className="flex items-center gap-2 px-2 py-2 border-b border-border shrink-0 min-h-[44px]">
              <button
                onClick={() => setShowList(v => !v)}
                className={`p-1.5 rounded transition-colors shrink-0 ${showList ? 'text-muted-foreground hover:text-foreground hover:bg-accent/50' : 'bg-accent text-foreground'}`}
                title={showList ? 'Hide destination list' : 'Show destination list'}
              >
                <PanelLeft className="h-3.5 w-3.5" />
              </button>
              <span className="text-xs font-semibold font-mono truncate flex-1 min-w-0 flex flex-col gap-0 leading-tight">
                {isCreating ? (
                  <span className="text-muted-foreground font-normal not-italic">New Destination</span>
                ) : selectedName ? (
                  <>
                    <span className="truncate">{selectedName}</span>
                    {activeInstScope && (
                      <span className="text-[10px] font-normal text-muted-foreground truncate">{activeInstScope.spaceName} › {activeInstScope.instanceName}</span>
                    )}
                  </>
                ) : (
                  <span className="text-muted-foreground font-normal">—</span>
                )}
              </span>
              {activeTab === 'properties' && !isCreating && (
                <div className="flex items-center gap-1 shrink-0">
                  {onToggleCompare && (
                    <button
                      onClick={() => {
                        onToggleCompare({
                          region:       org.region,
                          subdomain:    org.subdomain,
                          name:         selectedName,
                          spaceName:    activeInstScope?.spaceName,
                          instanceName: activeInstScope?.instanceName,
                          instanceGuid: activeInstScope?.instanceGuid,
                        });
                      }}
                      disabled={!selectedName}
                      className={(() => {
                        const compareSelected = selectedDests?.some(
                          d => d.region === org.region && d.subdomain === org.subdomain && d.name === selectedName &&
                            (activeInstScope ? d.instanceGuid === activeInstScope.instanceGuid : !d.instanceGuid),
                        );
                        return compareSelected
                          ? `${btnBase} border border-primary bg-primary/10 text-primary`
                          : btnOutline;
                      })()}
                      title={selectedDests?.some(d => d.region === org.region && d.subdomain === org.subdomain && d.name === selectedName && (activeInstScope ? d.instanceGuid === activeInstScope.instanceGuid : !d.instanceGuid))
                        ? 'Remove from comparison basket' : 'Add to comparison basket'}
                    >
                      <GitCompare className="h-3.5 w-3.5" />
                      {maximized && (
                        <span className="max-[680px]:hidden">
                          {selectedDests?.some(d => d.region === org.region && d.subdomain === org.subdomain && d.name === selectedName && (activeInstScope ? d.instanceGuid === activeInstScope.instanceGuid : !d.instanceGuid))
                            ? 'In Compare' : 'Select for Compare'}
                        </span>
                      )}
                    </button>
                  )}
                  <button
                    onClick={() => { setEditedProps(structuredClone(serverProps)); setSaveBanner(null); }}
                    disabled={!isDirty || isSaving || isImportRunning}
                    className={btnOutline}
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    {maximized && <span className="max-[680px]:hidden">Reset</span>}
                  </button>
                  <button
                    onClick={handleSave}
                    disabled={!selectedName || !isDirty || isSaving || isImportRunning}
                    className={`${btnBase} bg-primary text-primary-foreground hover:bg-primary/90`}
                  >
                    <Save className="h-3.5 w-3.5" />
                    {maximized && <span className="max-[680px]:hidden">{isSaving ? 'Saving…' : 'Save'}</span>}
                  </button>
                </div>
              )}
            </div>

            {/* Tab bar */}
            <div className="flex items-center border-b border-border shrink-0">
              <button className={tabCls(activeTab === 'properties')} onClick={() => handleTabChange('properties')}>
                {isCreating ? 'New Destination' : 'Properties'}
              </button>
              <button className={tabCls(activeTab === 'changelog')} onClick={() => { setIsCreating(false); handleTabChange('changelog'); }}>History</button>
              <button className={tabCls(activeTab === 'test')}      onClick={() => { setIsCreating(false); handleTabChange('test'); }}>Test</button>
            </div>

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
                loading={isLoading}
                banner={saveBanner}
                onUpdate={(idx, patch) => setEditedProps(prev => prev.map((p, i) => i === idx ? { ...p, ...patch } : p))}
                onDelete={idx => setEditedProps(prev => prev.filter((_, i) => i !== idx))}
                onAdd={() => setEditedProps(prev => [...prev, { key: '', value: '', isSensitive: false, revealed: false }])}
                onClearBanner={() => setSaveBanner(null)}
              />
            )}
            {activeTab === 'changelog' && (
              <ChangelogTab changelog={changelog} loading={isLoadingChangelog} />
            )}
            {activeTab === 'test' && <TestTab />}
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
        <ImportDialog
          open={importDialogOpen}
          onClose={() => setImportDialogOpen(false)}
          org={org}
          spaceInstances={spaceInstances}
          treeSelectedKeys={treeSelectedKeys}
          importItems={importItems}
          onConfirm={targets => void runImport(targets)}
          progress={importProgress}
          summary={importSummary}
        />
      </div>
    </div>
  );
}

function ImportDialog({ open, onClose, org, spaceInstances, treeSelectedKeys, importItems, onConfirm, progress, summary }: {
  open: boolean; onClose: () => void;
  org: SubaccountEntry;
  spaceInstances: Map<string, Array<{ instanceGuid: string; instanceName: string }>>;
  treeSelectedKeys: Set<string>;
  importItems: Record<string, unknown>[];
  onConfirm: (targets: ImportTarget[]) => void;
  progress: { done: number; total: number; lastDest?: string; lastAction?: 'created' | 'updated' | 'error' } | null;
  summary: { created: number; updated: number; errors: string[] } | null;
}) {
  const targets   = getImportTargets(treeSelectedKeys, spaceInstances, org);
  const isRunning = progress !== null && progress.done < progress.total;
  const isDone    = summary !== null;
  return (
    <Dialog open={open} onOpenChange={v => { if (!v && !isRunning) onClose(); }}>
      <DialogContent className="max-w-2xl w-full">
        <DialogHeader>
          <DialogTitle>Import Destinations</DialogTitle>
        </DialogHeader>

        <div className="flex gap-3 min-h-[160px] max-h-[360px]">
          <div className="flex-1 overflow-auto border rounded p-2 space-y-0.5 text-xs">
            <p className="font-medium text-muted-foreground mb-1.5">Import into ({targets.length} scope{targets.length !== 1 ? 's' : ''})</p>
            {targets.map((t, i) => (
              <div key={i} className="text-foreground truncate py-0.5">
                {t.type === 'sa'
                  ? `${org.alias ?? org.subdomain} — subaccount`
                  : `${t.spaceName} › ${t.instanceName}`}
              </div>
            ))}
          </div>
          <div className="flex-1 overflow-auto border rounded p-2 space-y-0.5 text-xs">
            <p className="font-medium text-muted-foreground mb-1.5">{importItems.length} destination{importItems.length !== 1 ? 's' : ''}</p>
            {importItems.map((item, i) => (
              <div key={i} className="font-mono text-foreground truncate py-0.5">{String(item['Name'])}</div>
            ))}
          </div>
        </div>

        {/* Status / summary banner */}
        <div className={`relative px-3 py-2 rounded border text-xs overflow-hidden ${
            isDone && summary!.errors.length > 0 && summary!.created + summary!.updated === 0
              ? 'bg-destructive/5 border-destructive/20 text-destructive'
              : isDone && summary!.errors.length > 0
              ? 'bg-amber-500/5 border-amber-500/20 text-amber-700 dark:text-amber-400'
              : isDone
              ? 'bg-green-500/5 border-green-500/20 text-green-700 dark:text-green-400'
              : isRunning
              ? 'bg-muted/30 border-border text-muted-foreground'
              : 'bg-muted/20 border-border text-muted-foreground'
          }`}>
            {isRunning && progress && (
              <div className="absolute bottom-0 left-0 h-0.5 w-full bg-primary/20">
                <div
                  className="h-full bg-primary transition-all duration-200"
                  style={{ width: `${progress.total > 0 ? Math.round(progress.done / progress.total * 100) : 0}%` }}
                />
              </div>
            )}
            {isRunning && progress && (
              <span>
                {progress.done} of {progress.total} {progress.lastAction === 'created' ? 'created' : progress.lastAction === 'updated' ? 'updated' : progress.lastAction === 'error' ? 'failed' : 'pending'}
                {progress.lastDest ? `: ${progress.lastDest}` : ''}
              </span>
            )}
            {isDone && summary!.errors.length === 0 && (
              <span>
                Success: {summary!.created + summary!.updated} destination{summary!.created + summary!.updated !== 1 ? 's' : ''} imported
                ({summary!.created} created, {summary!.updated} updated) in {targets.length} scope{targets.length !== 1 ? 's' : ''}
              </span>
            )}
            {isDone && summary!.errors.length > 0 && (
              <div className="space-y-1">
                <span className="font-medium">
                  {summary!.created + summary!.updated > 0 ? 'Warning' : 'Error'}:{' '}
                  {summary!.created + summary!.updated} of {progress?.total ?? (importItems.length * targets.length)} destinations imported
                  ({summary!.created} created, {summary!.updated} updated) in {targets.length} scope{targets.length !== 1 ? 's' : ''};
                  however the following destinations failed:
                </span>
                <ul className="mt-1 space-y-0.5 list-none">
                  {summary!.errors.map((e, i) => <li key={i} className="font-mono truncate">{e}</li>)}
                </ul>
              </div>
            )}
            {!isRunning && !isDone && (
              <span>Existing destinations with matching names will be overwritten.</span>
            )}
          </div>

        <DialogFooter>
          {!isDone && <Button variant="outline" size="sm" onClick={onClose} disabled={isRunning}>Cancel</Button>}
          {!isDone && (
            <Button size="sm" onClick={() => onConfirm(targets)} disabled={isRunning || targets.length === 0 || importItems.length === 0}>
              Import {importItems.length} destination{importItems.length !== 1 ? 's' : ''}
            </Button>
          )}
          {isDone && <Button size="sm" onClick={onClose}>Close</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function enc(s: string) { return encodeURIComponent(s); }
