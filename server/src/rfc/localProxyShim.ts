import { createServer, createConnection, type Socket } from 'node:net';
import { logger } from '../logger.js';

// ─── SOCKS5 (port 20004) ──────────────────────────────────────────────────────
// BTP Connectivity Service for TCP backends uses SOCKS5 with a proprietary SAP
// JWT authentication method (0x80).  RFC-protocol CC backends are NOT routable
// through SOCKS5 (returns 0x02), so this is only kept for reference/TCP backends.
//
// Handshake (3 phases):
//   1. Method negotiation: client→ [05 01 80]  server→ [05 80]
//   2. JWT auth:           client→ [01 <4-byte-BE-len> <raw-jwt> <1-byte-locid-len> <locid>]
//                          server→ [01 00]  (success)
//   3. CONNECT (ATYP=03): client→ [05 01 00 03 <len> <hostname> <port-hi> <port-lo>]
//                          server→ [05 00 00 ...]
async function socks5Connect(
  proxyHost: string,
  proxyPort: number,
  rawJwt: string,
  targetHost: string,
  targetPort: number,
  locationId: string,
): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    logger.info({ proxyHost, proxyPort, targetHost, targetPort, locationId, jwtLen: rawJwt.length }, 'SOCKS5 connecting');
    const sock = createConnection({ host: proxyHost, port: proxyPort });
    let step = 0;
    let buf = Buffer.alloc(0);

    const fail = (msg: string) => {
      logger.warn({ proxyHost, proxyPort, targetHost, targetPort, step, msg }, 'SOCKS5 handshake failed');
      sock.destroy();
      reject(new Error(msg));
    };

    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);

      if (step === 0) {
        if (buf.length < 2) return;
        logger.info({ bytes: buf.subarray(0, 2).toString('hex') }, 'SOCKS5 method response received');
        if (buf[0] !== 0x05 || buf[1] !== 0x80) return fail(`SOCKS5 method rejected: [${buf.subarray(0, 2).toString('hex')}]`);
        buf = buf.subarray(2);
        step = 1;

        const tokenBuf = Buffer.from(rawJwt, 'utf8');
        const locBuf   = locationId
          ? Buffer.from(Buffer.from(locationId, 'utf8').toString('base64'), 'ascii')
          : Buffer.alloc(0);
        const auth = Buffer.allocUnsafe(1 + 4 + tokenBuf.length + 1 + locBuf.length);
        let off = 0;
        auth[off++] = 0x01;
        auth.writeUInt32BE(tokenBuf.length, off); off += 4;
        tokenBuf.copy(auth, off); off += tokenBuf.length;
        auth[off++] = locBuf.length;
        if (locBuf.length > 0) locBuf.copy(auth, off);
        sock.write(auth);

        if (buf.length > 0) onData(Buffer.alloc(0));

      } else if (step === 1) {
        if (buf.length < 2) return;
        logger.info({ bytes: buf.subarray(0, 2).toString('hex') }, 'SOCKS5 JWT auth response received');
        if (buf[0] !== 0x01 || buf[1] !== 0x00) return fail(`SOCKS5 JWT auth failed: [${buf.subarray(0, 2).toString('hex')}]`);
        buf = buf.subarray(2);
        step = 2;

        const hostBuf = Buffer.from(targetHost, 'utf8');
        const req = Buffer.allocUnsafe(4 + 1 + hostBuf.length + 2);
        let off = 0;
        req[off++] = 0x05; req[off++] = 0x01; req[off++] = 0x00; req[off++] = 0x03;
        req[off++] = hostBuf.length;
        hostBuf.copy(req, off); off += hostBuf.length;
        req.writeUInt16BE(targetPort, off);
        sock.write(req);

        if (buf.length > 0) onData(Buffer.alloc(0));

      } else if (step === 2) {
        if (buf.length < 4) return;
        logger.info({ bytes: buf.subarray(0, 4).toString('hex') }, 'SOCKS5 CONNECT response received');
        if (buf[0] !== 0x05 || buf[1] !== 0x00) return fail(`SOCKS5 CONNECT refused: [${buf.subarray(0, 4).toString('hex')}]`);
        const atyp = buf[3];
        const addrLen = atyp === 0x01 ? 4 : atyp === 0x04 ? 16 : (buf.length > 4 ? buf[4] + 1 : undefined);
        if (addrLen === undefined) return;
        const replyLen = 4 + addrLen + 2;
        if (buf.length < replyLen) return;

        sock.removeAllListeners('data');
        sock.removeAllListeners('error');
        sock.removeAllListeners('close');
        resolve(sock);
      }
    };

    sock.on('connect', () => {
      logger.info({ proxyHost, proxyPort }, 'SOCKS5 TCP connected, sending method negotiation [05 01 80]');
      sock.write(Buffer.from([0x05, 0x01, 0x80]));
    });
    sock.on('data',  onData);
    sock.on('error', (err) => { logger.warn({ proxyHost, proxyPort, step, err: err.message }, 'SOCKS5 socket error'); reject(err); });
    sock.on('close', () => { if (step < 2) fail('SOCKS5 socket closed before tunnel ready'); });
  });
}

