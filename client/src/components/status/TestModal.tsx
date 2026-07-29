import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Separator } from '@/components/ui/separator';
import { PlayCircle, RotateCw, Copy, Check, ChevronDown, ChevronRight } from 'lucide-react';

interface ConditionResult {
  condition: string;
  passed: boolean;
  actual: string;
  expected: string;
}

interface RetryAttempt {
  attempt: number;
  conditions: ConditionResult[];
  passed: boolean;
  request: { url: string; method: string; headers: Record<string, string>; body: string | null };
  response: { status: number; headers: Record<string, string>; body: string };
  responseTime: number;
  screenshotUrl?: string;
  consoleText?: string;
  htmlText?: string;
}

interface EndpointCheckResult {
  index: number;
  name: string;
  conditions: ConditionResult[];
  passed: boolean;
  partiallyFailed?: boolean;
  retries?: RetryAttempt[];
  request: { url: string; method: string; headers: Record<string, string>; body: string | null };
  response: { status: number; headers: Record<string, string>; body: string };
  responseTime: number;
  screenshotUrl?: string;
  consoleText?: string;
  htmlText?: string;
}

interface CheckResult {
  success: boolean;
  message: string;
  details: EndpointCheckResult[];
}

interface Props {
  serviceName: string;
  open: boolean;
  onClose: () => void;
  onComplete: () => void;
}

function prettify(body: string): string {
  if (!body) return '(empty)';
  try { return JSON.stringify(JSON.parse(body), null, 2); } catch { return body; }
}

