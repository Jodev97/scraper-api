import { z } from 'zod';

const int = (min: number, max: number) =>
  z.coerce.number().int().min(min).max(max);

const csv = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );

/**
 * Shared by both processes. Role-specific requirements (the API needs the
 * API key and webhook settings, the worker does not) are enforced by
 * `loadEnv(role)`.
 */
const baseSchema = z.object({
  PORT: int(1, 65535).default(3000),
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),
  MAX_CONCURRENT_RUNS: int(1, 1000),
  MAX_CONCURRENT_BROWSER_RUNS: int(0, 1000),
  MAX_PAGES_PER_RUN: int(1, 10_000_000),
  MAX_DEPTH: int(0, 100),
  MAX_ITEMS_PER_RUN: int(1, 100_000_000),
  MAX_RUN_DURATION_SEC: int(1, 7 * 24 * 3600),
  MAX_RESPONSE_BYTES: int(1024, 1024 * 1024 * 1024).default(10 * 1024 * 1024),
  RESULT_TTL_HOURS: int(1, 24 * 365).default(72),
  USER_AGENT: z.string().min(1).default('NopxusScraper/1.0 (+https://nopxus.com/bot)'),
  BLOCKED_HOSTS: csv,
  // Optional extras (not part of the base contract).
  MAX_CONCURRENCY: int(1, 100).default(8),
  MAX_CONCURRENCY_PER_DOMAIN: int(1, 100).default(2),
  MAX_ITEM_BYTES: int(256, 16 * 1024 * 1024).default(64 * 1024),
  LEASE_TTL_SEC: int(1, 3600).default(20),
  WEBHOOK_RETRY_BASE_MS: int(1, 600_000).default(1000),
  LOG_LEVEL: z.string().default('info'),
});

const apiSchema = baseSchema.extend({
  SCRAPER_API_KEY: z.string().min(16, 'SCRAPER_API_KEY must be at least 16 characters'),
  NOPXUS_WEBHOOK_URL: z.url('NOPXUS_WEBHOOK_URL must be a valid URL'),
  NOPXUS_WEBHOOK_SECRET: z.string().min(16, 'NOPXUS_WEBHOOK_SECRET must be at least 16 characters'),
});

const workerSchema = baseSchema.extend({
  SCRAPER_API_KEY: z.string().optional(),
  NOPXUS_WEBHOOK_URL: z.string().optional(),
  NOPXUS_WEBHOOK_SECRET: z.string().optional(),
});

export type ApiEnv = z.infer<typeof apiSchema>;
export type WorkerEnv = z.infer<typeof workerSchema>;
export type Env = ApiEnv | WorkerEnv;

export class EnvError extends Error {}

export function loadEnv(role: 'api', source?: NodeJS.ProcessEnv): ApiEnv;
export function loadEnv(role: 'worker', source?: NodeJS.ProcessEnv): WorkerEnv;
export function loadEnv(
  role: 'api' | 'worker',
  source: NodeJS.ProcessEnv = process.env,
): ApiEnv | WorkerEnv {
  const schema = role === 'api' ? apiSchema : workerSchema;
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map(
      (i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`,
    );
    throw new EnvError(`Invalid environment configuration:\n${lines.join('\n')}`);
  }
  return parsed.data;
}

/** Global ceilings applied to every run's `limits`. */
export interface GlobalLimits {
  maxPages: number;
  maxDepth: number;
  maxItems: number;
  maxDurationSec: number;
  maxConcurrency: number;
  maxResponseBytes: number;
  maxItemBytes: number;
}

export function globalLimits(env: Env): GlobalLimits {
  return {
    maxPages: env.MAX_PAGES_PER_RUN,
    maxDepth: env.MAX_DEPTH,
    maxItems: env.MAX_ITEMS_PER_RUN,
    maxDurationSec: env.MAX_RUN_DURATION_SEC,
    maxConcurrency: env.MAX_CONCURRENCY,
    maxResponseBytes: env.MAX_RESPONSE_BYTES,
    maxItemBytes: env.MAX_ITEM_BYTES,
  };
}
