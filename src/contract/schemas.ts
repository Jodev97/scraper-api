import { z } from 'zod';

export const CONFIG_VERSION = 1;
export const SERVICE_VERSION = '1.0.0';

// ---------------------------------------------------------------- config v1

export const selectorSchema = z.object({
  type: z.enum(['css', 'xpath']),
  value: z.string().min(1).max(1000),
});
export type Selector = z.infer<typeof selectorSchema>;

export const transformSchema = z.enum(['trim', 'number', 'absoluteUrl', 'date']);
export type Transform = z.infer<typeof transformSchema>;

export const fieldSchema = z.object({
  key: z.string().min(1).max(64),
  selector: selectorSchema,
  attr: z.string().min(1).max(100).default('text'),
  transform: transformSchema.default('trim'),
  required: z.boolean().default(false),
});
export type FieldConfig = z.infer<typeof fieldSchema>;

export const extractionSchema = z
  .object({
    mode: z.enum(['list', 'single']),
    itemSelector: selectorSchema.optional(),
    fields: z.array(fieldSchema).min(1).max(50),
  })
  .superRefine((v, ctx) => {
    if (v.mode === 'list' && !v.itemSelector) {
      ctx.addIssue({
        code: 'custom',
        path: ['itemSelector'],
        message: 'itemSelector is required when mode is "list"',
      });
    }
    const keys = new Set<string>();
    for (const [i, f] of v.fields.entries()) {
      if (keys.has(f.key)) {
        ctx.addIssue({ code: 'custom', path: ['fields', i, 'key'], message: `duplicate field key "${f.key}"` });
      }
      keys.add(f.key);
    }
  });

export const paginationSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({ type: z.literal('nextLink'), selector: selectorSchema }),
  z
    .object({
      type: z.literal('urlPattern'),
      /** URL containing the `{page}` placeholder. */
      template: z
        .string()
        .min(1)
        .max(2000)
        .refine((t) => t.includes('{page}'), 'template must contain "{page}"'),
      from: z.number().int().min(0),
      to: z.number().int().min(0),
      step: z.number().int().min(1).default(1),
    })
    .refine((p) => p.to >= p.from, { message: '"to" must be >= "from"', path: ['to'] })
    .refine((p) => Math.floor((p.to - p.from) / p.step) < 10_000, {
      message: 'urlPattern generates too many pages (max 10000)',
      path: ['to'],
    }),
]);

export const navigationSchema = z.object({
  pagination: paginationSchema.default({ type: 'none' }),
  followLinks: z
    .object({
      selector: selectorSchema,
      sameDomainOnly: z.boolean().default(true),
    })
    .optional(),
});

export const executionSchema = z.object({
  requestTimeoutSec: z.number().int().min(1).max(300).default(30),
  maxRetries: z.number().int().min(0).max(10).default(2),
  delayMs: z.number().int().min(0).max(60_000).default(500),
  waitForSelector: z.string().min(1).max(1000).nullable().default(null),
});

export const scrapeConfigSchema = z.object({
  version: z.literal(1),
  engine: z.string().min(1).max(32).default('http'),
  startUrls: z.array(z.string().min(1).max(4000)).min(1).max(100),
  queryParams: z.record(z.string(), z.string()).default({}),
  headers: z.record(z.string(), z.string()).default({}),
  extraction: extractionSchema,
  navigation: navigationSchema.default({ pagination: { type: 'none' } }),
  execution: executionSchema.default({
    requestTimeoutSec: 30,
    maxRetries: 2,
    delayMs: 500,
    waitForSelector: null,
  }),
  dedupeKeyFields: z.array(z.string().min(1)).max(50).optional(),
});
export type ScrapeConfig = z.infer<typeof scrapeConfigSchema>;

// ------------------------------------------------------------------- secrets

export const secretsSchema = z.object({
  headers: z.record(z.string(), z.string()).optional(),
  cookies: z
    .array(
      z.object({
        name: z.string().min(1),
        value: z.string(),
        domain: z.string().min(1),
        path: z.string().optional(),
      }),
    )
    .max(100)
    .optional(),
});
export type Secrets = z.infer<typeof secretsSchema>;

// -------------------------------------------------------------------- limits

