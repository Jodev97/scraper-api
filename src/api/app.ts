import express, { type NextFunction, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { Queue, QueueEvents } from 'bullmq';
import { globalLimits, type ApiEnv } from '../config/env.js';
import {
  ApiError,
  CONFIG_VERSION,
  SERVICE_VERSION,
  createRunSchema,
  isTerminal,
  previewSchema,
  type PreviewJobData,
  type PreviewResult,
  type RunJobData,
} from '../contract/schemas.js';
import { parseBody, parseScrapeConfig, resolveLimits } from '../contract/validate.js';
import {
  BUILTIN_ENGINE_NAMES,
  BULL_PREFIX,
  ENGINES_HASH,
  PREVIEW_QUEUE,
  runQueueName,
} from '../engines/registry.js';
import { safeEqual } from '../security/crypto.js';
import { SsrfError, type SsrfGuard } from '../security/ssrf.js';
import { RunStore } from '../store/run-store.js';
import { nowIso } from '../util/misc.js';

export interface AppDeps {
  env: ApiEnv;
  redis: Redis;
  store: RunStore;
  guard: SsrfGuard;
  /** Connection options for BullMQ queues (separate from `redis`). */
  bullConnection: Redis;
  previewEvents: QueueEvents;
  logger?: (level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>) => void;
}

export function createApp(deps: AppDeps): express.Express {
  const { env, redis, store, guard } = deps;
  const limitsCeiling = globalLimits(env);
  const queues = new Map<string, Queue>();
  const queueFor = (name: string): Queue => {
    let q = queues.get(name);
    if (!q) {
      q = new Queue(name, { connection: deps.bullConnection, prefix: BULL_PREFIX });
      queues.set(name, q);
    }
    return q;
  };
  const previewQueue = queueFor(PREVIEW_QUEUE);

  async function availableEngines(): Promise<Record<string, { description?: string; concurrency?: number }>> {
    const raw = await redis.hgetall(ENGINES_HASH);
    const out: Record<string, { description?: string; concurrency?: number }> = {};
    for (const [k, v] of Object.entries(raw)) {
      try {
        out[k] = JSON.parse(v) as { description?: string; concurrency?: number };
      } catch {
        out[k] = {};
      }
    }
    // Before the first worker has registered, accept the built-in engines.
    if (Object.keys(out).length === 0) for (const n of BUILTIN_ENGINE_NAMES) out[n] = {};
    return out;
  }

  const app = express();
  app.disable('x-powered-by');

  // ---- public

  app.get('/health', async (_req, res) => {
    try {
      const pong = await Promise.race([
        redis.ping(),
        new Promise<never>((_r, rej) => setTimeout(() => rej(new Error('redis timeout')), 2000)),
      ]);
      if (pong !== 'PONG') throw new Error('unexpected ping reply');
      res.status(200).json({ status: 'ok' });
    } catch {
      res.status(503).json({ status: 'unavailable' });
    }
  });

  // ---- auth (everything below)

  app.use((req: Request, _res: Response, next: NextFunction) => {
    const header = req.get('authorization') ?? '';
    const m = /^Bearer\s+(.+)$/i.exec(header);
    if (!m || !safeEqual(m[1]!.trim(), env.SCRAPER_API_KEY)) {
      next(new ApiError(401, 'UNAUTHORIZED', 'Missing or invalid API key'));
      return;
    }
    next();
  });

  app.use(express.json({ limit: '2mb' }));

  app.get('/v1/config', async (_req, res) => {
    const engines = await availableEngines();
    let waiting = 0;
    let active = 0;
    for (const name of Object.keys(engines)) {
      const c = await queueFor(runQueueName(name)).getJobCounts('waiting', 'active', 'delayed');
      waiting += (c.waiting ?? 0) + (c.delayed ?? 0);
      active += c.active ?? 0;
    }
    res.json({
      version: SERVICE_VERSION,
      configVersions: [CONFIG_VERSION],
      engines: Object.entries(engines).map(([name, e]) => ({ name, available: true, ...e })),
      limits: {
        maxPages: limitsCeiling.maxPages,
        maxDepth: limitsCeiling.maxDepth,
        maxItems: limitsCeiling.maxItems,
        maxDurationSec: limitsCeiling.maxDurationSec,
        maxConcurrency: limitsCeiling.maxConcurrency,
        maxResponseBytes: limitsCeiling.maxResponseBytes,
        maxItemBytes: limitsCeiling.maxItemBytes,
        maxConcurrentRuns: env.MAX_CONCURRENT_RUNS,
        maxConcurrentBrowserRuns: env.MAX_CONCURRENT_BROWSER_RUNS,
        resultTtlHours: env.RESULT_TTL_HOURS,
      },
      queue: { waiting, active },
    });
  });

  app.post('/v1/runs', async (req, res) => {
    const body = parseBody(createRunSchema, req.body);
    const engines = Object.keys(await availableEngines());
    const config = parseScrapeConfig(body.config, { engines, guard });
    const { limits, clamped } = resolveLimits(body.limits, limitsCeiling);

    const created = await store.createRun({
      runId: randomUUID(),
      idempotencyKey: body.idempotencyKey,
      context: body.context,
      engine: config.engine,
    });
    if (!created.created) {
      const existing = await store.getView(created.runId);
      res.status(202).json({ runId: created.runId, status: existing?.status ?? 'queued' });
      return;
    }

    const job: RunJobData = {
      runId: created.runId,
      context: body.context,
      config,
      ...(body.secrets ? { secrets: body.secrets } : {}),
      limits,
      warnings: clamped,
    };
    try {
      await queueFor(runQueueName(config.engine)).add('run', job, {
        jobId: created.runId,
        removeOnComplete: true,
        removeOnFail: true,
      });
    } catch (e) {
      await store.discardRun(created.runId, body.idempotencyKey);
      deps.logger?.('error', `could not enqueue run: ${(e as Error).message}`);
      throw new ApiError(503, 'QUEUE_UNAVAILABLE', 'The run could not be queued; retry later');
    }
    res.status(202).json({ runId: created.runId, status: 'queued' });
  });

  app.get('/v1/runs', async (req, res) => {
    const raw = typeof req.query.ids === 'string' ? req.query.ids : '';
    const ids = [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))];
    if (ids.length === 0) throw new ApiError(400, 'VALIDATION_ERROR', 'ids: at least one id is required');
    if (ids.length > 100) throw new ApiError(400, 'VALIDATION_ERROR', 'ids: at most 100 ids per request');
    res.json({ runs: await store.getViews(ids) });
  });

  app.get('/v1/runs/:id', async (req, res) => {
    const view = await store.getView(req.params.id);
    if (!view) throw new ApiError(404, 'RUN_NOT_FOUND', 'Run not found');
    res.json(view);
  });

  app.get('/v1/runs/:id/items', async (req, res) => {
    const id = req.params.id;
    const afterSeq = parseIntParam(req.query.afterSeq, 'afterSeq', 0, 0, Number.MAX_SAFE_INTEGER);
    const limit = parseIntParam(req.query.limit, 'limit', 200, 1, 1000);
    const view = await store.getView(id);
    if (!view) throw new ApiError(404, 'RUN_NOT_FOUND', 'Run not found');
    const rows = await store.getItems(id, afterSeq, limit + 1);
    const items = rows.slice(0, limit);
    res.json({
      runId: id,
      status: view.status,
      afterSeq,
      items,
      nextSeq: items.length ? items[items.length - 1]!.seq : afterSeq,
      hasMore: rows.length > limit,
    });
  });

  app.post('/v1/runs/:id/cancel', async (req, res) => {
    const id = req.params.id;
    const view = await store.getView(id);
    if (!view) throw new ApiError(404, 'RUN_NOT_FOUND', 'Run not found');
    if (isTerminal(view.status)) {
      res.json(view);
      return;
    }
    if (view.status === 'queued') {
      const applied = await store.transition(id, 'cancelled', { finishedAt: nowIso() });
      if (applied) {
        // Remove the job so it never starts, then tell Nopxus.
        const q = queueFor(runQueueName((await redis.hget(`scraper:run:${id}`, 'engine')) ?? 'http'));
        await q.remove(id).catch(() => undefined);
        const fresh = await store.getView(id);
        await store.publishEvent(id, 'run.cancelled', view.context, fresh);
        res.json(fresh);
        return;
      }
    }
    // Running (or just started): the worker stops the crawl and finalises.
    await store.requestCancel(id);
    res.json((await store.getView(id)) ?? view);
  });

  app.post('/v1/preview', async (req, res) => {
    const body = parseBody(previewSchema, req.body);
    const engines = Object.keys(await availableEngines());
    const config = parseScrapeConfig(body.config, { engines, guard });
    const url = body.url ?? config.startUrls[0]!;
    try {
      guard.checkUrl(url);
    } catch (e) {
      if (e instanceof SsrfError) throw new ApiError(422, 'URL_NOT_ALLOWED', `url: ${e.message}`);
      throw e;
    }
    const data: PreviewJobData = {
      config,
      ...(body.secrets ? { secrets: body.secrets } : {}),
      url,
      maxItems: body.maxItems ?? 50,
    };
    const job = await previewQueue.add('preview', data, {
      removeOnComplete: { age: 60 },
      removeOnFail: { age: 60 },
    });
    let result: PreviewResult;
    try {
      result = (await job.waitUntilFinished(deps.previewEvents, 55_000)) as PreviewResult;
    } catch (e) {
      const msg = (e as Error).message ?? '';
      if (/timed out before finishing/i.test(msg)) {
        await job.remove().catch(() => undefined);
        throw new ApiError(504, 'PREVIEW_TIMEOUT', 'The preview did not finish in time');
      }
      throw new ApiError(422, 'PREVIEW_FAILED', msg || 'The preview failed');
    }
    res.json(result);
  });

  app.use((_req, _res, next) => next(new ApiError(404, 'NOT_FOUND', 'Route not found')));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ApiError) {
      res.status(err.status).json({ success: false, code: err.code, message: err.message });
      return;
    }
    const e = err as { type?: string; status?: number };
    if (e?.type === 'entity.parse.failed') {
      res.status(400).json({ success: false, code: 'INVALID_JSON', message: 'Request body is not valid JSON' });
      return;
    }
    if (e?.type === 'entity.too.large') {
      res.status(413).json({ success: false, code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large' });
      return;
    }
    deps.logger?.('error', `unhandled error: ${(err as Error)?.message ?? String(err)}`);
    res.status(500).json({ success: false, code: 'INTERNAL_ERROR', message: 'Internal server error' });
  });

  (app as express.Express & { closeQueues?: () => Promise<void> }).closeQueues = async () => {
    await Promise.allSettled([...queues.values()].map((q) => q.close()));
  };
  return app;
}

function parseIntParam(raw: unknown, name: string, dflt: number, min: number, max: number): number {
  if (raw === undefined || raw === '') return dflt;
  const n = typeof raw === 'string' ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ApiError(400, 'VALIDATION_ERROR', `${name}: must be an integer between ${min} and ${max}`);
  }
  return n;
}
