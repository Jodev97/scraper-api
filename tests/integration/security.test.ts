import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startEgressProxy, type EgressProxy } from '../../src/security/egress-proxy.js';
import { SsrfGuard } from '../../src/security/ssrf.js';
import { listConfig, runBody, startStack, waitFor, waitTerminal, API_KEY, type Stack } from '../helpers/stack.js';

let s: Stack;
beforeAll(async () => {
  s = await startStack();
});
afterAll(async () => {
  await s.stop();
});

describe('API authentication and error shape', () => {
  it('/health is public and reports Redis', async () => {
    const r = await fetch(`${s.baseUrl}/health`);
    expect(r.status).toBe(200);
  });
  it('rejects missing / wrong / malformed keys on every other route', async () => {
    for (const [method, path] of [
      ['GET', '/v1/config'],
      ['POST', '/v1/runs'],
      ['GET', '/v1/runs?ids=a'],
      ['GET', '/v1/runs/x'],
      ['GET', '/v1/runs/x/items'],
      ['POST', '/v1/runs/x/cancel'],
      ['POST', '/v1/preview'],
    ] as const) {
      const badHeaders: Array<Record<string, string>> = [{}, { authorization: 'Bearer wrong' }, { authorization: API_KEY }, { authorization: `Basic ${API_KEY}` }];
      for (const headers of badHeaders) {
        const r = await fetch(`${s.baseUrl}${path}`, { method, headers });
        expect(r.status, `${method} ${path}`).toBe(401);
        expect(await r.json()).toMatchObject({ success: false, code: 'UNAUTHORIZED' });
      }
    }
  });
  it('returns the documented error envelope', async () => {
    const r = await s.call('POST', '/v1/runs', { nope: true });
    expect(r.status).toBe(400);
    expect(r.json).toMatchObject({ success: false, code: 'VALIDATION_ERROR' });
    expect(typeof r.json.message).toBe('string');
    expect((await s.call('GET', '/v1/unknown')).json).toMatchObject({ success: false, code: 'NOT_FOUND' });
    const bad = await fetch(`${s.baseUrl}/v1/runs`, {
      method: 'POST',
      headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
      body: '{not json',
    });
    expect(bad.status).toBe(400);
  });
  it('GET /v1/config exposes version, engines, limits and queue size', async () => {
    const { status, json } = await s.call('GET', '/v1/config');
    expect(status).toBe(200);
    expect(json.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(json.engines.map((e: any) => e.name).sort()).toEqual(['browser', 'http']);
    expect(json.limits).toMatchObject({ maxPages: 100, maxDepth: 3, maxItems: 1000, maxDurationSec: 60 });
    expect(json.queue).toMatchObject({ waiting: expect.any(Number) });
  });
  it('validates payloads: unknown config version is 422, oversize context is 400', async () => {
    const cfg = listConfig(s.fixture);
    const v = await s.call('POST', '/v1/runs', runBody({ ...cfg, version: 2 }));
    expect(v.status).toBe(422);
    expect(v.json.code).toBe('UNSUPPORTED_CONFIG_VERSION');
    const big = await s.call('POST', '/v1/runs', runBody(cfg, { context: { blob: 'x'.repeat(5000) } }));
    expect(big.status).toBe(400);
    const eng = await s.call('POST', '/v1/runs', runBody({ ...cfg, engine: 'puppeteer' }));
    expect(eng.status).toBe(422);
  });
});

describe('SSRF at the API', () => {
  it('rejects start URLs pointing at forbidden destinations with 422', async () => {
    for (const url of [
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.5/admin',
      'http://[::1]/',
      'http://localhost:3000/',
      'http://scraper-redis:6379/',
      'file:///etc/passwd',
      'http://user:pw@example.com/',
    ]) {
      const r = await s.call('POST', '/v1/runs', runBody(listConfig(s.fixture, { startUrls: [url] })));
      expect(r.status, url).toBe(422);
      expect(r.json.code).toBe('URL_NOT_ALLOWED');
    }
    const p = await s.call('POST', '/v1/preview', { config: listConfig(s.fixture), url: 'http://169.254.169.254/' });
    expect(p.status).toBe(422);
  });
});

describe('SSRF at request time (redirects)', () => {
  it('http engine: a redirect to the metadata IP is refused and the page counts as failed', async () => {
    const cfg = listConfig(s.fixture, {
      startUrls: [`${s.fixture.baseUrl}/detail/1`, `${s.fixture.baseUrl}/redirect-private`],
      navigation: { pagination: { type: 'none' } },
      extraction: { mode: 'single', fields: [{ key: 'name', selector: { type: 'css', value: '.name' } }] },
    });
    const { json } = await s.call('POST', '/v1/runs', runBody(cfg));
    const view = await waitTerminal(s, json.runId);
    expect(view.status).toBe('completed');
    expect(view.pagesProcessed).toBe(1);
    expect(view.pagesFailed).toBe(1);
    expect(view.itemsExtracted).toBe(1);
  });

  it('a run whose only start URL redirects to a private IP fails with START_URLS_FAILED', async () => {
    const cfg = listConfig(s.fixture, {
      startUrls: [`${s.fixture.baseUrl}/redirect-private`],
      navigation: { pagination: { type: 'none' } },
      extraction: { mode: 'single', fields: [{ key: 'name', selector: { type: 'css', value: 'h1' } }] },
    });
    const { json } = await s.call('POST', '/v1/runs', runBody(cfg));
    const view = await waitTerminal(s, json.runId);
    expect(view.status).toBe('failed');
    expect(view.error.code).toBe('START_URLS_FAILED');
  });
});

describe('egress proxy: DNS pinning and blocking', () => {
  let proxy: EgressProxy;
  let origin: http.Server;
  let originPort: number;
  let lookups = 0;
  let answer = '127.0.0.1';

  beforeAll(async () => {
    origin = http.createServer((req, res) => {
      res.end(`hello from origin, host=${req.headers.host}`);
    });
    await new Promise<void>((r) => origin.listen(0, '127.0.0.1', r));
    originPort = (origin.address() as AddressInfo).port;
    const guard = new SsrfGuard({
      testAllowIps: ['127.0.0.1'],
      resolver: async () => {
        lookups++;
        return [{ address: answer, family: 4 as const }];
      },
    });
    proxy = await startEgressProxy(guard);
  });
  afterAll(async () => {
    await proxy.close();
    origin.closeAllConnections();
    origin.close();
  });

  const viaProxy = (target: string) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const u = new URL(proxy.url);
      const req = http.request({ host: u.hostname, port: u.port, path: target, headers: { host: new URL(target).host } }, (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b }));
      });
      req.on('error', reject);
      req.end();
    });

  it('connects to the address validated by the guard (no second resolution)', async () => {
    answer = '127.0.0.1'; // allowed in tests only
    const before = lookups;
    const r = await viaProxy(`http://pinned.example.com:${originPort}/`);
    expect(r.status).toBe(200);
    expect(r.body).toContain('host=pinned.example.com');
    expect(lookups - before).toBe(1);
  });

  it('blocks a hostname that resolves to a private IP (DNS rebinding)', async () => {
    answer = '10.1.2.3';
    const r = await viaProxy(`http://rebind.example.com:${originPort}/`);
    expect(r.status).toBe(403);
    answer = '169.254.169.254';
    expect((await viaProxy(`http://rebind2.example.com:${originPort}/`)).status).toBe(403);
    expect(proxy.stats().blocked).toBeGreaterThanOrEqual(2);
  });

  it('blocks CONNECT (https) tunnels to private destinations', async () => {
    answer = '192.168.1.1';
    const u = new URL(proxy.url);
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: u.hostname, port: Number(u.port), method: 'CONNECT', path: 'evil.example.com:443' });
      req.on('connect', (res, socket) => {
        socket.destroy();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(403);
  });
});

