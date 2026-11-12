import { Redis } from 'ioredis';
import { QueueEvents } from 'bullmq';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { loadEnv, type ApiEnv, type WorkerEnv } from '../../src/config/env.js';
import { createApp } from '../../src/api/app.js';
import { WebhookDispatcher } from '../../src/api/dispatcher.js';
import { BULL_PREFIX, PREVIEW_QUEUE } from '../../src/engines/registry.js';
import { SsrfGuard } from '../../src/security/ssrf.js';
import { RunStore } from '../../src/store/run-store.js';
import { startWorker, type WorkerHandle, type WorkerOptions } from '../../src/worker/worker.js';
import { startFixture, type Fixture } from './fixture-server.js';
import { startReceiver, type Receiver } from './webhook-receiver.js';

const TEST_REDIS_BASE = process.env.TEST_REDIS_BASE ?? 'redis://127.0.0.1:6390';
// Every stack gets its own Redis logical DB, so several stacks can coexist.
let dbCounter = 0;
const nextRedisUrl = (): string => `${TEST_REDIS_BASE}/${1 + (dbCounter++ % 15)}`;
export const API_KEY = 'test-api-key-0123456789abcdef';

export interface Stack {
  fixture: Fixture;
  receiver: Receiver;
  redis: Redis;
  store: RunStore;
  env: ApiEnv;
  baseUrl: string;
  worker: WorkerHandle;
  dispatcher: WebhookDispatcher;
  /** Authenticated JSON call to the API. */
  call(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; json: any }>;
  startExtraWorker(opts?: Partial<WorkerOptions>): Promise<WorkerHandle>;
  stopWorker(): Promise<void>;
  stop(): Promise<void>;
}

export interface StackOptions {
  env?: Record<string, string>;
  worker?: Partial<WorkerOptions>;
  dispatcher?: { retryBaseMs?: number; timeoutMs?: number; maxRetries?: number };
  withWorker?: boolean;
}

const baseEnv = (webhookUrl: string, secret: string, redisUrl: string): Record<string, string> => ({
  REDIS_URL: redisUrl,
  SCRAPER_API_KEY: API_KEY,
  NOPXUS_WEBHOOK_URL: webhookUrl,
  NOPXUS_WEBHOOK_SECRET: secret,
  MAX_CONCURRENT_RUNS: '4',
  MAX_CONCURRENT_BROWSER_RUNS: '2',
  MAX_PAGES_PER_RUN: '100',
  MAX_DEPTH: '3',
  MAX_ITEMS_PER_RUN: '1000',
  MAX_RUN_DURATION_SEC: '60',
  RESULT_TTL_HOURS: '72',
  LEASE_TTL_SEC: '2',
  WEBHOOK_RETRY_BASE_MS: '20',
  LOG_LEVEL: 'silent',
  USER_AGENT: 'NopxusScraperTest/1.0',
});