// ─── SCC Protocol (port 20001) ────────────────────────────────────────────────
// Port 20001 (onpremise_proxy_rfc_port) is plain TCP (NOT TLS).
// After a plain TCP connection, the protocol is HTTP CONNECT:
//
//   Step 1: plain TCP connect to port 20001
//
//   Step 2: HTTP CONNECT with Bearer token:
//     CONNECT <virtualHost>:<port> HTTP/1.1\r\n
//     Host: <virtualHost>:<port>\r\n
//     Proxy-Authorization: Bearer <token>\r\n
//     SAP-Connectivity-SCC-Location_ID: <locId>\r\n
//     \r\n
//
//   Step 3: Proxy responds HTTP 200 → switch to SCC binary protocol
//
//   Step 4: SCC OPEN_REQUEST binary frame:
//     [0x00]   1 byte:  OPEN_REQUEST type
//     [8B]     conv_id  (zeros initially)
//     [32B]    connectionIdentifier  (zeros initially)
//     [4B BE]  payload length
//     [payload] URL-encoded: userName=<u>&abapClient=<c>&ashost=<h>&sysNr=<n>
//
//   Step 5: SCC_RESPONSE from proxy:
//     [0x05]   1 byte:  SCC_RESPONSE type
//     [8B]     conv_id  assigned by proxy for subsequent frames
//     [32B]    connectionIdentifier assigned by proxy
//     [4B BE]  payload length (usually 1 — partner version)
//     [payload] partner version byte (etc.)
//
//   Step 6: CPIC bridge via RFC frames:
//     Client → proxy:  RFC_REQUEST  (0x03) frames wrapping CPIC chunks
//     Proxy → client:  RFC_RESPONSE (0x06) frames carrying CPIC from backend
//
// Frame header (all frames after handshake):
//   [0]    1 byte: message type
//   [1..8] 8 bytes: conv_id
//   [9..40] 32 bytes: connectionIdentifier
//   [41..44] 4 bytes: payload length (big-endian uint32)
//            → 45 bytes total header

const SCC_HDR_LEN = 45;
const SCC_CONV_OFF = 1;
const SCC_CONV_LEN = 8;
const SCC_CONN_OFF = 9;
const SCC_CONN_LEN = 32;
const SCC_PLEN_OFF = 41;

// SCC message type constants (from JCo NeoSocketDriver.class constant pool)
const SCC_OPEN_REQUEST  = 0x00;
const SCC_RESPONSE      = 0x05;
const RFC_REQUEST       = 0x03;
const RFC_RESPONSE      = 0x06;
const SCC_ERROR         = 0x07;
const SCC_PING          = 0x09;

function buildSccFrame(type: number, convId: Buffer, connId: Buffer, payload: Buffer): Buffer {
  const hdr = Buffer.allocUnsafe(SCC_HDR_LEN);
  hdr[0] = type;
  convId.copy(hdr, SCC_CONV_OFF);
  connId.copy(hdr, SCC_CONN_OFF);
  hdr.writeUInt32BE(payload.length, SCC_PLEN_OFF);
  return Buffer.concat([hdr, payload]);
}

export interface SccParams {
  userName?: string;   // SAP logon user (BasicAuth only; omit for PrincipalPropagation)
  abapClient: string;  // SAP client (mandatory)
  sysnr: string;       // System number string, e.g. "00" (used in OPEN_REQUEST payload)
}