export const limitsSchema = z.object({
  maxPages: z.number().int().min(1).optional(),
  maxDepth: z.number().int().min(0).optional(),
  maxItems: z.number().int().min(1).optional(),
  maxDurationSec: z.number().int().min(1).optional(),
  maxConcurrency: z.number().int().min(1).optional(),
});
export type RequestedLimits = z.infer<typeof limitsSchema>;

export interface EffectiveLimits {
  maxPages: number;
  maxDepth: number;
  maxItems: number;
  maxDurationSec: number;
  maxConcurrency: number;
}

// ---------------------------------------------------------------- POST /runs

export const CONTEXT_MAX_BYTES = 4 * 1024;

export const createRunSchema = z.object({
  idempotencyKey: z.string().min(1).max(256),
  context: z
    .record(z.string(), z.unknown())
    .refine((c) => Buffer.byteLength(JSON.stringify(c), 'utf8') <= CONTEXT_MAX_BYTES, {
      message: `context must be at most ${CONTEXT_MAX_BYTES} bytes when serialized`,
    }),
  // `config` is validated in two steps (version first, then the body) so an
  // unknown version yields 422 rather than a generic validation error.
  config: z.unknown(),
  secrets: secretsSchema.optional(),
  limits: limitsSchema.optional(),
});
export type CreateRunBody = z.infer<typeof createRunSchema>;

// ------------------------------------------------------------------- preview

export const previewSchema = z.object({
  config: z.unknown(),
  secrets: secretsSchema.optional(),
  /** Page to evaluate; defaults to `config.startUrls[0]`. */
  url: z.string().min(1).max(4000).optional(),
  /** Max items returned (default 50). */
  maxItems: z.number().int().min(1).max(200).optional(),
});
export type PreviewBody = z.infer<typeof previewSchema>;

// ---------------------------------------------------------------- run states

export const RUN_STATUSES = ['queued', 'running', 'completed', 'failed', 'cancelled'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export const TERMINAL_STATUSES: readonly RunStatus[] = ['completed', 'failed', 'cancelled'];
export const isTerminal = (s: RunStatus): boolean => TERMINAL_STATUSES.includes(s);

export type ErrorCode = 'TIMEOUT' | 'WORKER_RESTARTED' | 'START_URLS_FAILED' | 'INTERNAL_ERROR';

export interface RunStats {
  durationMs?: number;
  bytesDownloaded?: number;
  peakMemoryBytes?: number;
}

export interface RunView {
  runId: string;
  status: RunStatus;
  context: Record<string, unknown>;
  pagesProcessed: number;
  pagesFailed: number;
  itemsExtracted: number;
  lastSeq: number;
  startedAt: string | null;
  finishedAt: string | null;
  error: { code: string; message: string } | null;
  stats?: RunStats;
}

export interface ExtractedItem {
  seq: number;
  sourceUrl: string;
  data: Record<string, unknown>;
  dedupeKey: string;
}

// ------------------------------------------------------------------ webhooks

export type WebhookEventName =
  | 'run.started'
  | 'run.progress'
  | 'run.log'
  | 'run.items'
  | 'run.completed'
  | 'run.failed'
  | 'run.cancelled';

export interface LogEntry {
  seq: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  url?: string;
  at: string;
}

export interface WebhookBody {
  version: 1;
  deliveryId: string;
  runId: string;
  event: WebhookEventName;
  context: Record<string, unknown>;
  timestamp: string;
  data: unknown;
}

// ------------------------------------------------------------------- errors

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Everything the worker needs to execute a run. This is the BullMQ job
 * payload; it carries `secrets`, so jobs are removed from Redis as soon as
 * they finish.
 */
export interface RunJobData {
  runId: string;
  context: Record<string, unknown>;
  config: ScrapeConfig;
  secrets?: Secrets;
  limits: EffectiveLimits;
  /** Notes to write to the run log first (e.g. limits that were clamped). */
  warnings: string[];
}

export interface PreviewJobData {
  config: ScrapeConfig;
  secrets?: Secrets;
  url: string;
  maxItems: number;
}

export interface PreviewResult {
  url: string;
  items: Array<Pick<ExtractedItem, 'sourceUrl' | 'data' | 'dedupeKey'>>;
  itemsFound: number;
  logs: Array<{ level: string; message: string }>;
}
