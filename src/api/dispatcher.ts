import type { Redis } from 'ioredis';
import { signWebhook } from '../security/crypto.js';
import { EVENTS_CONSUMER, EVENTS_GROUP, KEYS } from '../store/run-store.js';
import { errMessage, sleep } from '../util/misc.js';

export interface DispatcherOptions {
  /** Dedicated connection (used for blocking XREADGROUP). */
  redis: Redis;
  url: string;
  secret: string;
  retryBaseMs?: number;
  maxRetries?: number;
  timeoutMs?: number;
  maxInflight?: number;
  fetchImpl?: typeof fetch;
  logger?: (level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>) => void;
}

export type DeliveryResult = 'delivered' | 'rejected' | 'exhausted' | 'stopped';

/**
 * Reads worker events from the Redis stream and POSTs them to Nopxus as signed
 * webhooks.
 *
 *  - Entries are acknowledged only after the delivery finished (success or
 *    definitive failure), so an API restart re-delivers whatever was in
 *    flight (same `deliveryId`, same bytes).
 *  - Webhooks of one run are sent strictly in order (one chain per run);
 *    different runs are delivered concurrently.
 *  - It must run as a single instance (one consumer name).
 */
export class WebhookDispatcher {
  private running = false;
  private loop: Promise<void> | null = null;
  private readonly chains = new Map<string, Promise<void>>();
  private inflight = 0;
  private slotWaiters: Array<() => void> = [];
  private readonly ctrl = new AbortController();

  constructor(private readonly o: DispatcherOptions) {}

  private log(level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>): void {
    this.o.logger?.(level, msg, extra);
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.o.redis.xgroup('CREATE', KEYS.events, EVENTS_GROUP, '0', 'MKSTREAM');
    } catch (e) {
      if (!String(errMessage(e)).includes('BUSYGROUP')) throw e;
    }
    this.loop = this.readLoop().catch((e) => this.log('error', `dispatcher loop crashed: ${errMessage(e)}`));
  }

  async stop(waitMs = 3000): Promise<void> {
    this.running = false;
    this.ctrl.abort();
    this.o.redis.disconnect();
    await Promise.race([this.loop, sleep(waitMs)]);
    await Promise.race([Promise.allSettled([...this.chains.values()]), sleep(waitMs)]);
  }

  private async readLoop(): Promise<void> {
    // Phase 1: entries delivered to us before a restart but never acknowledged.
    let cursor = '0';
    while (this.running) {
      const res = await this.read(cursor, 0);
      if (!res || res.length === 0) break;
      for (const entry of res) this.schedule(entry);
      cursor = res[res.length - 1]![0];
    }
    // Phase 2: new entries.
    while (this.running) {
      const res = await this.read('>', 2000);
      if (!res) continue;
      for (const entry of res) {
        await this.waitForSlot();
        this.schedule(entry);
      }
    }
  }

  private async read(id: string, blockMs: number): Promise<Array<[string, string[]]> | null> {
    try {
      const args: Array<string | number> = ['GROUP', EVENTS_GROUP, EVENTS_CONSUMER, 'COUNT', 100];
      if (blockMs > 0) args.push('BLOCK', blockMs);
      args.push('STREAMS', KEYS.events, id);
      const out = (await (this.o.redis as any).xreadgroup(...args)) as Array<[string, Array<[string, string[]]>]> | null;
      return out?.[0]?.[1] ?? null;
    } catch (e) {
      if (!this.running) return null;
      this.log('error', `xreadgroup failed: ${errMessage(e)}`);
      await sleep(1000);
      return null;
    }
  }

  private async waitForSlot(): Promise<void> {
    const max = this.o.maxInflight ?? 500;
    while (this.inflight >= max && this.running) await new Promise<void>((r) => this.slotWaiters.push(r));
  }

  private schedule([entryId, fields]: [string, string[]]): void {
    const f: Record<string, string> = {};
    for (let i = 0; i < fields.length; i += 2) f[fields[i]!] = fields[i + 1]!;
    const runId = f.runId ?? '';
    const payload = f.payload ?? '';
    this.inflight++;
    const prev = this.chains.get(runId) ?? Promise.resolve();
    const next = prev
      .then(async () => {
        const result = await this.deliver(payload, runId);
        if (result !== 'stopped') {
          await this.o.redis.xack(KEYS.events, EVENTS_GROUP, entryId);
          await this.o.redis.xdel(KEYS.events, entryId);
        }
      })
      .catch((e) => this.log('error', `delivery pipeline error: ${errMessage(e)}`, { runId }))
      .finally(() => {
        this.inflight--;
        this.slotWaiters.shift()?.();
        if (this.chains.get(runId) === next) this.chains.delete(runId);
      });
    this.chains.set(runId, next);
  }

  /** Delivers one webhook body, retrying 5xx / timeouts / network errors. */
  async deliver(rawBody: string, runId = ''): Promise<DeliveryResult> {
    const doFetch = this.o.fetchImpl ?? fetch;
    const maxRetries = this.o.maxRetries ?? 8;
    const base = this.o.retryBaseMs ?? 1000;
    let meta: { deliveryId?: string; event?: string } = {};
    try {
      meta = JSON.parse(rawBody) as typeof meta;
    } catch {
      /* the body is sent as-is regardless */
    }

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (!this.running) return 'stopped';
      const timestamp = Math.floor(Date.now() / 1000).toString();
      let failure: string;
      try {
        const res = await doFetch(this.o.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-timestamp': timestamp,
            'x-signature': signWebhook(this.o.secret, timestamp, rawBody),
            'user-agent': 'nopxus-scraper-webhook/1',
          },
          body: rawBody,
          redirect: 'manual',
          signal: AbortSignal.any([AbortSignal.timeout(this.o.timeoutMs ?? 10_000), this.ctrl.signal]),
        });
        void res.body?.cancel().catch(() => undefined);
        if (res.status >= 200 && res.status < 300) return 'delivered';
        if (res.status < 500) {
          this.log('error', `webhook rejected with HTTP ${res.status}; not retrying`, { runId, ...meta, status: res.status });
          return 'rejected';
        }
        failure = `HTTP ${res.status}`;
      } catch (e) {
        if (!this.running) return 'stopped';
        failure = errMessage(e);
      }
      if (attempt === maxRetries) {
        this.log('error', `webhook delivery failed after ${maxRetries + 1} attempts: ${failure}`, { runId, ...meta });
        return 'exhausted';
      }
      const delay = Math.min(base * 2 ** attempt, 5 * 60_000);
      this.log('warn', `webhook attempt ${attempt + 1} failed (${failure}); retrying in ${delay}ms`, { runId, ...meta });
      await sleepAbortable(delay, this.ctrl.signal);
    }
    return 'exhausted';
  }
}

function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}
