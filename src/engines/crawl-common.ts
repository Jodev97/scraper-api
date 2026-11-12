import { Configuration, RequestQueue } from 'crawlee';
import { randomUUID } from 'node:crypto';
import { sleep } from '../util/misc.js';

export interface CrawlerLike {
  run(requests?: Array<{ url: string; userData?: Record<string, unknown> }>): Promise<unknown>;
  stop(reason?: string): void;
  teardown(): Promise<void>;
}

/** Crawlee state for one run: in-memory only, isolated from other runs. */
export async function openRunStorage(): Promise<{ config: Configuration; queue: RequestQueue }> {
  const config = new Configuration({ persistStorage: false, purgeOnStart: true });
  const queue = await RequestQueue.open(`run-${randomUUID()}`, { config });
  return { config, queue };
}

export const ABORT_GRACE_MS = 2_500;

/**
 * Runs a crawler until it finishes or `signal` aborts. On abort the crawler is
 * stopped and torn down immediately (which also closes the browser), and the
 * promise settles within ABORT_GRACE_MS even if a request is still in flight.
 */
export async function driveCrawler(
  crawler: CrawlerLike,
  requests: Array<{ url: string; userData?: Record<string, unknown> }>,
  signal: AbortSignal,
  cleanup: () => Promise<void>,
): Promise<void> {
  let graceTimer: NodeJS.Timeout | undefined;
  const aborted = new Promise<void>((resolve) => {
    const fire = () => {
      try {
        crawler.stop('aborted');
      } catch {
        /* ignore */
      }
      void crawler.teardown().catch(() => undefined);
      graceTimer = setTimeout(resolve, ABORT_GRACE_MS);
    };
    if (signal.aborted) fire();
    else signal.addEventListener('abort', fire, { once: true });
  });

  try {
    if (!signal.aborted) {
      const running = crawler.run(requests).then(
        () => undefined,
        (e: unknown) => {
          if (!signal.aborted) throw e;
        },
      );
      await Promise.race([running, aborted]);
    }
  } finally {
    if (graceTimer) clearTimeout(graceTimer);
    await Promise.race([crawler.teardown().catch(() => undefined), sleep(3_000)]);
    await Promise.race([cleanup().catch(() => undefined), sleep(2_000)]);
  }
}
