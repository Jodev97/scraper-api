import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { listConfig, runBody, startStack, waitFor, waitTerminal, type Stack } from '../helpers/stack.js';

// Chromium's first launch can be slow on a cold machine.
vi.setConfig({ testTimeout: 90_000 });

let s: Stack;
beforeAll(async () => {
  s = await startStack();
}, 60_000);
afterAll(async () => {
  await s.stop();
});

const spaConfig = (fixture: Stack['fixture'], over: Record<string, unknown> = {}) =>
  listConfig(fixture, {
    engine: 'browser',
    startUrls: [`${fixture.baseUrl}/spa`],
    navigation: { pagination: { type: 'none' } },
    extraction: { mode: 'list', itemSelector: { type: 'xpath', value: "//div[@class='item']" }, fields: [{ key: 'text', selector: { type: 'css', value: 'b' } }] },
    execution: { requestTimeoutSec: 20, maxRetries: 0, delayMs: 0, waitForSelector: '.item' },
    ...over,
  });

describe('browser engine (Chromium)', () => {
  it('renders JavaScript before extracting (waitForSelector) and uses the identifiable UA', async () => {
    const { json } = await s.call('POST', '/v1/runs', runBody(spaConfig(s.fixture)));
    const v = await waitTerminal(s, json.runId, 60_000);
    expect(v).toMatchObject({ status: 'completed', pagesProcessed: 1, itemsExtracted: 1 });
    const items = (await s.call('GET', `/v1/runs/${json.runId}/items`)).json.items;
    expect(items[0].data.text).toBe('rendered by js');
    const ua = s.fixture.hits.filter((h) => h.path === '/spa').pop()!.headers['user-agent'];
    expect(ua).toContain('NopxusScraperTest/1.0');
  });

  it('the same page through the http engine does NOT see the JS-rendered content', async () => {
    const cfg = spaConfig(s.fixture, { engine: 'http', execution: { requestTimeoutSec: 10, maxRetries: 0, delayMs: 0, waitForSelector: null } });
    const { json } = await s.call('POST', '/v1/runs', runBody(cfg));
    const v = await waitTerminal(s, json.runId);
    expect(v.itemsExtracted).toBe(0);
  });

  it('blocks navigations and redirects to private addresses', async () => {
    const cfg = spaConfig(s.fixture, {
      startUrls: [`${s.fixture.baseUrl}/redirect-private`],
      execution: { requestTimeoutSec: 10, maxRetries: 0, delayMs: 0, waitForSelector: null },
    });
    const { json } = await s.call('POST', '/v1/runs', runBody(cfg, { limits: { maxDurationSec: 60 } }));
    const v = await waitTerminal(s, json.runId, 70_000);
    expect(v.status).toBe('failed');
    expect(v.error.code).toBe('START_URLS_FAILED');
  });

  it('refuses downloads', async () => {
    const cfg = spaConfig(s.fixture, {
      startUrls: [`${s.fixture.baseUrl}/download`],
      execution: { requestTimeoutSec: 10, maxRetries: 0, delayMs: 0, waitForSelector: null },
    });
    const { json } = await s.call('POST', '/v1/runs', runBody(cfg));
    const v = await waitTerminal(s, json.runId, 60_000);
    expect(v.itemsExtracted).toBe(0);
    expect(v.status).toBe('failed');
  });

  it('cancels in under 5 s and closes the browser', async () => {
    const cfg = spaConfig(s.fixture, {
      startUrls: [`${s.fixture.baseUrl}/slow?ms=60000`],
      execution: { requestTimeoutSec: 120, maxRetries: 0, delayMs: 0, waitForSelector: null },
    });
    const { json } = await s.call('POST', '/v1/runs', runBody(cfg, { limits: { maxDurationSec: 60 } }));
    await waitFor(() => s.fixture.hitCount('/slow') > 0, { timeout: 40_000, message: 'browser request in flight' });
    const t0 = Date.now();
    await s.call('POST', `/v1/runs/${json.runId}/cancel`);
    const v = await waitTerminal(s, json.runId, 10_000);
    expect(v.status).toBe('cancelled');
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});

describe('POST /v1/preview', () => {
  it('extracts from a single page synchronously, without following pagination', async () => {
    const r = await s.call('POST', '/v1/preview', { config: listConfig(s.fixture) });
    expect(r.status).toBe(200);
    expect(r.json.itemsFound).toBe(3);
    expect(r.json.items).toHaveLength(3);
    expect(r.json.items[0].data).toMatchObject({ titulo: 'Producto 1', precio: 1.5 });
    expect(s.fixture.hitCount('/list?page=2')).toBe(0);
  });
  it('honours url / maxItems overrides', async () => {
    const r = await s.call('POST', '/v1/preview', { config: listConfig(s.fixture), url: `${s.fixture.baseUrl}/list?page=3`, maxItems: 2 });
    expect(r.json.items).toHaveLength(2);
    expect(r.json.itemsFound).toBe(3);
    expect(r.json.items[0].data.titulo).toBe('Producto 7');
  });
  it('works with the browser engine', async () => {
    const r = await s.call('POST', '/v1/preview', { config: spaConfig(s.fixture) });
    expect(r.status).toBe(200);
    expect(r.json.items[0].data.text).toBe('rendered by js');
  });
  it('reports page failures as 422 PREVIEW_FAILED and validates input', async () => {
    const r = await s.call('POST', '/v1/preview', { config: listConfig(s.fixture), url: `${s.fixture.baseUrl}/status?code=404` });
    expect(r.status).toBe(422);
    expect(r.json).toMatchObject({ success: false, code: 'PREVIEW_FAILED' });
    expect((await s.call('POST', '/v1/preview', { config: { ...listConfig(s.fixture), version: 9 } })).status).toBe(422);
    expect((await s.call('POST', '/v1/preview', {})).status).toBe(400);
  });
});
