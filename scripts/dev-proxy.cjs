// Preload script — routes Node.js native fetch (undici) through an HTTP proxy.
// undici is a devDependency (npm install -D undici); it is the same fetch
// implementation bundled inside Node.js but must be installed explicitly.
//
// Usage:
//   export HTTPS_PROXY=http://127.0.0.1:8080 \
//   export NODE_EXTRA_CA_CERTS="$HOME/.mitmproxy/mitmproxy-ca-cert.pem" \
//   export NODE_OPTIONS="--require $(pwd)/scripts/dev-proxy.cjs" \
//   npm run dev
//
// mitmproxy generates its CA cert at ~/.mitmproxy/ on first launch.

const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
if (!proxy) return;

let setGlobalDispatcher, ProxyAgent;
try {
  ({ setGlobalDispatcher, ProxyAgent } = require('undici'));
} catch {
  console.error('[dev-proxy] undici not found — run: npm install -D undici');
  return;
}

setGlobalDispatcher(new ProxyAgent({ uri: proxy }));
console.error(`[dev-proxy] Routing fetch through ${proxy}`);
