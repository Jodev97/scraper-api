import http from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import { SsrfError, SsrfGuard } from './ssrf.js';

/**
 * Loopback-only forward proxy through which ALL outbound traffic of the
 * crawlers (got-scraping for the `http` engine, Chromium for `browser`) is
 * forced. It is the single enforcement point for the SSRF policy:
 *
 *  - every request / CONNECT target is resolved and validated *here*, at
 *    connect time, and the socket is opened to the validated IP (no second
 *    DNS lookup => no DNS rebinding window);
 *  - redirects are followed by the client, so every hop arrives as a fresh
 *    request and is validated again;
 *  - it also covers every Chromium subresource, WebSocket, etc.
 */
export interface EgressProxy {
  url: string;
  port: number;
  /** Total bytes relayed from upstream servers to clients since start. */
  stats(): { bytesDown: number; blocked: number };
  close(): Promise<void>;
}

const HOP_BY_HOP = new Set([
  'connection',
  'proxy-connection',
  'proxy-authorization',
  'proxy-authenticate',
  'keep-alive',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export async function startEgressProxy(
  guard: SsrfGuard,
  opts: { onBlocked?: (target: string, err: SsrfError) => void; connectTimeoutMs?: number } = {},
): Promise<EgressProxy> {
  let bytesDown = 0;
  let blocked = 0;
  const connectTimeoutMs = opts.connectTimeoutMs ?? 15_000;
  const sockets = new Set<net.Socket>();

  const track = (s: net.Socket) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  };

  const server = http.createServer(async (req, res) => {
    let target: URL;
    try {
      target = new URL(req.url ?? '');
    } catch {
      res.writeHead(400).end('bad proxy request');
      return;
    }
    if (target.protocol !== 'http:') {
      res.writeHead(400).end('only absolute http: URLs are proxied here');
      return;
    }
    let resolved;
    try {
      resolved = await guard.resolveUrl(target.href);
    } catch (e) {
      blocked++;
      if (e instanceof SsrfError) opts.onBlocked?.(target.href, e);
      res.writeHead(403, { 'content-type': 'application/json', 'x-ssrf-blocked': '1' });
      res.end(JSON.stringify({ blocked: true, message: (e as Error).message }));
      return;
    }

    const headers: http.OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (!HOP_BY_HOP.has(k.toLowerCase()) && v !== undefined) headers[k] = v;
    }
    headers.host = target.host;

    const upstream = http.request({
      host: resolved.address, // the validated IP — never re-resolved
      port: resolved.port,
      method: req.method,
      path: `${target.pathname}${target.search}`,
      headers,
      setHost: false,
      timeout: connectTimeoutMs * 4,
    });
    upstream.on('socket', track);
    upstream.on('response', (up) => {
      const outHeaders: http.OutgoingHttpHeaders = {};
      for (const [k, v] of Object.entries(up.headers)) {
        if (!HOP_BY_HOP.has(k.toLowerCase()) && v !== undefined) outHeaders[k] = v;
      }
      res.writeHead(up.statusCode ?? 502, up.statusMessage, outHeaders);
      up.on('data', (c: Buffer) => {
        bytesDown += c.length;
      });
      up.pipe(res);
      up.on('error', () => res.destroy());
    });
    upstream.on('timeout', () => upstream.destroy(new Error('upstream timeout')));
    upstream.on('error', (err) => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' }).end(`upstream error: ${err.message}`);
      else res.destroy();
    });
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  });

  server.on('connect', async (req, clientSocket: Duplex, head: Buffer) => {
    clientSocket.on('error', () => clientSocket.destroy());
    const raw = req.url ?? '';
    const idx = raw.lastIndexOf(':');
    const host = idx === -1 ? raw : raw.slice(0, idx);
    const port = idx === -1 ? 443 : Number(raw.slice(idx + 1));
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
      clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    let resolved;
    try {
      // CONNECT carries only host:port; validate it as an https URL.
      resolved = await guard.resolveUrl(`https://${host.includes(':') ? `[${host.replace(/^\[|\]$/g, '')}]` : host}:${port}/`);
    } catch (e) {
      blocked++;
      if (e instanceof SsrfError) opts.onBlocked?.(raw, e);
      clientSocket.end('HTTP/1.1 403 Forbidden\r\nX-SSRF-Blocked: 1\r\nConnection: close\r\n\r\n');
      return;
    }
    const upstream = net.connect({ host: resolved.address, port: resolved.port });
    track(upstream);
    upstream.setTimeout(connectTimeoutMs, () => upstream.destroy());
    upstream.once('connect', () => {
      upstream.setTimeout(0);
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.on('data', (c: Buffer) => {
        bytesDown += c.length;
      });
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on('error', () => {
      if (!clientSocket.destroyed) clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    });
    upstream.on('close', () => clientSocket.destroy());
    clientSocket.on('close', () => upstream.destroy());
  });

  server.on('connection', track);
  server.on('clientError', (_e, socket) => socket.destroy());

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as net.AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    stats: () => ({ bytesDown, blocked }),
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
