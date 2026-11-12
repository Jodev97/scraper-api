import { Redis } from 'ioredis';
import {
  isTerminal,
  type ErrorCode,
  type ExtractedItem,
  type RunStats,
  type RunStatus,
  type RunView,
  type WebhookBody,
  type WebhookEventName,
} from '../contract/schemas.js';
import { randomUUID } from 'node:crypto';
import { sha256Hex } from '../security/crypto.js';

export const KEYS = {
  run: (id: string) => `scraper:run:${id}`,
  items: (id: string) => `scraper:run:${id}:items`,
  cancel: (id: string) => `scraper:run:${id}:cancel`,
  lease: (id: string) => `scraper:run:${id}:lease`,
  idem: (key: string) => `scraper:idem:${sha256Hex(key)}`,
  active: 'scraper:runs:active',
  events: 'scraper:events',
  cancelChannel: 'scraper:cancel',
} as const;

export const EVENTS_GROUP = 'api-dispatcher';
export const EVENTS_CONSUMER = 'dispatcher-1';

// Atomically creates the run hash and the idempotency key. If the key already
// exists, returns the existing run id instead.
const CREATE_LUA = `
local existing = redis.call('GET', KEYS[1])
if existing then return {0, existing} end
redis.call('SET', KEYS[1], ARGV[1], 'EX', tonumber(ARGV[2]))
local n = #ARGV
for i = 3, n, 2 do redis.call('HSET', KEYS[2], ARGV[i], ARGV[i + 1]) end
return {1, ARGV[1]}
`;

// Monotonic state machine: queued -> running -> terminal, queued -> terminal.
// A terminal run never changes. Returns 1 if applied, 0 if refused, -1 if missing.
// ARGV: [1]=to, [2]=runId, [3..]=field/value pairs
const TRANSITION_LUA = `
local cur = redis.call('HGET', KEYS[1], 'status')
if not cur then return -1 end
if cur == 'completed' or cur == 'failed' or cur == 'cancelled' then return 0 end
local to = ARGV[1]
if to == 'running' and cur ~= 'queued' then return 0 end
if to == cur then return 0 end
redis.call('HSET', KEYS[1], 'status', to)
for i = 3, #ARGV, 2 do redis.call('HSET', KEYS[1], ARGV[i], ARGV[i + 1]) end
if to == 'running' then redis.call('SADD', KEYS[2], ARGV[2]) end
return 1
`;

export interface NewRun {
  runId: string;
  idempotencyKey: string;
  context: Record<string, unknown>;
  engine: string;
}

export interface Counters {
  pagesProcessed: number;
  pagesFailed: number;
  itemsExtracted: number;
  lastSeq: number;
}

export type RunExtras = {
  error?: { code: ErrorCode | string; message: string };
  stats?: RunStats;
  startedAt?: string;
  finishedAt?: string;
} & Partial<Counters>;

function hashToView(runId: string, h: Record<string, string>): RunView {
  return {
    runId,
    status: h.status as RunStatus,
    context: h.context ? (JSON.parse(h.context) as Record<string, unknown>) : {},
    pagesProcessed: Number(h.pagesProcessed ?? 0),
    pagesFailed: Number(h.pagesFailed ?? 0),
    itemsExtracted: Number(h.itemsExtracted ?? 0),
    lastSeq: Number(h.lastSeq ?? 0),
    startedAt: h.startedAt || null,
    finishedAt: h.finishedAt || null,
    error: h.errorCode ? { code: h.errorCode, message: h.errorMessage ?? '' } : null,
    ...(h.stats ? { stats: JSON.parse(h.stats) as RunStats } : {}),
  };
}

export class RunStore {
  constructor(
    private readonly redis: Redis,
    private readonly opts: { resultTtlSec: number; idempotencyTtlSec: number },
  ) {}

  async createRun(run: NewRun): Promise<{ created: boolean; runId: string }> {
    const fields: Record<string, string> = {
      status: 'queued',
      context: JSON.stringify(run.context),
      engine: run.engine,
      pagesProcessed: '0',
      pagesFailed: '0',
      itemsExtracted: '0',
      lastSeq: '0',
      createdAt: new Date().toISOString(),
    };
    const args: string[] = [run.runId, String(this.opts.idempotencyTtlSec)];
    for (const [k, v] of Object.entries(fields)) args.push(k, v);
    const [created, id] = (await this.redis.eval(
      CREATE_LUA,
      2,
      KEYS.idem(run.idempotencyKey),
      KEYS.run(run.runId),
      ...args,
    )) as [number, string];
    return { created: created === 1, runId: id };
  }

  /** Removes a run that was created but could not be enqueued. */
  async discardRun(runId: string, idempotencyKey: string): Promise<void> {
    await this.redis.del(KEYS.run(runId), KEYS.idem(idempotencyKey));
  }