async function sccProtocolConnect(
  proxyHost: string,
  proxyPort: number,
  bearerToken: string,
  targetHost: string,
  targetPort: number,
  locationId: string,
  params: SccParams,
): Promise<{ socket: Socket; convId: Buffer; connId: Buffer; extra: Buffer }> {
  return new Promise((resolve, reject) => {
    logger.info({ proxyHost, proxyPort, targetHost, targetPort, locationId: locationId || '(empty)' }, 'SCC: TLS connecting');

    // Build SCC OPEN_REQUEST frame (sent after HTTP 200)
    const parts: string[] = [];
    if (params.userName) parts.push(`userName=${encodeURIComponent(params.userName)}`);
    parts.push(`abapClient=${encodeURIComponent(params.abapClient)}`);
    parts.push(`ashost=${targetHost}`);
    parts.push(`sysNr=${params.sysnr}`);
    const openPayload = Buffer.from(parts.join('&'), 'utf8');

    const openReqHdr = Buffer.allocUnsafe(SCC_HDR_LEN);
    openReqHdr[0] = SCC_OPEN_REQUEST;
    openReqHdr.fill(0, SCC_CONV_OFF, SCC_CONV_OFF + SCC_CONV_LEN + SCC_CONN_LEN);
    openReqHdr.writeUInt32BE(openPayload.length, SCC_PLEN_OFF);
    const openReqFrame = Buffer.concat([openReqHdr, openPayload]);

    // Port 20001 is plain TCP (TLS was confirmed wrong — secureConnect never fired).
    const sock: Socket = createConnection({ host: proxyHost, port: proxyPort });

    let buf = Buffer.alloc(0);
    let httpDone = false;
    let resolvedOrRejected = false;

    const done = (err?: Error) => {
      if (resolvedOrRejected) return;
      resolvedOrRejected = true;
      if (err) { sock.destroy(); reject(err); }
    };

    sock.on('connect', () => {
      // Port 20001 does NOT respond to HTTP CONNECT with HTTP 200 (confirmed: proxyToClient=0).
      // Send HTTP CONNECT (auth/routing preamble) + SCC OPEN_REQUEST back-to-back in one burst.
      // The OPEN_REQUEST tells the proxy which session to open and establishes the return path so
      // the proxy can route SAP's CPIC response back to us. Without OPEN_REQUEST, the proxy routes
      // CPIC one-way to SAP but never sends anything back (confirmed: 60s proxyToClient=0 with
      // http-connect-pipe).
      const rawToken = bearerToken.startsWith('Bearer ') ? bearerToken : `Bearer ${bearerToken}`;
      const locHdr = locationId ? `SAP-Connectivity-SCC-Location_ID: ${locationId}\r\n` : '';
      const preamble = `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\nProxy-Authorization: ${rawToken}\r\n${locHdr}\r\n`;
      logger.info({
        proxyHost, proxyPort,
        openPayloadStr: openPayload.toString(),
        openReqHex: openReqFrame.subarray(0, SCC_HDR_LEN).toString('hex'),
      }, 'SCC: TCP connected, sending HTTP CONNECT + SCC OPEN_REQUEST (no HTTP 200 expected)');
      sock.write(preamble);
      sock.write(openReqFrame);
    });

    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      // Log ALL received bytes — essential to understand what the proxy sends back.
      logger.info({
        totalBytes: buf.length,
        chunkHex: chunk.toString('hex'),
        chunkAscii: chunk.toString('ascii').replace(/[^\x20-\x7e]/g, '.'),
      }, 'SCC: received bytes from proxy');

      // Skip any HTTP 200 response the proxy might send (though none observed so far).
      if (!httpDone) {
        const hdrsEnd = buf.indexOf('\r\n\r\n');
        if (hdrsEnd !== -1) {
          const statusLine = buf.subarray(0, buf.indexOf('\r\n')).toString('ascii');
          logger.info({ statusLine }, 'SCC: proxy sent an HTTP response (stripping header)');
          buf = buf.subarray(hdrsEnd + 4);
          httpDone = true;
        } else if (!buf.subarray(0, 5).toString('ascii').startsWith('HTTP/')) {
          // Not HTTP — treat accumulated bytes as the start of the SCC frame
          httpDone = true;
        } else {
          return; // still accumulating HTTP header
        }
        if (buf.length === 0) return;
      }

      // Parse SCC_RESPONSE frame from accumulated buffer
      if (buf.length < SCC_HDR_LEN) return;
      const payloadLen = buf.readUInt32BE(SCC_PLEN_OFF);
      const totalLen = SCC_HDR_LEN + payloadLen;
      if (buf.length < totalLen) return;

      sock.removeAllListeners('data');
      sock.removeAllListeners('error');

      const msgType = buf[0];
      if (msgType !== SCC_RESPONSE) {
        const errPayload = payloadLen > 0 ? buf.subarray(SCC_HDR_LEN, totalLen).toString('utf8') : '';
        logger.error({
          msgType: `0x${msgType.toString(16)}`,
          rawHex: buf.subarray(0, Math.min(totalLen, 128)).toString('hex'),
          errPayload,
        }, 'SCC: unexpected response type (expected 0x05 SCC_RESPONSE)');
        done(new Error(`SCC: expected 0x05 SCC_RESPONSE, got 0x${msgType.toString(16)}${errPayload ? ': ' + errPayload : ''}`));
        return;
      }

      const convId = Buffer.from(buf.subarray(SCC_CONV_OFF, SCC_CONV_OFF + SCC_CONV_LEN));
      const connId = Buffer.from(buf.subarray(SCC_CONN_OFF, SCC_CONN_OFF + SCC_CONN_LEN));
      const extra  = buf.subarray(totalLen);
      logger.info({ convIdHex: convId.toString('hex'), payloadLen, extraLen: extra.length },
        'SCC: SCC_RESPONSE received — tunnel established, wiring CPIC bridge');

      if (resolvedOrRejected) return;
      resolvedOrRejected = true;
      resolve({ socket: sock, convId, connId, extra });
    };

    sock.on('data',  onData);
    sock.on('error', (err) => { logger.warn({ err: err.message }, 'SCC: socket error'); done(err); });
    sock.on('close', () => { if (!resolvedOrRejected) done(new Error('SCC: socket closed during handshake')); });
  });
}