function HeaderTable({ headers }: { headers: Record<string, string> }) {
  const entries = Object.entries(headers);
  if (entries.length === 0) return <span className="text-xs text-muted-foreground italic">none</span>;
  return (
    <table className="w-full text-xs font-mono">
      <tbody>
        {entries.map(([k, v]) => (
          <tr key={k} className="border-b border-border last:border-0">
            <td className="py-1 pr-3 text-muted-foreground whitespace-nowrap align-top">{k}</td>
            <td className="py-1 break-all">{v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="text-xs text-muted-foreground font-medium uppercase tracking-wide">{label}</div>
      {children}
    </div>
  );
}

export default function TestModal({ serviceName, open, onClose, onComplete }: Props) {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<CheckResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [collapsedRetries, setCollapsedRetries] = useState<Set<string>>(new Set());

  function toggleCollapse(idx: number) {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx); else next.add(idx);
      return next;
    });
  }

  function toggleRetry(key: string) {
    setCollapsedRetries(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  const healthUrl = `${window.location.origin}/health/${encodeURIComponent(serviceName)}`;

  function copyUrl() {
    navigator.clipboard.writeText(healthUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => null);
  }

  function handleClose() {
    setResult(null);
    setError(null);
    setElapsed(null);
    setCollapsed(new Set());
    setCollapsedRetries(new Set());
    onClose();
  }

  async function runTest() {
    setRunning(true);
    setResult(null);
    setError(null);
    setElapsed(null);
    setCollapsed(new Set());
    setCollapsedRetries(new Set());
    const start = Date.now();
    try {
      const resp = await fetch(`/api/status/check/${encodeURIComponent(serviceName)}`);
      setElapsed(Date.now() - start);
      if (!resp.ok) {
        let msg = `Server error ${resp.status}`;
        try {
          const body = await resp.json() as { error?: string };
          if (body.error) msg = body.error;
        } catch { /* keep HTTP status message */ }
        setError(msg);
        return;
      }
      const data = await resp.json() as CheckResult;
      setResult(data);
      onComplete();
    } catch (e) {
      setElapsed(Date.now() - start);
      setError(String(e));
    } finally {
      setRunning(false);
    }
  }

  const passedCount = result?.details.filter(d => d.passed).length ?? 0;
  const totalCount = result?.details.length ?? 0;

  return (
    <Dialog open={open} onOpenChange={(o: boolean) => { if (!o) handleClose(); }}>
      <DialogContent className="max-w-3xl max-h-[85vh] flex flex-col gap-3">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 flex-wrap">
            <PlayCircle className="h-4 w-4 flex-shrink-0" />
            <span>Test — {serviceName}</span>
            {result && (
              <Badge
                variant={result.success ? 'outline' : 'destructive'}
                className={result.success ? 'border-green-600 text-green-400' : ''}
              >
                {result.success ? 'PASS' : 'FAIL'}
              </Badge>
            )}
            {elapsed !== null && (
              <span className="text-xs font-normal text-muted-foreground">{elapsed}ms total</span>
            )}
            {result && (
              <span className="text-xs font-normal text-muted-foreground">
                {passedCount}/{totalCount} endpoints passed
              </span>
            )}
          </DialogTitle>
        </DialogHeader>

        {/* Latest check URL + action buttons */}
        <div className="flex-shrink-0 space-y-1">
          <div className="flex items-center gap-1">
            <span className="text-xs font-medium text-muted-foreground">Latest check</span>
            <span
              className="text-xs text-muted-foreground cursor-help"
              title="Call this URL to see the latest endpoint check result from the same region. Returns 200 OK, 200 Partially OK (initial failed but retry succeeded), or 500 service down. Designed for Traffic Manager probes — fast response, no live check."
            >ⓘ</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs text-muted-foreground bg-muted rounded px-2 py-1.5 truncate flex-1 min-w-0">
              {healthUrl}
            </span>
            <Button size="sm" variant="outline" onClick={copyUrl} className="gap-1.5 flex-shrink-0">
              {copied ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? 'Copied!' : 'Copy URL'}
            </Button>
            <Button size="sm" onClick={runTest} disabled={running} className="gap-1.5 flex-shrink-0">
              {running ? (
                <><RotateCw className="h-3.5 w-3.5 animate-spin" />Running…</>
              ) : result ? (
                <><RotateCw className="h-3.5 w-3.5" />Run Again</>
              ) : (
                <><PlayCircle className="h-3.5 w-3.5" />Run Test</>
              )}
            </Button>
          </div>
        </div>

        {error && (
          <div className="text-destructive text-sm bg-destructive/10 rounded p-3 flex-shrink-0">
            {error}
          </div>
        )}

        {/* Results */}
        {result && (
          <div className="flex-1 min-h-0 overflow-y-auto">
            <div className="space-y-5 pr-1">
              {result.details.map((ep, epIdx) => (
                <div key={ep.index}>
                  {epIdx > 0 && <Separator className="mb-4" />}

                  {/* Endpoint header with collapse toggle */}
                  <div className="flex items-center gap-2 mb-3">
                    <button
                      onClick={() => toggleCollapse(epIdx)}
                      className="text-muted-foreground hover:text-foreground flex-shrink-0"
                      title={collapsed.has(epIdx) ? 'Expand' : 'Collapse'}
                    >
                      {collapsed.has(epIdx)
                        ? <ChevronRight className="h-4 w-4" />
                        : <ChevronDown className="h-4 w-4" />}
                    </button>
                    <span className={`w-2 h-2 rounded-full flex-shrink-0 ${ep.passed ? 'bg-green-500' : 'bg-red-500'}`} />
                    <span className="text-sm font-semibold">{ep.name}</span>
                    <span className="text-xs text-muted-foreground">{ep.responseTime}ms</span>
                    <Badge
                      variant={ep.passed ? 'outline' : 'destructive'}
                      className={`text-xs ml-auto ${ep.passed ? 'border-green-600 text-green-400' : ''}`}
                    >
                      {ep.passed ? 'PASS' : 'FAIL'}
                    </Badge>
                  </div>

                  {/* Per-endpoint tabs — hidden when collapsed */}
                  {!collapsed.has(epIdx) && <Tabs defaultValue="conditions">
                    <TabsList className="h-8">
                      <TabsTrigger value="conditions" className="text-xs h-7">
                        Conditions
                        {ep.conditions.some(c => !c.passed) && (
                          <span className="ml-1.5 text-red-400">
                            ({ep.conditions.filter(c => !c.passed).length} failed)
                          </span>
                        )}
                      </TabsTrigger>
                      {ep.request.method === 'BROWSER' && ep.screenshotUrl && (
                        <TabsTrigger value="screenshot" className="text-xs h-7">Screenshot</TabsTrigger>
                      )}
                      {ep.request.method === 'BROWSER' && ep.htmlText && (
                        <TabsTrigger value="pagesource" className="text-xs h-7">Page Source</TabsTrigger>
                      )}
                      {ep.request.method === 'BROWSER' && ep.consoleText && (
                        <TabsTrigger value="console" className="text-xs h-7">Console</TabsTrigger>
                      )}
                      {ep.request.method !== 'BROWSER' && (
                        <TabsTrigger value="request" className="text-xs h-7">Request</TabsTrigger>
                      )}
                      {ep.request.method !== 'BROWSER' && (
                        <TabsTrigger value="response" className="text-xs h-7">
                          Response
                          {ep.response.status > 0 && (
                            <span className={`ml-1.5 ${ep.response.status < 400 ? 'text-green-400' : 'text-red-400'}`}>
                              {ep.response.status}
                            </span>
                          )}
                        </TabsTrigger>
                      )}
                    </TabsList>

                    {/* Conditions tab */}
                    <TabsContent value="conditions" className="mt-2">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead className="h-8 text-xs">Condition</TableHead>
                            <TableHead className="h-8 text-xs w-10">Result</TableHead>
                            <TableHead className="h-8 text-xs">Actual</TableHead>
                            <TableHead className="h-8 text-xs">Expected</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {ep.conditions.map((c, ci) => (
                            <TableRow key={ci} className={c.passed ? '' : 'bg-destructive/10'}>
                              <TableCell className="font-mono text-xs py-2">{c.condition}</TableCell>
                              <TableCell className="py-2">
                                <span className={c.passed ? 'text-green-500' : 'text-red-500'}>
                                  {c.passed ? '✓' : '✗'}
                                </span>
                              </TableCell>
                              <TableCell className="font-mono text-xs py-2 max-w-[220px] truncate" title={c.actual}>
                                {c.actual}
                              </TableCell>
                              <TableCell className="font-mono text-xs py-2">{c.expected}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </TabsContent>

                    {/* Request tab */}
                    <TabsContent value="request" className="mt-2 space-y-4">
                      <Section label="URL">
                        <div className="font-mono text-xs bg-muted rounded px-2 py-1.5 break-all">
                          <span className="text-muted-foreground mr-2">{ep.request.method}</span>
                          {ep.request.url}
                        </div>
                      </Section>
                      <Section label="Headers">
                        <div className="bg-muted rounded px-2 py-1.5">
                          <HeaderTable headers={ep.request.headers} />
                        </div>
                      </Section>
                      <Section label="Body">
                        <pre className="font-mono text-xs bg-muted rounded px-2 py-1.5 whitespace-pre-wrap break-all max-h-40 overflow-auto">
                          {ep.request.body ? prettify(ep.request.body) : <span className="text-muted-foreground italic">none</span>}
                        </pre>
                      </Section>
                    </TabsContent>

                    {/* Response tab */}
                    <TabsContent value="response" className="mt-2 space-y-4">
                      <Section label="Status">
                        <div className="flex items-center gap-3">
                          <span className={`font-mono text-sm font-bold ${
                            ep.response.status === 0 ? 'text-red-400' :
                            ep.response.status < 300 ? 'text-green-400' :
                            ep.response.status < 400 ? 'text-yellow-400' : 'text-red-400'
                          }`}>
                            {ep.response.status === 0 ? 'Connection error' : ep.response.status}
                          </span>
                          <span className="text-xs text-muted-foreground">{ep.responseTime}ms</span>
                        </div>
                      </Section>
                      <Section label="Headers">
                        <div className="bg-muted rounded px-2 py-1.5">
                          <HeaderTable headers={ep.response.headers} />
                        </div>
                      </Section>
                      <Section label="Body">
                        <pre className="font-mono text-xs bg-muted rounded px-2 py-1.5 whitespace-pre-wrap break-all max-h-48 overflow-auto">
                          {ep.response.body ? prettify(ep.response.body) : <span className="text-muted-foreground italic">empty</span>}
                        </pre>
                      </Section>
                    </TabsContent>

                    {/* Screenshot tab (browser checks) */}
                    {ep.screenshotUrl && (
                      <TabsContent value="screenshot" className="mt-2">
                        <img
                          src={ep.screenshotUrl}
                          alt="Login screenshot"
                          className="w-full rounded border border-border"
                        />
                      </TabsContent>
                    )}

                    {/* Page Source tab (browser checks) */}
                    {ep.htmlText && (
                      <TabsContent value="pagesource" className="mt-2">
                        <pre className="text-xs font-mono bg-muted rounded p-2 whitespace-pre-wrap break-all max-h-96 overflow-auto">
                          {ep.htmlText}
                        </pre>
                      </TabsContent>
                    )}

                    {/* Console tab (browser checks) */}
                    {ep.consoleText && (
                      <TabsContent value="console" className="mt-2">
                        <pre className="text-xs font-mono bg-muted rounded p-2 whitespace-pre-wrap break-all max-h-96 overflow-auto">
                          {ep.consoleText}
                        </pre>
                      </TabsContent>
                    )}
                  </Tabs>}

                  {/* Retry sections — same visual style as endpoint sections */}
                  {!collapsed.has(epIdx) && ep.retries && ep.retries.length > 0 && (
                    <div className="mt-3">
                      {ep.retries.map((retry, retryIdx) => {
                        const key = `${epIdx}-${retryIdx}`;
                        const isExpanded = collapsedRetries.has(key);
                        const isBrowserRetry = retry.request.method === 'BROWSER';
                        return (
                          <div key={retryIdx}>
                            <div className="border-t border-border mt-3 mb-3" />
                            <div className="flex items-center gap-2 mb-3">
                              <button
                                onClick={() => toggleRetry(key)}
                                className="text-muted-foreground hover:text-foreground flex-shrink-0"
                                title={isExpanded ? 'Collapse' : 'Expand'}
                              >
                                {isExpanded
                                  ? <ChevronDown className="h-4 w-4" />
                                  : <ChevronRight className="h-4 w-4" />}
                              </button>
                              <span className={`w-2 h-2 rounded-full flex-shrink-0 ${retry.passed ? 'bg-green-500' : 'bg-red-500'}`} />
                              <span className="text-sm font-semibold">{ep.name}</span>
                              <Badge variant="outline" className="text-xs border-blue-500 text-blue-400 flex-shrink-0">
                                retry #{retry.attempt}
                              </Badge>
                              <span className="text-xs text-muted-foreground">{retry.responseTime}ms</span>
                              <Badge
                                variant={retry.passed ? 'outline' : 'destructive'}
                                className={`text-xs ml-auto ${retry.passed ? 'border-green-600 text-green-400' : ''}`}
                              >
                                {retry.passed ? 'PASS' : 'FAIL'}
                              </Badge>
                            </div>
                            {isExpanded && (
                              <div>
                                <Tabs defaultValue="conditions">
                                  <TabsList className="h-8">
                                    <TabsTrigger value="conditions" className="text-xs h-7">
                                      Conditions
                                      {retry.conditions.some(c => !c.passed) && (
                                        <span className="ml-1.5 text-red-400">
                                          ({retry.conditions.filter(c => !c.passed).length} failed)
                                        </span>
                                      )}
                                    </TabsTrigger>
                                    {isBrowserRetry && retry.screenshotUrl && (
                                      <TabsTrigger value="screenshot" className="text-xs h-7">Screenshot</TabsTrigger>
                                    )}
                                    {isBrowserRetry && retry.htmlText && (
                                      <TabsTrigger value="pagesource" className="text-xs h-7">Page Source</TabsTrigger>
                                    )}
                                    {isBrowserRetry && retry.consoleText && (
                                      <TabsTrigger value="console" className="text-xs h-7">Console</TabsTrigger>
                                    )}
                                    {!isBrowserRetry && (
                                      <TabsTrigger value="request" className="text-xs h-7">Request</TabsTrigger>
                                    )}
                                    {!isBrowserRetry && (
                                      <TabsTrigger value="response" className="text-xs h-7">
                                        Response
                                        {retry.response.status > 0 && (
                                          <span className={`ml-1.5 ${retry.response.status < 400 ? 'text-green-400' : 'text-red-400'}`}>
                                            {retry.response.status}
                                          </span>
                                        )}
                                      </TabsTrigger>
                                    )}
                                  </TabsList>

                                  <TabsContent value="conditions" className="mt-2">
                                    <Table>
                                      <TableHeader>
                                        <TableRow>
                                          <TableHead className="h-8 text-xs">Condition</TableHead>
                                          <TableHead className="h-8 text-xs w-10">Result</TableHead>
                                          <TableHead className="h-8 text-xs">Actual</TableHead>
                                          <TableHead className="h-8 text-xs">Expected</TableHead>
                                        </TableRow>
                                      </TableHeader>
                                      <TableBody>
                                        {retry.conditions.map((c, ci) => (
                                          <TableRow key={ci} className={c.passed ? '' : 'bg-destructive/10'}>
                                            <TableCell className="font-mono text-xs py-2">{c.condition}</TableCell>
                                            <TableCell className="py-2">
                                              <span className={c.passed ? 'text-green-500' : 'text-red-500'}>{c.passed ? '✓' : '✗'}</span>
                                            </TableCell>
                                            <TableCell className="font-mono text-xs py-2 max-w-[220px] truncate" title={c.actual}>{c.actual}</TableCell>
                                            <TableCell className="font-mono text-xs py-2">{c.expected}</TableCell>
                                          </TableRow>
                                        ))}
                                      </TableBody>
                                    </Table>
                                  </TabsContent>

                                  <TabsContent value="request" className="mt-2 space-y-4">
                                    <Section label="URL">
                                      <div className="font-mono text-xs bg-muted rounded px-2 py-1.5 break-all">
                                        <span className="text-muted-foreground mr-2">{retry.request.method}</span>
                                        {retry.request.url}
                                      </div>
                                    </Section>
                                    <Section label="Headers">
                                      <div className="bg-muted rounded px-2 py-1.5">
                                        <HeaderTable headers={retry.request.headers} />
                                      </div>
                                    </Section>
                                    <Section label="Body">
                                      <pre className="font-mono text-xs bg-muted rounded px-2 py-1.5 whitespace-pre-wrap break-all max-h-40 overflow-auto">
                                        {retry.request.body ? prettify(retry.request.body) : <span className="text-muted-foreground italic">none</span>}
                                      </pre>
                                    </Section>
                                  </TabsContent>

                                  <TabsContent value="response" className="mt-2 space-y-4">
                                    <Section label="Status">
                                      <div className="flex items-center gap-3">
                                        <span className={`font-mono text-sm font-bold ${
                                          retry.response.status === 0 ? 'text-red-400' :
                                          retry.response.status < 300 ? 'text-green-400' :
                                          retry.response.status < 400 ? 'text-yellow-400' : 'text-red-400'
                                        }`}>
                                          {retry.response.status === 0 ? 'Connection error' : retry.response.status}
                                        </span>
                                        <span className="text-xs text-muted-foreground">{retry.responseTime}ms</span>
                                      </div>
                                    </Section>
                                    <Section label="Headers">
                                      <div className="bg-muted rounded px-2 py-1.5">
                                        <HeaderTable headers={retry.response.headers} />
                                      </div>
                                    </Section>
                                    <Section label="Body">
                                      <pre className="font-mono text-xs bg-muted rounded px-2 py-1.5 whitespace-pre-wrap break-all max-h-48 overflow-auto">
                                        {retry.response.body ? prettify(retry.response.body) : <span className="text-muted-foreground italic">empty</span>}
                                      </pre>
                                    </Section>
                                  </TabsContent>

                                  {retry.screenshotUrl && (
                                    <TabsContent value="screenshot" className="mt-2">
                                      <img src={retry.screenshotUrl} alt="Retry screenshot" className="w-full rounded border border-border" />
                                    </TabsContent>
                                  )}

                                  {retry.htmlText && (
                                    <TabsContent value="pagesource" className="mt-2">
                                      <pre className="text-xs font-mono bg-muted rounded p-2 whitespace-pre-wrap break-all max-h-96 overflow-auto">
                                        {retry.htmlText}
                                      </pre>
                                    </TabsContent>
                                  )}

                                  {retry.consoleText && (
                                    <TabsContent value="console" className="mt-2">
                                      <pre className="text-xs font-mono bg-muted rounded p-2 whitespace-pre-wrap break-all max-h-96 overflow-auto">
                                        {retry.consoleText}
                                      </pre>
                                    </TabsContent>
                                  )}
                                </Tabs>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {!result && !error && !running && (
          <div className="text-muted-foreground text-sm text-center py-8">
            Click "Run Test" to fire a health check against all endpoints for this service.
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
