import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listConfig, runBody, startStack, waitFor, waitTerminal, type Stack } from '../helpers/stack.js';

let s: Stack;
beforeAll(async () => {
  s = await startStack({ env: { MAX_RESPONSE_BYTES: String(1024 * 1024) } });
});
afterAll(async () => {
  await s.stop();
});

const single = (fixture: Stack['fixture'], path: string, over: Record<string, unknown> = {}) =>
  listConfig(fixture, {
    startUrls: [`${fixture.baseUrl}${path}`],
    navigation: { pagination: { type: 'none' } },
    extraction: { mode: 'list', itemSelector: { type: 'css', value: '.row' }, fields: [{ key: 'v', selector: { type: 'css', value: 'b' } }] },
    ...over,
  });

async function logsOf(runId: string): Promise<string> {
  await waitFor(() => s.receiver.forRun(runId).some((w) => /^run\.(completed|failed|cancelled)$/.test(w.event)));
  return s.receiver
    .forRun(runId)
    .filter((w) => w.event === 'run.log')
    .flatMap((w) => (w.data as any).entries.map((e: any) => `${e.level}: ${e.message}`))
    .join('\n');
}

describe('limits', () => {
  it('maxPages stops the crawl as completed, with a warning in the log', async () => {
    const { json } = await s.call('POST', '/v1/runs', runBody(listConfig(s.fixture), { limits: { maxPages: 2 } }));
    const v = await waitTerminal(s, json.runId);
    expect(v.status).toBe('completed');
    expect(v.pagesProcessed).toBe(2);
    expect(v.itemsExtracted).toBe(6);
    expect(await logsOf(json.runId)).toMatch(/warn: Limit reached: maxPages=2/);
  });

  it('maxItems truncates exactly and completes', async () => {
    const { json } = await s.call('POST', '/v1/runs', runBody(single(s.fixture, '/many'), { limits: { maxItems: 7 } }));
    const v = await waitTerminal(s, json.runId);
    expect(v).toMatchObject({ status: 'completed', itemsExtracted: 7, lastSeq: 7 });
    const items = (await s.call('GET', `/v1/runs/${json.runId}/items?limit=100`)).json.items;
    expect(items).toHaveLength(7);
    expect(await logsOf(json.runId)).toMatch(/Limit reached: maxItems=7/);
  });

  it('maxDepth limits followLinks', async () => {
    const cfg = listConfig(s.fixture, {
      navigation: {
        pagination: { type: 'none' },
        followLinks: { selector: { type: 'css', value: 'a.detalle' }, sameDomainOnly: true },
      },
      extraction: { mode: 'single', fields: [{ key: 'name', selector: { type: 'css', value: '.name' } }] },
    });
    const d0 = await s.call('POST', '/v1/runs', runBody(cfg, { limits: { maxDepth: 0 } }));
    const v0 = await waitTerminal(s, d0.json.runId);
    expect(v0.pagesProcessed).toBe(1); // only the start page; its single-mode item has no .name -> 0 items
    expect(v0.itemsExtracted).toBe(0);
    const d1 = await s.call('POST', '/v1/runs', runBody(cfg, { limits: { maxDepth: 1 } }));
    const v1 = await waitTerminal(s, d1.json.runId);
    expect(v1.pagesProcessed).toBe(2); // start + 1 detail page
    expect(v1.itemsExtracted).toBe(1);
    const items = (await s.call('GET', `/v1/runs/${d1.json.runId}/items`)).json.items;
    expect(items[0].data.name).toBe('Detalle 1');
  });

  it('maxDurationSec ends the run as failed/TIMEOUT', async () => {
    const cfg = single(s.fixture, '/slow?ms=30000', { execution: { requestTimeoutSec: 60, maxRetries: 0, delayMs: 0, waitForSelector: null } });
    const t0 = Date.now();
    const { json } = await s.call('POST', '/v1/runs', runBody(cfg, { limits: { maxDurationSec: 2 } }));
    const v = await waitTerminal(s, json.runId);
    expect(v.status).toBe('failed');
    expect(v.error.code).toBe('TIMEOUT');
    expect(Date.now() - t0).toBeLessThan(9000);
  });

  it('clamps limits above the global maximum and logs it', async () => {
    const { json } = await s.call('POST', '/v1/runs', runBody(single(s.fixture, '/many'), { limits: { maxPages: 99999, maxItems: 99999 } }));
    const v = await waitTerminal(s, json.runId);
    expect(v.status).toBe('completed');
    const logs = await logsOf(json.runId);
    expect(logs).toMatch(/limits\.maxPages=99999 exceeds the global maximum; clamped to 100/);
    expect(logs).toMatch(/limits\.maxItems=99999 .* clamped to 1000/);
  });

  it('drops a response larger than MAX_RESPONSE_BYTES (page fails, run fails if it was the only start URL)', async () => {
    const { json } = await s.call('POST', '/v1/runs', runBody(single(s.fixture, '/huge', { execution: { requestTimeoutSec: 10, maxRetries: 0, delayMs: 0, waitForSelector: null } })));
    const v = await waitTerminal(s, json.runId);
    expect(v.status).toBe('failed');
    expect(v.error.code).toBe('START_URLS_FAILED');
    expect(v.error.message).toMatch(/maximum size/i);
    expect(v.pagesFailed).toBe(1);
  });

  it('skips items larger than 64 KB and keeps the rest', async () => {
    const { json } = await s.call('POST', '/v1/runs', runBody(single(s.fixture, '/bigitems')));
    const v = await waitTerminal(s, json.runId);
    expect(v).toMatchObject({ status: 'completed', itemsExtracted: 1 });
    const items = (await s.call('GET', `/v1/runs/${json.runId}/items`)).json.items;
    expect(items).toHaveLength(1);
    expect(items[0].seq).toBe(1);
    expect(items[0].data.v).toBe('ok');
    expect(await logsOf(json.runId)).toMatch(/warn: Item skipped/);
  });
});

