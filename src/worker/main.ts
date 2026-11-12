import pino from 'pino';
import { EnvError, loadEnv } from '../config/env.js';
import { startWorker } from './worker.js';

async function main(): Promise<void> {
  let env;
  try {
    env = loadEnv('worker');
  } catch (e) {
    if (e instanceof EnvError) {
      console.error(e.message);
      process.exit(1);
    }
    throw e;
  }
  const logger = pino({ level: env.LOG_LEVEL, base: { service: 'scraper-worker' } });
  const worker = await startWorker({
    env,
    logger: (level, msg, extra) => logger[level](extra ?? {}, msg),
  });
  logger.info('scraper-worker started');

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down (30s grace)');
    await worker.close(30_000);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});
