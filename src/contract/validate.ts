import { z } from 'zod';
import { validateConfigSelectors } from '../extraction/extract.js';
import type { GlobalLimits } from '../config/env.js';
import type { SsrfGuard } from '../security/ssrf.js';
import { SsrfError } from '../security/ssrf.js';
import {
  ApiError,
  CONFIG_VERSION,
  scrapeConfigSchema,
  type EffectiveLimits,
  type RequestedLimits,
  type ScrapeConfig,
} from './schemas.js';

export function formatZodError(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
}

/** Parses a request body with Zod, mapping failures to a 400 ApiError. */
export function parseBody<S extends z.ZodTypeAny>(schema: S, body: unknown): z.infer<S> {
  const r = schema.safeParse(body);
  if (!r.success) throw new ApiError(400, 'VALIDATION_ERROR', formatZodError(r.error));
  return r.data;
}

/**
 * Two-step validation of a `config`:
 *  1. unknown `version`            -> 422 UNSUPPORTED_CONFIG_VERSION
 *  2. malformed body               -> 400 VALIDATION_ERROR
 *  3. unknown engine / selectors / start URLs (static checks, no DNS)
 *                                  -> 422
 */
export function parseScrapeConfig(
  raw: unknown,
  opts: { engines: string[]; guard: SsrfGuard },
): ScrapeConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'config: must be an object');
  }
  const version = (raw as { version?: unknown }).version;
  if (version !== CONFIG_VERSION) {
    throw new ApiError(
      422,
      'UNSUPPORTED_CONFIG_VERSION',
      `config.version ${JSON.stringify(version)} is not supported (supported: ${CONFIG_VERSION})`,
    );
  }
  const parsed = scrapeConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', `config.${formatZodError(parsed.error)}`);
  }
  const config = parsed.data;

  if (!opts.engines.includes(config.engine)) {
    throw new ApiError(
      422,
      'UNKNOWN_ENGINE',
      `config.engine "${config.engine}" is not available (available: ${opts.engines.join(', ')})`,
    );
  }
  if (config.engine !== 'browser' && config.execution.waitForSelector) {
    // Spec: waitForSelector only applies to the browser engine. It is ignored, not an error.
  }
  const selectorErrors = validateConfigSelectors(config);
  if (selectorErrors.length) throw new ApiError(422, 'INVALID_SELECTOR', selectorErrors.join('; '));

  for (const [i, u] of config.startUrls.entries()) {
    try {
      opts.guard.checkUrl(applyQueryParams(u, config.queryParams));
    } catch (e) {
      if (e instanceof SsrfError) {
        throw new ApiError(422, 'URL_NOT_ALLOWED', `config.startUrls[${i}]: ${e.message}`);
      }
      throw e;
    }
  }
  const p = config.navigation.pagination;
  if (p.type === 'urlPattern') {
    try {
      opts.guard.checkUrl(applyQueryParams(p.template.replaceAll('{page}', String(p.from)), config.queryParams));
    } catch (e) {
      if (e instanceof SsrfError) {
        throw new ApiError(422, 'URL_NOT_ALLOWED', `config.navigation.pagination.template: ${e.message}`);
      }
      throw e;
    }
  }
  return config;
}

/** Merges `queryParams` into a URL (existing params with the same name win). */
export function applyQueryParams(rawUrl: string, params: Record<string, string>): string {
  if (Object.keys(params).length === 0) return rawUrl;
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return rawUrl; // let the guard report the invalid URL
  }
  for (const [k, v] of Object.entries(params)) if (!u.searchParams.has(k)) u.searchParams.set(k, v);
  return u.href;
}

/**
 * Clamps requested limits to the global ceilings. Missing values default to
 * the ceilings. Returns a message per clamped value (to be logged in the run).
 */
export function resolveLimits(
  requested: RequestedLimits | undefined,
  global: GlobalLimits,
): { limits: EffectiveLimits; clamped: string[] } {
  const clamped: string[] = [];
  const pick = (name: keyof EffectiveLimits, ceiling: number): number => {
    const want = requested?.[name];
    if (want === undefined) return ceiling;
    if (want > ceiling) {
      clamped.push(`limits.${name}=${want} exceeds the global maximum; clamped to ${ceiling}`);
      return ceiling;
    }
    return want;
  };
  return {
    limits: {
      maxPages: pick('maxPages', global.maxPages),
      maxDepth: pick('maxDepth', global.maxDepth),
      maxItems: pick('maxItems', global.maxItems),
      maxDurationSec: pick('maxDurationSec', global.maxDurationSec),
      maxConcurrency: pick('maxConcurrency', global.maxConcurrency),
    },
    clamped,
  };
}