describe('secrets never leak', () => {
  it('does not appear in webhooks, run views or item responses, but is sent to the target', async () => {
    const secret = 'Bearer sup3r-secret-token-9f8e7d';
    const cookieVal = 'cookie-secret-value-abc123';
    const cfg = listConfig(s.fixture, {
      startUrls: [`${s.fixture.baseUrl}/whoami`],
      navigation: { pagination: { type: 'none' } },
      extraction: {
        mode: 'single',
        fields: [
          { key: 'ua', selector: { type: 'css', value: '.ua' } },
          { key: 'lang', selector: { type: 'css', value: '.lang' } },
          { key: 'authSeen', selector: { type: 'css', value: '.auth' }, transform: 'trim' },
        ],
      },
      headers: { 'Accept-Language': 'es' },
    });
    const body = runBody(cfg, {
      secrets: {
        headers: { Authorization: secret },
        cookies: [{ name: 'sid', value: cookieVal, domain: '127.0.0.1' }],
      },
    });
    const { json } = await s.call('POST', '/v1/runs', body);
    const view = await waitTerminal(s, json.runId);
    expect(view.status).toBe('completed');

    // The target did receive the secret, our UA and the configured header.
    const hit = s.fixture.hits.filter((h) => h.path === '/whoami').pop()!;
    expect(hit.headers.authorization).toBe(secret);
    expect(hit.headers.cookie).toContain(`sid=${cookieVal}`);
    expect(hit.headers['user-agent']).toBe('NopxusScraperTest/1.0');
    expect(hit.headers['accept-language']).toBe('es');

    const items = await s.call('GET', `/v1/runs/${json.runId}/items`);
    expect(items.json.items[0].data).toMatchObject({ ua: 'NopxusScraperTest/1.0', lang: 'es' });

    // The echo page put the token in `authSeen`: that is extracted *data* the
    // customer asked for. Everything else must be free of it.
    await waitFor(() => s.receiver.forRun(json.runId).some((w) => w.event === 'run.completed'));
    const everything = [
      JSON.stringify(view),
      ...s.receiver.attempts.filter((a) => a.body.runId === json.runId && a.body.event !== 'run.items').map((a) => a.raw),
    ].join('\n');
    expect(everything).not.toContain('sup3r-secret-token');
    expect(everything).not.toContain(cookieVal);
  });
});
