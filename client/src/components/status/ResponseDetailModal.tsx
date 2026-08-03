import { useEffect, useState } from 'react';
import type { ResponseRecord } from '@shared/types';
import { ExternalLink, LogIn, ChevronDown, ChevronRight } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

interface AuthProp {
  enabled: boolean;
  loggedIn: boolean;
  login: () => void;
}

interface Props {
  file: { filename: string } | null;
  serviceName: string;
  onClose: () => void;
  auth?: AuthProp;
}

function prettifyBody(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

function formatTs(iso: string): string {
  return new Date(iso).toLocaleString();
}

export default function ResponseDetailModal({ file, serviceName, onClose, auth }: Props) {
  const [record, setRecord] = useState<ResponseRecord | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsAuth, setNeedsAuth] = useState(false);
  const [consoleText, setConsoleText] = useState<string | null>(null);
  const [htmlText, setHtmlText] = useState<string | null>(null);
  const [retryRecords, setRetryRecords] = useState<ResponseRecord[]>([]);
  const [retrySidecars, setRetrySidecars] = useState<Array<{ consoleText: string | null; htmlText: string | null }>>([]);
  // Set contains indices of COLLAPSED retries; empty = all expanded
  const [collapsedRetries, setCollapsedRetries] = useState<Set<number>>(new Set());

  const requiresLogin = auth?.enabled && !auth.loggedIn;

  function toggleRetry(idx: number) {
    setCollapsedRetries(prev => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx); else next.add(idx);
      return next;
    });
  }

  useEffect(() => {
    if (!file) {
      setRecord(null);
      setNeedsAuth(false);
      return;
    }
    if (requiresLogin) {
      setRecord(null);
      setNeedsAuth(true);
      return;
    }
    setNeedsAuth(false);
    setLoading(true);
    setError(null);
    setRetryRecords([]);
    setRetrySidecars([]);
    setCollapsedRetries(new Set());
    fetch(`/api/status/history/${encodeURIComponent(serviceName)}/${encodeURIComponent(file.filename)}`)
      .then(r => {
        if (r.status === 401) { setNeedsAuth(true); throw new Error('401'); }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<ResponseRecord>;
      })
      .then(data => setRecord(data))
      .catch(e => { if (String(e) !== 'Error: 401') setError(String(e)); })
      .finally(() => setLoading(false));
  }, [file, serviceName, requiresLogin]);

  useEffect(() => {
    if (!record) { setConsoleText(null); setHtmlText(null); setRetryRecords([]); setRetrySidecars([]); return; }

    const fetchSidecar = async (sidecarFile: string) => {
      const url = `/api/view?path=${encodeURIComponent(serviceName)}/${encodeURIComponent(sidecarFile)}`;
      try {
        const r = await fetch(url);
        return r.ok ? r.text() : null;
      } catch { return null; }
    };

    void (async () => {
      const [c, h] = await Promise.all([
        record.consoleLogFile ? fetchSidecar(record.consoleLogFile) : Promise.resolve(null),
        record.contentFile ? fetchSidecar(record.contentFile) : Promise.resolve(null),
      ]);
      setConsoleText(c);
      setHtmlText(h);

      if (record.retryFiles && record.retryFiles.length > 0) {
        const retryResults = await Promise.all(
          record.retryFiles.map(f =>
            fetch(`/api/status/history/${encodeURIComponent(serviceName)}/${encodeURIComponent(f)}`)
              .then(r => r.ok ? r.json() as Promise<ResponseRecord> : null)
              .catch(() => null),
          ),
        );
        const records = retryResults.filter((r): r is ResponseRecord => r !== null);
        setRetryRecords(records);

        const sidecars = await Promise.all(
          records.map(async rr => ({
            consoleText: rr.consoleLogFile ? await fetchSidecar(rr.consoleLogFile) : null,
            htmlText: rr.contentFile ? await fetchSidecar(rr.contentFile) : null,
          })),
        );
        setRetrySidecars(sidecars);
      }
    })();
  }, [record, serviceName]);

  const isBrowser = record?.request.method === 'BROWSER';
  const screenshotUrl = record?.screenshotFile
    ? `/api/view?path=${encodeURIComponent(serviceName)}/${encodeURIComponent(record.screenshotFile)}`
    : null;

  return (
    <Dialog open={!!file} onOpenChange={(open: boolean) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-4xl h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            Response Detail
            {record && (
              record.overallStatus === 200 ? <Badge variant="default">PASS</Badge> :
              record.overallStatus === 203 ? <Badge variant="default">PASS (always ok)</Badge> :
              record.overallStatus === 400 ? <Badge variant="outline" className="border-orange-500 text-orange-400">PARTIAL</Badge> :
              record.overallStatus === 503 ? <Badge variant="destructive">FAIL (always error)</Badge> :
              <Badge variant="destructive">FAIL</Badge>
            )}
            {isBrowser && (
              <Badge variant="outline" className="text-xs border-blue-600 text-blue-400">Browser</Badge>
            )}
          </DialogTitle>
        </DialogHeader>

        {needsAuth && auth && (
          <div className="flex flex-col items-center justify-center gap-3 py-10 text-center">
            <p className="text-sm text-muted-foreground">Login required to view response detail.</p>
            <button
              onClick={auth.login}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              <LogIn className="h-4 w-4" />
              Login
            </button>
          </div>
        )}
        {!needsAuth && loading && <div className="text-muted-foreground text-sm p-4">Loading…</div>}
        {!needsAuth && error && <div className="text-destructive text-sm p-4">{error}</div>}

        {record && (
          <ScrollArea className="flex-1 min-h-0">
            <div className="space-y-2 pr-1">
              {/* Main response tabs */}
              <Tabs defaultValue="overview">
                <TabsList className="flex-shrink-0">
                  <TabsTrigger value="overview">Overview</TabsTrigger>
                  {isBrowser && screenshotUrl && <TabsTrigger value="screenshot">Screenshot</TabsTrigger>}
                  {isBrowser && !!record.contentFile && <TabsTrigger value="pagesource">Page Source</TabsTrigger>}
                  {isBrowser && !!record.consoleLogFile && <TabsTrigger value="console">Console</TabsTrigger>}
                  {!isBrowser && <TabsTrigger value="request">Request</TabsTrigger>}
                  {!isBrowser && <TabsTrigger value="response">Response</TabsTrigger>}
                </TabsList>

                {isBrowser && screenshotUrl && (
                  <TabsContent value="screenshot" className="mt-2">
                    <img
                      src={screenshotUrl}
                      alt="Login screenshot"
                      className="w-full rounded border border-border"
                    />
                  </TabsContent>
                )}

                <TabsContent value="overview" className="mt-2">
                  <div className="space-y-4 p-1">
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <div className="text-xs text-muted-foreground mb-1">Timestamp</div>
                        <div className="text-sm">{formatTs(record.timestamp)}</div>
                      </div>
                      <div>
                        <div className="text-xs text-muted-foreground mb-1">Response Time</div>
                        <div className="text-sm">{record.responseTime}ms</div>
                      </div>
                      <div>
                        <div className="text-xs text-muted-foreground mb-1">Endpoint</div>
                        <div className="text-sm flex items-center gap-1.5">
                          {record.endpointName}
                          {record.request.url.startsWith('http') && (
                            <a
                              href={record.request.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              title={`Open ${record.endpointName}`}
                              className="text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
                            >
                              <ExternalLink className="h-3.5 w-3.5" />
                            </a>
                          )}
                        </div>
                      </div>
                      <div>
                        <div className="text-xs text-muted-foreground mb-1">
                          {isBrowser ? 'Check Type' : 'HTTP Status'}
                        </div>
                        <div className="text-sm">
                          {isBrowser ? 'Browser IAS Login' : record.response.status}
                        </div>
                      </div>
                      <div>
                        <div className="text-xs text-muted-foreground mb-1">Overall Result</div>
                        {record.overallStatus === 200 ? <Badge variant="default">PASS</Badge> :
                         record.overallStatus === 203 ? <Badge variant="default">PASS (always ok)</Badge> :
                         record.overallStatus === 400 ? <Badge variant="outline" className="border-orange-500 text-orange-400">PARTIAL (retry succeeded)</Badge> :
                         record.overallStatus === 503 ? <Badge variant="destructive">FAIL (always error)</Badge> :
                         <Badge variant="destructive">FAIL</Badge>}
                      </div>
                      {isBrowser && record.response.body && (
                        <div className="col-span-2">
                          <div className="text-xs text-muted-foreground mb-1">Result Message</div>
                          <div className="text-sm font-mono bg-muted rounded p-2 break-all">
                            {record.response.body}
                          </div>
                        </div>
                      )}
                    </div>

                    <div>
                      <div className="text-xs text-muted-foreground mb-2 font-medium uppercase tracking-wide">Conditions</div>
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Condition</TableHead>
                            <TableHead className="w-16">Result</TableHead>
                            <TableHead>Actual</TableHead>
                            <TableHead>Expected</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {record.conditions.map((c, i) => (
                            <TableRow key={i} className={c.passed ? '' : 'bg-destructive/10'}>
                              <TableCell className="font-mono text-xs">{c.condition}</TableCell>
                              <TableCell>
                                <span className={c.passed ? 'text-green-500' : 'text-red-500'}>
                                  {c.passed ? '✓' : '✗'}
                                </span>
                              </TableCell>
                              <TableCell className="font-mono text-xs max-w-xs truncate">
                                {c.actual}
                              </TableCell>
                              <TableCell className="font-mono text-xs">{c.expected}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  </div>
                </TabsContent>

                {!isBrowser && (
                  <TabsContent value="request" className="mt-2">
                    <div className="space-y-4 p-1">
                      <div>
                        <div className="text-xs text-muted-foreground mb-1">Method & URL</div>
                        <div className="text-sm font-mono bg-muted rounded p-2 break-all">
                          {record.request.method} {record.request.url}
                        </div>
                      </div>
                      <div>
                        <div className="text-xs text-muted-foreground mb-1">Headers</div>
                        <pre className="text-xs font-mono bg-muted rounded p-2 overflow-auto max-h-48">
                          {JSON.stringify(record.request.headers, null, 2)}
                        </pre>
                      </div>
                      {record.request.body && (
                        <div>
                          <div className="text-xs text-muted-foreground mb-1">Body</div>
                          <pre className="text-xs font-mono bg-muted rounded p-2 overflow-auto max-h-48">
                            {prettifyBody(record.request.body)}
                          </pre>
                        </div>
                      )}
                    </div>
                  </TabsContent>
                )}

                {!isBrowser && (
                  <TabsContent value="response" className="mt-2">
                    <div className="space-y-4 p-1">
                      <div>
                        <div className="text-xs text-muted-foreground mb-1">Status Code</div>
                        <div className="text-sm font-mono">{record.response.status}</div>
                      </div>
                      <div>
                        <div className="text-xs text-muted-foreground mb-1">Headers</div>
                        <pre className="text-xs font-mono bg-muted rounded p-2 overflow-auto max-h-48">
                          {JSON.stringify(record.response.headers, null, 2)}
                        </pre>
                      </div>
                      <div>
                        <div className="text-xs text-muted-foreground mb-1">Body</div>
                        <pre className="text-xs font-mono bg-muted rounded p-2 overflow-auto max-h-64 whitespace-pre-wrap break-all">
                          {prettifyBody(record.response.body)}
                        </pre>
                      </div>
                    </div>
                  </TabsContent>
                )}

                {isBrowser && !!record.consoleLogFile && (
                  <TabsContent value="console" className="mt-2">
                    <pre className="text-xs font-mono bg-muted rounded p-2 whitespace-pre-wrap break-all max-h-96 overflow-auto">
                      {consoleText === null ? '(loading…)' : consoleText || '(no console output)'}
                    </pre>
                  </TabsContent>
                )}

                {isBrowser && !!record.contentFile && (
                  <TabsContent value="pagesource" className="mt-2">
                    <pre className="text-xs font-mono bg-muted rounded p-2 whitespace-pre-wrap break-all max-h-96 overflow-auto">
                      {htmlText === null ? '(loading…)' : htmlText}
                    </pre>
                  </TabsContent>
                )}
              </Tabs>

              {/* Retry sections — same visual style as endpoint sections, expanded by default */}
              {retryRecords.map((rr, idx) => {
                const isCollapsed = collapsedRetries.has(idx);
                const isRetryBrowser = rr.request.method === 'BROWSER';
                const retryScreenshotUrl = rr.screenshotFile
                  ? `/api/view?path=${encodeURIComponent(serviceName)}/${encodeURIComponent(rr.screenshotFile)}`
                  : null;
                const sidecar = retrySidecars[idx] ?? { consoleText: null, htmlText: null };
                const retryPassed = rr.overallStatus === 200;
                return (
                  <div key={idx}>
                    <div className="border-t border-border my-3" />
                    <div className="flex items-center gap-2 mb-3">
                      <button
                        onClick={() => toggleRetry(idx)}
                        className="text-muted-foreground hover:text-foreground flex-shrink-0"
                        title={isCollapsed ? 'Expand' : 'Collapse'}
                      >
                        {isCollapsed
                          ? <ChevronRight className="h-4 w-4" />
                          : <ChevronDown className="h-4 w-4" />}
                      </button>
                      <span className={`w-2 h-2 rounded-full flex-shrink-0 ${retryPassed ? 'bg-green-500' : 'bg-red-500'}`} />
                      <span className="text-sm font-semibold flex-1 truncate">{rr.endpointName}</span>
                      <Badge variant="outline" className="text-xs border-blue-500 text-blue-400 flex-shrink-0">
                        retry #{idx + 1}
                      </Badge>
                      <span className="text-xs text-muted-foreground flex-shrink-0">{rr.responseTime}ms</span>
                      <Badge
                        variant={retryPassed ? 'outline' : 'destructive'}
                        className={`text-xs flex-shrink-0 ${retryPassed ? 'border-green-600 text-green-400' : ''}`}
                      >
                        {retryPassed ? 'PASS' : rr.overallStatus === 504 ? 'TIMEOUT' : 'FAIL'}
                      </Badge>
                    </div>

                    {!isCollapsed && (
                      <Tabs defaultValue="overview">
                        <TabsList className="h-8">
                          <TabsTrigger value="overview" className="text-xs h-7">Overview</TabsTrigger>
                          {isRetryBrowser && retryScreenshotUrl && (
                            <TabsTrigger value="screenshot" className="text-xs h-7">Screenshot</TabsTrigger>
                          )}
                          {isRetryBrowser && !!rr.consoleLogFile && (
                            <TabsTrigger value="console" className="text-xs h-7">Console</TabsTrigger>
                          )}
                          {isRetryBrowser && !!rr.contentFile && (
                            <TabsTrigger value="pagesource" className="text-xs h-7">Page Source</TabsTrigger>
                          )}
                          {!isRetryBrowser && (
                            <TabsTrigger value="request" className="text-xs h-7">Request</TabsTrigger>
                          )}
                          {!isRetryBrowser && (
                            <TabsTrigger value="response" className="text-xs h-7">
                              Response
                              {rr.response.status > 0 && (
                                <span className={`ml-1.5 ${rr.response.status < 400 ? 'text-green-400' : 'text-red-400'}`}>
                                  {rr.response.status}
                                </span>
                              )}
                            </TabsTrigger>
                          )}
                        </TabsList>

                        <TabsContent value="overview" className="mt-2">
                          <div className="space-y-3">
                            <div className="grid grid-cols-2 gap-3 text-sm">
                              <div>
                                <div className="text-xs text-muted-foreground mb-1">Timestamp</div>
                                <div>{formatTs(rr.timestamp)}</div>
                              </div>
                              <div>
                                <div className="text-xs text-muted-foreground mb-1">Response Time</div>
                                <div>{rr.responseTime}ms</div>
                              </div>
                              <div>
                                <div className="text-xs text-muted-foreground mb-1">
                                  {isRetryBrowser ? 'Check Type' : 'HTTP Status'}
                                </div>
                                <div>{isRetryBrowser ? 'Browser IAS Login' : rr.response.status}</div>
                              </div>
                              <div>
                                <div className="text-xs text-muted-foreground mb-1">Overall Result</div>
                                {retryPassed
                                  ? <Badge variant="default">PASS</Badge>
                                  : rr.overallStatus === 504
                                    ? <Badge variant="outline" className="border-orange-600 text-orange-500">TIMEOUT</Badge>
                                    : <Badge variant="destructive">FAIL</Badge>}
                              </div>
                            </div>
                            <Table>
                              <TableHeader>
                                <TableRow>
                                  <TableHead className="h-7 text-xs">Condition</TableHead>
                                  <TableHead className="h-7 text-xs w-10">Result</TableHead>
                                  <TableHead className="h-7 text-xs">Actual</TableHead>
                                  <TableHead className="h-7 text-xs">Expected</TableHead>
                                </TableRow>
                              </TableHeader>
                              <TableBody>
                                {rr.conditions.map((c, ci) => (
                                  <TableRow key={ci} className={c.passed ? '' : 'bg-destructive/10'}>
                                    <TableCell className="font-mono text-xs py-1.5">{c.condition}</TableCell>
                                    <TableCell className="py-1.5">
                                      <span className={c.passed ? 'text-green-500' : 'text-red-500'}>{c.passed ? '✓' : '✗'}</span>
                                    </TableCell>
                                    <TableCell className="font-mono text-xs py-1.5 max-w-xs truncate">{c.actual}</TableCell>
                                    <TableCell className="font-mono text-xs py-1.5">{c.expected}</TableCell>
                                  </TableRow>
                                ))}
                              </TableBody>
                            </Table>
                          </div>
                        </TabsContent>

                        {!isRetryBrowser && (
                          <TabsContent value="request" className="mt-2 space-y-3">
                            <div>
                              <div className="text-xs text-muted-foreground mb-1">Method & URL</div>
                              <div className="text-xs font-mono bg-muted rounded p-2 break-all">
                                {rr.request.method} {rr.request.url}
                              </div>
                            </div>
                            <div>
                              <div className="text-xs text-muted-foreground mb-1">Headers</div>
                              <pre className="text-xs font-mono bg-muted rounded p-2 overflow-auto max-h-40">
                                {JSON.stringify(rr.request.headers, null, 2)}
                              </pre>
                            </div>
                            {rr.request.body && (
                              <div>
                                <div className="text-xs text-muted-foreground mb-1">Body</div>
                                <pre className="text-xs font-mono bg-muted rounded p-2 overflow-auto max-h-40 whitespace-pre-wrap break-all">
                                  {prettifyBody(rr.request.body)}
                                </pre>
                              </div>
                            )}
                          </TabsContent>
                        )}

                        {!isRetryBrowser && (
                          <TabsContent value="response" className="mt-2 space-y-3">
                            <div>
                              <div className="text-xs text-muted-foreground mb-1">Status Code</div>
                              <div className="text-xs font-mono">{rr.response.status}</div>
                            </div>
                            <div>
                              <div className="text-xs text-muted-foreground mb-1">Headers</div>
                              <pre className="text-xs font-mono bg-muted rounded p-2 overflow-auto max-h-40">
                                {JSON.stringify(rr.response.headers, null, 2)}
                              </pre>
                            </div>
                            <div>
                              <div className="text-xs text-muted-foreground mb-1">Body</div>
                              <pre className="text-xs font-mono bg-muted rounded p-2 overflow-auto max-h-48 whitespace-pre-wrap break-all">
                                {prettifyBody(rr.response.body)}
                              </pre>
                            </div>
                          </TabsContent>
                        )}

                        {retryScreenshotUrl && (
                          <TabsContent value="screenshot" className="mt-2">
                            <img
                              src={retryScreenshotUrl}
                              alt="Retry screenshot"
                              className="w-full rounded border border-border"
                            />
                          </TabsContent>
                        )}

                        {!!rr.consoleLogFile && (
                          <TabsContent value="console" className="mt-2">
                            <pre className="text-xs font-mono bg-muted rounded p-2 whitespace-pre-wrap break-all max-h-64 overflow-auto">
                              {sidecar.consoleText === null ? '(loading…)' : sidecar.consoleText || '(no console output)'}
                            </pre>
                          </TabsContent>
                        )}

                        {!!rr.contentFile && (
                          <TabsContent value="pagesource" className="mt-2">
                            <pre className="text-xs font-mono bg-muted rounded p-2 whitespace-pre-wrap break-all max-h-64 overflow-auto">
                              {sidecar.htmlText === null ? '(loading…)' : sidecar.htmlText}
                            </pre>
                          </TabsContent>
                        )}
                      </Tabs>
                    )}
                  </div>
                );
              })}
            </div>
          </ScrollArea>
        )}
      </DialogContent>
    </Dialog>
  );
}
