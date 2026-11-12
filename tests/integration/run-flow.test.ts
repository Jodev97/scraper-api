import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listConfig, runBody, startStack, waitFor, waitTerminal, type Stack } from '../helpers/stack.js';

let s: Stack;
beforeAll(async () => {
  s = await startStack();
});
afterAll(async () => {
  await s.stop();
});

describe('full run with pagination', () => {
  let runId: string;
  let body: ReturnType<typeof runBody>;

  it('accepts the run (202) and replays it idempotently without enqueuing another', async () => {
    body = runBody(listConfig(s.fixture));
    const first = await s.call('POST', '/v1/runs', body);
    expect(first.status).toBe(202);
    expect(first.json).toMatchObject({ status: 'queued' });
    runId = first.json.runId;

    const again = await s.call('POST', '/v1/runs', { ...body, context: { different: true } });
    expect(again.status).toBe(202);
    expect(again.json.runId).toBe(runId);
  });

  it('completes, extracting every item of every page in order', async () => {
    const view = await waitTerminal(s, runId);
    expect(view).toMatchObject({
      runId,
      status: 'completed',
      pagesProcessed: 4,
      pagesFailed: 0,
      itemsExtracted: 12,
      lastSeq: 12,
      error: null,
    });
    expect(view.context).toEqual(body.context);
    expect(view.startedAt).toBeTruthy();
    expect(view.finishedAt).toBeTruthy();
    expect(view.stats.bytesDownloaded).toBeGreaterThan(0);

    // Only one run was created even though the POST was repeated.
    expect(s.fixture.hitCount('/list?page=1')).toBe(1);

    const { json } = await s.call('GET', `/v1/runs/${runId}/items?afterSeq=0&limit=1000`);
    expect(json.items).toHaveLength(12);
    expect(json.items.map((i: any) => i.seq)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    expect(json.items[0]).toMatchObject({
      seq: 1,
      data: { titulo: 'Producto 1', precio: 1.5, url: `${s.fixture.baseUrl}/detail/1` },
    });
    expect(json.items[0].sourceUrl).toContain('/list?page=1');
    expect(json.items[0].dedupeKey).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set(json.items.map((i: any) => i.dedupeKey)).size).toBe(12);
  });

  it('sends signed webhooks: started ... items ... completed (last), with context and stable shape', async () => {
    await waitFor(() => s.receiver.forRun(runId).some((w) => w.event === 'run.completed'), { message: 'run.completed webhook' });
    const events = s.receiver.forRun(runId);
    expect(events[0]!.event).toBe('run.started');
    expect(events[events.length - 1]!.event).toBe('run.completed');
    for (const e of events) {
      expect(e.version).toBe(1);
      expect(e.context).toEqual(body.context);
      expect(e.deliveryId).toMatch(/^[0-9a-f-]{36}$/);
      expect(Date.parse(e.timestamp)).not.toBeNaN();
    }
    expect(s.receiver.attempts.every((a) => a.signatureValid)).toBe(true);

    const itemEvents = events.filter((e) => e.event === 'run.items');
    const all = itemEvents.flatMap((e) => (e.data as any).items);
    expect(all.map((i: any) => i.seq)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    let prevTo = 0;
    for (const e of itemEvents) {
      const d = e.data as any;
      expect(d.fromSeq).toBe(prevTo + 1);
      expect(d.toSeq).toBe(d.items[d.items.length - 1].seq);
      prevTo = d.toSeq;
    }
    // Terminal event comes after the last items batch and carries the view.
    const lastItems = events.map((e) => e.event).lastIndexOf('run.items');
    expect(lastItems).toBeLessThan(events.length - 1);
    expect((events[events.length - 1]!.data as any)).toMatchObject({ runId, status: 'completed', itemsExtracted: 12 });
    expect(events.some((e) => e.event === 'run.log')).toBe(true);
  });

  it('lists runs by id, omitting unknown ones; 404 for unknown run', async () => {
    const { json } = await s.call('GET', `/v1/runs?ids=${runId},nope,also-nope`);
    expect(json.runs).toHaveLength(1);
    expect(json.runs[0].runId).toBe(runId);
    expect((await s.call('GET', '/v1/runs/nope')).status).toBe(404);
    expect((await s.call('GET', '/v1/runs?ids=')).status).toBe(400);
    const many = Array.from({ length: 101 }, (_, i) => `id${i}`).join(',');
    expect((await s.call('GET', `/v1/runs?ids=${many}`)).status).toBe(400);
  });

  it('serves items incrementally with afterSeq / limit', async () => {
    const a = await s.call('GET', `/v1/runs/${runId}/items?afterSeq=0&limit=5`);
    expect(a.json.items.map((i: any) => i.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(a.json).toMatchObject({ hasMore: true, nextSeq: 5 });
    const b = await s.call('GET', `/v1/runs/${runId}/items?afterSeq=${a.json.nextSeq}&limit=100`);
    expect(b.json.items.map((i: any) => i.seq)).toEqual([6, 7, 8, 9, 10, 11, 12]);
    expect(b.json.hasMore).toBe(false);
    const c = await s.call('GET', `/v1/runs/${runId}/items?afterSeq=12`);
    expect(c.json.items).toEqual([]);
    expect((await s.call('GET', `/v1/runs/${runId}/items?afterSeq=-1`)).status).toBe(400);
    expect((await s.call('GET', `/v1/runs/nope/items`)).status).toBe(404);
  });

  it('cancel on a terminal run is idempotent and returns the current state', async () => {
    const r = await s.call('POST', `/v1/runs/${runId}/cancel`);
    expect(r.status).toBe(200);
    expect(r.json.status).toBe('completed');
    expect((await s.call('POST', `/v1/runs/${runId}/cancel`)).json.status).toBe('completed');
  });
});