  async getView(runId: string): Promise<RunView | null> {
    const h = await this.redis.hgetall(KEYS.run(runId));
    if (!h.status) return null;
    return hashToView(runId, h);
  }

  async getViews(ids: string[]): Promise<RunView[]> {
    if (ids.length === 0) return [];
    const pipe = this.redis.pipeline();
    for (const id of ids) pipe.hgetall(KEYS.run(id));
    const res = (await pipe.exec()) ?? [];
    const out: RunView[] = [];
    res.forEach(([err, h], i) => {
      const hash = h as Record<string, string>;
      if (!err && hash?.status) out.push(hashToView(ids[i]!, hash));
    });
    return out;
  }

  /**
   * Applies a status transition atomically. Returns true only for the caller
   * whose transition took effect (so exactly one process emits the event).
   */
  async transition(runId: string, to: RunStatus, extras: RunExtras = {}): Promise<boolean> {
    const f: string[] = [];
    const add = (k: string, v: string | number | undefined) => {
      if (v !== undefined) f.push(k, String(v));
    };
    add('startedAt', extras.startedAt);
    add('finishedAt', extras.finishedAt);
    add('pagesProcessed', extras.pagesProcessed);
    add('pagesFailed', extras.pagesFailed);
    add('itemsExtracted', extras.itemsExtracted);
    add('lastSeq', extras.lastSeq);
    if (extras.error) {
      add('errorCode', extras.error.code);
      add('errorMessage', extras.error.message);
    }
    if (extras.stats) add('stats', JSON.stringify(extras.stats));
    const res = (await this.redis.eval(TRANSITION_LUA, 2, KEYS.run(runId), KEYS.active, to, runId, ...f)) as number;
    if (res !== 1) return false;
    if (isTerminal(to)) await this.expireRun(runId);
    return true;
  }

  async setCounters(runId: string, c: Partial<Counters>): Promise<void> {
    const args: string[] = [];
    for (const [k, v] of Object.entries(c)) args.push(k, String(v));
    if (args.length === 0) return;
    // Only while the run is still in flight; never rewrite a terminal run.
    await this.redis.eval(
      `local s = redis.call('HGET', KEYS[1], 'status')
       if s == 'running' then
         for i = 1, #ARGV, 2 do redis.call('HSET', KEYS[1], ARGV[i], ARGV[i+1]) end
         return 1
       end
       return 0`,
      1,
      KEYS.run(runId),
      ...args,
    );
  }

  /** Items expire with the run, once it is terminal. */
  async expireRun(runId: string): Promise<void> {
    const ttl = this.opts.resultTtlSec;
    const p = this.redis.pipeline();
    p.expire(KEYS.run(runId), ttl);
    p.expire(KEYS.items(runId), ttl);
    p.expire(KEYS.cancel(runId), ttl);
    p.del(KEYS.lease(runId));
    p.srem(KEYS.active, runId);
    await p.exec();
  }

  // ---- items

  async addItems(runId: string, items: ExtractedItem[]): Promise<void> {
    if (items.length === 0) return;
    const args: Array<string | number> = [];
    for (const it of items) args.push(it.seq, JSON.stringify(it));
    await this.redis.zadd(KEYS.items(runId), ...args);
  }

  async getItems(runId: string, afterSeq: number, limit: number): Promise<ExtractedItem[]> {
    const raw = await this.redis.zrangebyscore(KEYS.items(runId), `(${afterSeq}`, '+inf', 'LIMIT', 0, limit);
    return raw.map((r) => JSON.parse(r) as ExtractedItem);
  }

  // ---- liveness (worker-restart detection)

  async heartbeat(runId: string, ttlSec: number): Promise<void> {
    await this.redis.set(KEYS.lease(runId), '1', 'EX', ttlSec);
  }

  async activeRunIds(): Promise<string[]> {
    return this.redis.smembers(KEYS.active);
  }

  async hasLease(runId: string): Promise<boolean> {
    return (await this.redis.exists(KEYS.lease(runId))) === 1;
  }

  // ---- cancellation

  async requestCancel(runId: string): Promise<void> {
    await this.redis.set(KEYS.cancel(runId), '1', 'EX', this.opts.resultTtlSec);
    await this.redis.publish(KEYS.cancelChannel, runId);
  }

  async isCancelRequested(runId: string): Promise<boolean> {
    return (await this.redis.exists(KEYS.cancel(runId))) === 1;
  }

  // ---- events channel (worker -> api)

  /** Serializes once; the API forwards these exact bytes as the webhook body. */
  async publishEvent(
    runId: string,
    event: WebhookEventName,
    context: Record<string, unknown>,
    data: unknown,
  ): Promise<string> {
    const body: WebhookBody = {
      version: 1,
      deliveryId: randomUUID(),
      runId,
      event,
      context,
      timestamp: new Date().toISOString(),
      data,
    };
    await this.redis.xadd(KEYS.events, '*', 'runId', runId, 'payload', JSON.stringify(body));
    return body.deliveryId;
  }

}

