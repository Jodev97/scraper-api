import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listConfig, runBody, startStack, waitFor, waitTerminal, type Stack } from '../helpers/stack.js';

let s: Stack;
beforeAll(async () => {
  s = await startStack();
});
afterAll(async () => {
  await s.stop();
});

const slowConfig = (fixture: Stack['fixture']) =>
  listConfig(fixture, {
    startUrls: [`${fixture.baseUrl}/slow?ms=60000`],
    navigation: { pagination: { type: 'none' } },
    extraction: { mode: 'single', fields: [{ key: 'x', selector: { type: 'css', value: '.x' } }] },
    execution: { requestTimeoutSec: 120, maxRetries: 0, delayMs: 0, waitForSelector: null },
  });

describe('worker restart', () => {
  it('marks an in-flight run failed(WORKER_RESTARTED) and does not resume it', async () => {
    const { json } = await s.call('POST', '/v1/runs', runBody(slowConfig(s.fixture), { limits: { maxDurationSec: 60 } }));
    const runId = json.runId;
    await waitFor(async () => (await s.call('GET', `/v1/runs/${runId}`)).json.status === 'running');
    await waitFor(() => s.fixture.hitCount('/slow') > 0);
    const hits = s.fixture.hitCount('/slow');

    await s.worker.crash(); // SIGKILL-like: no finalisation
    expect((await s.call('GET', `/v1/runs/${runId}`)).json.status).toBe('running');

    await s.startExtraWorker(); // the "restarted" worker; its reaper notices the dead lease
    const view = await waitTerminal(s, runId, 20_000);
    expect(view.status).toBe('failed');
    expect(view.error.code).toBe('WORKER_RESTARTED');
    await waitFor(() => s.receiver.forRun(runId).some((w) => w.event === 'run.failed'));
    const failed = s.receiver.forRun(runId).find((w) => w.event === 'run.failed')!;
    expect((failed.data as any).error.code).toBe('WORKER_RESTARTED');
    expect(failed.context).toEqual((await s.call('GET', `/v1/runs/${runId}`)).json.context);

    // Never resumed: no new request for it, and the status stays terminal.
    await new Promise((r) => setTimeout(r, 1500));
    expect(s.fixture.hitCount('/slow')).toBe(hits);
    expect((await s.call('GET', `/v1/runs/${runId}`)).json.status).toBe('failed');
    // A fresh run still works on the new worker.
    const ok = await s.call('POST', '/v1/runs', runBody(listConfig(s.fixture, { startUrls: [`${s.fixture.baseUrl}/list?page=4`] })));
    expect((await waitTerminal(s, ok.json.runId)).status).toBe('completed');
  });

  it('graceful shutdown: after the grace period, what is left is failed', async () => {
    const st = await startStack();
    try {
      const { json } = await st.call('POST', '/v1/runs', runBody(slowConfig(st.fixture), { limits: { maxDurationSec: 60 } }));
      await waitFor(async () => (await st.call('GET', `/v1/runs/${json.runId}`)).json.status === 'running');
      await waitFor(() => st.fixture.hitCount('/slow') > 0);
      const t0 = Date.now();
      await st.worker.close(1000); // "SIGTERM" with a 1 s grace instead of 30 s
      expect(Date.now() - t0).toBeLessThan(15_000);
      const v = (await st.call('GET', `/v1/runs/${json.runId}`)).json;
      expect(v.status).toBe('failed');
      expect(v.error.code).toBe('WORKER_RESTARTED');
    } finally {
      await st.stop();
    }
  });

  it('graceful shutdown lets short runs finish within the grace period', async () => {
    const st = await startStack();
    try {
      const { json } = await st.call('POST', '/v1/runs', runBody(listConfig(st.fixture)));
      await waitFor(async () => ['running', 'completed'].includes((await st.call('GET', `/v1/runs/${json.runId}`)).json.status));
      await st.worker.close(15_000);
      expect((await st.call('GET', `/v1/runs/${json.runId}`)).json.status).toBe('completed');
    } finally {
      await st.stop();
    }
  });
});

