import { describe, expect, it } from 'vitest';
import { CrawlCore, DomainGate } from '../../src/engines/core.js';
import type { EngineContext, RunSink } from '../../src/engines/types.js';
import { scrapeConfigSchema } from '../../src/contract/schemas.js';
import { Redactor } from '../../src/security/redact.js';
import { SsrfGuard } from '../../src/security/ssrf.js';

function makeCtx(over: Record<string, unknown> = {}, secrets?: EngineContext['secrets']): { ctx: EngineContext; logs: string[]; items: unknown[] } {
  const logs: string[] = [];
  const items: unknown[] = [];
  const sink: RunSink = {
    itemLimitReached: false,
    addItem: (_u, d) => (items.push(d), 'added'),
    log: (_l, m) => void logs.push(m),
    pageProcessed: () => undefined,
    pageFailed: () => undefined,
    urlsEnqueued: () => undefined,
    addBytes: () => undefined,
    limitReached: (l) => void logs.push(`limit:${l}`),
  };
  const config = scrapeConfigSchema.parse({
    version: 1,
    startUrls: ['https://shop.example.com/list'],
    headers: { 'Accept-Language': 'es' },
    extraction: { mode: 'list', itemSelector: { type: 'css', value: '.p' }, fields: [{ key: 't', selector: { type: 'css', value: 'h2' } }] },
    navigation: {
      pagination: { type: 'nextLink', selector: { type: 'css', value: 'a.next' } },
      followLinks: { selector: { type: 'css', value: 'a.d' }, sameDomainOnly: true },
    },
    ...over,
  });
  const ctx: EngineContext = {
    config,
    limits: { maxPages: 2, maxDepth: 1, maxItems: 100, maxDurationSec: 60, maxConcurrency: 2 },
    ...(secrets ? { secrets } : {}),
    signal: new AbortController().signal,
    sink,
    guard: new SsrfGuard(),
    proxyUrl: 'http://127.0.0.1:1',
    userAgent: 'ua',
    redactor: new Redactor(secrets),
    maxResponseBytes: 1e6,
    maxConcurrencyPerDomain: 2,
  };
  return { ctx, logs, items };
}

describe('CrawlCore', () => {
  it('only sends secret headers/cookies to the hosts of the start URLs', () => {
    const { ctx } = makeCtx({}, {
      headers: { Authorization: 'Bearer abc123' },
      cookies: [{ name: 'sid', value: 'v1', domain: 'example.com' }],
    });
    const core = new CrawlCore(ctx);
    expect(core.headersFor('https://shop.example.com/x')).toMatchObject({ Authorization: 'Bearer abc123', 'Accept-Language': 'es' });
    const other = core.headersFor('https://evil.com/x');
    expect(other.Authorization).toBeUndefined();
    expect(other['Accept-Language']).toBe('es');
    expect(core.cookieHeaderFor('https://shop.example.com/')).toBe('sid=v1');
    expect(core.cookieHeaderFor('https://evil.com/')).toBeUndefined();
    expect(core.cookieHeaderFor('https://notexample.com/')).toBeUndefined();
  });

  it('claims at most maxPages and warns once', () => {
    const { ctx, logs } = makeCtx();
    const core = new CrawlCore(ctx);
    expect([core.claimPage(), core.claimPage(), core.claimPage(), core.claimPage()]).toEqual([true, true, false, false]);
    expect(logs.filter((l) => l === 'limit:maxPages').length).toBeGreaterThanOrEqual(1);
  });

  it('builds start requests, including urlPattern pages bounded by maxPages', () => {
    const { ctx } = makeCtx({
      queryParams: { q: '1' },
      navigation: { pagination: { type: 'urlPattern', template: 'https://shop.example.com/p/{page}', from: 1, to: 1000, step: 1 } },
    });
    const reqs = new CrawlCore(ctx).startRequests();
    expect(reqs[0]!.url).toBe('https://shop.example.com/list?q=1');
    expect(reqs[1]!.url).toBe('https://shop.example.com/p/1?q=1');
    expect(reqs.length).toBeLessThanOrEqual(ctx.limits.maxPages + 1);
  });

  const HTML = `<html><body><div class="p"><h2>A</h2></div><a class="next" href="/list?page=2">n</a>
    <a class="d" href="/d/1">1</a><a class="d" href="https://other.com/d/2">2</a><a class="d" href="https://www.shop.example.com/d/3">3</a></body></html>`;

  it('discovers next page and same-domain detail links, increasing depth only for details', () => {
    const { ctx, items } = makeCtx();
    const next = new CrawlCore(ctx).handlePage(HTML, 'https://shop.example.com/list', { depth: 0, kind: 'start' });
    expect(items).toEqual([{ t: 'A' }]);
    expect(next.map((n) => [n.url, n.userData.kind, n.userData.depth])).toEqual([
      ['https://shop.example.com/list?page=2', 'page', 0],
      ['https://shop.example.com/d/1', 'detail', 1],
      ['https://www.shop.example.com/d/3', 'detail', 1], // www. is treated as the same domain
    ]);
  });

  it('does not follow links beyond maxDepth, nor paginate from detail pages', () => {
    const { ctx, logs } = makeCtx();
    const core = new CrawlCore(ctx);
    const atMax = core.handlePage(HTML, 'https://shop.example.com/d/1', { depth: 1, kind: 'detail' });
    expect(atMax).toEqual([]);
    expect(logs).toContain('limit:maxDepth');
  });

  it('single-page mode (preview) never discovers links', () => {
    const { ctx } = makeCtx();
    ctx.singlePage = true;
    expect(new CrawlCore(ctx).handlePage(HTML, 'https://shop.example.com/list', { depth: 0, kind: 'start' })).toEqual([]);
  });
});

describe('DomainGate', () => {
  it('limits concurrency per host and spaces request starts by delayMs', async () => {
    const gate = new DomainGate(2, 80);
    const starts: number[] = [];
    let active = 0;
    let maxActive = 0;
    const t0 = Date.now();
    await Promise.all(
      Array.from({ length: 5 }, async () => {
        const release = await gate.acquire('a.com');
        starts.push(Date.now() - t0);
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 120));
        active--;
        release();
      }),
    );
    expect(maxActive).toBeLessThanOrEqual(2);
    starts.sort((a, b) => a - b);
    for (let i = 1; i < starts.length; i++) expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(60);
  });
  it('does not make different hosts wait for each other', async () => {
    const gate = new DomainGate(1, 0);
    const r1 = await gate.acquire('a.com');
    const t0 = Date.now();
    const r2 = await gate.acquire('b.com');
    expect(Date.now() - t0).toBeLessThan(50);
    r1();
    r2();
  });
});
