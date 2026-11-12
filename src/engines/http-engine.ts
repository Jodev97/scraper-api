import { CheerioCrawler, ProxyConfiguration } from 'crawlee';
import { Transform } from 'node:stream';
import { errMessage } from '../util/misc.js';
import { CrawlCore, SkipRequestError, type PageMeta } from './core.js';
import { driveCrawler, openRunStorage } from './crawl-common.js';
import type { EngineContext, EngineOutcome, ScrapingEngine } from './types.js';

class ResponseTooLargeError extends Error {
  constructor(limit: number) {
    super(`Response exceeds the maximum size of ${limit} bytes`);
    this.name = 'ResponseTooLargeError';
  }
}

/**
 * Wraps a got response stream so that more than `max` bytes aborts the
 * download (instead of buffering an arbitrarily large body in memory).
 */
function limitResponse<T extends NodeJS.ReadableStream & Record<string, any>>(response: T, max: number): T {
  const declared = Number(response.headers?.['content-length']);
  if (Number.isFinite(declared) && declared > max) {
    (response as any).destroy?.();
    throw new ResponseTooLargeError(max);
  }
  let total = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      total += chunk.length;
      if (total > max) cb(new ResponseTooLargeError(max));
      else cb(null, chunk);
    },
  });
  response.on('error', (e) => limiter.destroy(e));
  limiter.on('error', () => (response as any).destroy?.());
  response.pipe(limiter);
  // Crawlee reads these properties off the response it parses.
  for (const key of Object.keys(response)) {
    if (!(key in limiter)) (limiter as any)[key] = response[key];
  }
  for (const key of ['statusCode', 'statusMessage', 'headers', 'url', 'redirectUrls', 'request', 'httpVersion', 'trailers', 'rawHeaders', 'complete', 'ip', 'timings', 'isFromCache']) {
    if (key in response) (limiter as any)[key] = response[key];
  }
  return limiter as unknown as T;
}

export class HttpEngine implements ScrapingEngine {
  readonly name = 'http';
  readonly description = 'Plain HTTP fetching with CheerioCrawler (no JavaScript execution)';

  async run(ctx: EngineContext): Promise<EngineOutcome> {
    const { config, sink, signal } = ctx;
    const core = new CrawlCore(ctx);
    const { config: crawlee, queue } = await openRunStorage();
    const releases = new Map<string, () => void>();
    const release = (key: string) => {
      releases.get(key)?.();
      releases.delete(key);
    };
    let startUrlsProcessed = 0;

    const crawler: CheerioCrawler = new CheerioCrawler(
      {
        requestQueue: queue,
        proxyConfiguration: new ProxyConfiguration({ proxyUrls: [ctx.proxyUrl] }),
        useSessionPool: false,
        persistCookiesPerSession: false,
        ignoreSslErrors: false,
        maxRequestRetries: config.execution.maxRetries,
        maxConcurrency: ctx.limits.maxConcurrency,
        navigationTimeoutSecs: config.execution.requestTimeoutSec,
        requestHandlerTimeoutSecs: config.execution.requestTimeoutSec + 30,
        additionalMimeTypes: ['text/plain'],
        retryOnBlocked: false,

        preNavigationHooks: [
          async ({ request }, gotOptions) => {
            const key = request.uniqueKey;
            if (signal.aborted) {
              request.noRetry = true;
              throw new SkipRequestError('run aborted', false);
            }
            // maxPages: reserve a slot on the first attempt only.
            if ((request.retryCount ?? 0) === 0 && !core.claimPage()) {
              request.noRetry = true;
              crawler.stop('maxPages');
              throw new SkipRequestError('maxPages reached', false);
            }
            try {
              await ctx.guard.assertUrl(request.url); // fail fast; the proxy re-validates
            } catch (e) {
              request.noRetry = true;
              throw new SkipRequestError(errMessage(e), true);
            }
            const host = new URL(request.url).hostname;
            releases.set(key, await core.gate.acquire(host, signal));

            const headers: Record<string, string> = {
              ...core.headersFor(request.url),
              'user-agent': ctx.userAgent,
            };
            const cookie = core.cookieHeaderFor(request.url);
            if (cookie) headers.Cookie = cookie;
            gotOptions.headers = { ...gotOptions.headers, ...headers };
            // We want to be identifiable, not to impersonate a browser.
            (gotOptions as any).useHeaderGenerator = false;
            // Keep redirects bounded; each hop goes through the SSRF proxy again.
            (gotOptions as any).maxRedirects = 5;
          },
        ],

        postNavigationHooks: [
          async (crawlingContext) => {
            const { request, response } = crawlingContext as any;
            if (response.headers?.['x-ssrf-blocked']) {
              request.noRetry = true;
              response.destroy?.();
              throw new SkipRequestError('Blocked by SSRF policy', true);
            }
            (crawlingContext as any).response = limitResponse(response, ctx.maxResponseBytes);
          },
        ],

        requestHandler: async ({ request, body, response }) => {
          const key = request.uniqueKey;
          try {
            const status: number = (response as any).statusCode ?? 0;
            if (status >= 400) {
              if (status < 500 && status !== 408 && status !== 429) request.noRetry = true;
              throw new Error(`HTTP ${status}`);
            }
            const html = typeof body === 'string' ? body : body.toString('utf8');
            core.recordBytes(html);
            const meta = request.userData as unknown as PageMeta;
            const finalUrl = request.loadedUrl ?? request.url;
            const next = core.handlePage(html, finalUrl, meta);
            sink.pageProcessed(finalUrl, meta.kind === 'start');
            if (meta.kind === 'start') startUrlsProcessed++;
            if (next.length && !sink.itemLimitReached) {
              const res = await crawler.addRequests(next.map((n) => ({ url: n.url, userData: n.userData })));
              const added = res.addedRequests.filter((r) => !r.wasAlreadyPresent).length;
              if (added) sink.urlsEnqueued(added);
            }
            if (sink.itemLimitReached) crawler.stop('maxItems');
          } finally {
            release(key);
          }
        },

        errorHandler: async ({ request }, error) => {
          release(request.uniqueKey);
          if (error instanceof SkipRequestError) return;
          sink.log(
            'warn',
            `Attempt ${(request.retryCount ?? 0) + 1} failed: ${ctx.redactor.redact(errMessage(error))}`,
            request.url,
          );
        },

        failedRequestHandler: async ({ request }, error) => {
          release(request.uniqueKey);
          if (error instanceof SkipRequestError && !error.counts) return;
          const reason = ctx.redactor.redact(errMessage(error));
          sink.pageFailed(request.url, reason, (request.userData as unknown as PageMeta).kind === 'start');
        },
      },
      crawlee,
    );

    const initial = core.startRequests();
    sink.urlsEnqueued(initial.length);
    await driveCrawler(
      crawler,
      initial.map((r) => ({ url: r.url, userData: r.userData })),
      signal,
      async () => {
        for (const r of releases.values()) r();
        // After an abort in-flight requests may still touch the queue; the
        // per-run in-memory storage is simply garbage collected instead.
        if (!signal.aborted) await queue.drop();
      },
    );
    return { startUrlsProcessed };
  }
}