// Wire an SCC-protocol bridge between nwrfcsdk's CPIC socket and the SCC proxy socket.
// The bridge:
//   clientSocket (nwrfcsdk CPIC) → RFC_REQUEST (0x03) frames → proxySocket
//   proxySocket SCC frames       → RFC_RESPONSE (0x06) payload → clientSocket
function wireSccBridge(
  clientSocket: Socket,
  proxySocket: Socket,
  convId: Buffer,
  connId: Buffer,
  extra: Buffer, // any bytes already received from proxy after OPEN_RESPONSE
): void {
  logger.info({ convIdHex: convId.toString('hex'), extraLen: extra.length }, 'SCC bridge: wiring');

  // Client → proxy: wrap each CPIC chunk in an RFC_REQUEST frame
  clientSocket.on('data', (cpic: Buffer) => {
    const frame = buildSccFrame(RFC_REQUEST, convId, connId, cpic);
    const ok = proxySocket.write(frame);
    if (!ok) clientSocket.pause();
    logger.debug({ cpicLen: cpic.length, frameLen: frame.length }, 'SCC bridge: sent RFC_REQUEST');
  });
  proxySocket.on('drain', () => clientSocket.resume());

  // Proxy → client: parse SCC frames, extract RFC_RESPONSE payloads
  let proxybuf = Buffer.alloc(0);

  const processSccFrames = () => {
    while (proxybuf.length >= SCC_HDR_LEN) {
      const payloadLen = proxybuf.readUInt32BE(SCC_PLEN_OFF);
      const frameLen = SCC_HDR_LEN + payloadLen;
      if (proxybuf.length < frameLen) break;

      const msgType = proxybuf[0];
      const payload  = proxybuf.subarray(SCC_HDR_LEN, frameLen);
      proxybuf = proxybuf.subarray(frameLen);

      if (msgType === RFC_RESPONSE) {
        logger.debug({ payloadLen }, 'SCC bridge: received RFC_RESPONSE, forwarding CPIC to SDK');
        const ok = clientSocket.write(payload);
        if (!ok) proxySocket.pause();
      } else if (msgType === SCC_ERROR) {
        const msg = payload.toString('utf8');
        logger.error({ msg }, 'SCC bridge: SCC_ERROR from proxy');
        clientSocket.destroy(new Error(`SCC_ERROR from proxy: ${msg}`));
      } else if (msgType === SCC_PING) {
        logger.debug('SCC bridge: SCC_PING received (ignored)');
      } else if (msgType === SCC_RESPONSE) {
        logger.debug({ payloadLen }, 'SCC bridge: extra SCC_RESPONSE (ignored)');
      } else {
        logger.debug({ msgType: `0x${msgType.toString(16)}`, payloadLen }, 'SCC bridge: unknown frame type');
      }
    }
  };
  clientSocket.on('drain', () => proxySocket.resume());

  // Seed with any bytes already buffered during handshake
  if (extra.length > 0) {
    proxybuf = Buffer.from(extra);
    processSccFrames();
  }

  proxySocket.on('data', (chunk: Buffer) => {
    proxybuf = proxybuf.length ? Buffer.concat([proxybuf, chunk]) : Buffer.from(chunk);
    processSccFrames();
  });

  // Error / close handlers
  proxySocket.on('error', (e) => { logger.warn({ err: e.message }, 'SCC bridge: proxy socket error'); clientSocket.destroy(); });
  clientSocket.on('error', (e) => { logger.warn({ err: e.message }, 'SCC bridge: client socket error'); proxySocket.destroy(); });
  proxySocket.on('close', () => {
    logger.info('SCC bridge: proxy socket closed');
    clientSocket.destroy();
  });
  clientSocket.on('close', () => proxySocket.destroy());
}

