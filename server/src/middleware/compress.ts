import { createGzip } from 'node:zlib';
import type { Request, Response, NextFunction } from 'express';

// Match compressible MIME types; images (except SVG) are skipped
const COMPRESSIBLE = /^(text\/|application\/(json|javascript|xml)|image\/svg\+xml)/;

export function compress(req: Request, res: Response, next: NextFunction): void {
  if (req.method === 'HEAD') { next(); return; }
  // Sync batch returns an already-compressed ZIP — skip compression entirely
  if (req.path === '/api/sync/batch') { next(); return; }
  const ae = (req.headers['accept-encoding'] as string | undefined) ?? '';
  if (!ae.includes('gzip')) { next(); return; }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const _write = res.write.bind(res) as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const _end = res.end.bind(res) as any;
  let gz: ReturnType<typeof createGzip> | null = null;
  let decided = false;

  function init(): boolean {
    if (decided) return gz !== null;
    decided = true;
    if (res.headersSent) return false; // headers already flushed (e.g. SSE); can't add Content-Encoding
    const status = res.statusCode;
    if (status < 200 || status === 204 || status === 304) return false;
    const ct = (res.getHeader('content-type') as string | undefined) ?? '';
    if (!COMPRESSIBLE.test(ct)) return false;
    gz = createGzip({ level: 6 });
    res.setHeader('Content-Encoding', 'gzip');
    res.removeHeader('Content-Length');
    gz.on('data', (c: Buffer) => _write(c));
    gz.on('end', () => _end());
    gz.on('error', (err: Error) => res.destroy(err));
    return true;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (res as any).write = function (chunk: unknown, enc?: unknown, cb?: unknown): boolean {
    if (init() && gz) { gz.write(chunk as Buffer); return true; }
    return _write(chunk, enc, cb);
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (res as any).end = function (chunk?: unknown, enc?: unknown, cb?: unknown): Response {
    if (init() && gz) {
      if (chunk != null && typeof chunk !== 'function') gz.write(chunk as Buffer);
      gz.end();
      return res;
    }
    return _end(chunk, enc, cb);
  };

  next();
}