export async function startStack(opts: StackOptions = {}): Promise<Stack> {
  const fixture = await startFixture();
  const receiver = await startReceiver();
  const redisUrl = nextRedisUrl();
  const rawEnv = { ...baseEnv(receiver.url, receiver.secret, redisUrl), ...opts.env };
  const env: ApiEnv = loadEnv('api', rawEnv as NodeJS.ProcessEnv);
  const workerEnv: WorkerEnv = loadEnv('worker', rawEnv as NodeJS.ProcessEnv);

  const redis = new Redis(redisUrl);
  await redis.flushdb();
  const store = new RunStore(redis, { resultTtlSec: env.RESULT_TTL_HOURS * 3600, idempotencyTtlSec: 72 * 3600 });

  // The loopback allowance exists ONLY here (NODE_ENV=test).
  const guard = () => new SsrfGuard({ blockedHosts: env.BLOCKED_HOSTS, testAllowIps: ['127.0.0.1'] });

  const workers: WorkerHandle[] = [];
  const mkWorker = async (extra: Partial<WorkerOptions> = {}) => {
    const w = await startWorker({
      env: workerEnv,
      guard: guard(),
      reaperIntervalMs: 300,
      recorderIntervalMs: 200,
      ...opts.worker,
      ...extra,
    });
    workers.push(w);
    return w;
  };
  let worker = opts.withWorker === false ? (undefined as unknown as WorkerHandle) : await mkWorker();

  const bullConnection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const previewEvents = new QueueEvents(PREVIEW_QUEUE, {
    connection: new Redis(redisUrl, { maxRetriesPerRequest: null }),
    prefix: BULL_PREFIX,
  });
  await previewEvents.waitUntilReady();
  const app = createApp({ env, redis, store, guard: guard(), bullConnection, previewEvents });
  const server: Server = await new Promise((r) => {
    const s = app.listen(0, '127.0.0.1', () => r(s));
  });
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const dispatcher = new WebhookDispatcher({
    redis: new Redis(redisUrl, { maxRetriesPerRequest: null }),
    url: env.NOPXUS_WEBHOOK_URL,
    secret: env.NOPXUS_WEBHOOK_SECRET,
    retryBaseMs: 20,
    ...opts.dispatcher,
  });
  await dispatcher.start();

  return {
    fixture,
    receiver,
    redis,
    store,
    env,
    baseUrl,
    get worker() {
      return worker;
    },
    dispatcher,
    async call(method, path, body, headers = {}) {
      const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${API_KEY}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...headers,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const text = await res.text();
      let json: any = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = text;
      }
      return { status: res.status, json };
    },
    startExtraWorker: mkWorker,
    async stopWorker() {
      await worker?.close(2000);
    },
    async stop() {
      await dispatcher.stop(500);
      await Promise.allSettled(workers.map((w) => w.close(1000)));
      await new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      });
      await (app as unknown as { closeQueues(): Promise<void> }).closeQueues();
      await previewEvents.close().catch(() => undefined);
      bullConnection.disconnect();
      redis.disconnect();
      await fixture.close();
      await receiver.close();
    },
  };
}

export async function waitFor<T>(
  fn: () => T | Promise<T>,
  { timeout = 20_000, interval = 50, message = 'condition' }: { timeout?: number; interval?: number; message?: string } = {},
): Promise<NonNullable<T>> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${message}`);
    await new Promise((r) => setTimeout(r, interval));
  }
}

export const TERMINAL = ['completed', 'failed', 'cancelled'];

/** Polls GET /v1/runs/:id until the run is terminal. */
export async function waitTerminal(stack: Stack, runId: string, timeout = 30_000) {
  return waitFor(
    async () => {
      const { json } = await stack.call('GET', `/v1/runs/${runId}`);
      return TERMINAL.includes(json?.status) ? json : null;
    },
    { timeout, message: `run ${runId} to finish` },
  );
}

let counter = 0;
export function listConfig(fixture: Fixture, over: Record<string, unknown> = {}) {
  return {
    version: 1,
    engine: 'http',
    startUrls: [`${fixture.baseUrl}/list?page=1`],
    extraction: {
      mode: 'list',
      itemSelector: { type: 'css', value: '.producto' },
      fields: [
        { key: 'titulo', selector: { type: 'css', value: 'h2' }, required: true },
        { key: 'precio', selector: { type: 'css', value: '.precio' }, transform: 'number' },
        { key: 'url', selector: { type: 'css', value: 'a.link' }, attr: 'href', transform: 'absoluteUrl' },
      ],
    },
    navigation: { pagination: { type: 'nextLink', selector: { type: 'css', value: 'a.siguiente' } } },
    execution: { requestTimeoutSec: 10, maxRetries: 1, delayMs: 0, waitForSelector: null },
    dedupeKeyFields: ['url'],
    ...over,
  };
}

export function runBody(config: unknown, over: Record<string, unknown> = {}) {
  return {
    idempotencyKey: `idem-${Date.now()}-${++counter}`,
    context: { orgId: `org-${counter}`, taskId: `task-${counter}` },
    config,
    limits: { maxPages: 50, maxDepth: 2, maxItems: 500, maxDurationSec: 30, maxConcurrency: 2 },
    ...over,
  };
}
