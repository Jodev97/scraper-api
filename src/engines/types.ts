import type { EffectiveLimits, ScrapeConfig, Secrets } from '../contract/schemas.js';
import type { Redactor } from '../security/redact.js';
import type { SsrfGuard } from '../security/ssrf.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * What an engine reports back while crawling. Implemented by the worker's
 * `RunRecorder` (and by a lightweight collector for previews).
 */
export interface RunSink {
  /** Returns false when the item was not stored (limit hit / too large). */
  addItem(sourceUrl: string, data: Record<string, unknown>): 'added' | 'limit' | 'too-large';
  log(level: LogLevel, message: string, url?: string): void;
  pageProcessed(url: string, isStartUrl: boolean): void;
  pageFailed(url: string, reason: string, isStartUrl: boolean): void;
  urlsEnqueued(count: number): void;
  addBytes(n: number): void;
  /** True once maxItems has been reached. */
  readonly itemLimitReached: boolean;
  /** A global limit stopped the crawl (logs the warning once per limit). */
  limitReached(limit: 'maxPages' | 'maxItems' | 'maxDepth'): void;
}

export interface EngineContext {
  config: ScrapeConfig;
  limits: EffectiveLimits;
  secrets?: Secrets;
  /** Aborted on cancel, timeout or shutdown. The engine must stop promptly. */
  signal: AbortSignal;
  sink: RunSink;
  guard: SsrfGuard;
  /** Loopback SSRF-enforcing proxy all traffic must go through. */
  proxyUrl: string;
  userAgent: string;
  redactor: Redactor;
  maxResponseBytes: number;
  maxConcurrencyPerDomain: number;
  /** Hard cap for the whole engine run in "single page" mode (previews). */
  singlePage?: boolean;
}

export interface EngineOutcome {
  /** Number of start URLs that were fetched and processed successfully. */
  startUrlsProcessed: number;
}

/**
 * A scraping engine. New engines are added by implementing this interface and
 * registering it in the worker; the API discovers them through Redis and
 * needs no change.
 */
export interface ScrapingEngine {
  readonly name: string;
  readonly description: string;
  run(ctx: EngineContext): Promise<EngineOutcome>;
}
