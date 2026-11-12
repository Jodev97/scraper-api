import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Fixture {
  baseUrl: string;
  hits: Array<{ path: string; headers: http.IncomingHttpHeaders }>;
  hitCount(prefix: string): number;
  maxConcurrent(): number;
  close(): Promise<void>;
}

const PAGE_SIZE = 3;
const TOTAL_PAGES = 4;

const productHtml = (page: number, base: string) => {
  const items = Array.from({ length: PAGE_SIZE }, (_, i) => {
    const n = (page - 1) * PAGE_SIZE + i + 1;
    return `<div class="producto"><h2>Producto ${n}</h2><span class="precio">${n},50 €</span><a class="link" href="/detail/${n}">ver</a></div>`;
  }).join('\n');
  const next = page < TOTAL_PAGES ? `<a class="siguiente" href="/list?page=${page + 1}">Siguiente</a>` : '';
  return `<!doctype html><html><body><h1>Lista ${page}</h1>${items}${next}<a class="detalle" href="/detail/${(page - 1) * PAGE_SIZE + 1}">primero</a><a class="ext" href="http://other.invalid/x">ext</a><base href="${base}"></body></html>`;
};

/** A tiny site used by the integration tests. */
export async function startFixture(): Promise<Fixture> {
  const hits: Fixture['hits'] = [];
  let concurrent = 0;
  let maxConcurrent = 0;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    hits.push({ path: req.url ?? '', headers: req.headers });
    concurrent++;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    res.on('close', () => concurrent--);
    const html = (body: string, status = 200) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
      res.end(body);
    };
    const base = `http://${req.headers.host}`;

    if (url.pathname === '/list') {
      html(productHtml(Number(url.searchParams.get('page') ?? '1'), base));
    } else if (url.pathname.startsWith('/detail/')) {
      const n = url.pathname.split('/')[2];
      html(`<html><body><h1 class="name">Detalle ${n}</h1><span class="sku">SKU-${n}</span></body></html>`);
    } else if (url.pathname === '/p') {
      // urlPattern target: /p?page=N
      const n = url.searchParams.get('page');
      html(`<html><body><div class="item"><b>item-${n}</b></div><div class="item"><b>item-${n}b</b></div></body></html>`);
    } else if (url.pathname === '/many') {
      html(`<html><body>${Array.from({ length: 50 }, (_, i) => `<div class="row"><b>row-${i + 1}</b></div>`).join('')}</body></html>`);
    } else if (url.pathname === '/bigitems') {
      html(`<html><body><div class="row"><b>${'x'.repeat(100_000)}</b></div><div class="row"><b>ok</b></div></body></html>`);
    } else if (url.pathname === '/huge') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.write('<html><body>');
      const chunk = 'y'.repeat(64 * 1024);
      let sent = 0;
      const pump = () => {
        while (sent < 5 * 1024 * 1024) {
          sent += chunk.length;
          if (!res.write(chunk)) return void res.once('drain', pump);
        }
        res.end('</body></html>');
      };
      pump();
    } else if (url.pathname === '/slow') {
      setTimeout(() => html('<html><body><b class="x">slow</b></body></html>'), Number(url.searchParams.get('ms') ?? '60000'));
    } else if (url.pathname === '/status') {
      html('status page', Number(url.searchParams.get('code') ?? '500'));
    } else if (url.pathname === '/flaky') {
      // fails twice, then succeeds (per `key`)
      const key = url.searchParams.get('key') ?? 'k';
      const n = hits.filter((h) => h.path.includes(`/flaky?key=${key}`)).length;
      if (n <= 2) html('boom', 503);
      else html('<html><body><b class="x">recovered</b></body></html>');
    } else if (url.pathname === '/redirect-private') {
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
      res.end();
    } else if (url.pathname === '/redirect-ok') {
      res.writeHead(302, { location: '/detail/9' });
      res.end();
    } else if (url.pathname === '/whoami') {
      html(`<html><body><b class="ua">${req.headers['user-agent']}</b><b class="auth">${req.headers.authorization ?? ''}</b><b class="cookie">${req.headers.cookie ?? ''}</b><b class="lang">${req.headers['accept-language'] ?? ''}</b></body></html>`);
    } else if (url.pathname === '/spa') {
      html(`<html><body><div id="app"></div><script>setTimeout(()=>{document.getElementById('app').innerHTML='<div class="item"><b>rendered by js</b></div>';},150)</script></body></html>`);
    } else if (url.pathname === '/download') {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename=x.bin' });
      res.end('binary');
    } else {
      html('not found', 404);
    }
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    hits,
    hitCount: (prefix) => hits.filter((h) => h.path.startsWith(prefix)).length,
    maxConcurrent: () => maxConcurrent,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