describe('concurrency', () => {
  it('runs many simultaneous runs without mixing items or contexts', async () => {
    const N = 8;
    const created = await Promise.all(
      Array.from({ length: N }, (_, i) => {
        const cfg = listConfig(s.fixture, {
          startUrls: [`${s.fixture.baseUrl}/p?page=${100 + i}`],
          navigation: { pagination: { type: 'none' } },
          extraction: { mode: 'list', itemSelector: { type: 'css', value: '.item' }, fields: [{ key: 'n', selector: { type: 'css', value: 'b' } }] },
          dedupeKeyFields: ['n'],
        });
        const body = runBody(cfg, { context: { tenant: `tenant-${i}`, marker: `m${i}` } });
        return s.call('POST', '/v1/runs', body).then((r) => ({ i, runId: r.json.runId as string, ctx: body.context }));
      }),
    );
    expect(new Set(created.map((c) => c.runId)).size).toBe(N);

    for (const c of created) {
      const v = await waitTerminal(s, c.runId, 60_000);
      expect(v.status).toBe('completed');
      expect(v.context).toEqual(c.ctx);
      const items = (await s.call('GET', `/v1/runs/${c.runId}/items`)).json.items;
      expect(items.map((it: any) => it.data.n)).toEqual([`item-${100 + c.i}`, `item-${100 + c.i}b`]);
      expect(items.map((it: any) => it.seq)).toEqual([1, 2]);
    }
    await waitFor(() => created.every((c) => s.receiver.forRun(c.runId).some((w) => w.event === 'run.completed')));
    for (const c of created) {
      const events = s.receiver.forRun(c.runId);
      expect(events.every((e) => e.runId === c.runId)).toBe(true);
      expect(events.every((e) => JSON.stringify(e.context) === JSON.stringify(c.ctx))).toBe(true);
      const items = events.filter((e) => e.event === 'run.items').flatMap((e) => (e.data as any).items);
      expect(items.every((it: any) => it.data.n.startsWith(`item-${100 + c.i}`))).toBe(true);
    }
  });

  it('never exceeds the per-domain concurrency (2 by default)', async () => {
    const cfg = listConfig(s.fixture, {
      startUrls: Array.from({ length: 6 }, (_, i) => `${s.fixture.baseUrl}/slow?ms=300&i=${i}`),
      navigation: { pagination: { type: 'none' } },
      extraction: { mode: 'single', fields: [{ key: 'x', selector: { type: 'css', value: '.x' } }] },
      execution: { requestTimeoutSec: 20, maxRetries: 0, delayMs: 0, waitForSelector: null },
    });
    const before = s.fixture.maxConcurrent();
    void before;
    const { json } = await s.call('POST', '/v1/runs', runBody(cfg, { limits: { maxConcurrency: 6 } }));
    const v = await waitTerminal(s, json.runId);
    expect(v).toMatchObject({ status: 'completed', pagesProcessed: 6 });
    expect(s.fixture.maxConcurrent()).toBeLessThanOrEqual(2 + 0);
  });

  it('respects delayMs between requests to the same domain', async () => {
    const cfg = listConfig(s.fixture, {
      startUrls: [`${s.fixture.baseUrl}/p?page=70`, `${s.fixture.baseUrl}/p?page=71`, `${s.fixture.baseUrl}/p?page=72`],
      navigation: { pagination: { type: 'none' } },
      execution: { requestTimeoutSec: 20, maxRetries: 0, delayMs: 700, waitForSelector: null },
      extraction: { mode: 'single', fields: [{ key: 'x', selector: { type: 'css', value: 'b' } }] },
    });
    const t0 = Date.now();
    const { json } = await s.call('POST', '/v1/runs', runBody(cfg));
    await waitTerminal(s, json.runId);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1400); // 3 requests => 2 gaps of 700 ms
  });
});
