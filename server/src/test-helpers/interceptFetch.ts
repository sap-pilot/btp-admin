/**
 * Redirects all https:// fetch calls to a local fake server port.
 * Used by integration tests so service code hits the fake BTP/CF server
 * instead of real external APIs, without any production code changes.
 */

let _original: typeof globalThis.fetch | null = null;

/**
 * Replaces globalThis.fetch so every https:// request is routed to
 * http://localhost:{fakePort}/{path}{search} instead.
 * http:// requests (e.g. to the fake server itself) are passed through unchanged.
 */
export function installFetchInterceptor(fakePort: number): void {
  if (_original) return; // already installed
  _original = globalThis.fetch;
  const real = _original;
  globalThis.fetch = (input, init) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : (input as Request).url;

    if (url.startsWith('https://')) {
      const u = new URL(url);
      const fakeUrl = `http://localhost:${fakePort}${u.pathname}${u.search}`;
      return real(fakeUrl, init);
    }
    return real(input, init);
  };
}

/** Restores the original fetch. Safe to call even if interceptor was not installed. */
export function restoreFetch(): void {
  if (_original) {
    globalThis.fetch = _original;
    _original = null;
  }
}
