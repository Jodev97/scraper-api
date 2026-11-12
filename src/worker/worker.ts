import os from 'node:os';
import { Redis } from 'ioredis';
import { Queue, Worker } from 'bullmq';
import { log as crawleeLog } from 'crawlee';
import type { WorkerEnv } from '../config/env.js';
import type { PreviewJobData, RunJobData } from '../contract/schemas.js';
import { BrowserEngine } from '../engines/browser-engine.js';
import { HttpEngine } from '../engines/http-engine.js';
import {
  BULL_PREFIX,
  ENGINES_HASH,
  EngineRegistry,
  PREVIEW_QUEUE,
  runQueueName,
} from '../engines/registry.js';
import type { ScrapingEngine } from '../engines/types.js';
import { startEgressProxy, type EgressProxy } from '../security/egress-proxy.js';
import { SsrfGuard } from '../security/ssrf.js';
import { KEYS, RunStore } from '../store/run-store.js';
import { errMessage } from '../util/misc.js';
import { RunExecutor } from './executor.js';

export interface WorkerOptions {
  env: WorkerEnv;
  /** Replaces the default engine set (tests / extension). */
  engines?: ScrapingEngine[];
  /** TEST ONLY: guard with a loopback allowance. Production never passes it. */
  guard?: SsrfGuard;
  reaperIntervalMs?: number;
  recorderIntervalMs?: number;
  /** Concurrency per engine queue; defaults come from the env. */
  concurrency?: Record<string, number>;
  logger?: (level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>) => void;
}

export interface WorkerHandle {
  executor: RunExecutor;
  registry: EngineRegistry;
  /** Graceful shutdown: stop taking jobs, wait up to `graceMs`, fail the rest. */
  close(graceMs?: number): Promise<void>;
  /** Simulates SIGKILL: no finalisation, leases simply stop being renewed. */
  crash(): Promise<void>;
}

export async function startWorker(opts: WorkerOptions): Promise<WorkerHandle> {
  const { env } = opts;
  const logger = opts.logger ?? (() => undefined);
  crawleeLog.setLevel(crawleeLog.LEVELS.OFF); // we do our own (redacted) logging

  const mkRedis = () => new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const redis = mkRedis();
  const subscriber = mkRedis();
  const ttlSec = env.RESULT_TTL_HOURS * 3600;
  const store = new RunStore(redis, { resultTtlSec: ttlSec, idempotencyTtlSec: Math.max(72, env.RESULT_TTL_HOURS) * 3600 });

  const guard = opts.guard ?? new SsrfGuard({ blockedHosts: env.BLOCKED_HOSTS });
  const proxy: EgressProxy = await startEgressProxy(guard, {
    onBlocked: (target, err) => logger('warn', `egress blocked ${target}: ${err.message}`),
  });

  const registry = new EngineRegistry();
  const engines = opts.engines ?? [new HttpEngine(), new BrowserEngine()];
  const quota = (name: string): number => {
    if (opts.concurrency && name in opts.concurrency) return opts.concurrency[name]!;
    if (name === 'browser') return env.MAX_CONCURRENT_BROWSER_RUNS;
    return env.MAX_CONCURRENT_RUNS;
  };
  for (const e of engines) if (quota(e.name) > 0) registry.register(e);

  const executor = new RunExecutor({
    store,
    registry,
    guard,
    proxyUrl: proxy.url,
    userAgent: env.USER_AGENT,
    maxResponseBytes: env.MAX_RESPONSE_BYTES,
    maxItemBytes: env.MAX_ITEM_BYTES,
    maxConcurrencyPerDomain: env.MAX_CONCURRENCY_PER_DOMAIN,
    leaseTtlSec: env.LEASE_TTL_SEC,
    ...(opts.recorderIntervalMs ? { recorderIntervalMs: opts.recorderIntervalMs } : {}),
    log: logger,
  });

  // Advertise the engines so the API can validate configs and pick queues
  // without knowing about any engine in particular.
  for (const e of registry.list()) {
    await redis.hset(ENGINES_HASH, e.name, JSON.stringify({ description: e.description, concurrency: quota(e.name) }));
  }

  // One BullMQ queue (and quota) per engine.
  const workers: Worker[] = [];
  for (const e of registry.list()) {
    workers.push(
      new Worker<RunJobData>(
        runQueueName(e.name),
        async (job) => {
          await executor.execute(job.data);
        },
        {
          connection: redis,
          prefix: BULL_PREFIX,
          concurrency: quota(e.name),
          // A job whose worker dies is NOT retried (runs are never resumed);
          // the lease reaper marks it failed(WORKER_RESTARTED).
          maxStalledCount: 0,
          lockDuration: 60_000,
        },
      ),
    );
  }
  workers.push(
    new Worker<PreviewJobData>(
      PREVIEW_QUEUE,
      async (job) => executor.preview(job.data),
      { connection: redis, prefix: BULL_PREFIX, concurrency: 2, maxStalledCount: 0 },
    ),
  );
  for (const w of workers) w.on('error', (e) => logger('error', `bullmq worker error: ${errMessage(e)}`));

  // Cancellation requests (pub/sub; the per-run poll in the executor is the backstop).
  await subscriber.subscribe(KEYS.cancelChannel);
  subscriber.on('message', (_ch, runId) => {
    executor.abort(runId, 'cancel');
  });

  // Orphan reaper: fails runs whose worker died.
  const reap = () => {
    executor.reapOrphans().then(
      (n) => n && logger('warn', `marked ${n} orphaned run(s) as WORKER_RESTARTED`),
      (e) => logger('error', `reaper failed: ${errMessage(e)}`),
    );
  };
  reap();
  const reaper = setInterval(reap, opts.reaperIntervalMs ?? 5000);

  // Liveness key read by the container healthcheck (src/worker/healthcheck.ts).
  const aliveKey = workerAliveKey();
  const beat = () => void redis.set(aliveKey, '1', 'EX', 30).catch(() => undefined);
  beat();
  const alive = setInterval(beat, 10_000);

  let closed = false;
  const teardown = async (): Promise<void> => {
    clearInterval(reaper);
    clearInterval(alive);
    await Promise.allSettled(workers.map((w) => w.close(true)));
    await proxy.close().catch(() => undefined);
    subscriber.disconnect();
    redis.disconnect();
  };

  return {
    executor,
    registry,
    async close(graceMs = 30_000) {
      if (closed) return;
      closed = true;
      clearInterval(reaper);
      // 1. stop accepting jobs (let in-flight ones continue)
      await Promise.allSettled(workers.map((w) => w.pause(true)));
      // 2. wait for running runs
      const idle = await executor.waitIdle(graceMs);
      // 3. whatever is left is failed (WORKER_RESTARTED)
      if (!idle) {
        logger('warn', `grace period elapsed with ${executor.activeCount} run(s) still active; failing them`);
        executor.abortAll('shutdown');
        await executor.waitIdle(8_000);
      }
      await teardown();
    },
    async crash() {
      if (closed) return;
      closed = true;
      executor.simulateCrash();
      await executor.waitIdle(5_000);
      await teardown();
    },
  };
}

export const workerAliveKey = (host = os.hostname()): string => `scraper:worker:${host}:alive`;

// Used by tests to build a Queue handle for inspection.
export const makeRunQueue = (redis: Redis, engine: string): Queue =>
  new Queue(runQueueName(engine), { connection: redis, prefix: BULL_PREFIX });
