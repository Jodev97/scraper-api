import { Redis } from 'ioredis';
import { workerAliveKey } from './worker.js';

/** Container healthcheck: exits 0 iff this worker refreshed its liveness key recently. */
const url = process.env.REDIS_URL;
if (!url) process.exit(1);
const redis = new Redis(url, { maxRetriesPerRequest: 1, connectTimeout: 3000, lazyConnect: true });
try {
  await redis.connect();
  const ok = (await redis.exists(workerAliveKey())) === 1;
  process.exit(ok ? 0 : 1);
} catch {
  process.exit(1);
}