// ─── http-connect-pipe ────────────────────────────────────────────────────────
// Send HTTP CONNECT headers immediately and pipe without waiting for HTTP 200.
// Port 20001 does NOT send a 200 response, but CPIC bytes sent immediately after
// the CONNECT headers DO reach the SAP backend (confirmed by GwRead timeout).
// The shim intercepts proxy→client bytes and strips any HTTP header if present.
async function httpConnectPipe(
  proxyHost: string,
  proxyPort: number,
  bearerToken: string,
  targetHost: string,
  targetPort: number,
  locationId: string,
): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    logger.info({ proxyHost, proxyPort, targetHost, targetPort, locationId: locationId || '(empty)' }, 'HTTP-pipe: TCP connecting');
    const sock = createConnection({ host: proxyHost, port: proxyPort });
    sock.on('connect', () => {
      const rawToken = bearerToken.startsWith('Bearer ') ? bearerToken : `Bearer ${bearerToken}`;
      const locHdr = locationId ? `SAP-Connectivity-SCC-Location_ID: ${locationId}\r\n` : '';
      const preamble = `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\nProxy-Authorization: ${rawToken}\r\n${locHdr}\r\n`;
      logger.info({ proxyHost, proxyPort }, 'HTTP-pipe: connected, sending CONNECT (not waiting for 200)');
      sock.write(preamble);
      sock.removeAllListeners('error');
      sock.removeAllListeners('close');
      resolve(sock);
    });
    sock.on('error', (err) => { logger.warn({ err: err.message }, 'HTTP-pipe: connect error'); reject(err); });
  });
}

// ─── Legacy plain-pipe tunnel modes ──────────────────────────────────────────

async function httpConnectTunnel(
  proxyHost: string, proxyPort: number, bearerToken: string,
  targetHost: string, targetPort: number, locationId = '',
): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    logger.info({ proxyHost, proxyPort, targetHost, targetPort }, 'HTTP CONNECT: connecting');
    const sock = createConnection({ host: proxyHost, port: proxyPort });
    let buf = Buffer.alloc(0);
    let headersDone = false;

    const fail = (msg: string) => { logger.warn({ msg }, 'HTTP CONNECT: failed'); sock.destroy(); reject(new Error(msg)); };

    sock.on('connect', () => {
      const rawToken = bearerToken.startsWith('Bearer ') ? bearerToken : `Bearer ${bearerToken}`;
      const locHdr = locationId ? `SAP-Connectivity-SCC-Location_ID: ${locationId}\r\n` : '';
      const req = `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\nProxy-Authorization: ${rawToken}\r\n${locHdr}\r\n`;
      logger.info({ targetHost, targetPort, locationId: locationId || '(empty)' }, 'HTTP CONNECT: sending request');
      sock.write(req);
      sock.setTimeout(30_000, () => fail('HTTP CONNECT: proxy did not respond within 30s'));
    });

    sock.on('data', (chunk: Buffer) => {
      if (headersDone) return;
      logger.info({ rawHex: chunk.subarray(0, 64).toString('hex'), len: chunk.length }, 'HTTP CONNECT: raw response chunk');
      buf = Buffer.concat([buf, chunk]);
      const headerEnd = buf.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      headersDone = true;
      const statusLine = buf.subarray(0, buf.indexOf('\r\n')).toString('ascii');
      const code = parseInt(statusLine.split(' ')[1] ?? '0', 10);
      if (code !== 200) { return fail(`HTTP CONNECT failed: ${statusLine}`); }
      sock.removeAllListeners('data'); sock.removeAllListeners('error'); sock.removeAllListeners('close');
      resolve(sock);
    });

    sock.on('error', (err) => { logger.warn({ err: err.message }, 'HTTP CONNECT: error'); reject(err); });
    sock.on('close', () => { if (!headersDone) fail('HTTP CONNECT: socket closed before 200'); });
  });
}