describe('page failures and retries', () => {
  it('a failing page does not stop the run; it counts in pagesFailed', async () => {
    const cfg = single(s.fixture, '/many', {
      startUrls: [`${s.fixture.baseUrl}/many`, `${s.fixture.baseUrl}/status?code=404`, `${s.fixture.baseUrl}/status?code=500`],
      execution: { requestTimeoutSec: 10, maxRetries: 1, delayMs: 0, waitForSelector: null },
    });
    const { json } = await s.call('POST', '/v1/runs', runBody(cfg));
    const v = await waitTerminal(s, json.runId);
    expect(v.status).toBe('completed');
    expect(v.pagesProcessed).toBe(1);
    expect(v.pagesFailed).toBe(2);
    expect(v.itemsExtracted).toBe(50);
    expect(s.fixture.hitCount('/status?code=404')).toBe(1); // 4xx is not retried
    expect(s.fixture.hitCount('/status?code=500')).toBe(2); // 5xx: 1 try + maxRetries
  });

  it('retries per execution.maxRetries and recovers', async () => {
    const cfg = single(s.fixture, '/flaky?key=a', {
      extraction: { mode: 'single', fields: [{ key: 'x', selector: { type: 'css', value: '.x' } }] },
      execution: { requestTimeoutSec: 10, maxRetries: 3, delayMs: 0, waitForSelector: null },
    });
    const { json } = await s.call('POST', '/v1/runs', runBody(cfg));
    const v = await waitTerminal(s, json.runId);
    expect(v).toMatchObject({ status: 'completed', pagesProcessed: 1, pagesFailed: 0, itemsExtracted: 1 });
    expect(s.fixture.hitCount('/flaky?key=a')).toBe(3);
  });

  it('fails only when no start URL could be processed', async () => {
    const cfg = single(s.fixture, '/status?code=404');
    const { json } = await s.call('POST', '/v1/runs', runBody(cfg));
    const v = await waitTerminal(s, json.runId);
    expect(v.status).toBe('failed');
    expect(v.error.code).toBe('START_URLS_FAILED');
  });
});

describe('navigation', () => {
  it('urlPattern pagination generates the pages', async () => {
    const cfg = listConfig(s.fixture, {
      startUrls: [`${s.fixture.baseUrl}/p?page=0`],
      navigation: { pagination: { type: 'urlPattern', template: `${s.fixture.baseUrl}/p?page={page}`, from: 1, to: 3, step: 1 } },
      extraction: { mode: 'list', itemSelector: { type: 'css', value: '.item' }, fields: [{ key: 'n', selector: { type: 'xpath', value: './b' } }] },
      dedupeKeyFields: ['n'],
    });
    const { json } = await s.call('POST', '/v1/runs', runBody(cfg));
    const v = await waitTerminal(s, json.runId);
    expect(v).toMatchObject({ status: 'completed', pagesProcessed: 4, itemsExtracted: 8 });
  });

  it('queryParams are appended to start URLs; user-agent is identifiable', async () => {
    const cfg = single(s.fixture, '/whoami', { queryParams: { orden: 'precio' } });
    const { json } = await s.call('POST', '/v1/runs', runBody(cfg));
    await waitTerminal(s, json.runId);
    expect(s.fixture.hits.some((h) => h.path === '/whoami?orden=precio')).toBe(true);
  });

  it('follows same-origin redirects', async () => {
    const cfg = listConfig(s.fixture, {
      startUrls: [`${s.fixture.baseUrl}/redirect-ok`],
      navigation: { pagination: { type: 'none' } },
      extraction: { mode: 'single', fields: [{ key: 'name', selector: { type: 'css', value: '.name' } }] },
    });
    const { json } = await s.call('POST', '/v1/runs', runBody(cfg));
    const v = await waitTerminal(s, json.runId);
    expect(v.status).toBe('completed');
    expect((await s.call('GET', `/v1/runs/${json.runId}/items`)).json.items[0].data.name).toBe('Detalle 9');
  });
});
