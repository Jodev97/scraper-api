import { Redis } from 'ioredis';
import { QueueEvents } from 'bullmq';
import pino from 'pino';
import { EnvError, loadEnv } from '../config/env.js';
import { BULL_PREFIX, PREVIEW_QUEUE } from '../engines/registry.js';
import { SsrfGuard } from '../security/ssrf.js';
import { RunStore } from '../store/run-store.js';
import { createApp } from './app.js';
import { WebhookDispatcher } from './dispatcher.js';

async function main(): Promise<void> {
  let env;
  try {
    env = loadEnv('api');
  } catch (e) {
    if (e instanceof EnvError) {
      console.error(e.message);
      process.exit(1);
    }
    throw e;
  }
  const logger = pino({ level: env.LOG_LEVEL, base: { service: 'scraper-api' } });
  const log = (level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>) =>
    logger[level](extra ?? {}, msg);

  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 3 });
  const bullConnection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const dispatcherRedis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const previewEvents = new QueueEvents(PREVIEW_QUEUE, {
    connection: new Redis(env.REDIS_URL, { maxRetriesPerRequest: null }),
    prefix: BULL_PREFIX,
  });
  const store = new RunStore(redis, {
    resultTtlSec: env.RESULT_TTL_HOURS * 3600,
    idempotencyTtlSec: Math.max(72, env.RESULT_TTL_HOURS) * 3600,
  });
  const guard = new SsrfGuard({ blockedHosts: env.BLOCKED_HOSTS });

  const app = createApp({ env, redis, store, guard, bullConnection, previewEvents, logger: log });
  const dispatcher = new WebhookDispatcher({
    redis: dispatcherRedis,
    url: env.NOPXUS_WEBHOOK_URL,
    secret: env.NOPXUS_WEBHOOK_SECRET,
    retryBaseMs: env.WEBHOOK_RETRY_BASE_MS,
    logger: log,
  });
  await dispatcher.start();

  const server = app.listen(env.PORT, () => logger.info({ port: env.PORT }, 'scraper-api listening'));

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    server.close();
    await dispatcher.stop(5000);
    await (app as unknown as { closeQueues?: () => Promise<void> }).closeQueues?.();
    await previewEvents.close().catch(() => undefined);
    redis.disconnect();
    bullConnection.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});