async function rawTcpConnect(proxyHost: string, proxyPort: number): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const sock = createConnection({ host: proxyHost, port: proxyPort });
    sock.on('connect', () => { logger.info({ proxyHost, proxyPort }, 'Raw TCP: connected'); resolve(sock); });
    sock.on('error', (err) => reject(err));
  });
}

// ─── Public API ───────────────────────────────────────────────────────────────

export type TunnelMode = 'scc-protocol' | 'http-connect-pipe' | 'socks5' | 'http-connect' | 'raw-tcp';

export async function withDirectTunnelShim(
  proxyHost: string,
  proxyPort: number,
  bearerToken: string,
  virtualTarget: string, // "virtualhost:port"
  fn: (localPort: number) => Promise<void>,
  locationId = '',
  mode: TunnelMode = 'scc-protocol',
  sccParams?: SccParams, // required when mode === 'scc-protocol'
): Promise<void> {
  const colonIdx = virtualTarget.lastIndexOf(':');
  const virtualHost = virtualTarget.slice(0, colonIdx);
  const virtualPort = parseInt(virtualTarget.slice(colonIdx + 1), 10);
  const rawJwt = bearerToken.startsWith('Bearer ') ? bearerToken.slice(7) : bearerToken;

  return new Promise<void>((resolve, reject) => {
    const server = createServer((clientSocket: Socket) => {
      logger.info({ virtualHost, virtualPort, proxyHost, proxyPort, mode }, 'RFC shim: SDK connected, opening tunnel');

      if (mode === 'scc-protocol') {
        if (!sccParams) {
          clientSocket.destroy();
          return reject(new Error('scc-protocol mode requires sccParams'));
        }
        sccProtocolConnect(proxyHost, proxyPort, bearerToken, virtualHost, virtualPort, locationId, sccParams)
          .then(({ socket: proxySocket, convId, connId, extra }) => {
            wireSccBridge(clientSocket, proxySocket, convId, connId, extra);
          })
          .catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error({ virtualHost, virtualPort, msg }, 'RFC shim: SCC connect failed');
            clientSocket.destroy();
          });
        return;
      }

      if (mode === 'http-connect-pipe') {
        httpConnectPipe(proxyHost, proxyPort, bearerToken, virtualHost, virtualPort, locationId)
          .then((proxySocket) => {
            logger.info({ virtualHost, virtualPort }, 'HTTP-pipe: socket ready, wiring bidirectional pipe with diagnostic logging');

            // client→proxy: SDK CPIC bytes flow to the proxy immediately.
            let clientToProxy = 0;
            clientSocket.on('data', (chunk: Buffer) => {
              clientToProxy += chunk.length;
              if (clientToProxy === chunk.length) {
                logger.info({ firstHex: chunk.subarray(0, 64).toString('hex'), len: chunk.length }, 'HTTP-pipe: first SDK→proxy chunk (CPIC)');
              }
            });
            clientSocket.pipe(proxySocket);

            // proxy→client: log EVERY chunk — this answers whether the proxy sends anything back.
            let proxyToClient = 0;
            let headerBuf = Buffer.alloc(0);
            let headerDone = false;

            const forwardRaw = (data: Buffer) => {
              headerDone = true;
              if (data.length > 0) clientSocket.write(data);
              proxySocket.removeAllListeners('data');
              proxySocket.on('data', (chunk: Buffer) => {
                proxyToClient += chunk.length;
                logger.info({ hex: chunk.subarray(0, 64).toString('hex'), len: chunk.length, totalFromProxy: proxyToClient }, 'HTTP-pipe: proxy→client chunk (CPIC passthrough)');
                clientSocket.write(chunk);
              });
            };

            proxySocket.on('data', (chunk: Buffer) => {
              proxyToClient += chunk.length;
              logger.info({ hex: chunk.subarray(0, 128).toString('hex'), len: chunk.length, totalFromProxy: proxyToClient }, 'HTTP-pipe: proxy→client raw chunk');

              if (headerDone) { clientSocket.write(chunk); return; }

              headerBuf = Buffer.concat([headerBuf, chunk]);
              const hdrEnd = headerBuf.indexOf('\r\n\r\n');
              if (hdrEnd === -1) {
                if (!headerBuf.subarray(0, 5).toString('ascii').startsWith('HTTP/')) {
                  logger.info({ firstHex: headerBuf.subarray(0, 32).toString('hex') }, 'HTTP-pipe: non-HTTP bytes from proxy — forwarding as raw CPIC');
                  forwardRaw(Buffer.from(headerBuf));
                  headerBuf = Buffer.alloc(0);
                }
                return;
              }
              const statusLine = headerBuf.subarray(0, headerBuf.indexOf('\r\n')).toString('ascii');
              const after = headerBuf.subarray(hdrEnd + 4);
              logger.info({ statusLine, afterLen: after.length }, 'HTTP-pipe: HTTP header stripped from proxy response');
              headerBuf = Buffer.alloc(0);
              forwardRaw(Buffer.from(after));
            });

            proxySocket.on('error', (e) => { logger.warn({ err: e.message }, 'HTTP-pipe: proxy error'); clientSocket.destroy(); });
            clientSocket.on('error', (e) => { logger.warn({ err: e.message }, 'HTTP-pipe: client error'); proxySocket.destroy(); });
            proxySocket.on('close', () => {
              logger.info({ virtualHost, virtualPort, proxyToClient, clientToProxy }, 'HTTP-pipe: proxy closed (byte totals)');
              clientSocket.destroy();
            });
            clientSocket.on('close', () => proxySocket.destroy());
          })
          .catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error({ virtualHost, virtualPort, msg }, 'HTTP-pipe: connect failed');
            clientSocket.destroy();
          });
        return;
      }

      const tunnelPromise = mode === 'raw-tcp'
        ? rawTcpConnect(proxyHost, proxyPort)
        : mode === 'http-connect'
        ? httpConnectTunnel(proxyHost, proxyPort, bearerToken, virtualHost, virtualPort, locationId)
        : socks5Connect(proxyHost, proxyPort, rawJwt, virtualHost, virtualPort, locationId);

      tunnelPromise
        .then((proxySocket) => {
          logger.info({ mode }, 'RFC shim: tunnel established, piping');
          proxySocket.pipe(clientSocket);
          clientSocket.pipe(proxySocket);
          proxySocket.on('error', (e) => { logger.warn({ err: e.message }, 'RFC shim: proxy error'); clientSocket.destroy(); });
          clientSocket.on('error', (e) => { logger.warn({ err: e.message }, 'RFC shim: client error'); proxySocket.destroy(); });
          proxySocket.on('close', () => { logger.info({ virtualHost, virtualPort }, 'RFC shim: proxy closed'); clientSocket.destroy(); });
          clientSocket.on('close', () => proxySocket.destroy());
        })
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error({ virtualHost, virtualPort, mode, msg }, 'RFC shim: tunnel failed');
          clientSocket.destroy();
        });
    });

    let portAttempt = 3300;
    const tryListen = () => server.listen(portAttempt, '127.0.0.1');

    server.on('listening', async () => {
      try {
        await fn(portAttempt);
        resolve();
      } catch (err) {
        reject(err);
      } finally {
        server.close();
      }
    });

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE' && portAttempt < 3399) {
        portAttempt++;
        tryListen();
      } else {
        reject(new Error(`Could not bind to 3300-3399: ${err.message}`));
      }
    });

    tryListen();
  });
}
